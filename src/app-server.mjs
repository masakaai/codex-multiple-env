import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";
import { findCwsScript, cwsEnvironment, prepareCwsProfiles } from "./cws-adapter.mjs";
import { readOfficialCodexIdentity } from "./codex-auth.mjs";
import { readProxySettings, refreshProxyProfile } from "./proxy-runtime.mjs";
import { prepareProfileCodexHome } from "./state.mjs";

const REQUEST_TIMEOUT_MS = 20_000;

function errorMessage(error) {
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  return String(error);
}

async function readAccountSnapshotViaAppServer(profile, options = {}) {
  const source = options.env || process.env;
  await prepareCwsProfiles([profile], { env: source });
  const script = await findCwsScript(source);
  const python = options.python || source.MASAKA_PYTHON || "python3";
  const child = spawn(python, [
    script,
    "run",
    profile.id,
    "--",
    "app-server",
    "--listen",
    "stdio://",
  ], {
    // Account metadata and quotas must be read from this Profile's official
    // auth context, not from whichever account the model proxy currently uses.
    env: { ...cwsEnvironment(source), MASAKA_BYPASS_PROXY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let stderr = "";
  let finished = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8_000) stderr += chunk.slice(0, 8_000 - stderr.length);
  });

  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.id === undefined || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else request.resolve(message.result);
  });

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  child.once("error", (error) => {
    finished = true;
    rejectPending(error);
    resolveExit({ error });
  });
  child.stdin.on("error", (error) => {
    if (!finished) rejectPending(error);
  });
  child.once("exit", (code, signal) => {
    const wasFinished = finished;
    finished = true;
    const detail = stderr.trim();
    if (pending.size) {
      const failure = new Error(detail || `Codex app-server exited (${signal || code || "unknown"}).`);
      rejectPending(failure);
    }
    if (!wasFinished) resolveExit({ code, signal });
  });

  async function waitForExit(milliseconds) {
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function send(id, method, params) {
    return new Promise((resolve, reject) => {
      if (finished) {
        reject(new Error(`Codex app-server is not running while reading ${method}.`));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex app-server timed out while reading ${method}.`));
      }, options.timeoutMs || REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const message = params === undefined ? { method, id } : { method, id, params };
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  try {
    await send(0, "initialize", {
      clientInfo: { name: "masaka_cli", title: "Masaka", version: "0.4.0" },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const [account, limits, usage] = await Promise.all([
      send(1, "account/read", { refreshToken: false }),
      send(2, "account/rateLimits/read"),
      send(3, "account/usage/read").catch((error) => ({ unavailable: errorMessage(error) })),
    ]);
    return { account, limits, usage };
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
    await waitForExit(250);
    if (!finished) {
      child.kill("SIGTERM");
      await waitForExit(1_000);
    }
    if (!finished) {
      child.kill("SIGKILL");
      await waitForExit(1_000);
    }
    if (!finished) rejectPending(new Error("Codex app-server did not exit after forced shutdown."));
    lines.close();
  }
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapWindow(value) {
  if (!value || typeof value !== "object") return null;
  return {
    usedPercent: number(value.used_percent),
    windowDurationMins: number(value.limit_window_seconds) === undefined
      ? undefined : value.limit_window_seconds / 60,
    resetsAt: number(value.reset_at),
  };
}

function reachedType(value) {
  if (typeof value === "string") return value;
  return typeof value?.type === "string" ? value.type : null;
}

function mapRateLimitBucket(rateLimit, metadata = {}) {
  if (!rateLimit || typeof rateLimit !== "object") return undefined;
  const credits = metadata.credits;
  const individual = metadata.spend_control?.individual_limit;
  return {
    limitId: metadata.limitId || "codex",
    limitName: metadata.limitName || null,
    primary: mapWindow(rateLimit.primary_window),
    secondary: mapWindow(rateLimit.secondary_window),
    credits: credits ? {
      hasCredits: Boolean(credits.has_credits),
      unlimited: Boolean(credits.unlimited),
      balance: credits.balance == null ? null : String(credits.balance),
    } : null,
    individualLimit: individual ? {
      limit: String(individual.limit),
      used: String(individual.used),
      remainingPercent: number(individual.remaining_percent),
      resetsAt: number(individual.reset_at),
    } : null,
    planType: metadata.plan_type || null,
    rateLimitReachedType: reachedType(metadata.rate_limit_reached_type),
  };
}

function mapRateLimits(payload) {
  const buckets = [];
  const primary = mapRateLimitBucket(payload.rate_limit, payload);
  if (primary) buckets.push(primary);
  const review = mapRateLimitBucket(payload.code_review_rate_limit, {
    limitId: "codex_review",
    limitName: "Code review",
    plan_type: payload.plan_type,
  });
  if (review) buckets.push(review);
  for (const entry of Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []) {
    const id = entry.metered_feature || entry.limit_name;
    const bucket = mapRateLimitBucket(entry.rate_limit, {
      limitId: id,
      limitName: entry.limit_name || id,
      plan_type: payload.plan_type,
    });
    if (bucket) buckets.push(bucket);
  }
  const byId = Object.fromEntries(buckets.map((bucket) => [bucket.limitId, bucket]));
  return {
    rateLimits: byId.codex || buckets[0],
    rateLimitsByLimitId: byId,
    rateLimitResetCredits: payload.rate_limit_reset_credits ? {
      availableCount: number(payload.rate_limit_reset_credits.available_count),
    } : null,
  };
}

function mapTokenUsage(payload) {
  const stats = payload?.stats;
  if (!stats || typeof stats !== "object") return undefined;
  return {
    summary: {
      lifetimeTokens: number(stats.lifetime_tokens),
      peakDailyTokens: number(stats.peak_daily_tokens),
      longestRunningTurnSec: number(stats.longest_running_turn_sec),
      currentStreakDays: number(stats.current_streak_days),
      longestStreakDays: number(stats.longest_streak_days),
    },
    dailyUsageBuckets: Array.isArray(stats.daily_usage_buckets)
      ? stats.daily_usage_buckets.map((bucket) => ({ startDate: bucket.start_date, tokens: number(bucket.tokens) }))
      : null,
  };
}

async function safeAuth(profile, options = {}) {
  const source = options.env || process.env;
  await prepareCwsProfiles([profile], { env: source });
  const home = await prepareProfileCodexHome(profile.id, source);
  const path = join(home, "auth.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
    throw new Error("Profile auth.json has unsafe permissions or links.");
  }
  const auth = JSON.parse(await readFile(path, "utf8"));
  if (typeof auth?.tokens?.access_token !== "string" || !auth.tokens.access_token
      || typeof auth?.tokens?.account_id !== "string" || !auth.tokens.account_id) {
    throw new Error("Profile does not contain usable official Codex credentials.");
  }
  return { auth, home };
}

async function backendJson(path, credentials, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Node.js fetch is unavailable.");
  const response = await fetchImpl(`https://chatgpt.com/backend-api/${path}`, {
    headers: {
      authorization: `Bearer ${credentials.tokens.access_token}`,
      "chatgpt-account-id": credentials.tokens.account_id,
      "user-agent": "codex-cli",
    },
    signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`ChatGPT account endpoint returned HTTP ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }
  return await response.json();
}

async function readAccountSnapshotWithoutRefresh(profile, options = {}) {
  let { auth, home } = await safeAuth(profile, options);
  const request = async () => await Promise.all([
    backendJson("wham/usage", auth, options),
    backendJson("wham/profiles/me", auth, options).catch((error) => ({ unavailable: errorMessage(error) })),
  ]);
  let values;
  try {
    values = await request();
  } catch (error) {
    if (error.statusCode !== 401) throw error;
    await refreshProxyProfile(profile.id, options);
    ({ auth, home } = await safeAuth(profile, options));
    values = await request();
  }
  const [limitsPayload, usagePayload] = values;
  const identity = await readOfficialCodexIdentity(home);
  return {
    account: {
      account: {
        type: "chatgpt",
        email: identity.email || profile.email,
        planType: identity.planType || profile.planType,
      },
      requiresOpenaiAuth: true,
    },
    limits: mapRateLimits(limitsPayload),
    usage: usagePayload.unavailable
      ? { unavailable: usagePayload.unavailable }
      : mapTokenUsage(usagePayload),
  };
}

export async function readAccountSnapshot(profile, options = {}) {
  if (!options.forceAppServer) {
    const settings = await readProxySettings(options);
    // Once daemon ownership has been installed, health-check failure is not a
    // safe ownership transfer: launchd may be restarting it. Stay read-only;
    // a 401 will report unavailable until the daemon can refresh again.
    if (settings.daemonInstalled) return await readAccountSnapshotWithoutRefresh(profile, options);
  }
  return await readAccountSnapshotViaAppServer(profile, options);
}
