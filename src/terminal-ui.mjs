import { formatWindow, statusWindowLabel } from "./usage.mjs";

export const PROJECT_LINKS = Object.freeze({
  github: "https://github.com/masakaai/codex-multiple-env",
  website: "https://masaka-ai.vercel.app",
  author: "Masaka AI (@masakaai)",
});

const WIDE_BANNER_MIN_COLUMNS = 72;
const WIDE_BANNER_MAX_COLUMNS = 76;

function boxLine(content, width) {
  const available = width - 4;
  return `│ ${content.padEnd(available)} │`;
}

export function startupBanner(version, columns = 80) {
  const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  const lines = [
    `>_ masaka v${version}`,
    "Native Codex account & workspace manager",
    "",
    `GitHub   ${PROJECT_LINKS.github}`,
    `Website  ${PROJECT_LINKS.website}`,
    `Author   ${PROJECT_LINKS.author}`,
    "",
    "Start    /status  /profiles  /use <name|number>  /add",
    "More     /usage  /renew  /delete  /help",
  ];

  if (safeColumns < WIDE_BANNER_MIN_COLUMNS) return lines.join("\n");

  const width = Math.min(safeColumns, WIDE_BANNER_MAX_COLUMNS);
  const horizontal = "─".repeat(width - 2);
  return [
    `╭${horizontal}╮`,
    ...lines.map((line) => boxLine(line, width)),
    `╰${horizontal}╯`,
  ].join("\n");
}

export function statusLimitLines(windows, options = {}) {
  if (!windows.length) return [];
  const columns = Number.isFinite(options.columns)
    ? Math.max(1, Math.floor(options.columns))
    : Infinity;
  const now = options.now ?? Date.now();
  const groups = new Map();
  for (const window of windows) {
    const name = window.limitName || "Codex";
    const id = window.limitId || name;
    if (!groups.has(id)) groups.set(id, { id, name, windows: [] });
    groups.get(id).windows.push(window);
  }

  const values = [...groups.values()];
  const sole = values[0];
  const soleIsDefault = groups.size === 1
    && (sole.id.toLocaleLowerCase() === "codex" || sole.name.toLocaleLowerCase() === "codex");
  const grouped = !soleIsDefault;
  const nameCounts = new Map();
  for (const group of values) nameCounts.set(group.name, (nameCounts.get(group.name) || 0) + 1);
  const labelWidth = Math.max(...windows.map((window) => statusWindowLabel(window).length));
  const rowIndent = grouped ? "      " : "    ";
  const lines = [];

  for (const group of values) {
    if (grouped) {
      const duplicateName = nameCounts.get(group.name) > 1;
      lines.push(`    ${duplicateName ? `${group.name} (${group.id})` : group.name}`);
    }
    for (const window of group.windows) {
      const label = `${statusWindowLabel(window)}:`.padEnd(labelWidth + 2);
      const prefix = `${rowIndent}${label}`;
      const withBar = `${prefix}${formatWindow(window, now)}`;
      lines.push(withBar.length <= columns
        ? withBar
        : `${prefix}${formatWindow(window, now, { showBar: false })}`);
    }
  }
  return lines;
}
