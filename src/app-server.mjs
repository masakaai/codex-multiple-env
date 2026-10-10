import { spawn } from "node:child_process";
import readline from "node:readline";
import { findCwsScript, cwsEnvironment, prepareCwsProfiles } from "./cws-adapter.mjs";

const REQUEST_TIMEOUT_MS = 20_000;

function errorMessage(error) {
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  return String(error);
}

export async function readAccountSnapshot(profile, options = {}) {
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
    env: cwsEnvironment(source),
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
      clientInfo: { name: "masaka_cli", title: "Masaka", version: "0.3.0" },
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
