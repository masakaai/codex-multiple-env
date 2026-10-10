import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccountSnapshot } from "../src/app-server.mjs";

const fakeCws = fileURLToPath(new URL("./fake-cws.py", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "masaka-app-server-test-"));
  const profile = {
    id: "11111111-2222-4333-8444-555555555555",
    label: "Lifecycle Test",
    email: "alice@example.com",
    workspaceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    workspaceLabel: "Acme",
    planType: "business",
  };
  const home = join(root, "cws", "profiles", profile.id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "auth.json"), "{}\n", { mode: 0o600 });
  return { root, profile };
}

test("app-server spawn failures reject normally instead of escaping the caller", async () => {
  const { root, profile } = await fixture();
  await assert.rejects(readAccountSnapshot(profile, {
    env: { ...process.env, CX_HOME: root, MASAKA_CWS_SCRIPT: fakeCws },
    python: "/nonexistent-masaka-python",
    timeoutMs: 50,
  }), /ENOENT/);
});

test("app-server shutdown escalates to SIGKILL within a bounded time", async () => {
  const { root, profile } = await fixture();
  const started = Date.now();
  await assert.rejects(readAccountSnapshot(profile, {
    env: {
      ...process.env,
      CX_HOME: root,
      MASAKA_CWS_SCRIPT: fakeCws,
      FAKE_CWS_STUBBORN: "1",
    },
    timeoutMs: 50,
  }), /timed out/);
  assert.ok(Date.now() - started < 2_500, "stubborn app-server child must not block indefinitely");
});
