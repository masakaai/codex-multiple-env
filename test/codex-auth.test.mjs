import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProfile,
  automaticProfileLabel,
  officialCodexConfigArgs,
  officialCodexEnvironment,
  readOfficialCodexIdentity,
} from "../src/codex-auth.mjs";
import { listProfiles } from "../src/state.mjs";

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("official Codex identity metadata produces readable account and workspace names", async () => {
  const home = await mkdtemp(join(tmpdir(), "cx-official-auth-test-"));
  await writeFile(join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        sub: "user-stable-id",
        name: "Alice",
        email: "alice@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "11111111-2222-4333-8444-555555555555",
          chatgpt_plan_type: "self_serve_business_prolite",
          organizations: [
            { id: "org-one", title: "Acme", is_default: true, role: "member" },
            { id: "org-two", title: "Other", is_default: false, role: "member" },
          ],
        },
      }),
      access_token: jwt({
        "https://api.openai.com/auth": { poid: "org-one" },
      }),
      account_id: "11111111-2222-4333-8444-555555555555",
      refresh_token: ["not", "read", "by", "cx"].join("-"),
    },
  }), { mode: 0o600 });

  assert.deepEqual(await readOfficialCodexIdentity(home), {
    accountUserId: "user-stable-id",
    name: "Alice",
    email: "alice@example.com",
    planType: "self_serve_business_prolite",
    workspaceId: "11111111-2222-4333-8444-555555555555",
    workspaceLabel: "Acme",
    workspaceOrganizationId: "org-one",
  });
});

test("an unmatched organization id does not borrow another workspace's title", async () => {
  const home = await mkdtemp(join(tmpdir(), "cx-workspace-fallback-test-"));
  await writeFile(join(home, "auth.json"), JSON.stringify({
    tokens: {
      id_token: jwt({
        name: "Alice",
        email: "alice@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "11111111-2222-4333-8444-555555555555",
          chatgpt_plan_type: "team",
          organizations: [
            { id: "org-default", title: "Unrelated", is_default: true },
            { id: "org-other", title: "Other", is_default: false },
          ],
        },
      }),
      access_token: jwt({
        "https://api.openai.com/auth": { poid: "org-not-listed" },
      }),
    },
  }), { mode: 0o600 });

  const identity = await readOfficialCodexIdentity(home);
  assert.equal(identity.workspaceLabel, "");
  assert.equal(automaticProfileLabel(identity), "Alice (alice@example.com) · Team");
});

test("automatic profile labels use names, email, and workspace rather than ids", () => {
  const identity = {
    name: "Alice",
    email: "alice@example.com",
    workspaceLabel: "Acme Business",
    workspaceId: "11111111-2222-4333-8444-555555555555",
  };
  const first = automaticProfileLabel(identity);
  assert.equal(first, "Alice (alice@example.com) · Acme Business");
  assert.equal(automaticProfileLabel(identity, [first]), `${first} (2)`);
  assert.doesNotMatch(first, /11111111/);
});

test("new profiles run official login in a dedicated CODEX_HOME and persist only metadata", async () => {
  const previous = process.env.CX_HOME;
  const root = await mkdtemp(join(tmpdir(), "cx-add-profile-test-"));
  process.env.CX_HOME = root;
  const calls = [];
  try {
    const profile = await addProfile(undefined, {
      deviceAuth: true,
      async login(options) {
        calls.push(options);
        await mkdir(options.codexHome, { recursive: true });
      },
      async inspect() {
        return {
          name: "Alice",
          email: "alice@example.com",
          planType: "business",
          workspaceId: "11111111-2222-4333-8444-555555555555",
          workspaceLabel: "Acme",
        };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].deviceAuth, true);
    assert.match(calls[0].codexHome, new RegExp(`^${root}/cws/profiles/`));
    assert.equal(profile.label, "Alice (alice@example.com) · Acme (Business)");
    assert.deepEqual(await listProfiles(), [profile]);
    const state = await readFile(join(root, "cx-state.json"), "utf8");
    assert.doesNotMatch(state, /access_token|refresh_token/);
    assert.equal((await stat(join(root, "cx-state.json"))).mode & 0o077, 0);
  } finally {
    if (previous === undefined) delete process.env.CX_HOME;
    else process.env.CX_HOME = previous;
  }
});

test("official process configuration forces ChatGPT file auth and ignores ambient API credentials", () => {
  assert.deepEqual(officialCodexConfigArgs("workspace-uuid"), [
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'forced_login_method="chatgpt"',
    "-c", 'forced_chatgpt_workspace_id="workspace-uuid"',
  ]);
  const env = officialCodexEnvironment("/tmp/profile", {
    CODEX_ACCESS_TOKEN: "wrong",
    OPENAI_API_KEY: "wrong",
    CODEX_API_KEY: "wrong",
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: "https://example.invalid/refresh",
    CODEX_REVOKE_TOKEN_URL_OVERRIDE: "https://example.invalid/revoke",
    CODEX_AUTHAPI_BASE_URL: "https://example.invalid/authapi",
    CODEX_APP_SERVER_LOGIN_CLIENT_ID: "wrong-client",
    KEEP_ME: "yes",
  });
  assert.equal(env.CODEX_HOME, "/tmp/profile");
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, undefined);
  assert.equal(env.CODEX_REVOKE_TOKEN_URL_OVERRIDE, undefined);
  assert.equal(env.CODEX_AUTHAPI_BASE_URL, undefined);
  assert.equal(env.CODEX_APP_SERVER_LOGIN_CLIENT_ID, undefined);
});

test("explicit profile labels cannot silently collide", async () => {
  const previous = process.env.CX_HOME;
  const root = await mkdtemp(join(tmpdir(), "cx-label-collision-test-"));
  process.env.CX_HOME = root;
  let loginCount = 0;
  const options = {
    async login() { loginCount += 1; },
    async inspect() {
      return {
        name: "Alice",
        email: "alice@example.com",
        planType: "business",
        workspaceId: "11111111-2222-4333-8444-555555555555",
        workspaceLabel: "Acme",
      };
    },
  };
  try {
    await addProfile("Company", options);
    await assert.rejects(addProfile("company", options), /already exists/);
    assert.equal(loginCount, 1);
  } finally {
    if (previous === undefined) delete process.env.CX_HOME;
    else process.env.CX_HOME = previous;
  }
});
