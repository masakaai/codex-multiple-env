import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
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
  const sensitiveSentinel = ["must", "not", "leak"].join("-");
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "config.toml"), '[projects."/workspace"]\ntrust_level = "trusted"\n');
  await writeFile(join(base, "AGENTS.md"), "native global instructions\n");
  await writeFile(join(base, "auth.json"), '{"native":true}\n', { mode: 0o600 });
  await chmod(fakeCodex, 0o755);
  const env = {
    ...process.env,
    CWS_HOME: join(root, "profiles-root"),
    CWS_BASE_CODEX_HOME: base,
    CWS_CODEX_BIN: fakeCodex,
    CODEX_ACCESS_TOKEN: sensitiveSentinel,
    OPENAI_API_KEY: sensitiveSentinel,
    CODEX_AUTHAPI_BASE_URL: "https://example.invalid",
  };
  await execFileAsync("python3", [cws, "add", "profile-a", "--workspace-id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"], { env });
  const home = join(env.CWS_HOME, "profiles", "profile-a");
  await writeFile(join(home, "auth.json"), "{}\n", { mode: 0o600 });
  await execFileAsync("python3", [cws, "default", "profile-a"], { env });
  return { root, base, home, env };
}

test("native codex starts with the selected isolated CODEX_HOME and sanitized auth environment", async () => {
  const { root, base, home, env } = await setup();
  const result = await execFileAsync("python3", [cws, "auto", "--", "--version"], { env, cwd: root });
  const event = JSON.parse(result.stdout.trim());
  assert.equal(await realpath(event.codex_home), await realpath(home));
  assert.equal(event.codex_sqlite_home, null);
  assert.equal(await realpath(event.cwd), await realpath(root));
  assert.equal(await realpath(join(home, "config.toml")), await realpath(join(base, "config.toml")));
  assert.equal(event.has_access_token, false);
  assert.equal(event.has_openai_key, false);
  assert.equal(event.has_codex_key, false);
  assert.equal(event.has_auth_override, false);
  assert.deepEqual(event.argv, [
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'forced_login_method="chatgpt"',
    "-c", 'forced_chatgpt_workspace_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"',
    "--version",
  ]);
});

