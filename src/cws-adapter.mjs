import { execFile, spawn } from "node:child_process";
import { access, chmod, lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cxHome } from "./crypto-store.mjs";
import { prepareProfileCodexHome } from "./state.mjs";

const execFileAsync = promisify(execFile);
const CWS_METADATA = ".cws-profile.json";

export function cwsHome(source = process.env) {
  if (source.MASAKA_CWS_HOME) return resolve(source.MASAKA_CWS_HOME);
  if (source.CWS_HOME) return resolve(source.CWS_HOME);
  // Tests and explicit alternate installations already use CX_HOME as their
  // isolation boundary. Normal installations use the CWS default location.
  if (source.CX_HOME) return join(resolve(source.CX_HOME), "cws");
  return join(homedir(), ".codex-workspaces");
}

export async function findCwsScript(source = process.env) {
  if (source.MASAKA_CWS_SCRIPT) {
    const configured = resolve(source.MASAKA_CWS_SCRIPT);
    await access(configured);
    return configured;
  }

  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cws.py");
  try {
    await access(bundled);
    return bundled;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const versionsRoot = join(
    homedir(),
    ".codex",
    "plugins",
    "cache",
    "personal",
    "codex-workspace-switcher",
  );
  let entries;
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Codex workspace-switcher plugin is not installed; reinstall it before using masaka.");
    }
    throw error;
  }
  const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const version of versions) {
    const candidate = join(versionsRoot, version, "scripts", "cws.py");
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("The workspace-switcher plugin does not contain scripts/cws.py.");
}

function accountLabel(profile) {
  if (profile.name && profile.email && profile.name.toLocaleLowerCase() !== profile.email.toLocaleLowerCase()) {
    return `${profile.name} (${profile.email})`;
  }
  return profile.name || profile.email || "ChatGPT account";
}

function cwsMetadata(profile) {
  return {
    format_version: 1,
    name: profile.id,
    account_label: accountLabel(profile),
    workspace_label: profile.workspaceLabel || profile.planType || "ChatGPT",
    workspace_id: profile.workspaceId || null,
  };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function atomicText(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function ensureFileCredentialStore(home) {
  const path = join(home, "config.toml");
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const withoutSetting = content
    .split(/\r?\n/)
    .filter((line) => !/^\s*cli_auth_credentials_store\s*=/.test(line))
    .join("\n")
    .replace(/^\n+/, "");
  const wanted = `cli_auth_credentials_store = "file"\n${withoutSetting}`;
  if (content !== wanted) await atomicText(path, wanted);
}

async function assertCredentialIsolation(home, source = process.env, allowMissing = false) {
  const profileAuth = join(home, "auth.json");
  let profileInfo;
  try {
    profileInfo = await lstat(profileAuth);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw error;
  }
  if (!profileInfo.isFile() || profileInfo.isSymbolicLink()) {
    throw new Error(`Profile credential must be a regular file: ${profileAuth}`);
  }
  if (profileInfo.nlink !== 1) {
    throw new Error(`Profile credential must not be hard-linked: ${profileAuth}`);
  }
  const globalAuth = join(source.MASAKA_BASE_CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  try {
    const globalInfo = await lstat(globalAuth);
    if (globalInfo.dev === profileInfo.dev && globalInfo.ino === profileInfo.ino) {
      throw new Error(`Profile credential aliases the global Codex credential: ${profileAuth}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Add only CWS's non-secret metadata beside Codex-owned credential files. */
export async function prepareCwsProfiles(profiles, options = {}) {
  const source = options.env || process.env;
  for (const profile of profiles) {
    const home = await prepareProfileCodexHome(profile.id, source);
    await assertCredentialIsolation(home, source, options.allowMissingCredential === true);
    await ensureFileCredentialStore(home);
    const metadataPath = join(home, CWS_METADATA);
    let current;
    try {
      current = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const wanted = cwsMetadata(profile);
    if (JSON.stringify(current) !== JSON.stringify(wanted)) await atomicJson(metadataPath, wanted);
  }
}

export function cwsEnvironment(source = process.env) {
  const environment = {
    ...source,
    CWS_HOME: cwsHome(source),
    CWS_BASE_CODEX_HOME: source.MASAKA_BASE_CODEX_HOME || join(homedir(), ".codex"),
    CWS_QUIET: "1",
  };
  if (source.CX_CODEX_BIN) environment.CWS_CODEX_BIN = source.CX_CODEX_BIN;
  delete environment.CODEX_ACCESS_TOKEN;
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  delete environment.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
  delete environment.CODEX_REVOKE_TOKEN_URL_OVERRIDE;
  delete environment.CODEX_AUTHAPI_BASE_URL;
  delete environment.CODEX_APP_SERVER_LOGIN_CLIENT_ID;
  return environment;
}

export async function runCws(arguments_, options = {}) {
  const source = options.env || process.env;
  const script = await findCwsScript(source);
  const python = options.python || source.MASAKA_PYTHON || "python3";
  return await execFileAsync(python, [script, ...arguments_], {
    env: cwsEnvironment(source),
    maxBuffer: 1024 * 1024,
  });
}

export async function runCwsInteractive(arguments_, options = {}) {
  const source = options.env || process.env;
  const script = await findCwsScript(source);
  const python = options.python || source.MASAKA_PYTHON || "python3";
  await new Promise((resolvePromise, reject) => {
    const child = spawn(python, [script, ...arguments_], {
      env: cwsEnvironment(source),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Workspace launcher failed (${signal || code}).`));
    });
  });
}

export async function execCws(arguments_, options = {}) {
  const source = options.env || process.env;
  const script = await findCwsScript(source);
  const environment = cwsEnvironment(source);
  const python = options.python || source.MASAKA_PYTHON || "python3";
  // /usr/bin/env resolves python3, then CWS execs the real Codex binary. Both
  // are execs, so no masaka/Node process remains behind the native Codex CLI.
  process.execve("/usr/bin/env", ["env", python, script, ...arguments_], environment);
}

export async function shellInit() {
  const result = await runCws(["shell-init"]);
  return result.stdout.trim();
}

export async function createCwsProfile(profileId) {
  await runCws(["add", profileId]);
  return await prepareProfileCodexHome(profileId);
}

export async function finalizeCwsProfile(profile) {
  await prepareCwsProfiles([profile]);
  // Ask CWS to validate and retain the pinned workspace metadata.
  await runCws([
    "add",
    profile.id,
    "--workspace-id",
    profile.workspaceId,
    "--account",
    accountLabel(profile),
    "--workspace",
    profile.workspaceLabel || profile.planType || "ChatGPT",
  ]);
}

export function stateHome() {
  return cxHome();
}
