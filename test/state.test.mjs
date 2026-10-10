import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProfileLease, clearThread, getDefaultProfile, getThread, prepareProfileCodexHome, setDefaultProfile, setThread } from "../src/state.mjs";

test("profile defaults and threads remain isolated", async () => {
  const previous = process.env.CX_HOME;
  const root = await mkdtemp(join(tmpdir(), "cx-state-test-"));
  process.env.CX_HOME = root;
  try {
    await setDefaultProfile("profile-a");
    await setThread("profile-a", "/tmp/project", "thread-a");
    await setThread("profile-b", "/tmp/project", "thread-b");
    assert.equal(await getDefaultProfile(), "profile-a");
    assert.equal(await getThread("profile-a", "/tmp/project"), "thread-a");
    assert.equal(await getThread("profile-b", "/tmp/project"), "thread-b");
    await clearThread("profile-a", "/tmp/project");
    assert.equal(await getThread("profile-a", "/tmp/project"), undefined);
    assert.equal(await getThread("profile-b", "/tmp/project"), "thread-b");
    const info = await stat(join(root, "cx-state.json"));
    assert.equal(info.mode & 0o077, 0);
  } finally {
    if (previous === undefined) delete process.env.CX_HOME;
    else process.env.CX_HOME = previous;
  }
});

test("concurrent state updates and profile-home preparation are safe", async () => {
  const previous = process.env.CX_HOME;
  const root = await mkdtemp(join(tmpdir(), "cx-concurrency-test-"));
  process.env.CX_HOME = root;
  try {
    await Promise.all([
      prepareProfileCodexHome("profile-a"),
      prepareProfileCodexHome("profile-a"),
      ...Array.from({ length: 12 }, (_, index) => setThread(`profile-${index}`, "/tmp/project", `thread-${index}`)),
    ]);
    for (let index = 0; index < 12; index += 1) {
      assert.equal(await getThread(`profile-${index}`, "/tmp/project"), `thread-${index}`);
    }
    const info = await stat(join(root, "cws", "profiles", "profile-a"));
    assert.equal(info.mode & 0o077, 0);
  } finally {
    if (previous === undefined) delete process.env.CX_HOME;
    else process.env.CX_HOME = previous;
  }
});

test("a lock left by a dead process is recovered atomically", async () => {
  const previous = process.env.CX_HOME;
  const root = await mkdtemp(join(tmpdir(), "cx-stale-lock-test-"));
  process.env.CX_HOME = root;
  try {
    const lockDirectory = join(root, ".cx-state.lock.d");
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(
      join(lockDirectory, "0000000000000-dead.ticket"),
      `${JSON.stringify({ pid: 99999999, token: "dead", createdAt: 0 })}\n`,
      { mode: 0o600 },
    );
    await setDefaultProfile("profile-after-crash");
    assert.equal(await getDefaultProfile(), "profile-after-crash");
  } finally {
    if (previous === undefined) delete process.env.CX_HOME;
    else process.env.CX_HOME = previous;
  }
});

test("legacy SIWC defaults and threads are not applied to official Codex profiles", async () => {
  const previous = process.env.CX_HOME;
  const root = await mkdtemp(join(tmpdir(), "cx-state-migration-test-"));
  process.env.CX_HOME = root;
  try {
    await writeFile(join(root, "cx-state.json"), JSON.stringify({
      version: 1,
      defaultProfileId: "legacy-siwc-profile",
      threads: { "legacy-siwc-profile": { "/tmp/project": "legacy-thread" } },
    }), { mode: 0o600 });
    assert.equal(await getDefaultProfile(), undefined);
    assert.equal(await getThread("legacy-siwc-profile", "/tmp/project"), undefined);
  } finally {
    if (previous === undefined) delete process.env.CX_HOME;
    else process.env.CX_HOME = previous;
  }
});

test("one masaka process exclusively owns a profile until its lease is released", async () => {
  const previous = process.env.CX_HOME;
  const root = await mkdtemp(join(tmpdir(), "cx-profile-lease-test-"));
  process.env.CX_HOME = root;
  try {
    const first = await acquireProfileLease("profile-a", "start");
    await assert.rejects(acquireProfileLease("profile-a", "start"), /active in another masaka process/);
    await first.release();
    const second = await acquireProfileLease("profile-a", "start");
    await second.release();
  } finally {
    if (previous === undefined) delete process.env.CX_HOME;
    else process.env.CX_HOME = previous;
  }
});
