import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RedDB } from "@reddb-io/sdk";

export const RSP_TELEMETRY_SPOOL = join(".red", "tmp", "rsp-telemetry.spool.jsonl");
export const RSP_TELEMETRY_INVOCATIONS_COLLECTION = "rsp_telemetry_invocations_v1";
export const RSP_TELEMETRY_DEGRADATIONS_COLLECTION = "rsp_telemetry_degradations_v1";
export const RSP_TELEMETRY_INDEX_COLLECTION = "rsp_telemetry_index_v1";

export interface RspTelemetryEvent {
  collection: typeof RSP_TELEMETRY_INVOCATIONS_COLLECTION | typeof RSP_TELEMETRY_DEGRADATIONS_COLLECTION;
  id?: string;
  created_at?: string;
  bytes?: number;
  raw_text?: string;
  emitted_text?: string;
  raw_bytes?: number;
  emitted_bytes?: number;
  tokens_raw?: number;
  tokens_emitted?: number;
  estimated?: boolean;
  [key: string]: unknown;
}

export interface RspTelemetryStats {
  window_days: number;
  empty: boolean;
  savings: {
    invocations: number;
    elided: number;
    raw_bytes: number;
    emitted_bytes: number;
    bytes_saved: number;
    tokens_saved: number;
    daily_tokens_saved: Array<{ date: string; tokens_saved: number }>;
    top_commands: Array<{ command: string; invocations: number; bytes_saved: number; tokens_saved: number }>;
  };
  health: {
    degradations: number;
    degradation_rate: number;
    by_reason: Array<{ reason: string; count: number }>;
    most_recent: { timestamp: string; reason: string; command: string } | null;
  };
  latency: {
    wrapper_ms_p50: number | null;
    wrapper_ms_p95: number | null;
    store_open_count_sum: number;
    store_elapsed_ms_sum: number;
    store_elapsed_ms_avg: number | null;
  };
}

export function telemetrySpoolPath(rootDir: string): string {
  return join(rootDir, RSP_TELEMETRY_SPOOL);
}

export async function appendTelemetryEvent(rootDir: string, event: RspTelemetryEvent): Promise<void> {
  try {
    const path = telemetrySpoolPath(rootDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
}

export async function takeTelemetrySpool(rootDir: string): Promise<string[]> {
  const path = telemetrySpoolPath(rootDir);
  const drainingPath = `${path}.${process.pid}.${Date.now()}.drain`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await rename(path, drainingPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }

  try {
    await writeFile(path, "", { flag: "wx" }).catch(() => undefined);
    const text = await readFile(drainingPath, "utf8").catch(() => "");
    return text.split(/\r?\n/).filter((line) => line.trim() !== "");
  } finally {
    await rm(drainingPath, { force: true });
  }
}

export function parseTelemetryEvent(line: string): RspTelemetryEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    if (
      parsed.collection !== RSP_TELEMETRY_INVOCATIONS_COLLECTION &&
      parsed.collection !== RSP_TELEMETRY_DEGRADATIONS_COLLECTION
    ) return null;
    return parsed as RspTelemetryEvent;
  } catch {
    return null;
  }
}

