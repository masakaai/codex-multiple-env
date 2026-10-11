import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWindow,
  limitWindows,
  progressBar,
  resetCredits,
  statusWindowLabel,
  windowLabel,
  workspaceCredits,
  formatWorkspaceCredits,
} from "../src/usage.mjs";

test("rate-limit snapshots identify five-hour and weekly windows", () => {
  const windows = limitWindows({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2000 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 3000 },
    },
  });
  assert.deepEqual(windows.map(windowLabel), ["5h", "7d"]);
  assert.deepEqual(windows.map(statusWindowLabel), ["5h limit", "Weekly limit"]);
  assert.equal(progressBar(80), "[████████████████░░░░]");
  assert.equal(formatWindow(windows[0], 1_000_000), "[████████████████░░░░] 80% left (resets in 16m)");
});

test("reset-card count remains authoritative when details are capped", () => {
  assert.deepEqual(resetCredits({
    rateLimitResetCredits: { availableCount: 5, credits: [{ id: "one" }] },
  }), { availableCount: 5, credits: [{ id: "one" }] });
});

test("workspace credits mirror native Codex rounding and hiding rules", () => {
  assert.deepEqual(workspaceCredits({
    rateLimits: { credits: { hasCredits: true, unlimited: false, balance: "60780.793505" } },
  }), { unlimited: false, balance: 60781 });
  assert.equal(formatWorkspaceCredits({
    rateLimits: { credits: { hasCredits: true, unlimited: false, balance: "60780.793505" } },
  }), "Credits: 60,781 credits");
  assert.equal(formatWorkspaceCredits({
    rateLimits: { credits: { hasCredits: true, unlimited: true, balance: null } },
  }), "Credits: Unlimited");
  assert.equal(formatWorkspaceCredits({
    rateLimits: { credits: { hasCredits: true, unlimited: false, balance: null } },
  }), undefined);
});
