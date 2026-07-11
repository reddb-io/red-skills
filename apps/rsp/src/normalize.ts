import { readFileSync } from "node:fs";
import { decode, encode } from "@reddb-io/toon";
import { resolveRspConfig } from "./config.js";

export interface NormalizeEntry {
  readonly id: string;
  readonly apply: (input: string) => string;
}

// Entry 1: Strip ANSI/VT escape sequences (colours, cursor movement, OSC, C1 CSI).
// Covers OSC (ESC ] text BEL/ST) and CSI sequences (ESC [ params final, or C1 0x9b params final).
export const NORMALIZE_ANSI: NormalizeEntry = {
  id: "ansi",
  apply: stripAnsi,
};

// Entry 2: Collapse CR-based progress bars to their final frame.
// CRLF line endings are also converted to LF as a side effect.
export const NORMALIZE_CR_PROGRESS: NormalizeEntry = {
  id: "cr-progress",
  apply: (input) =>
    input
      .split("\n")
      .map((line) => {
        // Strip trailing \r first so CRLF endings don't look like overwrite frames
        const base = line.endsWith("\r") ? line.slice(0, -1) : line;
        const lastCr = base.lastIndexOf("\r");
        return lastCr >= 0 ? base.slice(lastCr + 1) : base;
      })
      .join("\n"),
};

// Entry 3: Strip trailing spaces and tabs from every line
export const NORMALIZE_TRAILING_WHITESPACE: NormalizeEntry = {
  id: "trailing-whitespace",
  apply: (input) =>
    input
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n"),
};

// Entry 4: Collapse three or more consecutive newlines to two (one blank line)
export const NORMALIZE_BLANK_LINES: NormalizeEntry = {
  id: "blank-lines",
  apply: (input) => input.replace(/\n{3,}/g, "\n\n"),
};

// Entry 5: Lossless JSON→TOON transcode, guarded per-invocation by a round-trip check.
// Any encode/decode failure or deep-equality mismatch ⇒ byte-identical passthrough.
export function transcodeJsonToToon(
  input: string,
  deps?: { encode?: (value: unknown) => string; decode?: (input: string) => unknown },
): string {
  const enc = deps?.encode ?? encode;
  const dec = deps?.decode ?? decode;

  const trimmed = input.trimEnd();
  if (!trimmed) return input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return input;
  }
  let encoded: string;
  try {
    encoded = enc(parsed);
  } catch {
    return input;
  }
  let roundTripped: unknown;
  try {
    roundTripped = dec(encoded);
  } catch {
    return input;
  }
  if (!deepEqual(parsed, roundTripped)) return input;
  return encoded;
}

export const NORMALIZE_JSON_TOON: NormalizeEntry = {
  id: "json-to-toon",
  apply: (input) => transcodeJsonToToon(input),
};

export const NORMALIZATION_ALLOWLIST: readonly NormalizeEntry[] = [
  NORMALIZE_ANSI,
  NORMALIZE_CR_PROGRESS,
  NORMALIZE_TRAILING_WHITESPACE,
  NORMALIZE_BLANK_LINES,
  NORMALIZE_JSON_TOON,
];

export function normalizeOutput(input: string): string {
  let out = input;
  for (const entry of NORMALIZATION_ALLOWLIST) out = entry.apply(out);
  return out;
}

// ───── PostToolUse hook integration ──────────────────────────────────────────

export interface NormalizeHookOptions {
  cwd: string;
  isEnabled?: (cwd: string) => boolean | Promise<boolean>;
  normalize?: (output: string) => string;
}

export type NormalizeDecision =
  | { kind: "normalized"; output: string }
  | { kind: "passthrough"; reason?: string };

export async function hookDecisionFromClaudePostExecJson(
  raw: string,
  options: NormalizeHookOptions,
): Promise<NormalizeDecision> {
  const payload = parseJsonRecord(raw);
  const cwd = stringAt(payload, ["cwd"]) || options.cwd;
  const enabled = await (options.isEnabled ?? isRspNormalizeEnabled)(cwd);
  if (!enabled) return { kind: "passthrough", reason: "disabled" };

  const toolResponse = recordAt(payload, "tool_response");
  if (!toolResponse) return { kind: "passthrough", reason: "missing-output" };
  if (typeof toolResponse["output"] !== "string") return { kind: "passthrough", reason: "missing-output" };
  const output = toolResponse["output"] as string;

  const doNormalize = options.normalize ?? normalizeOutput;
  const normalized = doNormalize(output);
  if (normalized === output) return { kind: "passthrough", reason: "no-change" };

  return { kind: "normalized", output: normalized };
}

export function formatNormalizeDecision(decision: NormalizeDecision): { stdout: string; status: number } {
  if (decision.kind === "normalized") {
    return { stdout: JSON.stringify({ tool_response: { output: decision.output } }), status: 0 };
  }
  return { stdout: "", status: 0 };
}

export async function runClaudePostExecHook(stdinPath?: string): Promise<number> {
  const raw = stdinPath ? readFileSync(stdinPath, "utf8") : readFileSync(0, "utf8");
  const decision = await hookDecisionFromClaudePostExecJson(raw, { cwd: process.cwd() });
  const formatted = formatNormalizeDecision(decision);
  if (formatted.stdout) process.stdout.write(formatted.stdout);
  return formatted.status;
}

// ───── Private helpers ────────────────────────────────────────────────────────

function stripAnsi(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    // ESC (0x1b) — start of a VT sequence
    if (ch === 0x1b) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x5d) {
        // OSC: ESC ] ... BEL (0x07) or ST (ESC \)
        i += 2;
        while (i < input.length) {
          const c = input.charCodeAt(i);
          if (c === 0x07) { i++; break; }
          if (c === 0x1b && input.charCodeAt(i + 1) === 0x5c) { i += 2; break; }
          i++;
        }
        continue;
      }
      if (next === 0x5b) {
        // CSI: ESC [ <params> <final>
        i += 2;
        while (i < input.length && isAnsiParam(input.charCodeAt(i))) i++;
        if (i < input.length) i++; // consume final byte
        continue;
      }
      // Other two-char ESC sequences — skip both
      i += next >= 0x20 ? 2 : 1;
      continue;
    }
    // C1 CSI (0x9b) — equivalent to ESC [
    if (ch === 0x9b) {
      i++;
      while (i < input.length && isAnsiParam(input.charCodeAt(i))) i++;
      if (i < input.length) i++; // consume final byte
      continue;
    }
    out += input[i++];
  }
  return out;
}

// ANSI parameter bytes: 0x20–0x3f (includes digits, semicolons, intro chars like ?)
function isAnsiParam(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

function isRspNormalizeEnabled(cwd: string): boolean {
  return resolveRspConfig(cwd, process.env).enabled;
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringAt(record: Record<string, unknown>, path: readonly string[]): string {
  let cursor: unknown = record;
  for (const key of path) {
    if (!isRecord(cursor)) return "";
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : "";
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const val = record[key];
  return isRecord(val) ? val : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    return a.every((item, i) => deepEqual(item, bArr[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]));
}
