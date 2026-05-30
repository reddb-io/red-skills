import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Port of lib/history.sh — the afk-history.jsonl ledger. The pure parts (the
// JSONL record shape, the 48h `done`-event bucketing, and the sparkline glyph
// rendering) are extracted as deterministic functions; the file append and the
// 10000-line truncation are thin, injectable IO. No clock is read at module
// scope — every timestamp is passed in as a parameter, mirroring how the bash
// Module stamps ts/epoch from its only ambient input.

export const HISTORY_MAX_LINES_DEFAULT = 10000;

export const SPARKLINE_BUCKETS_DEFAULT = 48;

// The glyph ramp matches monitor.sh's render_sparkline byte-for-byte: index 0
// is the empty middle-dot, indices 1..8 are the eighth-blocks ▁..█.
export const SPARKLINE_GLYPHS = ["·", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

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

/** Parses ledger text (JSONL) into records, skipping blank lines. */
export function parseHistoryLines(text: string): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    out.push(JSON.parse(line) as HistoryRecord);
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
    await writeFile(path, text, "utf8");
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
  await io.ensureDir(dirname(path));
  await io.append(path, `${serializeHistoryRecord(record)}\n`);
  return record;
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
): Promise<number | null> {
  const text = await io.read(path);
  if (text === null) return null;
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= maxLines) return null;
  const kept = lines.slice(lines.length - maxLines);
  await io.write(path, `${kept.join("\n")}\n`);
  return maxLines;
}
