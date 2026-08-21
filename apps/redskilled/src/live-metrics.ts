/**
 * live-metrics — the rates the daemon can derive from what it already holds.
 *
 * **Nothing here is a new measurement.** The heartbeat already carries each
 * Worker's cumulative counts and its runner and model, and the host event lane
 * already carries every Worker outcome. Those are ingredients only the daemon
 * sees across projects, and until now it aggregated none of them — so every
 * surface that wanted a rate either invented one from a single sample or went
 * without. This module turns the facts into rates once, for all of them.
 *
 * **The daemon aggregates and renders; surfaces print.** The result travels on
 * the same payload the statusline and both dashboards already read, so a rate is
 * computed in exactly one place. A surface that divided two counters itself would
 * be a second authority on a number that has one answer.
 *
 * **A window with no data reports absence, never zero.** "Nothing happened" and
 * "nothing was measured" are opposite facts about a busy machine, and a zero
 * standing in for the second is the failure `RedskilledStatuslineVitals` already
 * refuses for RSS. Every metric therefore carries `value: null` with a stated
 * reason, and a window names in `unavailable` each source that had nothing to
 * answer with.
 *
 * PURE: the observations, the outcomes and the instant are all inputs.
 */

/** The two windows the daemon answers for. */
export type RedskilledMetricWindowName = "hour" | "day";

export const REDSKILLED_METRIC_HOUR_MS = 3_600_000;
export const REDSKILLED_METRIC_DAY_MS = 86_400_000;
export const REDSKILLED_METRIC_HISTORY_HOURS = 48;

/**
 * How long the daemon keeps a fact it will later derive a rate from.
 *
 * Exactly the widest window it answers for: an observation older than the day
 * window can change no answer, and keeping it would grow the history without
 * ever being read.
 */
export const REDSKILLED_METRIC_RETENTION_MS =
  (REDSKILLED_METRIC_HISTORY_HOURS + 1) * REDSKILLED_METRIC_HOUR_MS;

/**
 * How many entries a history holds before the oldest are dropped.
 *
 * Age alone bounds the history in the ordinary case; the count bounds it in the
 * pathological one, where a project heartbeats far faster than the daemon
 * expects. The newest entries are the ones kept — a rate about the last minute
 * is worth more than one about twenty-three hours ago.
 */
export const REDSKILLED_METRIC_HISTORY_LIMIT = 8_192;

/**
 * One reading of a Worker's published counters, as the daemon received it.
 *
 * A projection of the display record rather than the record itself: the rates
 * rest on four fields, and a history that stored the whole record would keep a
 * phase string per heartbeat for a day.
 */
export interface RedskilledWorkerMetricObservation {
  readonly worker_id: string;
  readonly observed_at: string;
  /** The Worker's cumulative token count, as published; `null` when unstated. */
  readonly tokens: number | null;
  /** The Worker's cumulative tool count, as published; `null` when unstated. */
  readonly tools: number | null;
  readonly runner: string | null;
  readonly model: string | null;
}

/**
 * One Worker's ending, as the host event lane recorded it.
 *
 * The rate derivation reads only `ts`; the four fields beside it are what an
 * IDLE host has left to say. A machine with no live Worker renders `idle` and
 * nothing else, so a drain that landed thirty seconds ago and one that died an
 * hour ago look identical at a glance — and the facts that separate them were
 * already in the daemon's hand at the moment it recorded the death.
 *
 * Every added field is OPTIONAL because the same marks are replayed from the
 * event lane by a restarted daemon (`lifecycle.ts`), and a lane row carries the
 * project and the kind but never the Worker's own account of its work. A mark
 * recovered from history says less than one witnessed live, and says so.
 */
export interface RedskilledWorkerOutcomeMark {
  readonly worker_id: string;
  readonly ts: string;
  /** The lane's own event kind, carried unread. */
  readonly outcome: string;
  /** Which project ended, so an idle line never reports another repository's. */
  readonly project_label?: string;
  /** The work item, exactly as the Worker published it; never parsed here. */
  readonly issue?: string | null;
  /** The last phase the Worker pulsed, `!`-suffixed when that stage refused. */
  readonly phase?: string | null;
  /** What the Worker REPORTED before ending, in the birth-outcome vocabulary. */
  readonly birth_outcome?: string | null;
}

