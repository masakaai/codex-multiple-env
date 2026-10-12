import test from "node:test";
import assert from "node:assert/strict";
import { startupBanner, statusActiveProfileId, statusLimitLines } from "../src/terminal-ui.mjs";

test("status active profile follows the live proxy route and never the direct-mode default", () => {
  assert.equal(statusActiveProfileId({ proxyEnabled: true }, "default", "live"), "live");
  assert.equal(statusActiveProfileId({ proxyEnabled: true }, "default"), undefined);
  assert.equal(statusActiveProfileId({ proxyEnabled: false }, "default", "stale-live"), "default");
});

test("wide startup banner is aligned and contains project onboarding", () => {
  const banner = startupBanner("0.3.0", 80);
  const lines = banner.split("\n");
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);
  assert.match(banner, />_ masaka v0\.3\.0/);
  assert.match(banner, /https:\/\/github\.com\/masakaai\/codex-multiple-env/);
  assert.match(banner, /https:\/\/masaka-ai\.vercel\.app/);
  assert.match(banner, /Masaka AI \(@masakaai\)/);
  assert.match(banner, /\/status/);
  assert.match(banner, /\/use <name\|number>/);
  assert.match(banner, /\/add/);
});

test("narrow startup banner falls back to readable unboxed text", () => {
  const banner = startupBanner("0.3.0", 50);
  assert.match(banner, /^>_ masaka v0\.3\.0/m);
  assert.doesNotMatch(banner, /^╭/);
  assert.match(banner, /\/help/);
});

test("usage rows group Unicode limit names and never overflow for the progress bar", () => {
  const windows = [
    {
      limitId: "codex",
      limitName: "Codex",
      durationMins: 300,
      remainingPercent: 75,
      resetsAt: 2_000,
    },
    {
      limitId: "review",
      limitName: "代码审查",
      durationMins: 10080,
      remainingPercent: 60,
      resetsAt: 3_000,
    },
  ];
  const lines = statusLimitLines(windows, { columns: 80, now: 1_000_000 });
  assert.deepEqual(lines.filter((line) => !line.includes("[")), ["    Codex", "    代码审查"]);
  const rows = lines.filter((line) => line.includes("limit:"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].indexOf("["), rows[1].indexOf("["));
  assert.ok(rows.every((line) => line.length <= 80));
});

test("usage rows omit the bar when the complete row would exceed the terminal", () => {
  const lines = statusLimitLines([{
    limitName: "Codex",
    durationMins: 300,
    remainingPercent: 75,
    resetsAt: 2_000,
  }], { columns: 50, now: 1_000_000 });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[█░]/);
  assert.ok(lines[0].length <= 50);
  assert.match(lines[0], /75% left \(resets in 16m\)/);
});

test("a sole non-Codex bucket keeps its product heading", () => {
  const lines = statusLimitLines([{
    limitId: "review",
    limitName: "Code review",
    durationMins: 300,
    remainingPercent: 75,
  }], { columns: 80 });
  assert.equal(lines[0], "    Code review");
  assert.match(lines[1], /^      5h limit:/);
});

test("distinct buckets with matching names remain identifiable", () => {
  const lines = statusLimitLines([
    { limitId: "alpha", limitName: "Shared", durationMins: 300, remainingPercent: 75 },
    { limitId: "beta", limitName: "Shared", durationMins: 300, remainingPercent: 60 },
  ], { columns: 80 });
  assert.match(lines.join("\n"), /^    Shared \(alpha\)$/m);
  assert.match(lines.join("\n"), /^    Shared \(beta\)$/m);
  assert.equal(lines.filter((line) => /5h limit:/.test(line)).length, 2);
});
