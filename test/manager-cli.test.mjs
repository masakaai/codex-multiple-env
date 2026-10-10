import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const fakeCws = fileURLToPath(new URL("./fake-cws.py", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "masaka-manager-test-"));
  const profileId = "11111111-2222-4333-8444-555555555555";
  const profileHome = join(root, "cws", "profiles", profileId);
  await mkdir(profileHome, { recursive: true, mode: 0o700 });
  await writeFile(join(profileHome, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(root, "cx-state.json"), JSON.stringify({
    version: 2,
    defaultProfileId: profileId,
    profiles: [{
      id: profileId,
      label: "Native Test",
      name: "Alice",
      email: "alice@example.com",
      workspaceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      workspaceLabel: "Acme",
      planType: "business",
    }],
    threads: {},
  }), { mode: 0o600 });
  return { root, profileId };
}

function runCli(args, root, options = {}) {
  return new Promise((resolve, reject) => {
    const environment = {
      ...process.env,
      CX_HOME: root,
      MASAKA_CWS_SCRIPT: options.bundled ? undefined : fakeCws,
      CODEX_ACCESS_TOKEN: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
    };
    if (options.bundled) delete environment.MASAKA_CWS_SCRIPT;
    const child = spawn(process.execPath, [cli, ...args], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(options.input || "");
  });
}

test("masaka starts a standalone slash-command manager and never launches Codex", async () => {
  const { root } = await fixture();
  const result = await runCli([], root, { input: "/profiles\n/exit\n" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^╭─+╮\n/);
  assert.match(result.stdout, />_ masaka v0\.3\.0/);
  assert.match(result.stdout, /github\.com\/masakaai\/codex-multiple-env/);
  assert.match(result.stdout, /https:\/\/masaka-ai\.vercel\.app/);
  assert.match(result.stdout, /Masaka AI \(@masakaai\)/);
  assert.match(result.stdout, /\/status/);
  assert.match(result.stdout, /\/use <name\|number>/);
  assert.match(result.stdout, /\/add/);
  assert.match(result.stdout, /Native Test \[default\]/);
  assert.doesNotMatch(result.stdout, /"argv"/);
});

test("status and usage aggregate official app-server data for all profiles", async () => {
  const { root } = await fixture();
  const status = await runCli(["status"], root);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Auth: connected · alice@example.com · Business/);
  assert.match(status.stdout, /Usage limits/);
  assert.match(status.stdout, /5h limit:\s+\[███████████████░░░░░\] 75% left \(resets in /);
  assert.match(status.stdout, /Weekly limit:\s+\[████████████░░░░░░░░\] 60% left \(resets in /);
  const limitLines = status.stdout.split("\n").filter((line) => /(?:5h|Weekly) limit:/.test(line));
  assert.equal(limitLines.length, 2);
  assert.equal(limitLines[0].indexOf("["), limitLines[1].indexOf("["));
  assert.doesNotMatch(status.stdout, /^╭─+╮/);
  assert.match(status.stdout, /Tokens: 1,234,567 lifetime/);

  const usage = await runCli(["usage"], root);
  assert.equal(usage.code, 0, usage.stderr);
  assert.match(usage.stdout, /Reset cards: 2/);
  assert.match(usage.stdout, /Full reset/);
});

test("use selects a profile only for future native Codex processes", async () => {
  const { root, profileId } = await fixture();
  const result = await runCli(["use", "1"], root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Selected for new native Codex processes: Native Test/);
  assert.match(result.stdout, /Already-running Codex processes keep their original identity/);
  assert.equal(JSON.parse(await readFile(join(root, "cx-state.json"), "utf8")).defaultProfileId, profileId);
});

test("delete requires confirmation and removes only the selected profile", async () => {
  const { root } = await fixture();
  const refused = await runCli(["delete", "1"], root);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Run this inside masaka, or add --yes/);
  assert.equal(JSON.parse(await readFile(join(root, "cx-state.json"), "utf8")).profiles.length, 1);

  const deleted = await runCli(["delete", "1", "--yes"], root);
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.match(deleted.stdout, /Deleted: Native Test/);
  assert.equal(JSON.parse(await readFile(join(root, "cx-state.json"), "utf8")).profiles.length, 0);
});

test("shell integration launches native codex through the isolated profile launcher", async () => {
  const { root } = await fixture();
  const result = await runCli(["shell-init"], root, { bundled: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^unalias codex .*\ncodex\(\) \{ command .*scripts\/cws\.py auto -- .*"\$@"; \}\n$/);
  assert.match(result.stdout, new RegExp(`CWS_HOME=${(await realpath(root)).replaceAll("/", "\\/")}\\/cws`));
  assert.doesNotMatch(result.stdout, /command masaka/);
});

test("help exposes only the requested manager commands and no /new", async () => {
  const { root } = await fixture();
  const result = await runCli(["--help"], root);
  assert.equal(result.code, 0, result.stderr);
  for (const command of ["/status", "/usage", "/profiles", "/use", "/add", "/renew", "/delete"]) {
    assert.match(result.stdout, new RegExp(command.replace("/", "\\/")));
  }
  assert.doesNotMatch(result.stdout, /\/new/);
  assert.match(result.stdout, /manager, not a Codex chat client/);
});
