import type { StoredBrainArtifact } from "./schema.js";

/**
 * KpiQuery computes KPIs/metrics as time-windowed aggregations over
 * `kind:event` Brain artifacts. KPIs are derived read queries over the existing
 * artifact graph — there is no separate metrics store and no schema change.
 *
 * The output is shaped for direct consumption by a dashboard: a total count
 * plus one or more contiguous per-window series (zero-filled across the window
 * axis so charts can render gaps without client-side reconciliation).
 */

/** Width of each aggregation window. */
export type KpiInterval = "hour" | "day" | "week" | "month";

/** Optional dimension to split the metric series by. */
export type KpiGroupBy = "platform" | "event_type" | "target";

/**
 * Which timestamp to bucket on:
 * - `event` (default): the channel event's own `metadata.timestamp`, falling
 *   back to ingestion time when the event carried no timestamp.
 * - `ingested`: the artifact's `created_at` (when Brain captured the event).
 */
export type KpiTimeField = "event" | "ingested";

export interface KpiQueryInput {
  interval?: KpiInterval;
  /** Inclusive lower bound (ISO string or epoch ms). Defaults to earliest event. */
  from?: string | number;
  /** Inclusive upper bound (ISO string or epoch ms). Defaults to latest event. */
  to?: string | number;
  platform?: string;
  eventType?: string;
  target?: string;
  groupBy?: KpiGroupBy;
  timeField?: KpiTimeField;
}

export interface KpiBucket {
  /** Epoch ms of the (UTC-aligned) window start. */
  start: number;
  /** ISO-8601 rendering of `start`. */
  startIso: string;
  count: number;
}

export interface KpiSeries {
  /** Dimension value for this series, or `null` for the overall total series. */
  group: string | null;
  total: number;
  buckets: KpiBucket[];
}

