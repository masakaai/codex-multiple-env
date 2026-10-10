import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cxHome } from "./crypto-store.mjs";
import {
  getDefaultProfile,
  acquireProfileLease,
  listProfiles,
  prepareProfileCodexHome,
  saveProfile,
  setDefaultProfile,
  withCxLock,
} from "./state.mjs";

const MAX_PROFILE_LABEL_LENGTH = 140;

function cleanLabelPart(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() : "";
}

export function planDisplayName(planType) {
  const value = cleanLabelPart(planType).toLocaleLowerCase();
  if (!value) return "ChatGPT";
  if (value.includes("enterprise") || value.includes("ent26")) return "Enterprise";
  if (value === "team") return "Team";
  if (value.includes("business")) return "Business";
  if (value.includes("pro")) return "Pro";
  if (value.includes("plus")) return "Plus";
  if (value.includes("free")) return "Free";
  return planType;
}

export function workspaceDisplayName(identity) {
  const workspace = cleanLabelPart(identity?.workspaceLabel);
  const rawPlan = cleanLabelPart(identity?.planType);
  const plan = rawPlan ? planDisplayName(rawPlan) : "";
  if (workspace && plan && workspace.toLocaleLowerCase() !== plan.toLocaleLowerCase()) return `${workspace} (${plan})`;
  return workspace || plan || "ChatGPT";
}

export function automaticProfileLabel(identity, usedLabels = []) {
  const name = cleanLabelPart(identity?.name);
  const email = cleanLabelPart(identity?.email);
  const workspace = workspaceDisplayName(identity);
  const account = name && email && name.toLocaleLowerCase() !== email.toLocaleLowerCase()
    ? `${name} (${email})`
    : name || email || "ChatGPT account";
  const requested = `${account} · ${workspace}`.slice(0, MAX_PROFILE_LABEL_LENGTH).trim();
  const used = new Set(usedLabels);
  if (!used.has(requested)) return requested;
  for (let number = 2; ; number += 1) {
    const suffix = ` (${number})`;
    const candidate = `${requested.slice(0, MAX_PROFILE_LABEL_LENGTH - suffix.length).trim()}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("The official Codex ID token is not a JWT.");
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") throw new Error("unexpected payload");
    return payload;
  } catch (error) {
    throw new Error(`Could not read safe account metadata from the official Codex login: ${error.message}`);
  }
}

export async function readOfficialCodexIdentity(codexHome) {
  const path = join(codexHome, "auth.json");
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("The official Codex auth.json must be a regular file.");
  const auth = JSON.parse(await readFile(path, "utf8"));
  const tokens = auth?.tokens;
  if (!tokens || typeof tokens.id_token !== "string") {
    throw new Error("The official Codex login did not produce a ChatGPT ID token.");
  }
  const payload = decodeJwtPayload(tokens.id_token);
  const claims = payload["https://api.openai.com/auth"] || {};
  const organizations = Array.isArray(claims.organizations) ? claims.organizations.filter((entry) => entry && typeof entry === "object") : [];
  let organizationId = "";
  if (typeof tokens.access_token === "string") {
    try {
      const accessPayload = decodeJwtPayload(tokens.access_token);
      organizationId = cleanLabelPart(accessPayload["https://api.openai.com/auth"]?.poid);
    } catch {
      // An opaque access token is valid; the ID token still provides a safe
      // fallback workspace list and all required account metadata.
    }
  }
  const namedWorkspace = organizations.find((entry) => entry.id === organizationId && entry.title)
    || (organizations.length === 1 ? organizations[0] : undefined);
  const identity = {
    name: cleanLabelPart(payload.name),
    email: cleanLabelPart(payload.email),
    planType: cleanLabelPart(claims.chatgpt_plan_type),
    workspaceId: cleanLabelPart(claims.chatgpt_account_id || tokens.account_id),
    workspaceLabel: cleanLabelPart(namedWorkspace?.title),
  };
  const accountUserId = cleanLabelPart(payload.sub);
  if (accountUserId) identity.accountUserId = accountUserId;
  if (organizationId) identity.workspaceOrganizationId = organizationId;
  return identity;
}

export function officialCodexEnvironment(codexHome, source = process.env) {
  const env = { ...source, CODEX_HOME: codexHome };
  delete env.CODEX_ACCESS_TOKEN;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
  delete env.CODEX_REVOKE_TOKEN_URL_OVERRIDE;
  delete env.CODEX_AUTHAPI_BASE_URL;
  delete env.CODEX_APP_SERVER_LOGIN_CLIENT_ID;
  return env;
}

export function officialCodexConfigArgs(workspaceId) {
  const args = [
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'forced_login_method="chatgpt"',
  ];
  if (workspaceId) args.push("-c", `forced_chatgpt_workspace_id=${JSON.stringify(workspaceId)}`);
  return args;
}

export async function runOfficialCodexLogin({
  codexHome,
  workspaceId,
  deviceAuth = false,
  codexBin = process.env.CX_CODEX_BIN || "codex",
} = {}) {
  const args = [...officialCodexConfigArgs(workspaceId), "login"];
  if (deviceAuth) args.push("--device-auth");
  process.stderr.write(`[masaka] Starting official Codex login: codex login${deviceAuth ? " --device-auth" : ""}\n`);
  await new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      env: officialCodexEnvironment(codexHome),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Official codex login failed (${signal || code}).`));
    });
  });
}

