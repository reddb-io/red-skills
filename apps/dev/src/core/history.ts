import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { LANE_RETENTION_REGISTRY } from "@reddb-io/shared/lane-retention.js";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { appendCastleHistoryRecord, readCastleHistoryRecords } from "@reddb-io/worker/engine";

// Port of lib/history.sh — the afk-history.jsonl ledger. The pure parts (the
// JSONL record shape, the 48h `done`-event bucketing, and the sparkline glyph
// rendering) are extracted as deterministic functions; the file append and the
// 10000-line truncation are thin, injectable IO. No clock is read at module
// scope — every timestamp is passed in as a parameter, mirroring how the bash
// Module stamps ts/epoch from its only ambient input.

/** One ceiling, declared in the lane registry and shared with the append path. */
export const HISTORY_MAX_LINES_DEFAULT = LANE_RETENTION_REGISTRY["castle-history"].maxLines;
export const HISTORY_TQ_TRIM_TIMEOUT_MS = 1000;

export const SPARKLINE_BUCKETS_DEFAULT = 48;

// The glyph ramp matches monitor.sh's render_sparkline byte-for-byte: index 0
// is the empty middle-dot, indices 1..8 are the eighth-blocks ▁..█.
export const SPARKLINE_GLYPHS = ["·", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

const execFileAsync = promisify(execFile);

/** A single terminal event in the ledger. */
export type HistoryEvent = "done" | "blocked" | "exhausted" | (string & {});

/** Optional event-specific fields, mirroring the variadic KEY=VALUE pairs of history_append. */
export interface HistoryAppendFields {
  worker?: string;
  issue?: number;
  runner?: string;
  duration_s?: number;
  merge_sha?: string;
  reason?: string;
}

/** Clock inputs stamped onto the record (no Date.now() at module scope). */
export interface HistoryClock {
  ts: string;
  epoch: number;
}

/** The JSONL record as it is serialised to the ledger. */
export interface HistoryRecord {
  ts: string;
  epoch: number;
  worker: string;
  issue: number;
  event: HistoryEvent;
  duration_s: number;
  runner: string;
  merge_sha?: string;
  reason?: string;
}

type HistoryToonRow = Omit<HistoryRecord, "merge_sha" | "reason"> & {
  merge_sha: string | null;
  reason: string | null;
};

const HISTORY_TOON_FIELDS = [
  "ts",
  "epoch",
  "worker",
  "issue",
  "event",
  "duration_s",
  "runner",
  "merge_sha",
  "reason",
] as const;

const HISTORY_TOON_HEADER_RE = /^\[(\d+)\]\{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason\}:$/;

/**
 * Builds exactly one ledger record. Required fields default to the bash
 * Module's values ("" / 0); merge_sha and reason are omitted entirely when
 * empty, matching the `if $x != "" then {x:$x} else {} end` filter clauses.
 */
export function buildHistoryRecord(
  clock: HistoryClock,
  event: HistoryEvent,
  fields: HistoryAppendFields = {},
): HistoryRecord {
  if (!event) throw new Error("history: need <event>");
  const record: HistoryRecord = {
    ts: clock.ts,
    epoch: clock.epoch,
    worker: fields.worker ?? "",
    issue: fields.issue ?? 0,
    event,
    duration_s: fields.duration_s ?? 0,
    runner: fields.runner ?? "",
  };
  if (fields.merge_sha) record.merge_sha = fields.merge_sha;
  if (fields.reason) record.reason = fields.reason;
  return record;
}

/** Serialises a record to its single JSONL line (no trailing newline). */
export function serializeHistoryRecord(record: HistoryRecord): string {
  return JSON.stringify(record);
}

function historyToonRow(record: HistoryRecord): HistoryToonRow {
  return {
    ts: record.ts,
    epoch: record.epoch,
    worker: record.worker,
    issue: record.issue,
    event: record.event,
    duration_s: record.duration_s,
    runner: record.runner,
    merge_sha: record.merge_sha ?? null,
    reason: record.reason ?? null,
  };
}

function normalizeHistoryRecord(raw: unknown): HistoryRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ts !== "string") return null;
  const epoch = Number(rec.epoch);
  if (!Number.isFinite(epoch)) return null;
  if (typeof rec.event !== "string" || rec.event.length === 0) return null;
  const issue = Number(rec.issue ?? 0);
  const duration = Number(rec.duration_s ?? 0);
  const record: HistoryRecord = {
    ts: rec.ts,
    epoch,
    worker: typeof rec.worker === "string" ? rec.worker : "",
    issue: Number.isFinite(issue) ? issue : 0,
    event: rec.event,
    duration_s: Number.isFinite(duration) ? duration : 0,
    runner: typeof rec.runner === "string" ? rec.runner : "",
  };
  if (typeof rec.merge_sha === "string" && rec.merge_sha.length > 0) record.merge_sha = rec.merge_sha;
  if (typeof rec.reason === "string" && rec.reason.length > 0) record.reason = rec.reason;
  return record;
}