/**
 * The mark for an ending this daemon WITNESSED, with what the Worker had said.
 *
 * The display record is the Worker's own published account — the daemon reads
 * two fields off it and parses neither (ADR 0130 rule 3). Reading them HERE, at
 * the moment of death, is the only chance there is: the display map is cleared
 * the instant the Worker is forgotten.
 */
export function witnessedOutcomeMark(
  worker: { readonly worker_id: string; readonly project_label: string },
  ts: string,
  kind: string,
  display: { readonly issue: string | null; readonly phase: string | null } | undefined,
  birthOutcome: string | undefined,
): RedskilledWorkerOutcomeMark {
  return {
    worker_id: worker.worker_id,
    ts,
    outcome: kind,
    project_label: worker.project_label,
    issue: display?.issue ?? null,
    phase: display?.phase ?? null,
    birth_outcome: birthOutcome ?? null,
  };
}

/**
 * The mark for an ending REPLAYED off the lane by a successor daemon.
 *
 * It carries strictly less: the lane row holds the project and the kind, and the
 * Worker's account of its own work was never written there. A successor that
 * filled the gap with a plausible default would be inventing history, so the
 * fields it cannot know stay `null` and every reader degrades on them.
 */
export function replayedOutcomeMark(
  event: { readonly worker_id: string; readonly ts: string; readonly event: string; readonly project_label: string },
): RedskilledWorkerOutcomeMark {
  return {
    worker_id: event.worker_id,
    ts: event.ts,
    outcome: event.event,
    project_label: event.project_label,
    issue: null,
    phase: null,
    birth_outcome: null,
  };
}

/**
 * One derived number, or the honest absence of it.
 *
 * `samples` is stated beside the value because a rate resting on two heartbeats
 * and one resting on two hundred are different claims about the same machine,
 * and a surface that could not tell them apart would print both with the same
 * confidence.
 */
export interface RedskilledMetricValue {
  readonly value: number | null;
  /** Why there is no value; `null` exactly when there is one. */
  readonly absent_reason: string | null;
  /** How many facts inside the window the answer rests on. */
  readonly samples: number;
}

/** One key's share of a window — a runner name, or a model name. */
export interface RedskilledUsageShare {
  readonly key: string;
  readonly worker_count: number;
  /** This key's Workers over the attributed ones; never over the unattributed. */
  readonly share: number;
}

/**
 * How a window's Workers divide over one dimension.
 *
 * `unattributed_workers` is counted rather than dropped: a Worker whose project
 * published no runner is not a Worker that ran on nothing, and a share list that
 * silently excluded it would report 100% of a machine while describing half of
 * it.
 */
export interface RedskilledUsageShares {
  readonly dimension: "runner" | "model";
  readonly attributed_workers: number;
  readonly unattributed_workers: number;
  readonly shares: readonly RedskilledUsageShare[];
  /** Why the list is empty; `null` whenever it is not. */
  readonly absent_reason: string | null;
}

/** Everything one rolling window has to say. */
export interface RedskilledMetricsWindow {
  readonly window: RedskilledMetricWindowName;
  readonly window_ms: number;
  /** The oldest instant this window counts, inclusive. */
  readonly from: string;
  readonly to: string;
  readonly tokens_per_min: RedskilledMetricValue;
  readonly tools_per_min: RedskilledMetricValue;
  readonly issues_per_hour: RedskilledMetricValue;
  readonly runner_share: RedskilledUsageShares;
  readonly model_share: RedskilledUsageShares;
  /**
   * Each source that had nothing to answer with, by name.
   *
   * Named rather than merely missing, because "the sampler is down" and "the
   * machine is quiet" produce identical nulls and only one of them is a fault.
   */
  readonly unavailable: readonly string[];
}

/** The metrics block, as it travels on the aggregate payload. */
export interface RedskilledStatuslineMetrics {
  readonly generated_at: string;
  readonly hour: RedskilledMetricsWindow;
  readonly day: RedskilledMetricsWindow;
  /** Absent on daemon payloads produced before the 48-hour history contract. */
  readonly history_48h?: RedskilledHourlyHistory;
}