test("launcher injects the loopback model route only while Masaka proxy mode is enabled", async () => {
  const { base, env } = await setup();
  const legacySession = join(env.CWS_HOME, "proxy-client", "sessions", "2026", "10", "11", "rollout-legacy.jsonl");
  await mkdir(join(legacySession, ".."), { recursive: true });
  await writeFile(legacySession, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "legacy", model_provider: "masaka-proxy", cwd: "/workspace" },
  })}\n{"type":"response_item"}\n`);
  await writeFile(join(env.CWS_HOME, "masaka-proxy-routing.json"), JSON.stringify({
    version: 1,
    enabled: true,
    baseUrl: "http://127.0.0.1:8787/backend-api/codex",
  }), { mode: 0o600 });
  const enabledResults = await Promise.all(Array.from({ length: 4 }, () =>
    execFileAsync("python3", [cws, "auto", "--", "--version"], { env })));
  const enabled = enabledResults[0];
  for (const result of enabledResults) assert.equal(result.stderr, "");
  const enabledEvent = JSON.parse(enabled.stdout.trim());
  const runtimeHome = join(env.CWS_HOME, "proxy-runtime");
  assert.equal(enabledEvent.has_codex_key, false, "interactive Codex must load the loopback credential from its isolated auth file");
  assert.equal(await realpath(enabledEvent.codex_home), await realpath(runtimeHome));
  assert.equal(await realpath(enabledEvent.codex_sqlite_home), await realpath(base));
  assert.equal(await realpath(join(runtimeHome, "sessions")), await realpath(join(base, "sessions")));
  assert.equal(await realpath(join(runtimeHome, "AGENTS.md")), await realpath(join(base, "AGENTS.md")));
  assert.deepEqual(JSON.parse(await readFile(join(runtimeHome, "auth.json"), "utf8")), {
    auth_mode: "apikey",
    OPENAI_API_KEY: ["masaka", "loopback", "placeholder"].join("-"),
  });
  assert.equal(await readFile(join(base, "auth.json"), "utf8"), '{"native":true}\n');
  const migratedSession = join(base, "sessions", "2026", "10", "11", "rollout-legacy.jsonl");
  assert.equal(JSON.parse((await readFile(migratedSession, "utf8")).split("\n")[0]).payload.model_provider, "openai");
  assert.equal(JSON.parse((await readFile(legacySession, "utf8")).split("\n")[0]).payload.model_provider, "masaka-proxy");
  assert.deepEqual(enabledEvent.argv.slice(-5), [
    "-c", 'model_provider="openai"',
    "-c", 'openai_base_url="http://127.0.0.1:8787/backend-api/codex"',
    "--version",
  ]);
  assert.deepEqual(enabledEvent.argv.slice(0, 4), [
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'forced_login_method="api"',
  ]);

  // A pre-release build briefly linked mutable root files. Codex replaces
  // session_index.jsonl atomically, so upgrade turns the link into a private
  // seeded copy without touching the native file.
  const nativeIndex = join(base, "session_index.jsonl");
  const runtimeIndex = join(runtimeHome, "session_index.jsonl");
  await writeFile(nativeIndex, '{"id":"native"}\n');
  await symlink(nativeIndex, runtimeIndex);
  await execFileAsync("python3", [cws, "auto", "--", "--version"], { env });
  assert.equal((await lstat(runtimeIndex)).isSymbolicLink(), false);
  assert.equal(await readFile(runtimeIndex, "utf8"), '{"id":"native"}\n');
  await writeFile(runtimeIndex, '{"id":"runtime"}\n');
  await execFileAsync("python3", [cws, "auto", "--", "--version"], { env });
  assert.equal(await readFile(runtimeIndex, "utf8"), '{"id":"runtime"}\n');
  assert.equal(await readFile(nativeIndex, "utf8"), '{"id":"native"}\n');

  const customSqliteHome = join(env.CWS_HOME, "native-sqlite");
  const customSqlite = await execFileAsync("python3", [cws, "auto", "--", "--version"], {
    env: { ...env, CODEX_SQLITE_HOME: customSqliteHome },
  });
  assert.equal(JSON.parse(customSqlite.stdout.trim()).codex_sqlite_home, customSqliteHome);

  const archivedSession = join(base, "archived_sessions", "rollout-legacy.jsonl");
  await mkdir(join(base, "archived_sessions"), { recursive: true });
  await rename(migratedSession, archivedSession);
  await execFileAsync("python3", [cws, "auto", "--", "--version"], { env });
  await assert.rejects(readFile(migratedSession), { code: "ENOENT" });
  assert.equal(JSON.parse((await readFile(archivedSession, "utf8")).split("\n")[0]).payload.model_provider, "openai");

  await writeFile(join(env.CWS_HOME, "masaka-proxy-routing.json"), JSON.stringify({
    version: 1,
    enabled: false,
    baseUrl: "http://127.0.0.1:8787/backend-api/codex",
  }), { mode: 0o600 });
  const disabled = await execFileAsync("python3", [cws, "auto", "--", "--version"], { env });
  assert.doesNotMatch(disabled.stdout, /masaka-proxy/);
  assert.equal(JSON.parse(disabled.stdout.trim()).has_openai_key, false);
  assert.equal(JSON.parse(disabled.stdout.trim()).has_codex_key, false);

  await writeFile(join(env.CWS_HOME, "masaka-proxy-routing.json"), JSON.stringify({
    version: 1,
    enabled: true,
    baseUrl: "http://127.0.0.1:8787/backend-api/codex",
  }), { mode: 0o600 });
  const bypassed = await execFileAsync("python3", [cws, "auto", "--", "--version"], {
    env: { ...env, MASAKA_BYPASS_PROXY: "1" },
  });
  assert.doesNotMatch(bypassed.stdout, /masaka-proxy/);
  assert.equal(JSON.parse(bypassed.stdout.trim()).has_openai_key, false);
  assert.equal(JSON.parse(bypassed.stdout.trim()).has_codex_key, false);
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