function renderHistoryToonl(records: readonly HistoryRecord[]): string {
  if (records.length === 0) return `[0]{${HISTORY_TOON_FIELDS.join(",")}}:\n`;
  return encode(records.map(historyToonRow) as unknown as JsonValue);
}

function parseHistoryToonl(text: string): HistoryRecord[] {
  const lines = text.split(/\r?\n/);
  const header = lines.find((line) => line.trim().length > 0)?.trim();
  if (!header || !HISTORY_TOON_HEADER_RE.test(header)) return [];

  const out: HistoryRecord[] = [];
  for (const raw of lines.slice(lines.indexOf(lines.find((line) => line.trim().length > 0) ?? "") + 1)) {
    if (raw.trim().length === 0) continue;
    try {
      const value = decode(`[1]{${HISTORY_TOON_FIELDS.join(",")}}:\n${raw}\n`);
      const row = Array.isArray(value) ? value[0] : value;
      const record = normalizeHistoryRecord(row);
      if (record) out.push(record);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The re-queue ordinal for one Ticket: `1` on its first run, then `+1` for every
 * terminal record the ledger already holds for it. A `done` resets the count —
 * a Ticket that landed and was reopened starts its budget over rather than
 * inheriting an exhausted one.
 *
 * This is what the bounded retry caps in `core/recovery.ts` count (ADR 0103):
 * caps are automatic-re-queue limits per Ticket, replacing the deleted attempt
 * ledger's per-attempt-directory ordinal. The ledger is the right source because
 * it is durable, lane-blind, and already records exactly one row per terminal
 * exit — the same boundary a re-queue is decided at.
 */
export function requeueOrdinal(records: readonly HistoryRecord[], issue: number): number {
  let terminals = 0;
  for (const record of records) {
    if (record.issue !== issue) continue;
    terminals = record.event === "done" ? 0 : terminals + 1;
  }
  return terminals + 1;
}

/**
 * Buckets `done` events into per-hour counts, oldest → newest. The hour index
 * is `(epoch / 3600 | floor) - fromHour`; indices outside [0, buckets) are
 * dropped. Only `event === "done"` is counted. Mirrors
 * history_read_done_buckets.
 */
export function readDoneBuckets(
  events: ReadonlyArray<Pick<HistoryRecord, "event" | "epoch">>,
  fromHour: number,
  buckets: number = SPARKLINE_BUCKETS_DEFAULT,
): number[] {
  const counts = new Array<number>(buckets).fill(0);
  for (const event of events) {
    if (event.event !== "done") continue;
    const index = Math.floor(event.epoch / 3600) - fromHour;
    if (index >= 0 && index < buckets) counts[index] += 1;
  }
  return counts;
}

export interface SparklineResult {
  /** The glyph string, one glyph per bucket. */
  bar: string;
  /** Sum of all in-window done counts. */
  total: number;
  /** Peak hour count, clamped to a minimum of 1 (the scaling divisor). */
  peak: number;
  /** The full "48h: <bar>  (N closed, peak M/h, all workers)" line, uncoloured. */
  line: string;
}

/**
 * Renders the 48h sparkline from per-hour buckets, byte-for-byte matching
 * monitor.sh's render_sparkline: `idx = v * 8 / max` (integer division), max is
 * the peak count clamped to a minimum of 1, glyphs from SPARKLINE_GLYPHS, and
 * the "(N closed, peak M/h, all workers)" caption with two spaces before it.
 */
export function renderSparkline(counts: ReadonlyArray<number>): SparklineResult {
  let max = 0;
  let total = 0;
  for (const v of counts) {
    if (v > max) max = v;
    total += v;
  }
  if (max === 0) max = 1;

  let bar = "";
  for (const v of counts) {
    const idx = Math.floor((v * 8) / max);
    bar += SPARKLINE_GLYPHS[idx];
  }

  const line = `48h: ${bar}  (${total} closed, peak ${max}/h, all workers)`;
  return { bar, total, peak: max, line };
}

/** Aggregates and renders a ledger's events into the 48h sparkline in one call. */
export function buildSparkline(
  events: ReadonlyArray<Pick<HistoryRecord, "event" | "epoch">>,
  nowEpoch: number,
  buckets: number = SPARKLINE_BUCKETS_DEFAULT,
): SparklineResult {
  const floorHour = Math.floor(nowEpoch / 3600);
  const fromHour = floorHour - (buckets - 1);
  return renderSparkline(readDoneBuckets(events, fromHour, buckets));
}

/** Parses ledger text (legacy JSONL or TOONL) into records, skipping broken tail rows. */
export function parseHistoryLines(text: string): HistoryRecord[] {
  const first = text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  if (first && HISTORY_TOON_HEADER_RE.test(first)) return parseHistoryToonl(text);

  const out: HistoryRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const record = normalizeHistoryRecord(JSON.parse(line));
      if (record) out.push(record);
    } catch {
      continue;
    }
  }
  return out;
}

/** Thin injectable IO surface so callers (and tests) can swap the filesystem. */
export interface HistoryIO {
  ensureDir(dir: string): Promise<void>;
  append(path: string, line: string): Promise<void>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}

export const defaultHistoryIO: HistoryIO = {
  async ensureDir(dir) {
    await mkdir(dir, { recursive: true });
  },
  async append(path, line) {
    await appendFile(path, line, "utf8");
  },
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async write(path, text) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  },
};

