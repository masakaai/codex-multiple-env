import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProxySettings,
  installProxyRuntime,
  launchAgentDocument,
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
