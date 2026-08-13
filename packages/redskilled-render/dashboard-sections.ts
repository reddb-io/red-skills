// dashboard-sections — the blocks that sit ABOVE the Worker table.
//
// Split out when `dashboard.ts` crossed the 800-line threshold, and by domain
// rather than by size: these functions answer "what is this host watching and
// how has it been going", while what remains answers "what is each Worker
// doing right now". The sparkline lives here because it belongs to the first
// question, and it is EXPORTED because two other modules in this repo grew
// their own copy of it.
import type {
  RedskilledRenderHourlySeries,
  RedskilledRenderPayload,
} from "./payload.js";
import type { RedskilledDashboardOptions } from "./dashboard.js";
import { clamp, formatAgeSeconds, formatRate } from "./format.js";

/**
 * Every project this host is watching, and what it sees in each. PURE.
 *
 * The dashboard used to answer for ONE project — the caller's — on a machine
 * that routinely holds several. An operator asking "what is redskilled doing"
 * got a screen that looked like a view of the directory they happened to stand
 * in, and a second project draining beside it was invisible.
 *
 * Each line states what the daemon actually knows about that project: how many
 * Workers it holds, what its queue looked like at the last poll, and how old
 * that look is. A counter's own age travels with it, so a line never presents a
 * number as current when the poll behind it is minutes old.
 */
export function projectLines(
  payload: RedskilledRenderPayload,
  options: RedskilledDashboardOptions,
): readonly string[] {
  const counters = payload.remote_counters?.projects ?? [];
  const labels = [...new Set([
    ...(payload.registered_projects ?? []),
    ...counters.map((project) => project.project_label),
    ...payload.projects.map((project) => project.project_label),
  ])].sort();
  if (labels.length === 0) return [];

  const width = Math.max(...labels.map((label) => label.length));
  const lines = labels.map((label) => {
    const here = options.project === label ? "★" : " ";
    const workers = payload.projects.find((project) => project.project_label === label)?.worker_count ?? 0;
    const counted = counters.find((project) => project.project_label === label)?.counters;
    const ready = counted?.ready_queue;
    const human = counted?.human_queue;
    const queue = ready == null && human == null
      ? "queue unpolled"
      : `rdy=${counterText(ready)} human=${counterText(human)}`;
    const age = ready?.age_ms == null ? "" : ` · ${formatAgeSeconds(ready.age_ms) ?? "0s"} ago`;
    return clamp(`${here} ${label.padEnd(width)}  wrk=${workers}  ${queue}${age}`, options.maxWidth);
  });

  // A registration that ended is a fact about the host, not noise: it is the
  // difference between "nothing is draining here" and "something stopped".
  for (const lapsed of payload.lapsed_projects ?? []) {
    lines.push(clamp(`  ${lapsed.project_label} — lapsed: ${lapsed.reason}`, options.maxWidth));
  }
  for (const stopped of payload.stopped_projects ?? []) {
    const since = ageBetween(stopped.at, payload.generated_at);
    lines.push(clamp(
      `  ${stopped.project_label} — stopped${since == null ? "" : ` ${since} ago`}`,
      options.maxWidth,
    ));
  }
  for (const orphan of payload.orphaned_projects ?? []) {
    lines.push(clamp(`  ${orphan} — held by a daemon this socket does not reach`, options.maxWidth));
  }
  return lines;
}

/** How long before `now` an instant was, when both can be read. PURE. */
function ageBetween(instant: string, now: string): string | null {
  const from = Date.parse(instant);
  const to = Date.parse(now);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return formatAgeSeconds(Math.max(0, to - from));
}

/** A counter as a number, or the reason it is not one. PURE. */
function counterText(counter: { readonly value: number | null } | undefined): string {
  return counter?.value == null ? "?" : String(counter.value);
}

export function throughputLines(
  payload: RedskilledRenderPayload,
  options: RedskilledDashboardOptions,
): readonly string[] {
  const metrics = payload.metrics;
  if (metrics == null) {
    return [clamp("48h throughput unavailable — daemon payload carries no live metrics", options.maxWidth)];
  }
  if (metrics.history_48h == null) {
    return [clamp("48h throughput unavailable — daemon payload predates hourly history", options.maxWidth)];
  }
  // One padded width for every label, so the two curves start in the SAME
  // column. Unpadded, `tokens` and `Tickets` differ by one character and the
  // bars sit one column apart — which defeats the only thing two stacked
  // sparklines are for, reading them against each other at a glance.
  const width = Math.max(...SERIES_LABELS.map((name) => name.length));
  return [
    hourlySeriesLine("tokens", metrics.history_48h.tokens_per_hour, options, width),
    hourlySeriesLine("tickets", metrics.history_48h.tickets_per_hour, options, width),
  ];
}

/** Every series this block draws, and the source of the shared label column. */
export const SERIES_LABELS = ["tokens", "tickets"] as const;

export const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * The mark for an hour that reported nothing.
 *
 * `·` (U+00B7) was the earlier choice and it is East Asian AMBIGUOUS width: a
 * terminal is free to draw it half as wide as the block elements beside it, so
 * a run of absences visually shortened the curve it belongs to. `─` (U+2500) is
 * a box-drawing character, sized with the blocks, and still reads as "nothing
 * happened" rather than as the "zero" the lowest block already means.
 */
export const SPARK_ABSENT = "─";

function hourlySeriesLine(
  label: (typeof SERIES_LABELS)[number],
  series: RedskilledRenderHourlySeries,
  options: RedskilledDashboardOptions,
  labelWidth: number,
): string {
  const unit = label.padEnd(labelWidth);
  const current = series.current.value;
  const missing = series.buckets.filter((bucket) => bucket.value == null);
  const reason = missing[0]?.absent_reason ?? null;
  const currentText = current == null
    ? `now unavailable (${series.current.absent_reason ?? "no current sample"})`
    : `now=${formatRate(current)}/h ${trendMark(series.trend)}`.trim();
  if (options.maxWidth < 72) {
    return clamp(`${unit} 48h unavailable at width ${options.maxWidth} — 48 hourly points need 72 columns`, options.maxWidth);
  }
  const missingText = missing.length === 0 ? "" : ` · ${missing.length} missing (${reason ?? "unmeasured"})`;
  return clamp(`${unit} 48h ${sparkline(series)} · ${currentText}${missingText}`, options.maxWidth);
}

export function sparkline(series: RedskilledRenderHourlySeries): string {
  const values = series.buckets.flatMap((bucket) => bucket.value == null ? [] : [Math.max(0, bucket.value)]);
  const max = Math.max(0, ...values);
  return series.buckets.map((bucket) => {
    if (bucket.value == null) return SPARK_ABSENT;
    if (max === 0) return SPARK[0];
    return SPARK[Math.min(SPARK.length - 1, Math.floor((Math.max(0, bucket.value) / max) * (SPARK.length - 1)))]!;
  }).join("");
}

export function trendMark(trend: RedskilledRenderHourlySeries["trend"]): string {
  return trend === "up" ? "↑" : trend === "down" ? "↓" : trend === "flat" ? "→" : "?";
}