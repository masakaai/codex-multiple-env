import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseAutomaticProfile,
  effectiveProfileOrder,
  inferProfileTier,
  profilePolicyCandidate,
} from "../src/proxy-policy.mjs";

function candidate(id, planType, remainingPercent, options = {}) {
  return {
    profile: { id, label: options.label || id, planType },
    fiveHour: options.noFiveHour ? undefined : { remainingPercent },
    snapshotAvailable: options.snapshotAvailable !== false,
  };
}

test("automatic proxy order prefers plan priority, then uncapped profiles and remaining capacity", () => {
  const profiles = [
    candidate("pro-low", "pro", 20),
    candidate("business-full", "business", 100),
    candidate("pro-high", "pro", 80),
    candidate("pro-unlimited", "pro", undefined, { noFiveHour: true }),
  ];
  assert.deepEqual(
    effectiveProfileOrder(profiles, {}),
    ["pro-unlimited", "pro-high", "pro-low", "business-full"],
  );
});

test("same-tier profiles without a five-hour cap prefer greater remaining capacity", () => {
  const profile = (id, usedPercent) => profilePolicyCandidate(
    { id, label: id, planType: "business" },
    { value: { limits: { rateLimits: {
      limitId: "codex",
      secondary: { usedPercent, windowDurationMins: 10_080 },
    } } } },
  );
  assert.deepEqual(
    effectiveProfileOrder([profile("lower", 60), profile("higher", 10)], {}),
    ["higher", "lower"],
  );
});

test("automatic selection is sticky until the active five-hour allowance reaches five percent", () => {
  const profiles = [
    candidate("pro-a", "pro", 70),
    candidate("pro-b", "pro", 90),
  ];
  assert.equal(chooseAutomaticProfile(profiles, { activeProfileId: "pro-a", thresholdPercent: 5 }), "pro-a");
  profiles[0].fiveHour.remainingPercent = 5;
  assert.equal(chooseAutomaticProfile(profiles, { activeProfileId: "pro-a", thresholdPercent: 5 }), "pro-b");
});

test("manual account order overrides automatic tier sorting but still skips depleted accounts", () => {
  const profiles = [
    candidate("pro", "pro", 90),
    candidate("team", "team", 80),
    candidate("plus", "plus", 70),
  ];
  const settings = { orderMode: "manual", order: ["plus", "team", "pro"], thresholdPercent: 5 };
  assert.deepEqual(effectiveProfileOrder(profiles, settings), ["plus", "team", "pro"]);
  profiles[0].fiveHour.remainingPercent = 1;
  assert.equal(chooseAutomaticProfile(profiles, { ...settings, activeProfileId: "pro" }), "plus");
});

test("default plan priority recognizes supported plan types", () => {
  assert.equal(inferProfileTier({ planType: "pro", label: "Primary" }), 20);
  assert.equal(inferProfileTier({ planType: "pro", label: "Backup 10x" }), 20);
  assert.equal(inferProfileTier({ planType: "self_serve_business_prolite", label: "Business" }), 5);
  assert.equal(inferProfileTier({ planType: "business", label: "Business" }), 5);
  assert.equal(inferProfileTier({ planType: "plus", label: "Personal" }), 1);
});

test("multiple five-hour buckets use the most depleted bucket for switching", () => {
  const profile = { id: "a", label: "A", planType: "pro" };
  const candidate = profilePolicyCandidate(profile, {
    value: {
      limits: {
        rateLimitsByLimitId: {
          codex: { limitId: "codex", primary: { usedPercent: 20, windowDurationMins: 300 } },
          extra: { limitId: "extra", primary: { usedPercent: 96, windowDurationMins: 300 } },
        },
      },
    },
  });
  assert.equal(candidate.fiveHour.remainingPercent, 4);
});
