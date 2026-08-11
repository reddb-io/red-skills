/**
 * remote-counters — what the tracker holds, counter by counter, each with its age.
 *
 * ADR 0141 decision 2 makes every remote counter daemon-owned: open pull
 * requests, open Issues, and the ready and human queue counts come from one
 * poll, on one cycle, in one payload. Decision 3 makes the read free of the
 * network — a request never fetches, so what a surface renders is whatever the
 * last poll stored, and the only honest way to serve that is to state how old it
 * is.
 *
 * **The age is per COUNTER, not per poll.** `repository_activity` dates the poll,
 * which is the right unit for "when did this daemon last talk to GitHub". It is
 * the wrong unit for a line that renders four numbers side by side: a counter
 * nobody asked for and a counter fetched a second ago sit in the same document,
 * and one poll-wide `age_ms` describes neither. Here every counter carries the
 * instant that produced IT.
 *
 * **Absent is not stale, and neither is zero.** Three facts wear the same shape
 * on a naive render — "this queue has drained", "the quota was spent before we
 * asked", "no label was ever named for this counter" — and only the first is a
 * number. A counter with no value carries `null`, its own reason, and `stale:
 * false`, because nothing old is being shown when nothing was ever shown.
 *
 * **Derived once, here, for every surface.** The alternative is each consumer
 * subtracting instants itself, which is how three surfaces come to print three
 * ages for one poll — the same reason the staleness block exists at all.
 *
 * PURE.
 */

import { REDSKILLED_ACTIVITY_STALENESS_MS } from "./activity-report.js";
import type {
  RedskilledActivityOutcome,
  RedskilledProjectActivity,
  RedskilledRepositoryActivity,
} from "./repository-activity.js";

/**
 * Every counter this block carries, in the order a line reads them.
 *
 * Named as a total set rather than left implicit in the record type, so a
 * consumer can render "every counter" without knowing which ones exist and a
 * daemon that grows one cannot ship it unnamed.
 */
export const REDSKILLED_REMOTE_COUNTER_NAMES = [
  "open_pull_requests",
  "open_issues",
  "ready_queue",
  "human_queue",
] as const;

export type RedskilledRemoteCounterName = typeof REDSKILLED_REMOTE_COUNTER_NAMES[number];

/** One counter, and everything needed to render it without re-deriving anything. */
export interface RedskilledRemoteCounter {
  readonly name: RedskilledRemoteCounterName;
  /** What the tracker held; `null` when this poll produced no such count. */
  readonly value: number | null;
  /** The instant that produced `value`; `null` exactly when `value` is. */
  readonly fetched_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  /** True when a value is being served past its window; never true of an absence. */
  readonly stale: boolean;
  /** Why this counter reads as it does, in a sentence a surface can show unchanged. */
  readonly reason: string;
}

/** One project's counters, keyed by name so a consumer never searches a list. */
export interface RedskilledProjectRemoteCounters {
  readonly project_label: string;
  /** `owner/name`, echoed back as registered. */
  readonly repository: string;
  readonly outcome: RedskilledActivityOutcome;
  readonly counters: Readonly<Record<RedskilledRemoteCounterName, RedskilledRemoteCounter>>;
}

export interface RedskilledRemoteCounterReport {
  readonly version: 1;
  readonly threshold_ms: number;
  readonly projects: readonly RedskilledProjectRemoteCounters[];
  readonly reason: string;
}

/** The sentence a host that polls nothing answers with — one string, one meaning. */
export const REDSKILLED_REMOTE_COUNTERS_UNPOLLED_REASON =
  "this daemon polls no repository, so there are no remote counters to date";

/**
 * Date every counter of every polled project. PURE.
 *
 * The activity document is the one source: this projects it per counter and
 * derives nothing GitHub was not asked for. A project the poll could not reach
 * keeps every counter `null` and carries the poll's own sentence, so "the queue
 * is empty" and "we could not ask" never render the same.
 */
export function buildRemoteCounterReport(input: {
  readonly activity: RedskilledRepositoryActivity | null;
  readonly now: string;
  readonly stalenessMs?: number;
}): RedskilledRemoteCounterReport {
  const threshold = input.stalenessMs ?? REDSKILLED_ACTIVITY_STALENESS_MS;
  const activity = input.activity;
  if (activity == null || activity.projects.length === 0) {
    return {
      version: 1,
      threshold_ms: threshold,
      projects: [],
      reason: REDSKILLED_REMOTE_COUNTERS_UNPOLLED_REASON,
    };
  }
  const nowMs = Date.parse(input.now);
  const fetchedMs = Date.parse(activity.fetched_at);
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(fetchedMs) ? Math.max(0, nowMs - fetchedMs) : null;

  const projects = activity.projects.map((project) =>
    buildProjectCounters(project, { fetchedAt: activity.fetched_at, ageMs, threshold })
  );
  return {
    version: 1,
    threshold_ms: threshold,
    projects,
    reason: ageMs == null
      ? "these counters carry no readable instant, so none of them can be presented as current"
      : `every counter here was produced by the poll of ${activity.fetched_at}, ${ageMs}ms ago`,
  };
}

