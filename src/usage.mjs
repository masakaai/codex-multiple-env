function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const STATUS_LIMIT_BAR_SEGMENTS = 20;

export function compactDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function resetText(timestamp, now = Date.now()) {
  const seconds = number(timestamp);
  if (seconds === undefined) return "reset unknown";
  const delta = seconds - now / 1000;
  if (delta <= 0) return "reset due";
  return `resets in ${compactDuration(delta)}`;
}

export function limitWindows(result) {
  const source = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.values(result.rateLimitsByLimitId)
    : result?.rateLimits ? [result.rateLimits] : [];
  const rows = [];
  for (const bucket of source) {
    for (const [kind, window] of [["primary", bucket?.primary], ["secondary", bucket?.secondary]]) {
      if (!window) continue;
      const duration = number(window.windowDurationMins);
      const used = number(window.usedPercent);
      rows.push({
        limitId: bucket.limitId || "codex",
        limitName: bucket.limitName || bucket.limitId || "Codex",
        kind,
        durationMins: duration,
        usedPercent: used,
        remainingPercent: used === undefined ? undefined : Math.max(0, Math.min(100, 100 - used)),
        resetsAt: number(window.resetsAt),
        planType: bucket.planType,
        reachedType: bucket.rateLimitReachedType,
      });
    }
  }
  return rows.sort((left, right) => (left.durationMins ?? Infinity) - (right.durationMins ?? Infinity));
}

export function windowLabel(window) {
  if (window.durationMins === 300) return "5h";
  if (window.durationMins === 10080) return "7d";
  if (window.durationMins !== undefined && window.durationMins % 1440 === 0) return `${window.durationMins / 1440}d`;
  if (window.durationMins !== undefined && window.durationMins % 60 === 0) return `${window.durationMins / 60}h`;
  return window.durationMins === undefined ? window.kind : `${window.durationMins}m`;
}

export function statusWindowLabel(window) {
  if (window.durationMins === 300) return "5h limit";
  if (window.durationMins === 10080) return "Weekly limit";
  return `${windowLabel(window)} limit`;
}

export function progressBar(remainingPercent, width = STATUS_LIMIT_BAR_SEGMENTS) {
  const requestedWidth = number(width);
  const segments = requestedWidth === undefined
    ? STATUS_LIMIT_BAR_SEGMENTS
    : Math.max(1, Math.floor(requestedWidth));
  const remaining = number(remainingPercent);
  if (remaining === undefined) return undefined;
  const ratio = Math.max(0, Math.min(100, remaining)) / 100;
  const filled = Math.min(segments, Math.round(ratio * segments));
  return `[${"█".repeat(filled)}${"░".repeat(segments - filled)}]`;
}

export function formatWindow(window, now = Date.now(), options = {}) {
  const remaining = window.remainingPercent === undefined ? "remaining unknown" : `${Math.round(window.remainingPercent)}% left`;
  const bar = options.showBar === false ? undefined : progressBar(window.remainingPercent);
  return `${bar ? `${bar} ` : ""}${remaining} (${resetText(window.resetsAt, now)})`;
}

export function resetCredits(result) {
  const value = result?.rateLimitResetCredits;
  if (!value) return { availableCount: undefined, credits: [] };
  return {
    availableCount: number(value.availableCount),
    credits: Array.isArray(value.credits) ? value.credits : [],
  };
}

export function workspaceCredits(result) {
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.values(result.rateLimitsByLimitId)
    : result?.rateLimits ? [result.rateLimits] : [];
  const credits = buckets.map((bucket) => bucket?.credits).find((value) => value?.hasCredits);
  if (!credits) return undefined;
  if (credits.unlimited) return { unlimited: true, balance: undefined };
  const balance = typeof credits.balance === "string" ? Number(credits.balance.trim()) : Number.NaN;
  if (!Number.isFinite(balance) || balance <= 0) return undefined;
  return { unlimited: false, balance: Math.round(balance) };
}

export function formatWorkspaceCredits(result) {
  const credits = workspaceCredits(result);
  if (!credits) return undefined;
  return credits.unlimited ? "Credits: Unlimited" : `Credits: ${credits.balance.toLocaleString()} credits`;
}