function isCanonicalCastleHistoryPath(path: string, io: Pick<HistoryIO, "read">): boolean {
  if (io !== defaultHistoryIO) return false;
  const normalized = path.replace(/\\/g, "/");
  return normalized.endsWith("/.red/state/castle/history.toonl");
}

export interface HistoryTrimTool {
  trimKeepLast(path: string, keepLast: number): Promise<boolean>;
}

export const defaultHistoryTrimTool: HistoryTrimTool = {
  async trimKeepLast(path, keepLast) {
    try {
      await execFileAsync("tq", ["trim", "--keep-last", String(keepLast), "--in-place", path], {
        timeout: HISTORY_TQ_TRIM_TIMEOUT_MS,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Appends exactly one JSONL record to the ledger, creating the parent
 * directory if missing. Returns the record that was written.
 */
export async function historyAppend(
  path: string,
  clock: HistoryClock,
  event: HistoryEvent,
  fields: HistoryAppendFields = {},
  io: HistoryIO = defaultHistoryIO,
): Promise<HistoryRecord> {
  if (!path) throw new Error("history: need <path>");
  const record = buildHistoryRecord(clock, event, fields);
  if (isCanonicalCastleHistoryPath(path, io)) {
    await appendCastleHistoryRecord(path, record);
    return record;
  }
  await io.ensureDir(dirname(path));
  if (path.endsWith(".toonl")) {
    const existing = parseHistoryLines((await io.read(path)) ?? "");
    await io.write(path, renderHistoryToonl([...existing, record]));
    return record;
  }
  await io.append(path, `${serializeHistoryRecord(record)}\n`);
  return record;
}

export async function readHistoryRecords(
  path: string,
  io: Pick<HistoryIO, "read"> = defaultHistoryIO,
): Promise<HistoryRecord[]> {
  if (isCanonicalCastleHistoryPath(path, io)) {
    return (await readCastleHistoryRecords(path)).map((record) => {
      const historyRecord: HistoryRecord = {
        ts: record.ts,
        epoch: record.epoch,
        worker: record.worker,
        issue: record.issue,
        event: record.event,
        duration_s: record.duration_s,
        runner: record.runner,
      };
      if (record.merge_sha) historyRecord.merge_sha = record.merge_sha;
      if (record.reason) historyRecord.reason = record.reason;
      return historyRecord;
    });
  }
  const converted = await io.read(path);
  if (converted !== null) return parseHistoryLines(converted);
  if (path.endsWith(".toonl")) {
    const legacy = await io.read(path.slice(0, -".toonl".length) + ".jsonl");
    if (legacy !== null) return parseHistoryLines(legacy);
  }
  return [];
}

/**
 * Caps the ledger to its last `maxLines` lines. Returns the cap count when a
 * trim happened, or null when the file is missing or already within bound
 * (mirroring history_trim's "echoes the cap, else silent" contract).
 */
export async function historyTrim(
  path: string,
  maxLines: number = HISTORY_MAX_LINES_DEFAULT,
  io: HistoryIO = defaultHistoryIO,
  tool: HistoryTrimTool = defaultHistoryTrimTool,
): Promise<number | null> {
  const text = await io.read(path);
  if (text === null) return null;
  const records = parseHistoryLines(text);
  if (records.length <= maxLines) return null;
  if (path.endsWith(".toonl") && await tool.trimKeepLast(path, maxLines)) return maxLines;
  const kept = records.slice(records.length - maxLines);
  if (path.endsWith(".toonl")) {
    await io.write(path, renderHistoryToonl(kept));
    return maxLines;
  }
  await io.write(path, `${kept.map(serializeHistoryRecord).join("\n")}\n`);
  return maxLines;
}
