import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProxySettings,
  installProxyRuntime,
  launchAgentDocument,
  patchWebSocketRuntimeSource,
  readProxySettings,
  setProxyRouting,
} from "../src/proxy-runtime.mjs";

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
  assert.match(patched, /masaka-websocket-recovery-v1/);
  assert.match(patched, /pendingRequests\.some\(\(pending\) => pending\.started \|\| pending\.interrupted\)/);
  assert.match(patched, /stop\(closePayload\(1011, 'proxy_upstream_disconnected'\)\)/);
  assert.match(patched, /if \(pending\.peer && pending\.peer !== peer\)/);
  assert.match(patched, /peer\.closed = true;\n        if \(peers\.get\(peer\.name\) === peer\) peers\.delete\(peer\.name\);/);
  assert.match(patched, /stop\(message\.payload\)/);
  assert.doesNotMatch(patched, /if \(peer\.pending\.size\) stop\(\)/);
  assert.doesNotMatch(patched, /pending\.attempted\.delete\(name\)/);
  assert.equal(patchWebSocketRuntimeSource(patched), patched);
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
