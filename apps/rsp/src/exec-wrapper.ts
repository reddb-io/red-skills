import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { startChildProcessTimer } from "./overhead-budget.js";
import { decode, encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { scoreStructuralOutliers, type PreservedOutlierLine } from "./anomaly-scorer.js";
import { type RspMintMeta, type RspLossLevel } from "./elision-store.js";
import { recoveryInstruction, type GitRenderResult, type RecordedGitContract } from "./git-wrapper.js";
import {
  crushJsonArrayItems,
  NORMALIZE_ANSI,
  NORMALIZE_BLANK_LINES,
  NORMALIZE_CR_PROGRESS,
  NORMALIZE_TRAILING_WHITESPACE,
  type JsonArrayCrusher,
} from "./normalize.js";
import { classifyWrappedFailure, renderStructuredError } from "./structured-error.js";

export interface ExecRenderOptions {
  level: RspLossLevel;
  store?: RspMintStore;
  heavyByteThreshold?: number;
  anomalyScorer?: (text: string, options: { headBytes: number; tailStart: number }) => PreservedOutlierLine[];
  jsonArrayCrusher?: JsonArrayCrusher;
}

interface RspMintStore {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
}

const DEFAULT_EXEC_HEAVY_BYTE_THRESHOLD = 8 * 1024;
const BRIEF_INLINE_BYTES = 2 * 1024;
const TERSE_INLINE_BYTES = 1024;
const MAX_SUMMARY_STRING = 240;

type ExecContentKind = "json" | "jsonl" | "unified-diff" | "tabular" | "log-like" | "prose" | "untyped" | "bytes";

interface ExecSummaryRenderResult {
  text: string;
  degradation?: GitRenderResult["degradation"];
}

export async function runExecWrapper(argv: readonly string[], options: ExecRenderOptions): Promise<GitRenderResult> {
  const commandLine = parseExecCommandLine(argv);
  const contract = await collectShellContract(commandLine);
  return await renderExecContract(commandLine, contract, options);
}

export async function renderExecContract(
  commandLine: string,
  contract: RecordedGitContract,
  options: ExecRenderOptions,
): Promise<GitRenderResult> {
  const rawStdout = Buffer.from(contract.stdout, "binary");
  const stderr = Buffer.from(contract.stderr, "binary");
  if ((contract.status ?? 0) !== 0 || contract.signal) {
    const error = classifyWrappedFailure(commandLine, contract.stdout, contract.stderr);
    return {
      stdout: renderStructuredError(error),
      stderr,
      status: error.exitCode ?? 1,
      signal: contract.signal,
      rawOutput: rawStdout,
    };
  }
  if (rawStdout.length === 0) {
    return {
      stdout: rawStdout,
      stderr,
      status: contract.status,
      signal: contract.signal,
      rawOutput: rawStdout,
    };
  }

  const normalized = renderNormalizedStdout(rawStdout);
  const emitted = normalized.kind === "text" ? Buffer.from(normalized.text) : rawStdout;
  const threshold = positiveNumber(options.heavyByteThreshold, DEFAULT_EXEC_HEAVY_BYTE_THRESHOLD);
  if (emitted.length <= threshold && options.level !== "terse") {
    return {
      stdout: emitted,
      stderr,
      status: contract.status,
      signal: contract.signal,
      rawOutput: rawStdout,
    };
  }

  const bytesElided = rawStdout.length;
  const lossLevel = options.level === "lossless" ? "terse" : options.level;
  const handle = await options.store?.mint(rawStdout, {
    command: commandLine,
    loss: { level: lossLevel, bytes_elided: bytesElided },
  });
  if (!handle) throw new Error("rsp exec output elision requires an elision store");

  const rendered = normalized.kind === "text"
    ? renderRoutedTextSummary(normalized.text, rawStdout.length, handle, options.level, commandLine, options.anomalyScorer, options.jsonArrayCrusher)
    : renderBytesSummary(rawStdout, rawStdout.length, handle, commandLine);
  return {
    stdout: Buffer.from(rendered.text),
    stderr,
    status: contract.status,
    signal: contract.signal,
    mintedHandle: handle,
    bytesElided,
    rawOutput: rawStdout,
    degradation: rendered.degradation,
  };
}

export function parseExecCommandLine(argv: readonly string[]): string {
  if (argv[0] !== "exec") throw new Error("expected rsp exec -- <command line>");
  const separator = argv.indexOf("--");
  const parts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
  const commandLine = parts.length === 1 ? parts[0]! : parts.join(" ");
  if (!commandLine.trim()) throw new Error("usage: rsp exec -- <command line>");
  return commandLine;
}

async function collectShellContract(commandLine: string): Promise<RecordedGitContract> {
  const child = spawn(commandLine, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  // The wrapped command's own runtime is never rsp's overhead (#2746).
  const stopChildTimer = startChildProcessTimer();
  child.once("close", stopChildTimer);
  child.once("error", stopChildTimer);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("binary"),
        stderr: Buffer.concat(stderr).toString("binary"),
        status,
        signal,
      });
    });
  });
}