/** The complete block emitted by this daemon version, rather than decoded legacy input. */
export interface RedskilledDerivedStatuslineMetrics extends RedskilledStatuslineMetrics {
  readonly history_48h: RedskilledHourlyHistory;
}

export interface RedskilledHourlyMetricBucket {
  readonly hour: string;
  readonly value: number | null;
  readonly absent_reason: string | null;
}

export type RedskilledMetricTrend = "up" | "down" | "flat";

export interface RedskilledHourlyMetricSeries {
  readonly buckets: readonly RedskilledHourlyMetricBucket[];
  readonly current: RedskilledMetricValue;
  readonly trend: RedskilledMetricTrend | null;
  readonly trend_absent_reason: string | null;
}

export interface RedskilledHourlyHistory {
  readonly hours: 48;
  readonly from: string;
  readonly to: string;
  readonly tokens_per_hour: RedskilledHourlyMetricSeries;
  readonly tickets_per_hour: RedskilledHourlyMetricSeries;
}

export interface DeriveRedskilledLiveMetricsInput {
  readonly observations: readonly RedskilledWorkerMetricObservation[];
  readonly outcomes: readonly RedskilledWorkerOutcomeMark[];
  readonly now: string;
}

/** Both windows, derived from the facts the daemon holds. PURE. */
export function deriveRedskilledLiveMetrics(
  input: DeriveRedskilledLiveMetricsInput,
): RedskilledDerivedStatuslineMetrics {
  return {
    generated_at: input.now,
    hour: buildWindow("hour", REDSKILLED_METRIC_HOUR_MS, input),
    day: buildWindow("day", REDSKILLED_METRIC_DAY_MS, input),
    history_48h: buildHourlyHistory(input),
  };
}

/** Forty-eight UTC-aligned hourly points for the operational dashboard. PURE. */
function buildHourlyHistory(input: DeriveRedskilledLiveMetricsInput): RedskilledHourlyHistory {
  const nowMs = instant(input.now);
  const currentHour = nowMs == null ? null : Math.floor(nowMs / REDSKILLED_METRIC_HOUR_MS) * REDSKILLED_METRIC_HOUR_MS;
  const firstHour = currentHour == null
    ? null
    : currentHour - (REDSKILLED_METRIC_HISTORY_HOURS - 1) * REDSKILLED_METRIC_HOUR_MS;
  const hours = Array.from({ length: REDSKILLED_METRIC_HISTORY_HOURS }, (_unused, index) =>
    firstHour == null ? null : firstHour + index * REDSKILLED_METRIC_HOUR_MS);

  const tokenRates = hourlyTokenRates(input.observations, hours, nowMs);
  const tokenBuckets = hours.map((hour, index): RedskilledHourlyMetricBucket => ({
    hour: hour == null ? input.now : new Date(hour).toISOString(),
    value: tokenRates[index] ?? null,
    absent_reason: tokenRates[index] == null ? "no token samples span this hour" : null,
  }));

  const outcomes = input.outcomes
    .map((outcome) => instant(outcome.ts))
    .filter((at): at is number =>
      at != null && firstHour != null && nowMs != null && at >= firstHour && at <= nowMs);
  const ticketBuckets = hours.map((hour): RedskilledHourlyMetricBucket => {
    const value = hour == null || outcomes.length === 0
      ? null
      : outcomes.filter((at) => at >= hour && at < hour + REDSKILLED_METRIC_HOUR_MS).length;
    return {
      hour: hour == null ? input.now : new Date(hour).toISOString(),
      value,
      absent_reason: value == null ? "no Worker outcome history is available for the last 48 hours" : null,
    };
  });

  return {
    hours: REDSKILLED_METRIC_HISTORY_HOURS,
    from: firstHour == null ? input.now : new Date(firstHour).toISOString(),
    to: input.now,
    tokens_per_hour: hourlySeries(tokenBuckets),
    tickets_per_hour: hourlySeries(ticketBuckets),
  };
}

/**
 * Convert cumulative Worker counters into an hourly rate per Worker, then sum.
 * A segment crossing an hour contributes only its overlapping duration; a
 * partial current hour is therefore normalised to an hourly rate.
 */