export async function resolveProfile(selector) {
  const profiles = await listProfiles();
  if (!selector) return undefined;
  const exactId = profiles.find((profile) => profile.id === selector);
  if (exactId) return exactId;
  const exactLabels = profiles.filter((profile) => profile.label === selector);
  if (exactLabels.length === 1) return exactLabels[0];
  if (exactLabels.length > 1) throw new Error(`Profile selector is ambiguous: ${selector}`);
  const folded = profiles.filter((profile) => profile.label.toLocaleLowerCase() === selector.toLocaleLowerCase());
  if (folded.length === 1) return folded[0];
  if (folded.length > 1) throw new Error(`Profile selector is ambiguous: ${selector}`);
  throw new Error(`Profile not found: ${selector}`);
}

function explicitLabel(value) {
  const label = cleanLabelPart(value);
  if (!label) return undefined;
  if (label.length > MAX_PROFILE_LABEL_LENGTH) throw new Error(`Profile names must be at most ${MAX_PROFILE_LABEL_LENGTH} characters.`);
  return label;
}

export async function addProfile(label, options = {}) {
  return await withCxLock("auth", async () => {
    const requestedLabel = explicitLabel(label);
    const profiles = await listProfiles();
    if (requestedLabel && profiles.some((entry) => entry.label.toLocaleLowerCase() === requestedLabel.toLocaleLowerCase())) {
      throw new Error(`A profile named ${requestedLabel} already exists.`);
    }
    const id = randomUUID();
    const codexHome = options.prepare
      ? await options.prepare({ id })
      : await prepareProfileCodexHome(id);
    try {
      const login = options.login || runOfficialCodexLogin;
      const inspect = options.inspect || readOfficialCodexIdentity;
      await login({ codexHome, deviceAuth: options.deviceAuth, codexBin: options.codexBin });
      const identity = await inspect(codexHome);
      if (!identity.email && !identity.name) throw new Error("Codex login succeeded, but no account name or email was available.");
      if (!identity.workspaceId) throw new Error("Codex login succeeded, but no ChatGPT workspace identifier was available.");
      const profile = {
        id,
        label: requestedLabel || automaticProfileLabel(identity, profiles.map((entry) => entry.label)),
        labelSource: requestedLabel ? "custom" : "automatic",
        ...identity,
        createdAt: new Date().toISOString(),
      };
      if (options.finalize) await options.finalize({ profile, codexHome });
      await saveProfile(profile);
      await setDefaultProfile(profile.id);
      return profile;
    } catch (error) {
      if (options.cleanup) await options.cleanup({ id, codexHome });
      throw error;
    }
  });
}

export async function reauthorizeProfile(selector, options = {}) {
  const profile = await resolveProfile(selector);
  return await withCxLock("auth", async () => {
    const lease = await acquireProfileLease(profile.id, "reauthenticate");
    const codexHome = await prepareProfileCodexHome(profile.id);
    const login = options.login || runOfficialCodexLogin;
    const inspect = options.inspect || readOfficialCodexIdentity;
    try {
      await login({
        codexHome,
        workspaceId: profile.workspaceId,
        deviceAuth: options.deviceAuth,
        codexBin: options.codexBin,
      });
      const identity = await inspect(codexHome);
      const profiles = await listProfiles();
      const automatic = profile.labelSource !== "custom";
      const updated = {
        ...profile,
        ...identity,
        label: automatic
          ? automaticProfileLabel(identity, profiles.filter((entry) => entry.id !== profile.id).map((entry) => entry.label))
          : profile.label,
        labelSource: automatic ? "automatic" : "custom",
        updatedAt: new Date().toISOString(),
      };
      await saveProfile(updated);
      await setDefaultProfile(updated.id);
      return updated;
    } finally {
      await lease.release();
    }
  });
}

export async function selectProfile(selector) {
  const profile = await resolveProfile(selector);
  await setDefaultProfile(profile.id);
  return profile;
}

export function profileSummary(profile, defaultId) {
  const flags = profile.id === defaultId ? " [default]" : "";
  const identity = profile.email || profile.name || "unknown account";
  const workspace = workspaceDisplayName(profile);
  return `${profile.label}${flags}\n  ${identity} · ${workspace} · official Codex login`;
}

export async function selectedProfile(requested) {
  const profiles = await listProfiles();
  if (!profiles.length) throw new Error("No masaka profiles. Run `masaka auth add` first.");
  if (requested) return await resolveProfile(requested);
  const defaultId = await getDefaultProfile();
  const profile = profiles.find((entry) => entry.id === defaultId);
  if (profile) return profile;
  if (profiles.length === 1) return profiles[0];
  throw new Error("Select a profile with `masaka use NAME`.");
}

export { cxHome };