function renderNormalizedStdout(stdout: Buffer): { kind: "text"; text: string } | { kind: "bytes" } {
  if (!isUtf8(stdout)) return { kind: "bytes" };
  return { kind: "text", text: normalizeExecText(stdout.toString("utf8")) };
}

function normalizeExecText(input: string): string {
  let out = input;
  for (const entry of [NORMALIZE_ANSI, NORMALIZE_CR_PROGRESS, NORMALIZE_TRAILING_WHITESPACE, NORMALIZE_BLANK_LINES]) {
    out = entry.apply(out);
  }
  return out;
}

function renderRoutedTextSummary(
  stdout: string,
  rawBytes: number,
  handle: string,
  level: RspLossLevel,
  command: string,
  anomalyScorer = defaultAnomalyScorer,
  jsonArrayCrusher = crushJsonArrayItems,
): ExecSummaryRenderResult {
  const inlineBytes = level === "terse" ? TERSE_INLINE_BYTES : BRIEF_INLINE_BYTES;
  const half = Math.max(1, Math.floor(inlineBytes / 2));
  const stdoutBytes = Buffer.from(stdout);
  const tailStart = Math.max(0, stdoutBytes.length - half);
  const outliers = preservedOutliers(stdout, half, tailStart, anomalyScorer);
  const kind = classifyExecContent(stdout);
  const routed = summarizeByKind(kind, stdout, stdoutBytes, half, tailStart, outliers.kind === "ok" ? outliers.lines : [], jsonArrayCrusher);
  const payload = baseSummary(command, kind, rawBytes, countLines(stdoutBytes), handle, routed.summary);
  const degradation = outliers.kind === "failed"
    ? {
      reason: "exec-anomaly-scorer-failed",
      family: "exec",
      stderrHead: truncateDiagnostic(outliers.error),
    }
    : routed.degradation;
  return {
    text: encodeToonDocument(payload),
    degradation,
  };
}

function renderBytesSummary(stdout: Buffer, rawBytes: number, handle: string, command: string): ExecSummaryRenderResult {
  const half = Math.max(1, Math.floor(TERSE_INLINE_BYTES / 2));
  const summary = {
    head_hex: stdout.subarray(0, half).toString("hex"),
    tail_hex: stdout.subarray(Math.max(0, stdout.length - half)).toString("hex"),
  } satisfies JsonObject;
  return {
    text: encodeToonDocument(baseSummary(command, "bytes", rawBytes, 0, handle, summary)),
  };
}

function baseSummary(
  command: string,
  content: ExecContentKind,
  bytes: number,
  lines: number,
  handle: string,
  summary: JsonObject,
): JsonObject {
  return {
    family: "exec",
    command,
    content,
    bytes,
    lines,
    summary,
    recovery: { original: recoveryInstruction(handle) },
  };
}