function hourlyTokenRates(
  observations: readonly RedskilledWorkerMetricObservation[],
  hours: readonly (number | null)[],
  nowMs: number | null,
): readonly (number | null)[] {
  if (nowMs == null || hours.some((hour) => hour == null)) return hours.map(() => null);
  const byWorker = new Map<string, { at: number; count: number }[]>();
  for (const observation of observations) {
    const at = instant(observation.observed_at);
    if (at == null || observation.tokens == null || !Number.isFinite(observation.tokens)) continue;
    const series = byWorker.get(observation.worker_id) ?? [];
    series.push({ at, count: observation.tokens });
    byWorker.set(observation.worker_id, series);
  }

  const totals = hours.map(() => 0);
  const measured = hours.map(() => false);
  for (const series of byWorker.values()) {
    series.sort((left, right) => left.at - right.at);
    const allocated = hours.map(() => ({ tokens: 0, duration: 0 }));
    for (let index = 1; index < series.length; index += 1) {
      const previous = series[index - 1];
      const current = series[index];
      if (previous == null || current == null || current.at <= previous.at || current.count < previous.count) continue;
      const duration = current.at - previous.at;
      const delta = current.count - previous.count;
      for (let bucketIndex = 0; bucketIndex < hours.length; bucketIndex += 1) {
        const start = hours[bucketIndex]!;
        const end = Math.min(start + REDSKILLED_METRIC_HOUR_MS, nowMs);
        const overlap = Math.max(0, Math.min(current.at, end) - Math.max(previous.at, start));
        if (overlap === 0) continue;
        allocated[bucketIndex]!.tokens += delta * (overlap / duration);
        allocated[bucketIndex]!.duration += overlap;
      }
    }
    for (let index = 0; index < allocated.length; index += 1) {
      const bucket = allocated[index]!;
      if (bucket.duration <= 0) continue;
      totals[index]! += bucket.tokens / (bucket.duration / REDSKILLED_METRIC_HOUR_MS);
      measured[index] = true;
    }
  }
  return totals.map((value, index) => measured[index] ? value : null);
}

function hourlySeries(buckets: readonly RedskilledHourlyMetricBucket[]): RedskilledHourlyMetricSeries {
  const currentBucket = buckets.at(-1);
  const previousBucket = buckets.at(-2);
  const value = currentBucket?.value ?? null;
  const samples = buckets.filter((bucket) => bucket.value != null).length;
  let trend: RedskilledMetricTrend | null = null;
  if (value != null && previousBucket?.value != null) {
    trend = value === previousBucket.value ? "flat" : value > previousBucket.value ? "up" : "down";
  }
  return {
    buckets,
    current: {
      value,
      absent_reason: currentBucket?.absent_reason ?? "the current hourly bucket is unavailable",
      samples,
    },
    trend,
    trend_absent_reason: trend == null ? "the current and previous hourly buckets are not both measured" : null,
  };
}

export interface PruneRedskilledMetricHistoryOptions {
  readonly now: string;
  readonly retentionMs?: number;
  readonly limit?: number;
}

/**
 * The entries still worth keeping, oldest first. PURE.
 *
 * The history is bounded here rather than at each call site so both lanes — the
 * observations and the outcomes — age out by one rule. An entry whose instant
 * cannot be read is dropped: it can date no window, so keeping it would grow the
 * history with something no answer can ever rest on.
 */
export function pruneRedskilledMetricHistory<T>(
  entries: readonly T[],
  instantOf: (entry: T) => string,
  options: PruneRedskilledMetricHistoryOptions,
): T[] {
  const nowMs = instant(options.now);
  const retention = options.retentionMs ?? REDSKILLED_METRIC_RETENTION_MS;
  const limit = options.limit ?? REDSKILLED_METRIC_HISTORY_LIMIT;
  const kept = entries.filter((entry) => {
    const at = instant(instantOf(entry));
    if (at == null) return false;
    return nowMs == null || nowMs - at <= retention;
  });
  return kept.length <= limit ? kept : kept.slice(kept.length - limit);
}

