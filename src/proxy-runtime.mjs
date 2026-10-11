import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { promisify } from "node:util";
import { cxHome } from "./crypto-store.mjs";
import { cwsHome, prepareCwsProfiles } from "./cws-adapter.mjs";
import { listProfiles, prepareProfileCodexHome, withCxLock } from "./state.mjs";

const execFileAsync = promisify(execFile);
export const PROXY_RUNTIME_VERSION = "0.2.15";
export const PROXY_RUNTIME_SOURCE = `https://github.com/moonsunkim/codexmulti/archive/refs/tags/v${PROXY_RUNTIME_VERSION}.tar.gz`;
export const PROXY_RUNTIME_SHA256 = "f5c81af791ec06dfd1cb57c69544785442cac0514e4ff02df17f1fba35d68c94";
export const PROXY_LAUNCH_LABEL = "ai.masaka.codex-proxy";
const RUNTIME_SAFETY_PATCH = "masaka-single-refresh-owner-v1";

function rootPath(options = {}) {
  return resolve(options.root || options.env?.CX_HOME || cxHome());
}

export function proxyPaths(options = {}) {
  const root = rootPath(options);
  const proxy = join(root, "proxy");
  return {
    root,
    proxy,
    settings: join(proxy, "settings.json"),
    config: join(proxy, "proxy.json"),
    state: join(proxy, "proxy-state.json"),
    log: join(proxy, "proxy.log"),
    stdout: join(proxy, "daemon.stdout.log"),
    stderr: join(proxy, "daemon.stderr.log"),
    runtime: join(proxy, "runtime", `codexmulti-${PROXY_RUNTIME_VERSION}`),
  };
}

export function defaultProxySettings() {
  return {
    version: 1,
    proxyEnabled: false,
    daemonInstalled: false,
    auto: true,
    thresholdPercent: 5,
    pollSeconds: 60,
    orderMode: "automatic",
    order: [],
    port: 8787,
  };
}

function validateSettings(value) {
  const { tiers: _removedTierOverrides, ...source } = value && typeof value === "object" ? value : {};
  const settings = { ...defaultProxySettings(), ...source };
  if (settings.version !== 1
      || typeof settings.proxyEnabled !== "boolean"
      || typeof settings.daemonInstalled !== "boolean"
      || typeof settings.auto !== "boolean"
      || !Number.isFinite(settings.thresholdPercent) || settings.thresholdPercent < 0 || settings.thresholdPercent > 100
      || !Number.isSafeInteger(settings.pollSeconds) || settings.pollSeconds < 15 || settings.pollSeconds > 3600
      || !["automatic", "manual"].includes(settings.orderMode)
      || !Array.isArray(settings.order)
      || !Number.isSafeInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    throw new Error("Masaka proxy settings are invalid.");
  }
  return settings;
}

async function atomicWrite(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, mode);
}

