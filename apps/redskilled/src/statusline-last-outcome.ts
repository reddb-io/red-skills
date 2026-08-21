/**
 * statusline-last-outcome — the newest Worker ending, for a line with no Worker
 * to report.
 *
 * **An idle host is not a silent one.** `0w idle` is what the line says when
 * nothing is running, and it says exactly the same thing on a machine that
 * landed a Ticket a minute ago and on one whose drain died an hour back. The
 * daemon already holds the difference: it keeps a mark per Worker ending for its
 * own outcome rate, replayed from `redskilled.log.toonl` on restart. This module
 * is the one hop from that history to the payload.
 *
 * **Facts here, vocabulary there.** Nothing in this module decides whether an
 * ending is a landing or a park — that word is chosen in
 * `@reddb-io/redskilled-render/last-outcome.js`, beside every other word on the
 * line. The daemon publishes what it witnessed and stops.
 *
 * **No new lane and no new read.** The marks are already in memory and already
 * bounded by the metric history's retention, so the newest one costs a scan of a
 * list the process was keeping anyway.
 *
 * PURE.
 */
import type { RedskilledWorkerOutcomeMark } from "./live-metrics.js";

/** One Worker ending, as the payload carries it. */
export interface RedskilledStatuslineLastOutcome {
  /** The lane's event kind — `worker-death` or `worker-budget-kill`. */
  readonly kind: string;
  readonly ts: string;
  readonly project_label: string | null;
  /** The work item exactly as the Worker published it; never parsed here. */
  readonly issue: string | null;
  /** The last phase the Worker pulsed, `!`-suffixed when that stage refused. */
  readonly phase: string | null;
  /** What the Worker reported before ending, in the birth-outcome vocabulary. */
  readonly birth_outcome: string | null;
}

/**
 * The newest ending this host recorded; `null` when it has recorded none. PURE.
 *
 * Newest by the mark's own instant rather than by list position: the boot replay
 * appends a predecessor's history to a list this generation also writes to, and
 * a reader trusting the order would report a replayed ending as the current one.
 * A mark whose instant will not parse loses to any that will — it cannot be
 * dated, and an undatable ending has no age to print beside it.
 */
export function buildLastOutcome(
  marks: readonly RedskilledWorkerOutcomeMark[] | undefined,
): RedskilledStatuslineLastOutcome | null {
  let newest: RedskilledWorkerOutcomeMark | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const mark of marks ?? []) {
    const at = Date.parse(mark.ts);
    if (!Number.isFinite(at) || at < newestMs) continue;
    newest = mark;
    newestMs = at;
  }
  if (newest == null) return null;
  return {
    kind: newest.outcome,
    ts: newest.ts,
    project_label: newest.project_label ?? null,
    issue: newest.issue ?? null,
    phase: newest.phase ?? null,
    birth_outcome: newest.birth_outcome ?? null,
  };
}