/** One window's whole answer. PURE. */
function buildWindow(
  name: RedskilledMetricWindowName,
  windowMs: number,
  input: DeriveRedskilledLiveMetricsInput,
): RedskilledMetricsWindow {
  const nowMs = instant(input.now);
  const fromMs = nowMs == null ? null : nowMs - windowMs;
  const label = name === "hour" ? "1h" : "24h";

  const observations = input.observations
    .map((observation) => ({ observation, at: instant(observation.observed_at) }))
    .filter((entry): entry is { observation: RedskilledWorkerMetricObservation; at: number } =>
      entry.at != null && withinWindow(entry.at, fromMs, nowMs)
    )
    .sort((a, b) => a.at - b.at);
  const outcomes = input.outcomes
    .map((outcome) => instant(outcome.ts))
    .filter((at): at is number => at != null && withinWindow(at, fromMs, nowMs));

  const tokens = buildRate(observations, (observation) => observation.tokens, "tokens", label);
  const tools = buildRate(observations, (observation) => observation.tools, "tools", label);

  const unavailable: string[] = [];
  if (observations.length === 0) unavailable.push("worker-vitals");
  else {
    if (tokens.samples === 0) unavailable.push("worker-vitals.tokens");
    if (tools.samples === 0) unavailable.push("worker-vitals.tools");
  }
  if (outcomes.length === 0) unavailable.push("worker-outcomes");

  return {
    window: name,
    window_ms: windowMs,
    from: fromMs == null ? input.now : new Date(fromMs).toISOString(),
    to: input.now,
    tokens_per_min: tokens,
    tools_per_min: tools,
    issues_per_hour: buildIssueRate(outcomes.length, windowMs, label),
    runner_share: buildShares("runner", observations, (observation) => observation.runner, label),
    model_share: buildShares("model", observations, (observation) => observation.model, label),
    unavailable,
  };
}

/**
 * A per-minute rate from the climb of one cumulative counter. PURE.
 *
 * **Per Worker, then summed.** Each Worker publishes its own running total, so a
 * difference taken across Workers would measure the gap between two unrelated
 * counters rather than anything spent.
 *
 * **A drop is a counter that restarted, never work undone.** A Worker's project
 * may reset its count — a fresh run, a re-published record — and subtracting
 * across that boundary would report negative tokens. Only the climbs are summed.
 *
 * **The span is the union of the samples, not their sum.** Workers run at the
 * same time, so adding each one's span would divide the machine's work by more
 * wall-clock than the machine lived through and report a rate several times too
 * low.
 */
function buildRate(
  entries: readonly { readonly observation: RedskilledWorkerMetricObservation; readonly at: number }[],
  counterOf: (observation: RedskilledWorkerMetricObservation) => number | null,
  field: string,
  label: string,
): RedskilledMetricValue {
  const byWorker = new Map<string, { readonly at: number; readonly count: number }[]>();
  let samples = 0;
  for (const entry of entries) {
    const count = counterOf(entry.observation);
    if (count == null || !Number.isFinite(count)) continue;
    samples += 1;
    const series = byWorker.get(entry.observation.worker_id) ?? [];
    series.push({ at: entry.at, count });
    byWorker.set(entry.observation.worker_id, series);
  }

  if (samples === 0) {
    return {
      value: null,
      absent_reason: `no Worker published a ${field} count in the last ${label}`,
      samples: 0,
    };
  }

  let climbed = 0;
  let earliest: number | null = null;
  let latest: number | null = null;
  for (const series of byWorker.values()) {
    if (series.length < 2) continue;
    for (let index = 1; index < series.length; index++) {
      const previous = series[index - 1];
      const current = series[index];
      if (previous == null || current == null) continue;
      climbed += Math.max(0, current.count - previous.count);
    }
    const first = series[0];
    const last = series[series.length - 1];
    if (first != null) earliest = earliest == null ? first.at : Math.min(earliest, first.at);
    if (last != null) latest = latest == null ? last.at : Math.max(latest, last.at);
  }

  if (earliest == null || latest == null || latest <= earliest) {
    return {
      value: null,
      absent_reason: `the last ${label} holds one sample of ${field} per Worker, and one instant spans no rate`,
      samples,
    };
  }

  return { value: climbed / ((latest - earliest) / 60_000), absent_reason: null, samples };
}

/**
 * Outcomes per hour, from the endings the lane recorded. PURE.
 *
 * A window with no outcome reports absence rather than `0/h`: a machine that
 * finished nothing in the last minute of a fresh boot and one that has stalled
 * for an hour produce the same zero, and only the second is worth waking for.
 */
