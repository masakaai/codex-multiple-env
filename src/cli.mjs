#!/usr/bin/env node

import { access, chmod, lstat, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readAccountSnapshot } from "./app-server.mjs";
import {
  addProfile,
  planDisplayName,
  profileSummary,
  readOfficialCodexIdentity,
  resolveProfile,
} from "./codex-auth.mjs";
import { cxHome } from "./crypto-store.mjs";
import {
  createCwsProfile,
  finalizeCwsProfile,
  findCwsScript,
  prepareCwsProfiles,
  runCws,
  runCwsInteractive,
  shellInit,
} from "./cws-adapter.mjs";
import {
  getDefaultProfile,
  listProfiles,
  prepareProfileCodexHome,
  removeProfile,
  saveProfile,
  setDefaultProfile,
} from "./state.mjs";
import { startupBanner, statusLimitLines } from "./terminal-ui.mjs";
import { formatWorkspaceCredits, limitWindows, resetCredits, resetText } from "./usage.mjs";
import {
  effectiveProfileOrder,
  inferProfileTier,
  profilePolicyCandidate,
} from "./proxy-policy.mjs";
import {
  onboardingProxy,
  pauseProxyProfile,
  proxyStatus,
  readProxySettings,
  refreshProxyProfile,
  reloadProxyProfile,
  resumeProxyProfile,
  runtimeInstalled,
  setLiveProxyAutoSelect,
  setProxyMode,
  switchProxyProfile,
  syncProxyConfig,
  updateProxySettings,
  waitForProxyProfileDrain,
} from "./proxy-runtime.mjs";

const VERSION = "0.4.4";

function help() {
  return `masaka — account and workspace manager for the native Codex CLI

Run \`masaka\` for the interactive manager:
  /status             All accounts, login state, usage, and 5-hour limits
  /usage              Reset-card counts and expiry for every account
  /profiles           All saved account + workspace profiles
  /use NAME|NUMBER    Select the profile used by new native Codex processes
  /auto [true|false]  Show or change automatic Proxy switching (default: true)
  /order              Show, customize, or reset account priority
  /proxy on|off       Route new native Codex processes through the daemon
  /onboarding         Install and start the local Proxy daemon
  /add [NAME]         Add an official Codex browser login
  /renew NAME|NUMBER  Renew the same saved identity
  /delete NAME|NUMBER Delete a profile after exact-name confirmation
  /help               Show commands
  /exit               Exit masaka

Terminal equivalents omit the slash, for example \`masaka status\`.
Masaka is a manager, not a Codex chat client. Run \`codex\` normally. In
Proxy mode, /use applies to the next request of already-running Codex clients.
`;
}

function formatError(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error?.message || String(error);
}

function parseWords(line) {
  const words = [];
  let word = "";
  let quote = "";
  let escaped = false;
  let active = false;
  for (const character of line.trim()) {
    if (escaped) {
      word += character;
      escaped = false;
      active = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else word += character;
      active = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (active) {
        words.push(word);
        word = "";
        active = false;
      }
      continue;
    }
    word += character;
    active = true;
  }
  if (escaped) word += "\\";
  if (quote) throw new Error("Unclosed quote.");
  if (active) words.push(word);
  return words;
}

function parseAuthArguments(args) {
  const names = [];
  let deviceAuth = false;
  for (const value of args) {
    if (value === "--device-auth") deviceAuth = true;
    else if (value.startsWith("--")) throw new Error(`Unknown auth option: ${value}`);
    else names.push(value);
  }
  return { selector: names.join(" ").trim(), deviceAuth };
}

async function resolveUserProfile(selector) {
  const value = String(selector || "").trim();
  if (!value) throw new Error("Choose a profile by its number or full name. Run /profiles to list them.");
  const profiles = await listProfiles();
  if (/^[1-9]\d*$/.test(value)) {
    const profile = profiles[Number(value) - 1];
    if (!profile) throw new Error(`Profile number is out of range: ${value}`);
    return profile;
  }
  return await resolveProfile(value);
}