async function atomicJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readProxySettings(options = {}) {
  try {
    return validateSettings(JSON.parse(await readFile(proxyPaths(options).settings, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return defaultProxySettings();
    throw error;
  }
}

export async function updateProxySettings(update, options = {}) {
  const operation = async () => {
    const current = await readProxySettings(options);
    const next = validateSettings(typeof update === "function" ? await update(structuredClone(current)) : { ...current, ...update });
    await atomicJson(proxyPaths(options).settings, next);
    return next;
  };
  return options.root ? await operation() : await withCxLock("proxy", operation);
}

export function proxyBaseUrl(settings) {
  return `http://127.0.0.1:${settings.port}/backend-api/codex`;
}

export async function setProxyRouting(enabled, settings, options = {}) {
  const routing = {
    version: 1,
    enabled: Boolean(enabled),
    baseUrl: proxyBaseUrl(settings),
  };
  const path = join(cwsHome(options.env || process.env), "masaka-proxy-routing.json");
  await atomicJson(path, routing);
  return path;
}

export async function runtimeInstalled(options = {}) {
  try {
    const info = await lstat(join(proxyPaths(options).runtime, "src", "cli.mjs"));
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function responseBuffer(response, maximumBytes = 20 * 1024 * 1024) {
  if (!response.ok) throw new Error(`Proxy runtime download failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Proxy runtime archive is unexpectedly large.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new Error("Proxy runtime archive is unexpectedly large.");
  return bytes;
}

export async function installProxyRuntime(options = {}) {
  const paths = proxyPaths(options);
  if (await runtimeInstalled(options)) {
    await applyRuntimeSafetyPatch(paths.runtime);
    return paths.runtime;
  }
  await mkdir(join(paths.proxy, "runtime"), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(paths.proxy, "runtime", ".install-"));
  try {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("Node.js fetch is unavailable.");
    const archive = await responseBuffer(await fetchImpl(PROXY_RUNTIME_SOURCE, { redirect: "follow" }));
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== PROXY_RUNTIME_SHA256) throw new Error("Proxy runtime checksum mismatch; installation stopped.");
    const archivePath = join(temporary, "runtime.tar.gz");
    const staging = join(temporary, "unpacked");
    await writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
    await mkdir(staging, { mode: 0o700 });
    await execFileAsync("tar", [
      "-xzf", archivePath,
      "-C", staging,
      "--strip-components", "2",
      `codexmulti-${PROXY_RUNTIME_VERSION}/proxy`,
    ]);
    const entry = join(staging, "src", "cli.mjs");
    const info = await lstat(entry);
    if (!info.isFile()) throw new Error("Proxy runtime archive is incomplete.");
    await rename(staging, paths.runtime);
    await applyRuntimeSafetyPatch(paths.runtime);
    return paths.runtime;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function applyRuntimeSafetyPatch(runtime) {
  const path = join(runtime, "src", "server.mjs");
  let source = await readFile(path, "utf8");
  if (source.includes(RUNTIME_SAFETY_PATCH)) return;
  const reloadNeedle = `      try {
        if (options.beforeReloadCommit) await options.beforeReloadCommit();`;
  const reloadReplacement = `      try {
        // ${RUNTIME_SAFETY_PATCH}: fence background/control refresh before
        // replacing the registry, then reread credentials after the fence.
        await renewalMutex.run(async () => {});
        await candidateRegistry.initialize();
        if (options.beforeReloadCommit) await options.beforeReloadCommit();`;
  const refreshNeedle = "          const credentials = await registry.forceRefresh(name);";
  const refreshReplacement = `          const credentials = await renewalMutex.run(async () => {
            if (reconfiguring || generation !== current) throw new Error('proxy_reconfiguring');
            return await registry.forceRefresh(name);
          });`;
  if (!source.includes(reloadNeedle) || !source.includes(refreshNeedle)) {
    throw new Error("Pinned Proxy runtime no longer matches Masaka's refresh-safety patch.");
  }
  source = source.replace(reloadNeedle, reloadReplacement).replace(refreshNeedle, refreshReplacement);
  await atomicWrite(path, source, 0o600);
}

export async function buildProxyConfig(profiles, orderedIds, settings, options = {}) {
  const paths = proxyPaths(options);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const ordered = [...orderedIds.map((id) => byId.get(id)).filter(Boolean)];
  for (const profile of profiles) if (!ordered.includes(profile)) ordered.push(profile);
  await prepareCwsProfiles(ordered, { env: options.env });
  const accounts = [];
  for (const profile of ordered) {
    const home = await prepareProfileCodexHome(profile.id, options.env || process.env);
    accounts.push({
      name: profile.id,
      label: profile.label,
      auth_file: join(home, "auth.json"),
      auto_select_enabled: settings.auto,
    });
  }
  return {
    listen_host: "127.0.0.1",
    port: settings.port,
    mode: "failover",
    accounts,
    state_file: paths.state,
    log_file: paths.log,
    upstream_chatgpt_base_url: "https://chatgpt.com/backend-api/",
    upstream_openai_base_url: "https://chatgpt.com/backend-api/codex",
    request_body_limit_bytes: 67_108_864,
    token_refresh_skew_seconds: 172_800,
    default_cooldown_seconds: 1800,
    cooldown_safety_margin_seconds: 60,
    allow_insecure_upstream: false,
  };
}

export async function writeProxyConfig(profiles, orderedIds, settings, options = {}) {
  if (!profiles.length) throw new Error("Add at least one Profile before installing Proxy mode.");
  const config = await buildProxyConfig(profiles, orderedIds, settings, options);
  await atomicJson(proxyPaths(options).config, config);
  return config;
}

async function writeProxyConfigIfChanged(profiles, orderedIds, settings, options = {}) {
  if (!profiles.length) throw new Error("Add at least one Profile before installing Proxy mode.");
  const config = await buildProxyConfig(profiles, orderedIds, settings, options);
  let previous;
  try {
    previous = JSON.parse(await readFile(proxyPaths(options).config, "utf8"));
    if (JSON.stringify(previous) === JSON.stringify(config)) return { config, changed: false, previous };
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  await atomicJson(proxyPaths(options).config, config);
  return { config, changed: true, previous };
}

async function readControlToken(configPath) {
  const path = `${configPath}.control-token`;
  const info = await lstat(path);
  const wrongOwner = typeof process.getuid === "function" && info.uid !== process.getuid();
  if (!info.isFile() || info.isSymbolicLink() || wrongOwner || (info.mode & 0o077) !== 0 || info.size !== 64) {
    throw new Error("Proxy control token has unsafe permissions.");
  }
  const token = await readFile(path, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Proxy control token is invalid.");
  return token;
}

export async function proxyControl(method, requestPath, body, options = {}) {
  const paths = proxyPaths(options);
  const settings = await readProxySettings(options);
  const token = await readControlToken(paths.config);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return await new Promise((resolvePromise, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: settings.port,
      method,
      path: requestPath,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
      },
    }, async (response) => {
      const chunks = [];
      let length = 0;
      try {
        for await (const chunk of response) {
          length += chunk.length;
          if (length > 2 * 1024 * 1024) throw new Error("Proxy control response is too large.");
          chunks.push(chunk);
        }
        const text = Buffer.concat(chunks, length).toString("utf8");
        const result = text ? JSON.parse(text) : {};
        if ((response.statusCode || 500) >= 400) {
          const error = new Error(result.error || `Proxy control request failed (${response.statusCode}).`);
          error.statusCode = response.statusCode;
          error.result = result;
          throw error;
        }
        resolvePromise(result);
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
    request.setTimeout(options.timeoutMs || 3_000, () => request.destroy(new Error("Masaka Proxy is not running.")));
    request.end(payload);
  });
}

export async function proxyStatus(options = {}) {
  return await proxyControl("GET", "/_proxy/status", undefined, options);
}

export async function switchProxyProfile(profileId, options = {}) {
  return await proxyControl("POST", "/_proxy/switch", { name: profileId }, options);
}

export async function refreshProxyProfile(profileId, options = {}) {
  return await proxyControl("POST", `/_proxy/accounts/${encodeURIComponent(profileId)}/refresh`, {}, options);
}

export async function pauseProxyProfile(profileId, options = {}) {
  return await proxyControl("POST", `/_proxy/accounts/${encodeURIComponent(profileId)}/pause`, {}, options);
}

export async function resumeProxyProfile(profileId, options = {}) {
  return await proxyControl("POST", `/_proxy/accounts/${encodeURIComponent(profileId)}/resume`, {}, options);
}

export async function reloadProxyProfile(profileId, options = {}) {
  return await proxyControl("POST", `/_proxy/accounts/${encodeURIComponent(profileId)}/reload`, {}, options);
}

export async function setProxyAccountAutoSelect(profileId, enabled, options = {}) {
  return await proxyControl("POST", `/_proxy/accounts/${encodeURIComponent(profileId)}/auto-select`, { enabled: Boolean(enabled) }, options);
}

export async function setLiveProxyAutoSelect(enabled, options = {}) {
  const status = await proxyStatus(options);
  if (!enabled && status.active) await switchProxyProfile(status.active, options);
  await Promise.all(status.accounts.map((account) => setProxyAccountAutoSelect(account.name, enabled, options)));
  return await proxyStatus(options);
}

export async function waitForProxyProfileDrain(profileId, options = {}) {
  const deadline = Date.now() + (options.waitMs || 60_000);
  while (Date.now() < deadline) {
    const status = await proxyStatus(options);
    const account = status.accounts.find((entry) => entry.name === profileId);
    if (!account) throw new Error("Profile is not loaded by Masaka Proxy.");
    if (account.in_flight === 0) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Timed out waiting for this Profile's proxy requests to finish.");
}

export async function reloadProxyConfig(options = {}) {
  return await proxyControl("POST", "/_proxy/reload-config", {}, options);
}

export async function syncProxyConfig(orderedIds, options = {}) {
  const [profiles, settings] = await Promise.all([listProfiles(), readProxySettings(options)]);
  const { changed, previous } = await writeProxyConfigIfChanged(profiles, orderedIds, settings, options);
  if (!changed) return true;
  try {
    await reloadProxyConfig(options);
    return true;
  } catch (error) {
    if (error.statusCode === 409 || error.statusCode === 503) {
      // A rejected reload did not update the live registry. Restore the last
      // applied file so a later policy cycle sees a diff and retries instead
      // of mistaking an unapplied disk config for live state.
      if (previous) await atomicJson(proxyPaths(options).config, previous);
      return false;
    }
    if (/not running|ECONNREFUSED|ENOENT/i.test(error.message)) return false;
    throw error;
  }
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function launchAgentDocument(options = {}) {
  const paths = proxyPaths(options);
  const daemon = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
  const environment = {
    CX_HOME: paths.root,
    MASAKA_CWS_HOME: cwsHome(options.env || process.env),
    PATH: options.env?.PATH || process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ...(process.env.CX_CODEX_BIN ? { CX_CODEX_BIN: process.env.CX_CODEX_BIN } : {}),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PROXY_LAUNCH_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(daemon)}</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(paths.stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.stderr)}</string>
</dict></plist>
`;
}

export async function installLaunchAgent(options = {}) {
  if (process.platform !== "darwin") throw new Error("Automatic daemon installation currently requires macOS.");
  const paths = proxyPaths(options);
  await mkdir(paths.proxy, { recursive: true, mode: 0o700 });
  const agent = options.agentPath || join(homedir(), "Library", "LaunchAgents", `${PROXY_LAUNCH_LABEL}.plist`);
  await atomicWrite(agent, launchAgentDocument(options), 0o644);
  const domain = `gui/${process.getuid()}`;
  let loaded = false;
  try {
    await execFileAsync("launchctl", ["print", `${domain}/${PROXY_LAUNCH_LABEL}`]);
    loaded = true;
  } catch {
    // The service was not loaded yet.
  }
  if (!loaded) await execFileAsync("launchctl", ["bootstrap", domain, agent]);
  await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/${PROXY_LAUNCH_LABEL}`]);
  return agent;
}

export async function stopLaunchAgent(options = {}) {
  if (process.platform !== "darwin") throw new Error("Automatic daemon control currently requires macOS.");
  const domain = `gui/${process.getuid()}`;
  try {
    await execFileAsync("launchctl", ["print", `${domain}/${PROXY_LAUNCH_LABEL}`]);
  } catch {
    return false;
  }
  await execFileAsync("launchctl", ["bootout", `${domain}/${PROXY_LAUNCH_LABEL}`]);
  return true;
}

export async function waitForProxy(options = {}) {
  const deadline = Date.now() + (options.waitMs || 15_000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await proxyStatus({ ...options, timeoutMs: 1_000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
  throw new Error(`Masaka Proxy did not become ready: ${lastError?.message || "timeout"}`);
}

export async function onboardingProxy(orderedIds, options = {}) {
  const previous = await readProxySettings(options);
  let previousRunning = false;
  try {
    await proxyStatus(options);
    previousRunning = true;
  } catch { /* first install or an offline prior installation */ }
  await installProxyRuntime(options);
  const profiles = await listProfiles();
  await writeProxyConfig(profiles, orderedIds, previous, options);
  try {
    await installLaunchAgent(options);
    const status = await waitForProxy(options);
    const settings = await updateProxySettings((current) => ({
      ...current,
      proxyEnabled: true,
      daemonInstalled: true,
      auto: current.auto ?? true,
    }), options);
    await setProxyRouting(true, settings, options);
    return { settings, status };
  } catch (error) {
    await updateProxySettings(() => previous, options).catch(() => {});
    await setProxyRouting(previous.proxyEnabled, previous, options).catch(() => {});
    if (!previousRunning) await stopLaunchAgent(options).catch(() => {});
    throw error;
  }
}

export async function setProxyMode(enabled, options = {}) {
  if (enabled && !(await runtimeInstalled(options))) throw new Error("Proxy is not installed. Run /onboarding first.");
  const previous = await readProxySettings(options);
  let changedDaemon = false;
  try {
    if (enabled) {
      let running = false;
      try { await proxyStatus(options); running = true; } catch { /* start below */ }
      if (!running) {
        await installLaunchAgent(options);
        changedDaemon = true;
      }
      await waitForProxy(options);
    } else {
      let status;
      try { status = await proxyStatus(options); } catch { /* already stopped */ }
      if (status?.in_flight > 0) throw new Error("Proxy has an in-flight response; retry /proxy off after it finishes.");
      changedDaemon = await stopLaunchAgent(options);
    }
    const settings = await updateProxySettings({ proxyEnabled: Boolean(enabled) }, options);
    await setProxyRouting(enabled, settings, options);
    return settings;
  } catch (error) {
    await updateProxySettings(() => previous, options).catch(() => {});
    await setProxyRouting(previous.proxyEnabled, previous, options).catch(() => {});
    if (changedDaemon) {
      if (previous.proxyEnabled) await installLaunchAgent(options).catch(() => {});
      else await stopLaunchAgent(options).catch(() => {});
    }
    throw error;
  }
}
