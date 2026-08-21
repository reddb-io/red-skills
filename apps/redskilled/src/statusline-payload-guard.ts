/**
 * statusline-payload-guard — is this record a complete statusline payload?
 *
 * **A fail-closed check is a domain, not a tail.** The payload document, its
 * assembly and this validator were one 864-line file, so a reader asking "what
 * does a client accept" walked four hundred lines of aggregation to find out —
 * the same accumulation the file-size ratchet exists to refuse. Splitting it
 * puts the question and its answer in one place and drops the payload module
 * back under the threshold it had a declared debt against.
 *
 * The shape check is DELIBERATELY partial and deliberately structural: it asks
 * for the fields a consumer would crash without, and it asks about their types
 * rather than their values. A daemon that predates an OPTIONAL block still
 * produces a valid payload — that is what makes the block optional — so every
 * later addition is checked only when present.
 *
 * PURE.
 */
import { isGithubBalanceReport } from "@reddb-io/github";
import { isRedskilledActivityReport } from "./activity-report.js";
import { isRedskilledStatuslineMetrics } from "./live-metrics.js";
import { isRedskilledRemoteCounterReport } from "./remote-counters.js";
import { isStatuslineDeaths } from "./statusline-deaths.js";
import type { RedskilledStatuslinePayload } from "./statusline-payload.js";

/** True when `value` is a complete payload — a client's fail-closed check. */
export function isRedskilledStatuslinePayload(value: unknown): value is RedskilledStatuslinePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const daemon = payload.daemon as Record<string, unknown> | undefined;
  const staleness = payload.staleness as Record<string, unknown> | undefined;
  const host = payload.host as Record<string, unknown> | undefined;
  return payload.version === 1 &&
    typeof payload.generated_at === "string" &&
    daemon != null && typeof daemon === "object" &&
    Number.isInteger(daemon.pid) &&
    typeof daemon.daemon_version === "string" &&
    typeof daemon.protocol_version === "number" &&
    staleness != null && typeof staleness === "object" &&
    typeof staleness.stale === "boolean" &&
    typeof staleness.threshold_ms === "number" &&
    Array.isArray(staleness.unmeasured_workers) &&
    host != null && typeof host === "object" &&
    Number.isInteger(host.worker_count) &&
    Number.isInteger(host.project_count) &&
    typeof host.observed_rss_bytes === "number" &&
    Array.isArray(payload.projects) &&
    Array.isArray(payload.workers) &&
    // Absent is accepted for the same reason the activity report's is: a daemon
    // older than this field answers completely without it, and a consumer that
    // rejected the whole payload would lose the Worker set over a fact it only
    // needed to tell an idle project from an unknown one.
    (payload.known_projects === undefined ||
      (Array.isArray(payload.known_projects) && payload.known_projects.every((label) => typeof label === "string"))) &&
    (payload.registered_projects === undefined ||
      (Array.isArray(payload.registered_projects) &&
        payload.registered_projects.every((label) => typeof label === "string"))) &&
    (payload.lapsed_projects === undefined ||
      (Array.isArray(payload.lapsed_projects) && payload.lapsed_projects.every(isStatuslineLapse))) &&
    (payload.stopped_projects === undefined ||
      (Array.isArray(payload.stopped_projects) && payload.stopped_projects.every(isStatuslineStop))) &&
    (payload.orphaned_projects === undefined ||
      (Array.isArray(payload.orphaned_projects) &&
        payload.orphaned_projects.every((label) => typeof label === "string"))) &&
    // Absent is accepted, malformed is not: a daemon older than the activity
    // poller answers a newer client's read, and rejecting its whole payload over
    // a field this consumer did not ask for would lose the Worker set — the very
    // version skew one host-scoped daemon exists to stop managing (ADR 0130).
    (payload.repository_activity === undefined || isRedskilledActivityReport(payload.repository_activity)) &&
    // Absent is accepted for the same reason, and for one more: this block is
    // newer than the report beside it, so a daemon one release behind serves
    // every counter's value without their per-counter ages.
    (payload.remote_counters === undefined || isRedskilledRemoteCounterReport(payload.remote_counters)) &&
    // Absent is accepted for the same reason: a daemon older than the balance
    // poller answers completely without it, and a consumer that rejected the
    // whole payload would lose the Worker set over a badge.
    (payload.github_balance === undefined || isGithubBalanceReport(payload.github_balance)) &&
    // Absent is accepted for the reason the two project lists are: a daemon that
    // predates the reaper, or the engine block, answers completely without them,
    // and rejecting the whole payload would lose the Worker set over a field this
    // consumer only needed for a badge (ADR 0130 rule 3).
    (payload.deaths === undefined || isStatuslineDeaths(payload.deaths)) &&
    (payload.engine === undefined || isStatuslineEngine(payload.engine)) &&
    (payload.metrics === undefined || isRedskilledStatuslineMetrics(payload.metrics));
}

function isStatuslineLapse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const lapse = value as Record<string, unknown>;
  return typeof lapse.project_label === "string" &&
    typeof lapse.at === "string" &&
    (lapse.registered_at === undefined || typeof lapse.registered_at === "string") &&
    (lapse.standing === undefined || typeof lapse.standing === "boolean") &&
    (lapse.queue_depth === undefined || Number.isInteger(lapse.queue_depth)) &&
    typeof lapse.reason === "string";
}

function isStatuslineStop(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const stopped = value as Record<string, unknown>;
  return typeof stopped.project_label === "string" &&
    typeof stopped.at === "string" &&
    (stopped.standing === undefined || typeof stopped.standing === "boolean") &&
    (stopped.queue_depth === undefined || Number.isInteger(stopped.queue_depth));
}

function isStatuslineEngine(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const engine = value as Record<string, unknown>;
  return typeof engine.running_version === "string" &&
    (engine.published_version === null || typeof engine.published_version === "string");
}