async function hasCredential(profile) {
  try {
    const home = await prepareProfileCodexHome(profile.id);
    const info = await lstat(`${home}/auth.json`);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function profilesCommand() {
  const [profiles, defaultId] = await Promise.all([listProfiles(), getDefaultProfile()]);
  if (!profiles.length) {
    console.log("No profiles yet. Run /add.");
    return;
  }
  for (const [index, profile] of profiles.entries()) {
    const credential = await hasCredential(profile);
    console.log(`${index + 1}. ${profileSummary(profile, defaultId)}`);
    console.log(`  Auth: ${credential ? "saved" : "missing — run /renew"}`);
  }
}

async function setDefault(profile) {
  await prepareCwsProfiles([profile]);
  await runCws(["default", profile.id]);
  await setDefaultProfile(profile.id);
}

async function addCommand(args) {
  const { selector, deviceAuth } = parseAuthArguments(args);
  console.error("[masaka] Opening the official Codex login for a new isolated profile.");
  const profile = await addProfile(selector || undefined, {
    deviceAuth,
    prepare: async ({ id }) => await createCwsProfile(id),
    finalize: async ({ profile: created }) => await finalizeCwsProfile(created),
    cleanup: async ({ id }) => {
      try { await runCws(["remove", id]); } catch { /* preserve the login error */ }
    },
  });
  await runCws(["default", profile.id]);
  console.log(`Added and selected: ${profile.label}`);
}

async function renewCommand(args) {
  const { selector, deviceAuth } = parseAuthArguments(args);
  const profile = await resolveUserProfile(selector);
  await prepareCwsProfiles([profile], { allowMissingCredential: true });
  const cwsArgs = [
    "login",
    profile.id,
    "--reauth",
    "--expected-workspace-id",
    profile.workspaceId,
  ];
  if (profile.accountUserId) cwsArgs.push("--expected-user-id", profile.accountUserId);
  else if (profile.email) cwsArgs.push("--expected-email", profile.email);
  if (deviceAuth) cwsArgs.push("--device-auth");
  let proxyPaused = false;
  let wasPaused = false;
  let wasActive = false;
  try {
    const status = await proxyStatus();
    const account = status.accounts.find((entry) => entry.name === profile.id);
    if (!account) throw new Error("This Profile is not loaded by Masaka Proxy.");
    wasPaused = account.state === "PAUSED";
    wasActive = status.active === profile.id;
    await pauseProxyProfile(profile.id);
    proxyPaused = true;
    await waitForProxyProfileDrain(profile.id);
    // Move the proxy's refresh chain forward before handing the file to the
    // official login flow. A failed refresh is expected for expired Profiles.
    try {
      await refreshProxyProfile(profile.id, { timeoutMs: 30_000 });
    } catch (error) {
      if (error.statusCode !== 409) throw error;
    }
  } catch (error) {
    const settings = await readProxySettings();
    if (settings.daemonInstalled && settings.proxyEnabled) {
      if (proxyPaused && !wasPaused) {
        try {
          await resumeProxyProfile(profile.id);
          if (wasActive) await switchProxyProfile(profile.id);
        } catch { /* surface original setup error */ }
      }
      throw new Error(`Cannot safely renew while Masaka Proxy is unavailable: ${formatError(error)}`);
    }
  }
  try {
    await runCwsInteractive(cwsArgs);
  } finally {
    if (proxyPaused) {
      try {
        await reloadProxyProfile(profile.id);
        if (!wasPaused) {
          await resumeProxyProfile(profile.id);
          if (wasActive) await switchProxyProfile(profile.id);
        }
      } catch (error) {
        console.error(`[masaka] Proxy credential reload needs attention: ${formatError(error)}`);
      }
    }
  }
  const identity = await readOfficialCodexIdentity(await prepareProfileCodexHome(profile.id));
  const sameAccount = profile.accountUserId
    ? identity.accountUserId === profile.accountUserId
    : identity.email?.toLocaleLowerCase() === profile.email?.toLocaleLowerCase();
  if (!sameAccount || identity.workspaceId !== profile.workspaceId) {
    throw new Error("The renewed login is a different account or workspace. The previous credential was restored; use /add for a different identity.");
  }
  const updated = { ...profile, ...identity, updatedAt: new Date().toISOString() };
  await finalizeCwsProfile(updated);
  await saveProfile(updated);
  console.log(`Renewed: ${updated.label}`);
}

function accountLine(snapshot, profile) {
  const account = snapshot?.account?.account;
  if (!account) return "Auth: unavailable";
  const plan = account.planType ? planDisplayName(account.planType) : planDisplayName(profile.planType);
  return `Auth: connected · ${account.email || profile.email || "no email"} · ${plan}`;
}

function tokenUsageLine(snapshot) {
  const summary = snapshot?.usage?.summary;
  if (!summary) return undefined;
  const lifetime = typeof summary.lifetimeTokens === "number" ? summary.lifetimeTokens.toLocaleString() : "unknown";
  const streak = typeof summary.currentStreakDays === "number" ? ` · ${summary.currentStreakDays}d streak` : "";
  return `Tokens: ${lifetime} lifetime${streak}`;
}

async function snapshotFor(profile) {
  try {
    return { value: await readAccountSnapshot(profile) };
  } catch (error) {
    return { error: formatError(error) };
  }
}

async function profilesWithSnapshots() {
  const [profiles, defaultId] = await Promise.all([listProfiles(), getDefaultProfile()]);
  const snapshots = await Promise.all(profiles.map((profile) => snapshotFor(profile)));
  return { profiles, defaultId, snapshots };
}

async function statusCommand() {
  const { profiles, defaultId, snapshots } = await profilesWithSnapshots();
  if (!profiles.length) return console.log("No profiles yet. Run /add.");
  const proxy = await readProxySettings();
  if (proxy.daemonInstalled) {
    try {
      const live = await proxyStatus();
      const active = profiles.find((profile) => profile.id === live.active);
      console.log(`Proxy: ${proxy.proxyEnabled ? "on" : "off"} · auto ${proxy.auto ? "on" : "off"} · active ${active?.label || live.active || "none"}`);
    } catch {
      console.log(`Proxy: ${proxy.proxyEnabled ? "on" : "off"} · daemon unavailable`);
    }
  }
  for (const [index, profile] of profiles.entries()) {
    const marker = profile.id === defaultId ? " [active]" : "";
    console.log(`${index + 1}. ${profile.label}${marker}`);
    const snapshot = snapshots[index];
    if (snapshot.error) {
      console.log(`  Status unavailable: ${snapshot.error}`);
      continue;
    }
    console.log(`  ${accountLine(snapshot.value, profile)}`);
    const windows = limitWindows(snapshot.value.limits);
    const fiveHour = windows.filter((window) => window.durationMins === 300);
    const shown = fiveHour.length ? [...fiveHour, ...windows.filter((window) => window.durationMins !== 300)] : windows;
    if (!shown.length) console.log("  Limits: not returned by this account");
    else {
      console.log("  Usage limits");
      for (const line of statusLimitLines(shown, { columns: output.columns })) console.log(line);
    }
    const credits = formatWorkspaceCredits(snapshot.value.limits);
    if (credits) console.log(`  ${credits}`);
    const usage = tokenUsageLine(snapshot.value);
    if (usage) console.log(`  ${usage}`);
  }
}

async function policySnapshot() {
  const { profiles, snapshots } = await profilesWithSnapshots();
  const settings = await readProxySettings();
  const candidates = profiles.map((profile, index) => profilePolicyCandidate(profile, snapshots[index]));
  return { profiles, snapshots, settings, candidates, ordered: effectiveProfileOrder(candidates, settings) };
}

async function syncInstalledProxy(ordered, activeId) {
  if (!(await runtimeInstalled())) return false;
  let live;
  try { live = await proxyStatus(); } catch { /* daemon may be stopped */ }
  try {
    const applied = await syncProxyConfig(ordered);
    if (!applied) return false;
    const keep = activeId || live?.active;
    if (keep) await switchProxyProfile(keep);
    return true;
  } catch (error) {
    if (error.statusCode === 409 || /not running|ECONNREFUSED|ENOENT/i.test(error.message)) return false;
    throw error;
  }
}

function booleanArgument(value) {
  if (value === "true" || value === "on") return true;
  if (value === "false" || value === "off") return false;
  throw new Error("Use /auto true or /auto false.");
}

async function autoCommand(args) {
  if (args.length > 1) throw new Error("Use /auto, /auto true, or /auto false.");
  if (!args.length) {
    const settings = await readProxySettings();
    console.log(`Automatic switching: ${settings.auto ? "on" : "off"} · switch at 5h remaining ≤ ${settings.thresholdPercent}%`);
    return;
  }
  const enabled = booleanArgument(args[0].toLocaleLowerCase());
  let active;
  try { active = (await proxyStatus()).active; } catch { /* not installed/running yet */ }
  const settings = await updateProxySettings({ auto: enabled });
  const snapshot = await policySnapshot();
  const ordered = effectiveProfileOrder(snapshot.candidates, settings);
  const reloaded = await syncInstalledProxy(ordered, active || await getDefaultProfile());
  let liveApplied = false;
  try {
    await setLiveProxyAutoSelect(enabled);
    liveApplied = true;
  } catch { /* saved config applies when the daemon becomes available */ }
  console.log(`Automatic switching: ${enabled ? "on" : "off"}`);
  if ((await runtimeInstalled()) && !liveApplied) {
    console.log("Daemon unavailable: the saved setting will apply when it starts; no live change was claimed.");
  } else if (!reloaded) {
    console.log("Live auto-select was updated; the saved failover order will reload after long-lived connections close or the daemon restarts.");
  }
  if (enabled) console.log(`Sticky account policy: switch only when 5h remaining is ≤ ${settings.thresholdPercent}% or the account is unavailable.`);
}

function orderDescription(candidate) {
  const priority = inferProfileTier(candidate.profile);
  const group = priority >= 20 ? "Pro priority" : priority >= 5 ? "Business/Team priority" : "Standard priority";
  const remaining = candidate.snapshotAvailable
    ? candidate.fiveHour
      ? `${Math.round(candidate.fiveHour.remainingPercent)}% 5h left`
      : `no 5h window${candidate.remainingPercent === undefined ? "" : ` · ${Math.round(candidate.remainingPercent)}% minimum left`}`
    : "usage unavailable";
  return `${candidate.profile.label} · ${group} · ${remaining}`;
}

async function orderCommand(args) {
  const snapshot = await policySnapshot();
  if (!args.length) {
    console.log(`Order: ${snapshot.settings.orderMode}`);
    const byId = new Map(snapshot.candidates.map((candidate) => [candidate.profile.id, candidate]));
    snapshot.ordered.forEach((id, index) => console.log(`${index + 1}. ${orderDescription(byId.get(id))}`));
    console.log("Change: /order NAME|NUMBER POSITION · Reset: /order auto");
    return;
  }
  if (args.length === 1 && args[0].toLocaleLowerCase() === "auto") {
    const settings = await updateProxySettings({ orderMode: "automatic", order: [] });
    const ordered = effectiveProfileOrder(snapshot.candidates, settings);
    await syncInstalledProxy(ordered);
    console.log("Order reset to automatic: multiplier → healthy 5h capacity → remaining percentage.");
    return;
  }
  const positionText = args.at(-1);
  if (!/^[1-9]\d*$/.test(positionText)) throw new Error("Use /order NAME|NUMBER POSITION, for example /order 3 1.");
  const selector = args.slice(0, -1).join(" ").trim();
  let profile;
  if (/^[1-9]\d*$/.test(selector)) {
    const id = snapshot.ordered[Number(selector) - 1];
    profile = snapshot.profiles.find((entry) => entry.id === id);
    if (!profile) throw new Error(`Order number is out of range: ${selector}`);
  } else {
    profile = await resolveUserProfile(selector);
  }
  const position = Number(positionText);
  if (position > snapshot.profiles.length) throw new Error(`Order position must be between 1 and ${snapshot.profiles.length}.`);
  const order = snapshot.ordered.filter((id) => id !== profile.id);
  order.splice(position - 1, 0, profile.id);
  const settings = await updateProxySettings({ orderMode: "manual", order });
  await syncInstalledProxy(order);
  console.log(`Moved ${profile.label} to position ${position}. Automatic switching remains sticky until the 5% threshold.`);
}

async function onboardingCommand() {
  const snapshot = await policySnapshot();
  if (!snapshot.profiles.length) throw new Error("Add at least one Profile before onboarding Proxy mode.");
  console.log("Installing the pinned local Proxy runtime and per-user daemon…");
  const result = await onboardingProxy(snapshot.ordered);
  console.log(`Proxy ready on 127.0.0.1:${result.settings.port}.`);
  console.log(`Automatic switching is ${result.settings.auto ? "on" : "off"}. Restart existing Codex clients once; after that /use hot-switches their next request.`);
}

async function proxyCommand(args) {
  const action = (args[0] || "status").toLocaleLowerCase();
  if (args.length > 1 || !["on", "off", "status"].includes(action)) throw new Error("Use /proxy on, /proxy off, or /proxy status.");
  if (action === "status") {
    const settings = await readProxySettings();
    const installed = await runtimeInstalled();
    let live;
    try { live = await proxyStatus(); } catch { /* report offline */ }
    console.log(`Proxy mode: ${settings.proxyEnabled ? "on" : "off"}`);
    console.log(`Daemon: ${installed ? live ? "running" : "installed, unavailable" : "not installed — run /onboarding"}`);
    console.log(`Automatic switching: ${settings.auto ? "on" : "off"} · threshold ${settings.thresholdPercent}%`);
    if (live?.active) {
      const profile = (await listProfiles()).find((entry) => entry.id === live.active);
      console.log(`Active route: ${profile?.label || live.active}`);
    }
    return;
  }
  const settings = await setProxyMode(action === "on");
  console.log(`Proxy mode: ${settings.proxyEnabled ? "on" : "off"}. ${settings.proxyEnabled ? "New Codex processes use the daemon." : "New Codex processes connect directly."}`);
  if (!settings.proxyEnabled) console.log("The daemon was stopped to return refresh ownership to direct mode. Restart existing Proxy-mode Codex processes.");
}

async function usageCommand() {
  const { profiles, defaultId, snapshots } = await profilesWithSnapshots();
  if (!profiles.length) return console.log("No profiles yet. Run /add.");
  for (const [index, profile] of profiles.entries()) {
    const marker = profile.id === defaultId ? " [active]" : "";
    console.log(`${index + 1}. ${profile.label}${marker}`);
    const snapshot = snapshots[index];
    if (snapshot.error) {
      console.log(`  Usage unavailable: ${snapshot.error}`);
      continue;
    }
    const reset = resetCredits(snapshot.value.limits);
    console.log(`  Reset cards: ${reset.availableCount ?? "not provided"}`);
    for (const credit of reset.credits) {
      const title = credit.title || credit.resetType || "Rate-limit reset";
      const expiry = credit.expiresAt == null ? "no expiry returned" : resetText(credit.expiresAt).replace("resets", "expires");
      console.log(`  - ${title} · ${credit.status || "unknown"} · ${expiry}`);
    }
  }
}

async function deleteCommand(args, context = {}) {
  const selector = args.filter((value) => value !== "--yes").join(" ").trim();
  const confirmedByFlag = args.includes("--yes");
  const profile = await resolveUserProfile(selector);
  if (!confirmedByFlag) {
    if (!context.question) throw new Error("Run this inside masaka, or add --yes after verifying the exact profile name.");
    const answer = await context.question(`Type the exact profile name to delete:\n${profile.label}\n> `);
    if (answer !== profile.label) {
      console.log("Delete cancelled.");
      return;
    }
  }
  const moved = await runCws(["remove", profile.id]);
  const nextDefault = await removeProfile(profile.id);
  if (nextDefault) await runCws(["default", nextDefault]);
  console.log(`Deleted: ${profile.label}`);
  console.log(`Recoverable copy: ${moved.stdout.trim()}`);
}

async function doctor() {
  const checks = [];
  try {
    const script = await findCwsScript();
    const result = await runCws(["doctor"]);
    checks.push(["Native Codex launcher", `${script}\n${result.stdout.trim()}`, true]);
  } catch (error) {
    checks.push(["Native Codex launcher", formatError(error), false]);
  }
  await mkdir(cxHome(), { recursive: true, mode: 0o700 });
  await chmod(cxHome(), 0o700);
  const info = await lstat(cxHome());
  checks.push(["Profile index permissions", `${cxHome()} (${(info.mode & 0o777).toString(8)})`, (info.mode & 0o077) === 0]);
  try {
    await access(await findCwsScript());
    checks.push(["Profile isolation", "one CODEX_HOME per account + workspace", true]);
  } catch (error) {
    checks.push(["Profile isolation", formatError(error), false]);
  }
  checks.push(["Global ~/.codex/auth.json", "never replaced", true]);
  for (const [name, detail, ok] of checks) console.log(`${ok ? "OK" : "FAIL"}  ${name}: ${detail}`);
  if (checks.some((entry) => !entry[2])) process.exitCode = 1;
}

async function dispatch(rawArgs, context = {}) {
  const args = [...rawArgs];
  let command = args.shift() || "";
  if (command.startsWith("/")) command = command.slice(1);
  if (["-h", "--help", "help"].includes(command)) return console.log(help());
  if (["exit", "quit"].includes(command)) return "exit";
  if (command === "profiles") return await profilesCommand();
  if (command === "status") return await statusCommand();
  if (command === "usage") return await usageCommand();
  if (command === "auto") return await autoCommand(args);
  if (command === "order") return await orderCommand(args);
  if (command === "proxy") return await proxyCommand(args);
  if (command === "onboarding") return await onboardingCommand();
  if (command === "add") return await addCommand(args);
  if (command === "renew") return await renewCommand(args);
  if (command === "delete") return await deleteCommand(args, context);
  if (command === "use") {
    const profile = await resolveUserProfile(args.join(" "));
    const settings = await readProxySettings();
    if (settings.proxyEnabled && settings.daemonInstalled) {
      try {
        await switchProxyProfile(profile.id);
        await setDefault(profile);
        console.log(`Selected now: ${profile.label}`);
        console.log("Already-running Codex clients use this Profile on their next request; in-flight responses are unchanged.");
        return;
      } catch (error) {
        throw new Error(`Proxy route was not changed and the default was left unchanged: ${formatError(error)}`);
      }
    }
    await setDefault(profile);
    console.log(`Selected for new native Codex processes: ${profile.label}`);
    console.log("Proxy mode is off; already-running Codex processes keep their current identity.");
    return;
  }
  if (command === "shell-init") return console.log(await shellInit());
  if (command === "doctor") return await doctor();
  if (command === "version" || command === "--version" || command === "-v") return console.log(`masaka ${VERSION}`);
  if (!command) return;
  throw new Error(`Unknown command: ${command}. Run /help.`);
}

async function interactive() {
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = createInterface({ input, output, terminal });
  console.log(startupBanner(VERSION, output.columns));
  console.log();
  try {
    for (;;) {
      let line;
      try {
        line = await rl.question(terminal ? "masaka> " : "");
      } catch (error) {
        if (error?.code === "ERR_USE_AFTER_CLOSE") break;
        throw error;
      }
      if (!line.trim()) continue;
      try {
        const result = await dispatch(parseWords(line), { question: (prompt) => rl.question(prompt) });
        if (result === "exit") break;
      } catch (error) {
        console.error(`masaka: ${formatError(error)}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) return await interactive();
  return await dispatch(args);
}

main().catch((error) => {
  console.error(`masaka: ${formatError(error)}`);
  process.exitCode = 1;
});
