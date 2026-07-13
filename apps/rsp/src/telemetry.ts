import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RedDB } from "@reddb-io/sdk";
import { tokenSavingsEstimate, type TokenSavingsEstimate } from "./pricing.js";

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
    tokens_saved_estimated: boolean;
    token_estimate_range_pct: number | null;
    tokens_saved_low: number | null;
    tokens_saved_high: number | null;
    dollars_saved_estimate_usd: number;
    dollars_saved_low_usd: number | null;
    dollars_saved_high_usd: number | null;
    pricing_model_family: string;
    pricing_input_usd_per_million_tokens: number;
    pricing_note: string;
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

export interface RspTelemetryGainsReport {
  schema_version: "red.rsp.gains.v1";
  window: {
    requested_days: number;
    data_days: number;
    since: string;
    until: string;
    label: string;
    empty: boolean;
    invocations: number;
    degradations: number;
  };
  latency: {
    global: LatencyPercentiles;
    by_command_family: Array<{ command_family: string; count: number } & LatencyPercentiles>;
  };
  throughput: {
    requests_per_day: Array<{ date: string; requests: number }>;
    active_minute_avg: number | null;
    peak_minute: { minute: string; requests: number } | null;
    hour_weekday_heatmap: Array<{ weekday: string; hour: number; requests: number }>;
  };
  savings: {
    tokens: TokenSavingsEstimate;
    weekly_tokens_saved: Array<{ week_start: string; tokens_saved: number; wow_delta_pct: number | null }>;
    elision_rate: number;
    top_commands_by_tokens_saved: Array<{ command_family: string; invocations: number; tokens_saved: number; bytes_saved: number }>;
    top_commands_by_invocation_count: Array<{ command_family: string; invocations: number; tokens_saved: number; bytes_saved: number }>;
    single_biggest_elision: {
      timestamp: string;
      command_family: string;
      tokens_saved: number;
      bytes_saved: number;
    } | null;
  };
  health: {
    degradation_timeline: Array<{ timestamp: string; command_family: string; reason: string }>;
    degradations_by_reason: Array<{ reason: string; count: number }>;
    cold_boots: number | null;
    warm_hits: number | null;
  };
}

export interface LatencyPercentiles {
  wrapper_ms_p50: number | null;
  wrapper_ms_p90: number | null;
  wrapper_ms_p95: number | null;
  wrapper_ms_p99: number | null;
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
    const text = await readSettledFile(drainingPath);
    return text.split(/\r?\n/).filter((line) => line.trim() !== "");
  } finally {
    await rm(drainingPath, { force: true });
  }
}

export async function drainTelemetrySpool(
  rootDir: string,
  drainLine: (line: string) => Promise<boolean>,
): Promise<void> {
  const path = telemetrySpoolPath(rootDir);
  const drainingPath = `${path}.${process.pid}.${Date.now()}.drain`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await rename(path, drainingPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    return;
  }

  const retryLines: string[] = [];
  try {
    await writeFile(path, "", { flag: "wx" }).catch(() => undefined);
    const text = await readSettledFile(drainingPath);
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
    for (const line of lines) {
      try {
        if (await drainLine(line)) continue;
      } catch {}
      retryLines.push(line);
    }
  } finally {
    if (retryLines.length > 0) {
      const current = safeReadFileSync(path);
      await writeFile(path, `${retryLines.join("\n")}\n${current}`, "utf8");
    }
    await rm(drainingPath, { force: true });
  }
}