function classifyExecContent(input: string): ExecContentKind {
  const trimmed = input.trim();
  if (!trimmed) return "untyped";
  if (parseJsonContainer(trimmed)) return "json";
  if (parseJsonLines(input)) return "jsonl";
  if (isUnifiedDiff(input)) return "unified-diff";
  if (parseTable(input)) return "tabular";
  if (isLogLike(input)) return "log-like";
  if (isProse(input)) return "prose";
  return "untyped";
}

function summarizeByKind(
  kind: ExecContentKind,
  stdout: string,
  stdoutBytes: Buffer,
  headBytes: number,
  tailStart: number,
  outliers: readonly PreservedOutlierLine[],
  jsonArrayCrusher = crushJsonArrayItems,
): { summary: JsonObject; degradation?: GitRenderResult["degradation"] } {
  switch (kind) {
    case "json":
      return summarizeJson(stdout, jsonArrayCrusher);
    case "jsonl":
      return { summary: summarizeJsonLines(stdout) };
    case "unified-diff":
      return { summary: summarizeUnifiedDiff(stdout) };
    case "tabular":
      return { summary: summarizeTable(stdout) };
    case "log-like":
      return { summary: summarizeLog(stdout, outliers) };
    case "prose":
      return { summary: summarizeProse(stdout) };
    case "bytes":
      return { summary: {} };
    case "untyped":
      return { summary: summarizeUntyped(stdoutBytes, headBytes, tailStart, outliers) };
  }
}

function summarizeJson(input: string, jsonArrayCrusher: JsonArrayCrusher): { summary: JsonObject; degradation?: GitRenderResult["degradation"] } {
  const value = parseJsonContainer(input) as JsonValue;
  if (Array.isArray(value)) {
    if (value.length > 15) {
      try {
        const crushed = jsonArrayCrusher(value, 15);
        return {
          summary: {
            root_type: "array",
            total: crushed.total,
            kept: crushed.kept,
            dropped: crushed.dropped,
            shape_outliers: crushed.shapeOutliers,
            value_outliers: crushed.valueOutliers,
            items: crushed.items.map(compactJsonValue) as JsonValue[],
            item_keys: commonKeys(value),
          },
        };
      } catch (error) {
        return {
          summary: summarizeJsonArraySample(value),
          degradation: {
            reason: "exec-json-array-crusher-failed",
            family: "exec",
            stderrHead: truncateDiagnostic(error),
          },
        };
      }
    }
    return { summary: summarizeJsonArraySample(value) };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return {
      summary: {
        root_type: "object",
        keys: entries.map(([key]) => key).slice(0, 20),
        key_count: entries.length,
        sample: Object.fromEntries(entries.slice(0, 8).map(([key, val]) => [key, compactJsonValue(val)])) as JsonObject,
      },
    };
  }
  return { summary: { root_type: typeof value, value: compactJsonValue(value) } };
}

function summarizeJsonArraySample(value: readonly JsonValue[]): JsonObject {
  return {
    root_type: "array",
    items: value.length,
    sample: value.slice(0, 5).map(compactJsonValue) as JsonValue[],
    item_keys: commonKeys(value),
  };
}

function summarizeJsonLines(input: string): JsonObject {
  const rows = parseJsonLines(input) ?? [];
  const levels = countJsonField(rows, "level");
  return {
    records: rows.length,
    keys: commonKeys(rows),
    levels,
    first: compactJsonValue(rows[0]) as JsonValue,
    last: compactJsonValue(rows.at(-1)) as JsonValue,
  };
}

