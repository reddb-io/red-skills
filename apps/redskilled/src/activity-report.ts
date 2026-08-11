/**
 * activity-report — the stored poll, dated for whoever reads it.
 *
 * **Fetching and dating are two domains.** `repository-activity` spends the
 * request: it holds the token condition, the conditional-list plumbing and the
 * rules about what a 304, a spent quota and an unreachable repository each mean.
 * Nothing here talks to GitHub. This module takes the document that poll stored
 * and answers one question — how old is it, and may it be presented as current.
 *
 * **Staleness travels inside the payload.** A surface that dated the answer
 * itself would need the poll interval, the daemon's clock and its own read
 * latency, and would get it subtly wrong in a different way per surface. The age
 * is a field, and rendering it is the whole of a consumer's job.
 *
 * `remote-counters` is this module's sibling, not its replacement: this dates the
 * POLL, which is what tells an operator whether the daemon still reaches GitHub,
 * and that dates each COUNTER, which is what a line rendering several numbers
 * side by side needs (ADR 0141).
 *
 * PURE.
 */

import {
  DEFAULT_REDSKILLED_ACTIVITY_MS,
  type RedskilledActivityRateLimit,
  type RedskilledProjectActivity,
  type RedskilledRepositoryActivity,
} from "./repository-activity.js";

/**
 * How old counts may be before the payload calls them stale.
 *
 * Two poll windows, for the same reason the memory sampler uses two of its own:
 * one missed interval is the jitter of a busy host or a slow API, and two is a
 * poller that stopped.
 */
export const REDSKILLED_ACTIVITY_STALENESS_MS = 2 * DEFAULT_REDSKILLED_ACTIVITY_MS;

/** One project's counts, dated — the shape a consumer renders. */
export interface RedskilledActivityView extends RedskilledProjectActivity {
  readonly fetched_at: string;
  readonly age_ms: number | null;
  readonly stale: boolean;
}

export interface RedskilledActivityReport {
  readonly version: 1;
  readonly fetched_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  readonly stale: boolean;
  readonly request_count: number;
  readonly rate_limit: RedskilledActivityRateLimit;
  readonly projects: readonly RedskilledActivityView[];
  readonly reason: string;
}

/** Date the counts so the consumer renders the age instead of inventing it. PURE. */
export function buildActivityReport(input: {
  readonly activity: RedskilledRepositoryActivity | null;
  readonly now: string;
  readonly stalenessMs?: number;
}): RedskilledActivityReport {
  const threshold = input.stalenessMs ?? REDSKILLED_ACTIVITY_STALENESS_MS;
  const activity = input.activity;
  if (activity == null) {
    return {
      version: 1,
      fetched_at: null,
      age_ms: null,
      threshold_ms: threshold,
      stale: false,
      request_count: 0,
      rate_limit: { remaining: null, reset_at: null, exhausted: false, point_cost: null },
      projects: [],
      reason: "the daemon polls no repository, so there are no counts to age",
    };
  }
  const nowMs = Date.parse(input.now);
  const fetchedMs = Date.parse(activity.fetched_at);
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(fetchedMs) ? Math.max(0, nowMs - fetchedMs) : null;
  const stale = ageMs == null || ageMs > threshold;
  return {
    version: 1,
    fetched_at: activity.fetched_at,
    age_ms: ageMs,
    threshold_ms: threshold,
    stale: activity.projects.length > 0 && stale,
    request_count: activity.request_count,
    rate_limit: activity.rate_limit,
    projects: activity.projects.map((project) => ({
      ...project,
      fetched_at: activity.fetched_at,
      age_ms: ageMs,
      stale: stale,
    })),
    reason: activity.projects.length === 0
      ? "the daemon polls no repository, so there are no counts to age"
      : ageMs == null
        ? "these counts carry no readable instant, so they cannot be presented as current"
        : stale
          ? `these counts are ${ageMs}ms old, past the ${threshold}ms window`
          : `fetched ${ageMs}ms ago, within the ${threshold}ms window`,
  };
}

/** True when `value` is a complete activity report — a client's fail-closed check. */
export function isRedskilledActivityReport(value: unknown): value is RedskilledActivityReport {
  if (!isRecord(value)) return false;
  const report = value as Record<string, unknown>;
  return report.version === 1 &&
    (report.fetched_at === null || typeof report.fetched_at === "string") &&
    (report.age_ms === null || typeof report.age_ms === "number") &&
    typeof report.threshold_ms === "number" &&
    typeof report.stale === "boolean" &&
    Number.isInteger(report.request_count) &&
    isRecord(report.rate_limit) &&
    Array.isArray(report.projects) &&
    typeof report.reason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
