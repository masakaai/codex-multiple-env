#!/usr/bin/env node

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccountSnapshot } from "./app-server.mjs";
import { effectiveProfileOrder, chooseAutomaticProfile, profilePolicyCandidate } from "./proxy-policy.mjs";
import {
  proxyPaths,
  proxyStatus,
  readProxySettings,
  runtimeInstalled,
  switchProxyProfile,
  syncProxyConfig,
  waitForProxy,
  writeProxyConfig,
} from "./proxy-runtime.mjs";
import { getDefaultProfile, listProfiles } from "./state.mjs";

async function snapshotsFor(profiles) {
  return await Promise.all(profiles.map(async (profile) => {
    try {
      return { value: await readAccountSnapshot(profile) };
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  }));
}

export async function evaluateProxyPolicy(options = {}) {
  const [profiles, startingStatus] = await Promise.all([
    listProfiles(),
    proxyStatus(options),
  ]);
  if (!profiles.length) return { active: undefined, ordered: [] };
  const snapshots = await snapshotsFor(profiles);
  const candidates = profiles.map((profile, index) => profilePolicyCandidate(profile, snapshots[index]));
  // Settings may change while quota reads are in flight. Re-read before any
  // route decision so `/auto false` and manual order changes take effect now.
  const settings = await readProxySettings(options);
  const ordered = effectiveProfileOrder(candidates, settings);
  await syncProxyConfig(ordered, options);
  const status = await proxyStatus(options);
  if (!settings.auto) return { active: status.active, ordered };

  // A user or runtime failover may have changed the route while the network
  // snapshots were in progress. Preserve that newer choice for this cycle.
  if (status.active !== startingStatus.active) return { active: status.active, ordered };

  const unavailableProfileIds = status.accounts
    .filter((account) => !["READY", "REFRESHING"].includes(account.state))
    .map((account) => account.name);
  const selected = chooseAutomaticProfile(candidates, {
    ...settings,
    activeProfileId: status.active,
    unavailableProfileIds,
  });
  if (selected && selected !== status.active) await switchProxyProfile(selected, options);
  return { active: selected || status.active, ordered };
}

async function serve() {
  if (!(await runtimeInstalled())) throw new Error("Masaka Proxy runtime is not installed. Run masaka onboarding.");
  const [profiles, settings, defaultId] = await Promise.all([listProfiles(), readProxySettings(), getDefaultProfile()]);
  if (!profiles.length) throw new Error("Masaka Proxy has no profiles.");
  // Bring the loopback listener up from local state first. Quota endpoints can
  // take many seconds; the first policy cycle refreshes them after readiness.
  const initialCandidates = profiles.map((profile) => profilePolicyCandidate(profile, { error: "startup" }));
  const initialOrder = effectiveProfileOrder(initialCandidates, settings);
  await writeProxyConfig(profiles, initialOrder, settings);

  const paths = proxyPaths();
  const cli = join(paths.runtime, "src", "cli.mjs");
  const child = spawn(process.execPath, [cli, "--config", paths.config, "serve"], {
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    process.stderr.write(`[masaka-daemon] proxy spawn failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  const exited = new Promise((resolvePromise) => child.once("exit", (exitCode, signal) => {
    resolvePromise({ code: signal ? 1 : exitCode ?? 1, signal });
  }));
  const failIfExited = exited.then(({ code, signal }) => {
    throw new Error(`Proxy child exited during startup (${signal || code}).`);
  });

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  await Promise.race([waitForProxy(), failIfExited]);
  if (!settings.auto && defaultId && profiles.some((profile) => profile.id === defaultId)) {
    try { await switchProxyProfile(defaultId); } catch { /* preserve restored runtime selection */ }
  }

  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      await evaluateProxyPolicy();
    } catch (error) {
      if (error.statusCode !== 409) process.stderr.write(`[masaka-daemon] policy: ${error.message}\n`);
    } finally {
      running = false;
    }
  };
  await Promise.race([cycle(), failIfExited]);
  const interval = setInterval(cycle, Math.max(15, settings.pollSeconds) * 1000);

  const { code } = await exited;
  clearInterval(interval);
  process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "serve") {
    process.stderr.write("usage: masaka-daemon serve\n");
    process.exitCode = 2;
  } else {
    serve().catch((error) => {
      process.stderr.write(`[masaka-daemon] ${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