function summarizeUnifiedDiff(input: string): JsonObject {
  const files = new Map<string, { path: string; added: number; deleted: number; hunks: number }>();
  let current = "";
  let added = 0;
  let deleted = 0;
  let hunks = 0;
  for (const line of input.split(/\r?\n/)) {
    const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffMatch) {
      current = diffMatch[2] ?? diffMatch[1] ?? "unknown";
      if (!files.has(current)) files.set(current, { path: current, added: 0, deleted: 0, hunks: 0 });
      continue;
    }
    if (!current) {
      const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
      if (fileMatch) {
        current = fileMatch[1] ?? "unknown";
        if (!files.has(current)) files.set(current, { path: current, added: 0, deleted: 0, hunks: 0 });
      }
    }
    if (line.startsWith("@@")) {
      hunks++;
      if (current) files.get(current)!.hunks++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
      if (current) files.get(current)!.added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deleted++;
      if (current) files.get(current)!.deleted++;
    }
  }
  return {
    files: [...files.values()].slice(0, 12),
    file_count: files.size,
    hunks,
    added_lines: added,
    deleted_lines: deleted,
  };
}

function summarizeTable(input: string): JsonObject {
  const parsed = parseTable(input);
  if (!parsed) return summarizeUntyped(Buffer.from(input), 512, Math.max(0, Buffer.byteLength(input) - 512), []);
  return {
    columns: parsed.columns,
    rows: parsed.rows.length,
    sample: parsed.rows.slice(0, 5) as JsonObject[],
  };
}

function summarizeLog(input: string, outliers: readonly PreservedOutlierLine[]): JsonObject {
  const rows = nonBlankLines(input);
  return {
    entries: rows.length,
    levels: countLogLevels(rows),
    first: truncateText(rows[0] ?? ""),
    last: truncateText(rows.at(-1) ?? ""),
    outliers: outliers.map((line) => ({
      line: line.lineNumber,
      score: Number(line.score.toFixed(2)),
      text: truncateText(line.text),
    })),
  };
}

function summarizeProse(input: string): JsonObject {
  const paragraphs = input.trim().split(/\n\s*\n/).filter((part) => part.trim());
  const words = input.trim().split(/\s+/).filter(Boolean);
  return {
    paragraphs: paragraphs.length,
    words: words.length,
    opening: truncateText(paragraphs[0] ?? ""),
    closing: truncateText(paragraphs.at(-1) ?? ""),
  };
}

function summarizeUntyped(
  stdout: Buffer,
  headBytes: number,
  tailStart: number,
  outliers: readonly PreservedOutlierLine[],
): JsonObject {
  const head = truncateUtf8(stdout.subarray(0, headBytes));
  const tail = truncateUtf8(stdout.subarray(tailStart));
  return {
    head,
    tail,
    outliers: outliers.map((line) => ({
      line: line.lineNumber,
      score: Number(line.score.toFixed(2)),
      text: truncateText(line.text),
    })),
  };
}

function preservedOutliers(
  stdout: string,
  headBytes: number,
  tailStart: number,
  anomalyScorer: (text: string, options: { headBytes: number; tailStart: number }) => PreservedOutlierLine[],
): { kind: "ok"; lines: PreservedOutlierLine[] } | { kind: "failed"; error: unknown } {
  try {
    return { kind: "ok", lines: anomalyScorer(stdout, { headBytes, tailStart }) };
  } catch (error) {
    return { kind: "failed", error };
  }
}

function defaultAnomalyScorer(text: string, options: { headBytes: number; tailStart: number }): PreservedOutlierLine[] {
  return scoreStructuralOutliers(text, {
    excludedByteRanges: [
      { start: 0, end: options.headBytes },
      { start: options.tailStart, end: Buffer.byteLength(text, "utf8") },
    ],
  });
}