export interface KpiResult {
  kind: "event";
  interval: KpiInterval;
  timeField: KpiTimeField;
  /** The resolved window axis bounds (epoch ms), or null when no data/bounds. */
  range: { from: number | null; to: number | null };
  /** Number of `kind:event` artifacts matched after filtering. */
  total: number;
  /** Overall series first, then one per group when `groupBy` is set. */
  series: KpiSeries[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;

const UNGROUPED = "unknown";

interface NormalizedEvent {
  ts: number;
  platform: string;
  eventType: string;
  target: string;
}

export class KpiQuery {
  private readonly artifacts: StoredBrainArtifact[];

  constructor(artifacts: StoredBrainArtifact[]) {
    this.artifacts = artifacts;
  }

  /**
   * Compute the time-windowed event KPI over the artifacts this query holds.
   * Pure and deterministic: the same artifacts and input always yield the same
   * result (no reliance on wall-clock time).
   */
  events(input: KpiQueryInput = {}): KpiResult {
    const interval = input.interval ?? "day";
    const timeField = input.timeField ?? "event";
    const fromBound = parseTime(input.from);
    const toBound = parseTime(input.to);

    const events = this.artifacts
      .filter((artifact) => artifact.kind === "event")
      .map((artifact) => normalizeEvent(artifact, timeField))
      .filter((event): event is NormalizedEvent => event != null)
      .filter((event) => matchesFilters(event, input))
      .filter((event) => withinBounds(event.ts, fromBound, toBound))
      .sort((a, b) => a.ts - b.ts);

    const total = events.length;

    const lower = fromBound ?? (events.length > 0 ? events[0].ts : null);
    const upper = toBound ?? (events.length > 0 ? events[events.length - 1].ts : null);
    const axis = buildWindowAxis(lower, upper, interval);

    const overall = buildSeries(null, events, axis, interval);
    const series: KpiSeries[] = [overall];

    if (input.groupBy) {
      const byGroup = groupEvents(events, input.groupBy);
      const grouped = [...byGroup.entries()]
        .map(([group, groupEvents]) => buildSeries(group, groupEvents, axis, interval))
        .sort((a, b) => b.total - a.total || compareGroup(a.group, b.group));
      series.push(...grouped);
    }

    return {
      kind: "event",
      interval,
      timeField,
      range: { from: lower, to: upper },
      total,
      series,
    };
  }
}

function normalizeEvent(
  artifact: StoredBrainArtifact,
  timeField: KpiTimeField,
): NormalizedEvent | null {
  const metadata = (artifact.properties.metadata ?? {}) as Record<string, unknown>;
  const ts = resolveTimestamp(artifact, metadata, timeField);
  if (ts == null) return null;
  return {
    ts,
    platform: metadataString(metadata, "platform") ?? UNGROUPED,
    eventType: metadataString(metadata, "event_type") ?? UNGROUPED,
    target: metadataString(metadata, "target") ?? UNGROUPED,
  };
}

function resolveTimestamp(
  artifact: StoredBrainArtifact,
  metadata: Record<string, unknown>,
  timeField: KpiTimeField,
): number | null {
  const ingested = Number.isFinite(artifact.properties.created_at)
    ? artifact.properties.created_at
    : null;
  if (timeField === "ingested") return ingested;
  const eventTs = parseTime(metadata.timestamp as string | number | undefined);
  return eventTs ?? ingested;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function matchesFilters(event: NormalizedEvent, input: KpiQueryInput): boolean {
  if (input.platform != null && event.platform !== input.platform) return false;
  if (input.eventType != null && event.eventType !== input.eventType) return false;
  if (input.target != null && event.target !== input.target) return false;
  return true;
}

function withinBounds(ts: number, from: number | null, to: number | null): boolean {
  if (from != null && ts < from) return false;
  if (to != null && ts > to) return false;
  return true;
}

function groupEvents(
  events: NormalizedEvent[],
  groupBy: KpiGroupBy,
): Map<string, NormalizedEvent[]> {
  const out = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const key = groupValue(event, groupBy);
    const bucket = out.get(key);
    if (bucket) bucket.push(event);
    else out.set(key, [event]);
  }
  return out;
}

function groupValue(event: NormalizedEvent, groupBy: KpiGroupBy): string {
  switch (groupBy) {
    case "platform":
      return event.platform;
    case "event_type":
      return event.eventType;
    case "target":
      return event.target;
  }
}

function buildSeries(
  group: string | null,
  events: NormalizedEvent[],
  axis: number[],
  interval: KpiInterval,
): KpiSeries {
  const counts = new Map<number, number>();
  for (const event of events) {
    const start = floorToWindow(event.ts, interval);
    counts.set(start, (counts.get(start) ?? 0) + 1);
  }
  const buckets: KpiBucket[] = axis.map((start) => ({
    start,
    startIso: new Date(start).toISOString(),
    count: counts.get(start) ?? 0,
  }));
  return { group, total: events.length, buckets };
}

function buildWindowAxis(
  lower: number | null,
  upper: number | null,
  interval: KpiInterval,
): number[] {
  if (lower == null || upper == null) return [];
  const axis: number[] = [];
  let cursor = floorToWindow(lower, interval);
  const end = floorToWindow(upper, interval);
  // Guard against pathological inputs producing an unbounded axis.
  let guard = 0;
  while (cursor <= end && guard < 1_000_000) {
    axis.push(cursor);
    cursor = nextWindow(cursor, interval);
    guard++;
  }
  return axis;
}

function floorToWindow(ts: number, interval: KpiInterval): number {
  const date = new Date(ts);
  switch (interval) {
    case "hour":
      return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
      );
    case "day":
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    case "week": {
      const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      const dayOfWeek = new Date(dayStart).getUTCDay(); // 0 = Sunday
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      return dayStart - daysSinceMonday * DAY_MS;
    }
    case "month":
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
}

function nextWindow(start: number, interval: KpiInterval): number {
  switch (interval) {
    case "hour":
      return start + HOUR_MS;
    case "day":
      return start + DAY_MS;
    case "week":
      return start + WEEK_MS;
    case "month": {
      const date = new Date(start);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
  }
}

function parseTime(value: string | number | undefined | null): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    const epoch = Number(trimmed);
    return Number.isFinite(epoch) ? epoch : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareGroup(a: string | null, b: string | null): number {
  return String(a ?? "").localeCompare(String(b ?? ""));
}
