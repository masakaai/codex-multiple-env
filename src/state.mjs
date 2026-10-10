import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { cxHome } from "./crypto-store.mjs";

const STATE_VERSION = 2;
const LOCK_HELPER = fileURLToPath(new URL("../scripts/file-lock.py", import.meta.url));

function statePath() {
  return join(cxHome(), "cx-state.json");
}

function emptyState() {
  return { version: STATE_VERSION, profiles: [], threads: {} };
}

function validateState(value) {
  if (!value || typeof value !== "object" || value.version !== STATE_VERSION || !Array.isArray(value.profiles) || !value.threads || typeof value.threads !== "object") {
    throw new Error("masaka state is invalid; restore or remove cx-state.json after backing it up.");
  }
  if (value.defaultProfileId !== undefined && typeof value.defaultProfileId !== "string") throw new Error("masaka state has an invalid default profile.");
  for (const profile of value.profiles) {
    if (!profile || typeof profile !== "object" || typeof profile.id !== "string" || typeof profile.label !== "string") {
      throw new Error("masaka state has an invalid profile.");
    }
  }
  return value;
}

function migrateState(value) {
  if (value?.version === 1 && value.threads && typeof value.threads === "object") {
    // v1 profile ids belonged to the removed third-party SIWC store. They
    // cannot safely identify an official Codex login, so do not carry its
    // default selection or thread ids into the new authentication model.
    return emptyState();
  }
  return validateState(value);
}

async function readStateUnlocked() {
  try {
    return migrateState(JSON.parse(await readFile(statePath(), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeStateUnlocked(value) {
  validateState(value);
  const path = statePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function acquireFileLock(lock, timeoutMs, busyMessage) {
  const python = process.env.MASAKA_PYTHON || "python3";
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(python, [LOCK_HELPER, lock, String(timeoutMs)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let ready = false;
    let released = false;
    let stdout = "";
    let stderr = "";
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.stdin.on("error", () => { /* exit handling below reports helper failures */ });
    child.once("error", (error) => {
      resolveExit({ error });
      if (!ready) reject(new Error(`Cannot start the local lock helper: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal });
      if (ready) return;
      if (code === 75) reject(new Error(busyMessage));
      else reject(new Error(stderr.trim() || `The local lock helper exited (${signal || code}).`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (ready) return;
      stdout += chunk;
      if (!stdout.includes("\n")) return;
      if (stdout.trim() !== "ready") {
        reject(new Error("The local lock helper returned an invalid handshake."));
        child.kill("SIGTERM");
        return;
      }
      ready = true;
      resolvePromise(async () => {
        if (released) return;
        released = true;
        child.stdin.end();
        const result = await exited;
        if (result.error) throw result.error;
        if (result.code !== 0) {
          throw new Error(stderr.trim() || `The local lock helper exited (${result.signal || result.code}).`);
        }
      });
    });
  });
}

export async function withCxLock(name, operation) {
  if (!/^[a-z-]{1,40}$/.test(name)) throw new Error("Invalid cx lock name.");
  const root = cxHome();
  const lock = join(root, `.cx-${name}.lock`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const release = await acquireFileLock(
    lock,
    10_000,
    "Another masaka process is updating local state or credentials; try again.",
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function withStateLock(operation) {
  return await withCxLock("state", operation);
}

export async function readState() {
  return await readStateUnlocked();
}

export async function listProfiles() {
  return (await readStateUnlocked()).profiles;
}

export async function saveProfile(profile) {
  await withStateLock(async () => {
    const state = await readStateUnlocked();
    const index = state.profiles.findIndex((entry) => entry.id === profile.id);
    if (index === -1) state.profiles.push(profile);
    else state.profiles[index] = profile;
    await writeStateUnlocked(state);
  });
}

export async function setDefaultProfile(profileId) {
  await withStateLock(async () => {
    const state = await readStateUnlocked();
    state.defaultProfileId = profileId;
    await writeStateUnlocked(state);
  });
}

export async function getDefaultProfile() {
  return (await readStateUnlocked()).defaultProfileId;
}

export async function removeProfile(profileId) {
  return await withStateLock(async () => {
    const state = await readStateUnlocked();
    const before = state.profiles.length;
    state.profiles = state.profiles.filter((profile) => profile.id !== profileId);
    if (state.profiles.length === before) throw new Error("Profile was not found in masaka state.");
    delete state.threads[profileId];
    if (state.defaultProfileId === profileId) {
      if (state.profiles.length) state.defaultProfileId = state.profiles[0].id;
      else delete state.defaultProfileId;
    }
    await writeStateUnlocked(state);
    return state.defaultProfileId;
  });
}

export async function getThread(profileId, cwd) {
  const state = await readStateUnlocked();
  return state.threads[profileId]?.[resolve(cwd)];
}

export async function setThread(profileId, cwd, threadId) {
  await withStateLock(async () => {
    const state = await readStateUnlocked();
    state.threads[profileId] ??= {};
    state.threads[profileId][resolve(cwd)] = threadId;
    await writeStateUnlocked(state);
  });
}

export async function clearThread(profileId, cwd) {
  await withStateLock(async () => {
    const state = await readStateUnlocked();
    if (state.threads[profileId]) delete state.threads[profileId][resolve(cwd)];
    await writeStateUnlocked(state);
  });
}

export async function prepareProfileCodexHome(profileId, source = process.env) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(profileId)) throw new Error("Invalid profile id.");
  const configuredCxHome = source.CX_HOME || cxHome();
  const cwsRoot = source.MASAKA_CWS_HOME
    || source.CWS_HOME
    || (source.CX_HOME ? join(configuredCxHome, "cws") : join(homedir(), ".codex-workspaces"));
  const profileHome = join(resolve(cwsRoot), "profiles", profileId);
  try {
    if ((await lstat(profileHome)).isSymbolicLink()) {
      throw new Error(`Profile directory must not be a symlink: ${profileHome}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(profileHome, { recursive: true, mode: 0o700 });
  await chmod(profileHome, 0o700);
  return profileHome;
}

export async function acquireProfileLease(profileId, action = "use") {
  const profileHome = await prepareProfileCodexHome(profileId);
  const lock = join(profileHome, ".cx-session.lock");
  const release = await acquireFileLock(
    lock,
    0,
    `Cannot ${action} this profile while it is active in another masaka process.`,
  );
  return {
    profileId,
    release,
  };
}
