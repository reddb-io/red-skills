export const CODEX_STATUSLINE_RECOMMENDED = [
  "project",
  "git-branch",
  "model-with-reasoning",
  "context-remaining",
  "task-progress",
] as const;

export interface CodexStatuslineInspection {
  statusLine: string[] | null;
  hidden: boolean;
  hasTaskProgress: boolean;
  problem: "missing-tui" | "missing-status-line" | "hidden" | "missing-task-progress" | null;
  parseError?: string;
}

function splitLines(text: string): string[] {
  return text.split(/\n/);
}

function findTuiSection(lines: readonly string[]): { header: number; end: number } | null {
  let header = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[tui\]\s*(#.*)?$/.test(lines[i])) {
      header = i;
      break;
    }
  }
  if (header < 0) return null;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { header, end };
}

function stripTomlComment(value: string): string {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (ch === "#" && !inString) return value.slice(0, i).trimEnd();
  }
  return value.trimEnd();
}

function findStatusLine(lines: readonly string[], section: { header: number; end: number }): number {
  for (let i = section.header + 1; i < section.end; i++) {
    if (/^\s*status_line\s*=/.test(lines[i])) return i;
  }
  return -1;
}

function parseStatusLineValue(line: string): { value: string[] | null; parseError?: string } {
  const eq = line.indexOf("=");
  if (eq < 0) return { value: null, parseError: "missing '=' in status_line" };
  const raw = stripTomlComment(line.slice(eq + 1).trim());
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item): item is string => typeof item === "string")
    ) {
      return { value: parsed };
    }
    return { value: null, parseError: "status_line must be an array of strings" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: null, parseError: message };
  }
}

export function inspectCodexStatuslineConfig(text: string): CodexStatuslineInspection {
  const lines = splitLines(text);
  const section = findTuiSection(lines);
  if (section === null) {
    return {
      statusLine: null,
      hidden: false,
      hasTaskProgress: false,
      problem: "missing-tui",
    };
  }
  const statusLineIdx = findStatusLine(lines, section);
  if (statusLineIdx < 0) {
    return {
      statusLine: null,
      hidden: false,
      hasTaskProgress: false,
      problem: "missing-status-line",
    };
  }
  const parsed = parseStatusLineValue(lines[statusLineIdx]);
  if (parsed.value === null) {
    return {
      statusLine: null,
      hidden: false,
      hasTaskProgress: false,
      problem: "missing-task-progress",
      parseError: parsed.parseError,
    };
  }
  const hidden = parsed.value.length === 0;
  const hasTaskProgress = parsed.value.includes("task-progress");
  return {
    statusLine: parsed.value,
    hidden,
    hasTaskProgress,
    problem: hidden ? "hidden" : hasTaskProgress ? null : "missing-task-progress",
  };
}

export function formatCodexStatusLine(items: readonly string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
}

export function ensureCodexTaskProgress(text: string): string {
  const lines = splitLines(text);
  const section = findTuiSection(lines);
  if (section === null) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push("[tui]", `status_line = ${formatCodexStatusLine(CODEX_STATUSLINE_RECOMMENDED)}`, "");
    return out.join("\n");
  }

  const statusLineIdx = findStatusLine(lines, section);
  if (statusLineIdx < 0) {
    const out = [...lines];
    out.splice(section.header + 1, 0, `status_line = ${formatCodexStatusLine(CODEX_STATUSLINE_RECOMMENDED)}`);
    return out.join("\n");
  }

  const parsed = parseStatusLineValue(lines[statusLineIdx]);
  const current = parsed.value;
  if (current === null || current.length === 0 || current.includes("task-progress")) return text;

  const next = [...current];
  const afterCurrentDir = next.indexOf("current-dir");
  next.splice(afterCurrentDir >= 0 ? afterCurrentDir + 1 : next.length, 0, "task-progress");

  const indent = lines[statusLineIdx].match(/^\s*/)?.[0] ?? "";
  const out = [...lines];
  out[statusLineIdx] = `${indent}status_line = ${formatCodexStatusLine(next)}`;
  return out.join("\n");
}
