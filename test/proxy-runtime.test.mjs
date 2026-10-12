import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProxyConfig,
  defaultProxySettings,
  installProxyRuntime,
  installLaunchAgent,
  launchAgentDocument,
  patchWebSocketRuntimeSource,
  readProxySettings,
  setProxyRouting,
} from "../src/proxy-runtime.mjs";

test("generated proxy config allows slow Responses requests to receive upstream headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "masaka-proxy-config-"));
  const config = await buildProxyConfig([], [], defaultProxySettings(), {
    root,
    env: { MASAKA_CWS_HOME: join(root, "cws") },
  });
  assert.equal(config.upstream_headers_timeout_ms, 300_000);
});

test("launch agent installation reloads changed program arguments and tolerates launchd teardown lag", async () => {
  const root = await mkdtemp(join(tmpdir(), "masaka-launch-agent-"));
  const agentPath = join(root, "ai.masaka.codex-proxy.plist");
  const calls = [];
  let bootstrapAttempts = 0;
  const execute = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "bootstrap" && bootstrapAttempts++ === 0) throw new Error("launchd teardown in progress");
    return { stdout: "", stderr: "" };
  };
  await installLaunchAgent({
    root,
    agentPath,
    platform: "darwin",
    uid: 501,
    execFileAsync: execute,
    sleep: async () => {},
    env: { MASAKA_CWS_HOME: join(root, "cws"), PATH: "/usr/bin:/bin" },
  });
  assert.deepEqual(calls.map((call) => call.slice(1, 3)), [
    ["print", "gui/501/ai.masaka.codex-proxy"],
    ["bootout", "gui/501/ai.masaka.codex-proxy"],
    ["bootstrap", "gui/501"],
    ["bootstrap", "gui/501"],
  ]);
});

test("proxy defaults to automatic sticky switching without enabling routing before onboarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "masaka-proxy-settings-"));
  const settings = await readProxySettings({ root });
  assert.deepEqual(settings, defaultProxySettings());
  assert.equal(settings.auto, true);
  assert.equal(settings.thresholdPercent, 5);
  assert.equal(settings.proxyEnabled, false);
});

test("runtime installer rejects an archive that does not match the pinned digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "masaka-proxy-runtime-"));
  await assert.rejects(installProxyRuntime({
    root,
    fetchImpl: async () => new Response("not the pinned runtime", { status: 200 }),
  }), /checksum mismatch/);
});

test("runtime patch recovers untouched WebSocket work and closes clients with a handshake", () => {
  const source = `import { WebSocketMessages, webSocketFrame } from './websocket-frames.mjs';

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clientSocket.destroy();

      operation = Promise.resolve().then(work).catch(stop).finally(() => operations.delete(operation));

      if (message.opcode === 8) {
        peer.socket.end(webSocketFrame(message.payload, { opcode: 8, masked: true }));
        if (peer.pending.size) stop();
        return;
      }

      const gone = () => {
        peer.closed = true;
        peer.release();
        allPeers.delete(peer);
        if (!stopped && peer.pending.size) stop();
      };

      if (message.opcode === 8) {
        clientSocket.end(webSocketFrame(message.payload, { opcode: 8 }));
        stop();
        return;
      }

      if (!admitted) {
        pending.attempted.delete(name);
        pending.attempted.delete(peer.name);
        return await dispatch(pending);
      }
`;
  const patched = patchWebSocketRuntimeSource(source);
  assert.match(patched, /masaka-websocket-recovery-v2/);
  assert.match(patched, /pendingRequests\.some\(\(pending\) => pending\.started \|\| pending\.interrupted\)/);
  assert.match(patched, /stop\(closePayload\(1011, 'proxy_upstream_disconnected'\)\)/);
  assert.match(patched, /if \(pending\.peer && pending\.peer !== peer\)/);
  assert.match(patched, /peer\.closed = true;\n        if \(peers\.get\(peer\.name\) === peer\) peers\.delete\(peer\.name\);/);
  assert.match(patched, /stop\(message\.payload\)/);
  assert.doesNotMatch(patched, /if \(peer\.pending\.size\) stop\(\)/);
  assert.doesNotMatch(patched, /pending\.attempted\.delete\(name\)/);
  assert.equal(patchWebSocketRuntimeSource(patched), patched);

  const v1 = patched
    .replace("masaka-websocket-recovery-v2", "masaka-websocket-recovery-v1")
    .replace(
      `      if (message.opcode === 8) {
        peer.closed = true;
        if (peers.get(peer.name) === peer) peers.delete(peer.name);
        closeSocket(peer.socket, message.payload, { masked: true });
        return;
      }`,
      `      if (message.opcode === 8) {
        closeSocket(peer.socket, message.payload, { masked: true });
        return;
      }`,
    )
    .replace(
      `      const gone = () => {
        peer.closed = true;`,
      `      const gone = () => {
        if (peer.closed) return;
        peer.closed = true;`,
    )
    .replace(
      `      if (!admitted) {
        // Keep rejected accounts in the attempted set. A persistent manual
        // selection can otherwise make selection and admission disagree and
        // recurse forever between the same rejected account.
        return await dispatch(pending);
      }`,
      `      if (!admitted) {
        pending.attempted.delete(name);
        pending.attempted.delete(peer.name);
        return await dispatch(pending);
      }`,
    );
  assert.equal(patchWebSocketRuntimeSource(v1), patched);
});

test("routing state contains only a validated loopback endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "masaka-proxy-routing-"));
  const cws = join(root, "cws");
  const settings = defaultProxySettings();
  const path = await setProxyRouting(true, settings, { root, env: { MASAKA_CWS_HOME: cws } });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    enabled: true,
    baseUrl: "http://127.0.0.1:8787/backend-api/codex",
  });
  const plist = launchAgentDocument({ root, env: { MASAKA_CWS_HOME: cws, PATH: "/usr/bin:/bin" } });
  assert.match(plist, /ai\.masaka\.codex-proxy/);
  assert.doesNotMatch(plist, /access_token|refresh_token|Authorization/);
});