export async function readTelemetryStats(db: RedDB, sinceDays: number, now = new Date()): Promise<RspTelemetryStats> {
  const windowDays = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : 30;
  const sinceMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const invocations = (await readCollection(db, RSP_TELEMETRY_INVOCATIONS_COLLECTION))
    .filter((record) => timestampMs(record) >= sinceMs);
  const degradations = (await readCollection(db, RSP_TELEMETRY_DEGRADATIONS_COLLECTION))
    .filter((record) => timestampMs(record) >= sinceMs);

  let elided = 0;
  let rawBytes = 0;
  let emittedBytes = 0;
  let tokensSaved = 0;
  const byDay = new Map<string, number>();
  const byCommand = new Map<string, { command: string; invocations: number; bytes_saved: number; tokens_saved: number }>();
  const wrapperMs: number[] = [];
  let storeOpenCountSum = 0;
  let storeElapsedMsSum = 0;
  let storeElapsedMsCount = 0;

  for (const record of invocations) {
    if (record.elided === true) elided++;
    const raw = numeric(record.raw_bytes);
    const emitted = numeric(record.emitted_bytes);
    const bytesSaved = Math.max(0, raw - emitted);
    const tokenDelta = Math.max(0, numeric(record.tokens_raw) - numeric(record.tokens_emitted));
    rawBytes += raw;
    emittedBytes += emitted;
    tokensSaved += tokenDelta;
    const date = timestampString(record).slice(0, 10);
    if (date) byDay.set(date, (byDay.get(date) ?? 0) + tokenDelta);
    const command = stringField(record.command) || "unknown";
    const current = byCommand.get(command) ?? { command, invocations: 0, bytes_saved: 0, tokens_saved: 0 };
    current.invocations++;
    current.bytes_saved += bytesSaved;
    current.tokens_saved += tokenDelta;
    byCommand.set(command, current);
    const latency = optionalNumeric(record.wrapper_ms);
    if (latency != null) wrapperMs.push(latency);
    storeOpenCountSum += numeric(record.store_open_count);
    const storeMs = optionalNumeric(record.store_elapsed_ms);
    if (storeMs != null) {
      storeElapsedMsSum += storeMs;
      storeElapsedMsCount++;
    }
  }

  const byReason = new Map<string, number>();
  let mostRecent: RspTelemetryStats["health"]["most_recent"] = null;
  for (const record of degradations) {
    const reason = stringField(record.reason) || "unknown";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    const timestamp = timestampString(record);
    if (!mostRecent || timestamp > mostRecent.timestamp) {
      mostRecent = {
        timestamp,
        reason,
        command: stringField(record.command) || "unknown",
      };
    }
  }

  const totalAttempts = invocations.length + degradations.length;
  return {
    window_days: windowDays,
    empty: invocations.length === 0 && degradations.length === 0,
    savings: {
      invocations: invocations.length,
      elided,
      raw_bytes: rawBytes,
      emitted_bytes: emittedBytes,
      bytes_saved: Math.max(0, rawBytes - emittedBytes),
      tokens_saved: tokensSaved,
      daily_tokens_saved: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, saved]) => ({ date, tokens_saved: saved })),
      top_commands: [...byCommand.values()]
        .sort((a, b) => b.bytes_saved - a.bytes_saved || b.tokens_saved - a.tokens_saved || a.command.localeCompare(b.command)),
    },
    health: {
      degradations: degradations.length,
      degradation_rate: totalAttempts === 0 ? 0 : degradations.length / totalAttempts,
      by_reason: [...byReason.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => ({ reason, count })),
      most_recent: mostRecent,
    },
    latency: {
      wrapper_ms_p50: percentile(wrapperMs, 0.5),
      wrapper_ms_p95: percentile(wrapperMs, 0.95),
      store_open_count_sum: storeOpenCountSum,
      store_elapsed_ms_sum: round(storeElapsedMsSum),
      store_elapsed_ms_avg: storeElapsedMsCount === 0 ? null : round(storeElapsedMsSum / storeElapsedMsCount),
    },
  };
}

async function readCollection(db: RedDB, collection: string): Promise<Array<Record<string, unknown>>> {
  const listed = await db.kv(collection).list({ limit: 10_000 }).catch((err: unknown) => {
    if (err instanceof Error && /\bnot found\b/i.test(err.message)) return { items: [] };
    throw err;
  });
  return listed.items
    .map((entry) => parseRecord(entry.value))
    .filter((value): value is Record<string, unknown> => isRecord(value));
}

function parseRecord(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function timestampMs(record: Record<string, unknown>): number {
  const parsed = Date.parse(timestampString(record));
  return Number.isFinite(parsed) ? parsed : 0;
}

function timestampString(record: Record<string, unknown>): string {
  return stringField(record.created_at) || stringField(record.ts) || "";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numeric(value: unknown): number {
  return optionalNumeric(value) ?? 0;
}

function optionalNumeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return round(sorted[index]!);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
