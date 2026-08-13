import type { ValidationStatus } from "./feedback.js";

/** Strip ANSI SGR sequences so identity matching survives coloured runner output. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Patterns that name which check failed, rather than only how many did. */
const FAILURE_IDENTITY_PATTERNS: readonly RegExp[] = [
  /^\s*FAIL\s+\S.*$/,
  /^\s*\S.*\.{3}\s+FAILED\s*$/,
  /^\s*----\s+\S.*\s+stdout\s+----\s*$/,
];

const MAX_NAMED_FAILURES = 5;

/** Return distinct failing identities in first-seen order. */
export function namedFailures(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = stripAnsi(raw).replace(/\s+/g, " ").trim();
    if (line === "") continue;
    if (!FAILURE_IDENTITY_PATTERNS.some((pattern) => pattern.test(line))) continue;
    seen.add(line);
    if (seen.size >= MAX_NAMED_FAILURES) break;
  }
  return [...seen];
}

/** Build the bounded, actionable summary stored with one finished check. */
export function outputSummary(status: ValidationStatus, output: string): string {
  if (status === "passed") return "command exited 0";
  const trimmed = output.replace(/\n+$/, "");
  if (trimmed === "") return "command exited non-zero";
  const tail = trimmed.split("\n").slice(-20).join(" ");
  const named = namedFailures(trimmed);
  if (named.length === 0) return tail.slice(0, 1000);
  return `failing: ${named.join(" | ")} — ${tail}`.slice(0, 1000);
}