function safeReadFileSync(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function readSettledFile(path: string): Promise<string> {
  let text = "";
  for (let i = 0; i < 5; i++) {
    const next = await readFile(path, "utf8").catch(() => "");
    if (next === text) return next;
    text = next;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return text;
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
  let tokensEstimated = false;
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
    tokensEstimated ||= record.estimated === true && tokenDelta > 0;
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
  const savingsEstimate = tokenSavingsEstimate(tokensSaved, tokensEstimated);
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
      tokens_saved_estimated: savingsEstimate.tokens_saved_estimated,
      token_estimate_range_pct: savingsEstimate.token_estimate_range_pct,
      tokens_saved_low: savingsEstimate.tokens_saved_low,
      tokens_saved_high: savingsEstimate.tokens_saved_high,
      dollars_saved_estimate_usd: savingsEstimate.dollars_saved_estimate_usd,
      dollars_saved_low_usd: savingsEstimate.dollars_saved_low_usd,
      dollars_saved_high_usd: savingsEstimate.dollars_saved_high_usd,
      pricing_model_family: savingsEstimate.pricing_model_family,
      pricing_input_usd_per_million_tokens: savingsEstimate.pricing_input_usd_per_million_tokens,
      pricing_note: savingsEstimate.pricing_note,
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

export async function readTelemetryGainsReport(db: RedDB, sinceDays: number, now = new Date()): Promise<RspTelemetryGainsReport> {
  const windowDays = Number.isFinite(sinceDays) && sinceDays > 0 ? sinceDays : 28;
  const until = now.toISOString();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const sinceMs = Date.parse(since);
  const invocations = (await readCollection(db, RSP_TELEMETRY_INVOCATIONS_COLLECTION))
    .filter((record) => timestampMs(record) >= sinceMs);
  const degradations = (await readCollection(db, RSP_TELEMETRY_DEGRADATIONS_COLLECTION))
    .filter((record) => timestampMs(record) >= sinceMs);
  const allTimestamps = [...invocations, ...degradations]
    .map(timestampMs)
    .filter((value) => Number.isFinite(value) && value > 0);
  const oldestMs = allTimestamps.length === 0 ? null : Math.min(...allTimestamps);
  const dataDays = oldestMs == null ? 0 : Math.max(1, Math.min(windowDays, Math.ceil((now.getTime() - oldestMs) / dayMs())));

  const globalLatencies: number[] = [];
  const latencyByFamily = new Map<string, number[]>();
  const requestsByDay = new Map<string, number>();
  const requestsByMinute = new Map<string, number>();
  const heatmap = new Map<string, number>();
  const weeklyTokens = new Map<string, number>();
  const commandTotals = new Map<string, { command_family: string; invocations: number; tokens_saved: number; bytes_saved: number }>();
  let totalTokensSaved = 0;
  let tokensEstimated = false;
  let elided = 0;
  let biggest: RspTelemetryGainsReport["savings"]["single_biggest_elision"] = null;
  let recordsWithStoreMetric = 0;
  let coldBoots = 0;

  for (const record of invocations) {
    const timestamp = timestampString(record);
    const date = timestamp.slice(0, 10);
    const minute = timestamp.slice(0, 16);
    const family = commandFamily(stringField(record.command));
    const tokensSaved = Math.max(0, numeric(record.tokens_raw) - numeric(record.tokens_emitted));
    totalTokensSaved += tokensSaved;
    tokensEstimated ||= record.estimated === true && tokensSaved > 0;
    const bytesSaved = Math.max(0, numeric(record.raw_bytes) - numeric(record.emitted_bytes));
    const latency = optionalNumeric(record.wrapper_ms);
    if (latency != null) {
      globalLatencies.push(latency);
      const familyLatencies = latencyByFamily.get(family) ?? [];
      familyLatencies.push(latency);
      latencyByFamily.set(family, familyLatencies);
    }
    if (date) requestsByDay.set(date, (requestsByDay.get(date) ?? 0) + 1);
    if (minute) requestsByMinute.set(minute, (requestsByMinute.get(minute) ?? 0) + 1);
    const heatmapKey = heatmapKeyFor(timestamp);
    if (heatmapKey) heatmap.set(heatmapKey, (heatmap.get(heatmapKey) ?? 0) + 1);
    const week = weekStartDate(timestamp);
    if (week) weeklyTokens.set(week, (weeklyTokens.get(week) ?? 0) + tokensSaved);
    const totals = commandTotals.get(family) ?? { command_family: family, invocations: 0, tokens_saved: 0, bytes_saved: 0 };
    totals.invocations++;
    totals.tokens_saved += tokensSaved;
    totals.bytes_saved += bytesSaved;
    commandTotals.set(family, totals);
    if (record.elided === true) elided++;
    if (record.store_open_count != null || record.store_elapsed_ms != null) {
      recordsWithStoreMetric++;
      if (numeric(record.store_open_count) > 0) coldBoots++;
    }
    if (tokensSaved > 0 && (!biggest || tokensSaved > biggest.tokens_saved || (tokensSaved === biggest.tokens_saved && bytesSaved > biggest.bytes_saved))) {
      biggest = { timestamp, command_family: family, tokens_saved: tokensSaved, bytes_saved: bytesSaved };
    }
  }

  const degradationTimeline = degradations
    .map((record) => ({
      timestamp: timestampString(record),
      command_family: commandFamily(stringField(record.command)),
      reason: stringField(record.reason) || "unknown",
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const byReason = new Map<string, number>();
  for (const entry of degradationTimeline) {
    byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  }
  const peakMinute = [...requestsByMinute.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  return {
    schema_version: "red.rsp.gains.v1",
    window: {
      requested_days: windowDays,
      data_days: dataDays,
      since,
      until,
      label: `window: ${windowDays}d, data: ${dataDays}d`,
      empty: invocations.length === 0 && degradations.length === 0,
      invocations: invocations.length,
      degradations: degradations.length,
    },
    latency: {
      global: latencyPercentiles(globalLatencies),
      by_command_family: [...latencyByFamily.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([command_family, values]) => ({ command_family, count: values.length, ...latencyPercentiles(values) })),
    },
    throughput: {
      requests_per_day: [...requestsByDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, requests]) => ({ date, requests })),
      active_minute_avg: requestsByMinute.size === 0
        ? null
        : round([...requestsByMinute.values()].reduce((sum, value) => sum + value, 0) / requestsByMinute.size),
      peak_minute: peakMinute ? { minute: peakMinute[0], requests: peakMinute[1] } : null,
      hour_weekday_heatmap: renderHeatmapRows(heatmap),
    },
    savings: {
      tokens: tokenSavingsEstimate(totalTokensSaved, tokensEstimated),
      weekly_tokens_saved: weeklySeries(weeklyTokens),
      elision_rate: invocations.length === 0 ? 0 : round(elided / invocations.length),
      top_commands_by_tokens_saved: [...commandTotals.values()]
        .sort((a, b) => b.tokens_saved - a.tokens_saved || b.bytes_saved - a.bytes_saved || a.command_family.localeCompare(b.command_family))
        .slice(0, 10),
      top_commands_by_invocation_count: [...commandTotals.values()]
        .sort((a, b) => b.invocations - a.invocations || b.tokens_saved - a.tokens_saved || a.command_family.localeCompare(b.command_family))
        .slice(0, 10),
      single_biggest_elision: biggest,
    },
    health: {
      degradation_timeline: degradationTimeline,
      degradations_by_reason: [...byReason.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => ({ reason, count })),
      cold_boots: recordsWithStoreMetric === 0 ? null : coldBoots,
      warm_hits: recordsWithStoreMetric === 0 ? null : Math.max(0, recordsWithStoreMetric - coldBoots),
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

function latencyPercentiles(values: number[]): LatencyPercentiles {
  return {
    wrapper_ms_p50: percentile(values, 0.5),
    wrapper_ms_p90: percentile(values, 0.9),
    wrapper_ms_p95: percentile(values, 0.95),
    wrapper_ms_p99: percentile(values, 0.99),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function commandFamily(command: string): string {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "unknown";
  if (parts[0] === "git" && parts[1]) return `git ${parts[1]}`;
  if (parts[0] === "gh" && parts[1] && parts[2]) return `gh ${parts[1]} ${parts[2]}`;
  if (parts[0] === "gh" && parts[1]) return `gh ${parts[1]}`;
  if (parts[0] === "cargo" && parts[1]) return `cargo ${parts[1]}`;
  if (parts[0] === "vitest") return "vitest";
  return parts[0]!;
}

function heatmapKeyFor(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return `${weekdayName(date.getUTCDay())}:${date.getUTCHours()}`;
}

function renderHeatmapRows(heatmap: Map<string, number>): Array<{ weekday: string; hour: number; requests: number }> {
  const rows: Array<{ weekday: string; hour: number; requests: number }> = [];
  for (const weekday of ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]) {
    for (let hour = 0; hour < 24; hour++) {
      const requests = heatmap.get(`${weekday}:${hour}`) ?? 0;
      if (requests > 0) rows.push({ weekday, hour, requests });
    }
  }
  return rows;
}

function weekdayName(day: number): string {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][day] ?? "unknown";
}

function weekStartDate(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + mondayOffset));
  return start.toISOString().slice(0, 10);
}

function weeklySeries(weeklyTokens: Map<string, number>): Array<{ week_start: string; tokens_saved: number; wow_delta_pct: number | null }> {
  let previous: number | null = null;
  return [...weeklyTokens.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week_start, tokens_saved]) => {
      const wow_delta_pct = previous == null || previous === 0 ? null : round(((tokens_saved - previous) / previous) * 100);
      previous = tokens_saved;
      return { week_start, tokens_saved, wow_delta_pct };
    });
}

function dayMs(): number {
  return 24 * 60 * 60 * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