function parseJsonContainer(input: string): JsonValue | null {
  const trimmed = input.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    const parsed = JSON.parse(trimmed) as JsonValue;
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonLines(input: string): JsonValue[] | null {
  const lines = nonBlankLines(input);
  if (lines.length < 2 || !lines.every((line) => /^[\[{]/.test(line.trim()))) return null;
  const rows: JsonValue[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as JsonValue);
    } catch {
      return null;
    }
  }
  return rows;
}

function isUnifiedDiff(input: string): boolean {
  const lines = nonBlankLines(input);
  const first = lines[0] ?? "";
  if (!/^diff --git a\/.+ b\/.+/.test(first) && !/^--- /.test(first)) return false;
  const hasFileHeader = lines.some((line) => /^diff --git a\/.+ b\/.+/.test(line)) ||
    (lines.some((line) => /^--- /.test(line)) && lines.some((line) => /^\+\+\+ /.test(line)));
  const hasHunk = lines.some((line) => /^@@ /.test(line));
  const hasChange = lines.some((line) => /^[+-]/.test(line) && !/^(---|\+\+\+) /.test(line));
  return hasFileHeader && hasHunk && hasChange;
}

function parseTable(input: string): { columns: string[]; rows: JsonObject[] } | null {
  const lines = nonBlankLines(input);
  if (lines.length < 3) return null;
  const header = lines[0] ?? "";
  if (/[=:{}/]/.test(header) || /^\d{4}-\d{2}-\d{2}/.test(header)) return null;
  const splitter = header.includes("\t") ? /\t+/ : /\s{2,}/;
  const columns = header.split(splitter).map((part) => part.trim()).filter(Boolean);
  if (columns.length < 2 || columns.some((column) => !/^[A-Za-z0-9_.-]+$/.test(column))) return null;
  const rows: JsonObject[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(splitter).map((part) => part.trim());
    if (cells.length !== columns.length || cells.some((cell) => cell === "")) return null;
    rows.push(Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ""])) as JsonObject);
  }
  return rows.length > 0 ? { columns, rows } : null;
}

function isLogLike(input: string): boolean {
  const lines = nonBlankLines(input);
  if (lines.length < 3) return false;
  const matches = lines.filter((line) =>
    /^\d{4}-\d{2}-\d{2}[T\s]/.test(line) ||
    /\b(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\b/i.test(line) ||
    (line.match(/\b[A-Za-z0-9_.+:-]+=/g)?.length ?? 0) >= 2 ||
    /^\[[^\]]+\]\s+/.test(line)
  ).length;
  return matches / lines.length >= 0.6;
}

function isProse(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  const sentenceMarks = text.match(/[.!?](?:\s|$)/g)?.length ?? 0;
  return words.length >= 20 && sentenceMarks >= 2;
}

function nonBlankLines(input: string): string[] {
  return input.split(/\r?\n/).filter((line) => line.trim() !== "");
}

function commonKeys(values: readonly JsonValue[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const key of Object.keys(value)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20).map(([key]) => key);
}

function countJsonField(values: readonly JsonValue[], field: string): JsonObject {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!isRecord(value)) continue;
    const fieldValue = value[field];
    if (typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean") {
      const key = String(fieldValue).toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) as JsonObject;
}

function countLogLevels(lines: readonly string[]): JsonObject {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const match = /\blevel=([A-Za-z]+)\b/.exec(line) ?? /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\b/i.exec(line);
    if (!match) continue;
    const key = (match[1] ?? match[0]).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) as JsonObject;
}

function compactJsonValue(value: unknown): JsonValue {
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 5).map(compactJsonValue) as JsonValue[];
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 8).map(([key, val]) => [key, compactJsonValue(val)])) as JsonObject;
  }
  return String(value);
}

function truncateText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_SUMMARY_STRING ? normalized : `${normalized.slice(0, MAX_SUMMARY_STRING - 1)}…`;
}

function encodeToonDocument(payload: JsonObject): string {
  const encoded = encode(payload).trimEnd();
  const roundTripped = decode(encoded);
  if (!deepEqual(payload, roundTripped)) throw new Error("exec TOON round-trip guard failed");
  return `${encoded}\n`;
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

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateDiagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "unknown scorer failure");
  const line = text.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() || "unknown scorer failure";
  return line.length <= 240 ? line : `${line.slice(0, 239)}…`;
}

function truncateUtf8(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/�$/g, "");
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) lines++;
  }
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
