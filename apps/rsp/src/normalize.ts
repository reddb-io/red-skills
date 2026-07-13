import { readFileSync } from "node:fs";
import { decode, encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { resolveRspConfig } from "./config.js";
import type { RspElisionStore, RspLossLevel } from "./elision-store.js";

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

export interface GenericJsonLaneOptions {
  level?: RspLossLevel;
  minTokens?: number;
  maxItems?: number;
  command?: string;
  store?: Pick<RspElisionStore, "mint">;
}

export interface GenericJsonLaneResult {
  output: string;
  detected: boolean;
  lossy: boolean;
  totalItems?: number;
  keptItems?: number;
  handle?: `el:${string}`;
}

const DEFAULT_JSON_MIN_TOKENS = 200;
const DEFAULT_JSON_MAX_ITEMS = 15;

export async function renderGenericJsonLane(
  input: string,
  options: GenericJsonLaneOptions = {},
): Promise<GenericJsonLaneResult> {
  const parsed = parseJsonOrNdjson(input);
  if (!parsed) return { output: input, detected: false, lossy: false };

  const value = parsed.value;
  if (!Array.isArray(value)) {
    return { output: encode(value as JsonValue), detected: true, lossy: false };
  }

  const total = value.length;
  const minTokens = positiveInteger(options.minTokens, DEFAULT_JSON_MIN_TOKENS);
  const maxItems = positiveInteger(options.maxItems, DEFAULT_JSON_MAX_ITEMS);
  const shouldSelect = total > maxItems && estimateTokens(input) >= minTokens;
  if (!shouldSelect) {
    return { output: encode(value as JsonValue), detected: true, lossy: false, totalItems: total, keptItems: total };
  }

  const kept = selectJsonItems(value, maxItems);
  const payload = {
    items: kept as JsonValue,
  } satisfies JsonObject;
  const marker = `items: ${kept.length} of ${total} kept`;
  let handle: `el:${string}` | undefined;
  if (options.level && options.level !== "lossless") {
    handle = await options.store?.mint(Buffer.from(input), {
      command: options.command ?? "rsp json",
      loss: { level: options.level, bytes_elided: Buffer.byteLength(input) },
    });
  }
  const handleLine = handle
    ? `original: rsp show ${handle}`
    : `original: unavailable - re-run: ${options.command ?? "command"}`;
  return {
    output: [marker, handleLine, encode(payload)].filter(Boolean).join("\n"),
    detected: true,
    lossy: true,
    totalItems: total,
    keptItems: kept.length,
    handle,
  };
}

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

function parseJsonOrNdjson(input: string): { value: JsonObject | JsonValue[] } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed) || Array.isArray(parsed)) return { value: parsed as JsonObject | JsonValue[] };
    return null;
  } catch {}

  const rows: JsonValue[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as JsonValue);
    } catch {
      return null;
    }
  }
  return rows.length > 0 ? { value: rows } : null;
}

function selectJsonItems(items: readonly JsonValue[], maxItems: number): JsonValue[] {
  if (items.length <= maxItems) return [...items];
  const keep = new Set<number>();
  const edge = Math.max(1, Math.floor(maxItems * 0.2));
  for (let i = 0; i < edge; i++) {
    keep.add(i);
    keep.add(items.length - 1 - i);
  }

  for (let i = 0; i < items.length; i++) {
    if (isErrorShaped(items[i])) keep.add(i);
  }

  for (const i of numericAnomalyIndexes(items)) keep.add(i);
  for (const i of changePointIndexes(items)) keep.add(i);

  const stride = Math.max(1, Math.floor(items.length / Math.max(1, maxItems - keep.size)));
  for (let offset = 0; keep.size < maxItems && offset < stride; offset++) {
    for (let i = offset; keep.size < maxItems && i < items.length; i += stride) keep.add(i);
  }

  return [...keep].sort((a, b) => a - b).slice(0, maxItems).map((i) => items[i] as JsonValue);
}

function isErrorShaped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const level = value.level;
  if (typeof level === "string" && level.toLowerCase() === "error") return true;
  if (Object.prototype.hasOwnProperty.call(value, "error") && value.error) return true;
  const status = value.status;
  return typeof status === "number" && status >= 400;
}

function numericAnomalyIndexes(items: readonly JsonValue[]): number[] {
  const numbersByField = new Map<string, Array<{ index: number; value: number }>>();
  items.forEach((item, index) => {
    if (!isRecord(item)) return;
    for (const [key, value] of Object.entries(item)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const rows = numbersByField.get(key) ?? [];
      rows.push({ index, value });
      numbersByField.set(key, rows);
    }
  });

  const indexes = new Set<number>();
  for (const rows of numbersByField.values()) {
    if (rows.length < 3) continue;
    const mean = rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
    const variance = rows.reduce((sum, row) => sum + Math.pow(row.value - mean, 2), 0) / rows.length;
    const stddev = Math.sqrt(variance);
    if (stddev === 0) continue;
    for (const row of rows) {
      if (Math.abs(row.value - mean) > stddev * 2) indexes.add(row.index);
    }
  }
  return [...indexes];
}

function changePointIndexes(items: readonly JsonValue[]): number[] {
  const indexes = new Set<number>();
  for (let i = 1; i < items.length; i++) {
    const before = items[i - 1];
    const after = items[i];
    if (!isRecord(before) || !isRecord(after)) continue;
    for (const [key, value] of Object.entries(after)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const previous = before[key];
      if (typeof previous !== "number" || !Number.isFinite(previous)) continue;
      if (previous === 0 ? Math.abs(value) > 10 : Math.abs((value - previous) / previous) >= 2) indexes.add(i);
    }
  }
  return [...indexes];
}

function estimateTokens(input: string): number {
  return Math.ceil(input.length / 4);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
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
