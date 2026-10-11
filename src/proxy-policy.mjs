import { limitWindows } from "./usage.mjs";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function inferProfileTier(profile) {
  const plan = String(profile?.planType || "").toLocaleLowerCase();
  if (plan.includes("enterprise") || plan === "pro" || plan.startsWith("pro_")) return 20;
  if (plan.includes("business") || plan === "team") return 5;
  return 1;
}

export function profilePolicyCandidate(profile, snapshotResult) {
  if (!snapshotResult || snapshotResult.error || !snapshotResult.value) {
    return { profile, snapshotAvailable: false, fiveHour: undefined, remainingPercent: undefined };
  }
  const windows = limitWindows(snapshotResult.value.limits);
  const fiveHour = windows
    .filter((window) => window.durationMins === 300)
    .sort((left, right) => (finite(left.remainingPercent) ?? Infinity) - (finite(right.remainingPercent) ?? Infinity))[0];
  const knownRemaining = windows.map((window) => finite(window.remainingPercent)).filter((value) => value !== undefined);
  return {
    profile,
    snapshotAvailable: true,
    fiveHour,
    // The tightest returned window is the useful capacity when two Profiles
    // have the same multiplier. Five-hour presence is ranked separately.
    remainingPercent: knownRemaining.length ? Math.min(...knownRemaining) : undefined,
  };
}

function tierFor(candidate) {
  return inferProfileTier(candidate.profile);
}

function healthRank(candidate, threshold) {
  if (!candidate.snapshotAvailable) return 3;
  if (!candidate.fiveHour) return 0;
  const remaining = finite(candidate.fiveHour.remainingPercent);
  if (remaining === undefined) return 2;
  return remaining <= threshold ? 2 : 1;
}

export function effectiveProfileOrder(candidates, settings = {}) {
  const threshold = finite(settings.thresholdPercent) ?? 5;
  const inputIndex = new Map(candidates.map((candidate, index) => [candidate.profile.id, index]));
  if (settings.orderMode === "manual" && Array.isArray(settings.order)) {
    const orderIndex = new Map(settings.order.map((id, index) => [id, index]));
    return [...candidates]
      .sort((left, right) => (orderIndex.get(left.profile.id) ?? Infinity) - (orderIndex.get(right.profile.id) ?? Infinity)
        || inputIndex.get(left.profile.id) - inputIndex.get(right.profile.id))
      .map((candidate) => candidate.profile.id);
  }
  return [...candidates]
    .sort((left, right) => tierFor(right) - tierFor(left)
      || healthRank(left, threshold) - healthRank(right, threshold)
      || (finite(right.remainingPercent) ?? finite(right.fiveHour?.remainingPercent) ?? -1)
        - (finite(left.remainingPercent) ?? finite(left.fiveHour?.remainingPercent) ?? -1)
      || inputIndex.get(left.profile.id) - inputIndex.get(right.profile.id))
    .map((candidate) => candidate.profile.id);
}

function isUsable(candidate, threshold, unavailable) {
  if (!candidate || unavailable.has(candidate.profile.id) || !candidate.snapshotAvailable) return false;
  if (!candidate.fiveHour) return true;
  const remaining = finite(candidate.fiveHour.remainingPercent);
  return remaining !== undefined && remaining > threshold;
}

export function chooseAutomaticProfile(candidates, settings = {}) {
  if (!candidates.length) return undefined;
  const threshold = finite(settings.thresholdPercent) ?? 5;
  const unavailable = new Set(settings.unavailableProfileIds || []);
  const byId = new Map(candidates.map((candidate) => [candidate.profile.id, candidate]));
  const active = byId.get(settings.activeProfileId);

  // A temporary snapshot failure is not sufficient reason to destroy prompt
  // cache locality. Explicit proxy INVALID/COOLDOWN state still forces a move.
  if (active && !unavailable.has(active.profile.id)
      && (!active.snapshotAvailable || isUsable(active, threshold, unavailable))) {
    return active.profile.id;
  }

  const ordered = effectiveProfileOrder(candidates, settings);
  return ordered.find((id) => isUsable(byId.get(id), threshold, unavailable))
    || ordered.find((id) => !unavailable.has(id));
}