function buildIssueRate(count: number, windowMs: number, label: string): RedskilledMetricValue {
  if (count === 0) {
    return {
      value: null,
      absent_reason: `no Worker outcome was recorded in the last ${label}`,
      samples: 0,
    };
  }
  return { value: count / (windowMs / REDSKILLED_METRIC_HOUR_MS), absent_reason: null, samples: count };
}

/**
 * How the window's Workers divide over one published dimension. PURE.
 *
 * Each Worker counts once, under its NEWEST attribution: a Worker steered from
 * one runner to another spent time on both, but the daemon holds no per-sample
 * duration to split it by, and counting it twice would report more Workers than
 * the host ever held.
 */
function buildShares(
  dimension: "runner" | "model",
  entries: readonly { readonly observation: RedskilledWorkerMetricObservation; readonly at: number }[],
  keyOf: (observation: RedskilledWorkerMetricObservation) => string | null,
  label: string,
): RedskilledUsageShares {
  const latest = new Map<string, string | null>();
  for (const entry of entries) {
    const key = keyOf(entry.observation);
    // Entries arrive oldest first, so the last non-null wins; an observation that
    // published nothing does not erase what an earlier one said about the Worker.
    if (key != null) latest.set(entry.observation.worker_id, key);
    else if (!latest.has(entry.observation.worker_id)) latest.set(entry.observation.worker_id, null);
  }

  const counts = new Map<string, number>();
  let attributed = 0;
  let unattributed = 0;
  for (const key of latest.values()) {
    if (key == null) {
      unattributed += 1;
      continue;
    }
    attributed += 1;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const shares = [...counts.entries()]
    .map(([key, worker_count]) => ({ key, worker_count, share: worker_count / attributed }))
    .sort((a, b) => b.worker_count - a.worker_count || a.key.localeCompare(b.key));

  return {
    dimension,
    attributed_workers: attributed,
    unattributed_workers: unattributed,
    shares,
    absent_reason: shares.length > 0
      ? null
      : latest.size === 0
        ? `no Worker was observed in the last ${label}`
        : `no Worker published a ${dimension} in the last ${label}`,
  };
}

function withinWindow(at: number, fromMs: number | null, nowMs: number | null): boolean {
  if (fromMs == null || nowMs == null) return true;
  return at >= fromMs && at <= nowMs;
}

/** An ISO instant in milliseconds, or `null` when it is not one. PURE. */
function instant(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** True when `value` is a complete metrics block — a consumer's fail-closed check. */
export function isRedskilledStatuslineMetrics(value: unknown): value is RedskilledStatuslineMetrics {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const metrics = value as Record<string, unknown>;
  return typeof metrics.generated_at === "string" &&
    isMetricsWindow(metrics.hour) &&
    isMetricsWindow(metrics.day) &&
    (metrics.history_48h === undefined || isHourlyHistory(metrics.history_48h));
}

function isHourlyHistory(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const history = value as Record<string, unknown>;
  return history.hours === REDSKILLED_METRIC_HISTORY_HOURS &&
    isHourlySeries(history.tokens_per_hour) &&
    isHourlySeries(history.tickets_per_hour);
}

function isHourlySeries(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const series = value as Record<string, unknown>;
  return Array.isArray(series.buckets) && series.buckets.length === REDSKILLED_METRIC_HISTORY_HOURS &&
    series.buckets.every((bucket) => {
      if (bucket === null || typeof bucket !== "object" || Array.isArray(bucket)) return false;
      const point = bucket as Record<string, unknown>;
      return typeof point.hour === "string" &&
        (point.value === null || typeof point.value === "number") &&
        (point.absent_reason === null || typeof point.absent_reason === "string");
    });
}

function isMetricsWindow(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Record<string, unknown>;
  return typeof window.window === "string" &&
    typeof window.window_ms === "number" &&
    isMetricValue(window.tokens_per_min) &&
    isMetricValue(window.tools_per_min) &&
    isMetricValue(window.issues_per_hour) &&
    Array.isArray(window.unavailable);
}

function isMetricValue(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const metric = value as Record<string, unknown>;
  return (metric.value === null || typeof metric.value === "number") &&
    (metric.absent_reason === null || typeof metric.absent_reason === "string") &&
    Number.isInteger(metric.samples);
}
