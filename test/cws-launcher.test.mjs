import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cws = fileURLToPath(new URL("../scripts/cws.py", import.meta.url));
const fakeCodex = fileURLToPath(new URL("./fake-native-codex.py", import.meta.url));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "masaka-cws-test-"));
  const base = join(root, "base");
  await mkdir(base, { recursive: true });
  await chmod(fakeCodex, 0o755);
  const env = {
    ...process.env,
    CWS_HOME: join(root, "profiles-root"),
    CWS_BASE_CODEX_HOME: base,
    CWS_CODEX_BIN: fakeCodex,
    CODEX_ACCESS_TOKEN: "must-not-leak",
    OPENAI_API_KEY: "must-not-leak",
    CODEX_AUTHAPI_BASE_URL: "https://example.invalid",
  };
  await execFileAsync("python3", [cws, "add", "profile-a", "--workspace-id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], { env });
  const home = join(env.CWS_HOME, "profiles", "profile-a");
  await writeFile(join(home, "auth.json"), "{}\n", { mode: 0o600 });
  await execFileAsync("python3", [cws, "default", "profile-a"], { env });
  return { root, base, home, env };
}

test("native codex starts with the selected isolated CODEX_HOME and sanitized auth environment", async () => {
  const { home, env } = await setup();
  const result = await execFileAsync("python3", [cws, "auto", "--", "--version"], { env });
  const event = JSON.parse(result.stdout.trim());
  assert.equal(await realpath(event.codex_home), await realpath(home));
  assert.equal(event.has_access_token, false);
  assert.equal(event.has_openai_key, false);
  assert.equal(event.has_auth_override, false);
  assert.deepEqual(event.argv, [
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'forced_login_method="chatgpt"',
    "-c", 'forced_chatgpt_workspace_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"',
    "--version",
  ]);
});

test("launcher refuses credentials hard-linked to another path", async () => {
  const { root, home, env } = await setup();
  await link(join(home, "auth.json"), join(root, "credential-alias.json"));
  await assert.rejects(
    execFileAsync("python3", [cws, "auto", "--", "--version"], { env }),
    /credential storage must be one regular, unlinked file/,
  );
});

test("launcher rejects auth mutation and profile-security overrides", async () => {
  const { env } = await setup();
  await assert.rejects(
    execFileAsync("python3", [cws, "auto", "--", "login"], { env }),
    /use masaka \/renew/,
  );
  await assert.rejects(
    execFileAsync("python3", [cws, "auto", "--", "-c", "forced_login_method=api"], { env }),
    /cannot override profile setting/,
  );
});

test("renewal restores the original credential when another account signs in", async () => {
  const { home, env } = await setup();
  const original = '{"original":true}\n';
  await writeFile(join(home, "auth.json"), original, { mode: 0o600 });
  const renewalEnv = {
    ...env,
    FAKE_LOGIN_IDENTITY: JSON.stringify({
      user_id: "different-user",
      email: "other@example.com",
      workspace_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    }),
  };
  await assert.rejects(execFileAsync("python3", [
    cws,
    "login",
    "profile-a",
    "--reauth",
    "--expected-user-id",
    "original-user",
    "--expected-workspace-id",
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ], { env: renewalEnv }), /different account/);
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), original);
});

async function assertInterruptedRenewal(signal, expectedCode) {
  const { home, env } = await setup();
  const original = '{"original":true}\n';
  await writeFile(join(home, "auth.json"), original, { mode: 0o600 });
  const renewal = spawn("python3", [
    cws,
    "login",
    "profile-a",
    "--reauth",
    "--expected-user-id",
    "original-user",
  ], {
    env: {
      ...env,
      FAKE_LOGIN_DELAY: "10",
      FAKE_LOGIN_IDENTITY: JSON.stringify({
        user_id: "original-user",
        email: "person@example.com",
        workspace_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 3_000;
  while (!(await readdir(home)).some((entry) => entry.startsWith(".auth.json.masaka-renew-"))) {
    if (Date.now() >= deadline) {
      renewal.kill("SIGKILL");
      assert.fail("renewal did not create its rollback credential in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  renewal.kill(signal);
  const [code, signalName] = await new Promise((resolve) => renewal.once("exit", (...event) => resolve(event)));
  assert.equal(signalName, null);
  assert.equal(code, expectedCode);
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), original);
}

test("renewal restores the original credential when interrupted by Ctrl+C", async () => {
  await assertInterruptedRenewal("SIGINT", 130);
});

test("renewal restores the original credential when interrupted by SIGTERM", async () => {
  await assertInterruptedRenewal("SIGTERM", 143);
});