function buildProjectCounters(
  project: RedskilledProjectActivity,
  ctx: { readonly fetchedAt: string; readonly ageMs: number | null; readonly threshold: number },
): RedskilledProjectRemoteCounters {
  const counters = {} as Record<RedskilledRemoteCounterName, RedskilledRemoteCounter>;
  for (const name of REDSKILLED_REMOTE_COUNTER_NAMES) {
    counters[name] = buildCounter(name, valueOf(project, name), project, ctx);
  }
  return {
    project_label: project.project_label,
    repository: project.repository,
    outcome: project.outcome,
    counters,
  };
}

/** What this poll produced for one counter; `null` is an absence, never a zero. */
function valueOf(project: RedskilledProjectActivity, name: RedskilledRemoteCounterName): number | null {
  const counts = project.counts;
  if (counts == null) return null;
  switch (name) {
    case "open_pull_requests":
      return counts.open_pull_requests;
    case "open_issues":
      return counts.open_issues;
    case "ready_queue":
      return counts.ready_queue;
    case "human_queue":
      return counts.human_queue;
  }
}

function buildCounter(
  name: RedskilledRemoteCounterName,
  value: number | null,
  project: RedskilledProjectActivity,
  ctx: { readonly fetchedAt: string; readonly ageMs: number | null; readonly threshold: number },
): RedskilledRemoteCounter {
  const absent = {
    name,
    value: null,
    fetched_at: null,
    age_ms: null,
    threshold_ms: ctx.threshold,
    // An absence is not stale: staleness is a claim about a number being shown,
    // and there is no number here. Calling it stale would put a warning on a
    // counter nobody ever asked for.
    stale: false,
  } as const;
  if (value == null) {
    return {
      ...absent,
      // The poll's own sentence when the poll is why there is no number, so a
      // spent quota reaches the surface in the words of the fetch that met it.
      reason: project.outcome === "counted"
        ? `this poll produced no ${name}, so it is absent rather than zero`
        : project.detail,
    };
  }
  if (ctx.ageMs == null) {
    return {
      name,
      value,
      fetched_at: ctx.fetchedAt,
      age_ms: null,
      threshold_ms: ctx.threshold,
      stale: true,
      reason: `this ${name} carries no readable instant, so it cannot be presented as current`,
    };
  }
  const stale = ctx.ageMs > ctx.threshold;
  return {
    name,
    value,
    fetched_at: ctx.fetchedAt,
    age_ms: ctx.ageMs,
    threshold_ms: ctx.threshold,
    stale,
    reason: stale
      ? `this ${name} is ${ctx.ageMs}ms old, past the ${ctx.threshold}ms window`
      : `counted ${ctx.ageMs}ms ago, within the ${ctx.threshold}ms window`,
  };
}

/** True when `value` is a complete counter report — a client's fail-closed check. */
export function isRedskilledRemoteCounterReport(value: unknown): value is RedskilledRemoteCounterReport {
  if (!isRecord(value)) return false;
  const report = value as Record<string, unknown>;
  return report.version === 1 &&
    typeof report.threshold_ms === "number" &&
    typeof report.reason === "string" &&
    Array.isArray(report.projects) &&
    report.projects.every(isProjectRemoteCounters);
}

function isProjectRemoteCounters(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const project = value as Record<string, unknown>;
  if (typeof project.project_label !== "string" || typeof project.repository !== "string") return false;
  if (typeof project.outcome !== "string" || !isRecord(project.counters)) return false;
  const counters = project.counters as Record<string, unknown>;
  // Every counter, or none of them: a block missing one name is a shape a
  // consumer would have to existence-check, which is what carrying the absence
  // as a value exists to avoid.
  return REDSKILLED_REMOTE_COUNTER_NAMES.every((name) => isRemoteCounter(counters[name]));
}

function isRemoteCounter(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const counter = value as Record<string, unknown>;
  return typeof counter.name === "string" &&
    (counter.value === null || typeof counter.value === "number") &&
    (counter.fetched_at === null || typeof counter.fetched_at === "string") &&
    (counter.age_ms === null || typeof counter.age_ms === "number") &&
    typeof counter.threshold_ms === "number" &&
    typeof counter.stale === "boolean" &&
    typeof counter.reason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
