import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { cxHome } from "./crypto-store.mjs";

const STATE_VERSION = 2;

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

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function acquireFileLock(lock, timeoutMs, busyMessage) {
  const token = randomUUID();
  const owner = { pid: process.pid, token, createdAt: Date.now() };
  const lockDirectory = `${lock}.d`;
  const ticket = join(lockDirectory, `${String(owner.createdAt).padStart(13, "0")}-${token}.ticket`);
  const temporary = `${ticket}.tmp`;
  const deadline = Date.now() + timeoutMs;

  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await chmod(lockDirectory, 0o700);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(owner)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, ticket);

  try {
    for (;;) {
      const entries = (await readdir(lockDirectory))
        .filter((entry) => entry.endsWith(".ticket"))
        .sort();
      let firstLiveTicket;
      for (const entry of entries) {
        const candidate = join(lockDirectory, entry);
        let candidateOwner;
        try {
          candidateOwner = JSON.parse(await readFile(candidate, "utf8"));
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          // Tickets are published by atomic rename, so unreadable content is
          // never a partially written live ticket. Treat external corruption
          // as busy instead of risking removal of another process's lock.
          firstLiveTicket ??= candidate;
          continue;
        }
        if (!processIsAlive(Number(candidateOwner?.pid))) {
          try {
            // Every contender owns a unique immutable path. Removing this
            // exact dead ticket cannot delete a replacement lock.
            await unlink(candidate);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          continue;
        }
        firstLiveTicket ??= candidate;
      }
      if (firstLiveTicket === ticket) break;
      if (Date.now() >= deadline) throw new Error(busyMessage);
      await delay(50);
    }
  } catch (error) {
    try {
      await unlink(ticket);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    const current = JSON.parse(await readFile(ticket, "utf8"));
    if (current.token !== token || current.pid !== process.pid) {
      throw new Error("The local masaka lock changed owners during an update.");
    }
    await unlink(ticket);
    released = true;
  };
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
