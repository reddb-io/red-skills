// worker-state-reclaim.ts — reclaim for the durable Worker STATE RECORD lane,
// `.red/state/castle/workers/<id>/state.toon` (issue #2978).
//
// PURE: every input is pre-read by the caller. No I/O, no process reads, no
// clock — `nowMs` is injected.
//
// THE GAP THIS CLOSES. The tmp-lane janitor reclaims what a dead Worker left in
// `.red/tmp/` and the daemon reclaims its own session runtime dirs, but the
// record that NAMES those bytes was owned by neither, so it accumulated without
// bound: 345 records to convey one live Worker. Every reader paid for the pile —
// `worker_vitals` serialised 559KB across 18,633 lines — and the pile is what
// turned a filter bug into an operator-facing lie, because the corpses buried
// the live row.
//
// THE RULE, STATED ONCE. A record is reclaimable when its Worker's process is
// gone AND the record has been settled for longer than the retention. Both
// halves are load-bearing:
//
//   - "its process is gone" is the DAEMON's verdict (ADR 0130): it owns birth
//     and death, so it cannot be out of date about a process it holds. A record
//     born outside the daemon contributes its own recorded pid as EVIDENCE OF
//     LIFE, which can only WITHHOLD a death claim, never manufacture one — the
//     same asymmetry the liveness anchor publishes.
//   - "settled" is what `updated_at` means once the process is gone: the record
//     is written by its own Worker and by nothing else, so a Worker that no
//     longer exists has written its last word. Whatever outcome the record
//     carries at that instant IS its terminal outcome, and the verdict carries
//     it so the reclaim reports what it removed rather than a bare path.
//
// THREE VERDICTS ON LIVENESS, NOT TWO, and the third is the load-bearing one:
// `unknown` — an unreachable or stale daemon — is not `dead`, so it retains.
// A reader that could not reach the authority must never report a running Worker
// as gone; that inversion is what deleted a live lane once already (#2679).
//
// A SILENT TRUNCATION IS A FAILURE: every considered record lands in exactly one
// of `reclaim` or `retain`, and `totals` states the identity so a caller can
// assert it.

import type { WorkerProcessVerdict } from "./worker-reclaim.js";

/**
 * How long a settled Worker state record is kept after its Worker's process is
 * gone. DECLARED ONCE, HERE, and nowhere else.
 *
 * Twenty-four hours, because that is the shortest window that still covers a
 * full overnight drain: an operator triaging the morning after a night of AFK
 * work reads yesterday's records at their desk, and a retention shorter than a
 * day would delete exactly the evidence that triage needs. Past a day the record
 * is no longer the material anyone reads — the Worker's own lane log, the
 * castle history and the tracker all outlive it — while every extra day of
 * records is payload that every reader of every surface pays for on every read.
 */
export const WORKER_STATE_RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;

/** One Worker state record on disk, with its liveness already resolved. */
export interface WorkerStateRecordEntry {
  /** The Worker the record belongs to. */
  worker_id: string;
  /** Absolute path of the record's directory (the parent of `state.toon`). */
  path: string;
  /**
   * The DAEMON's verdict on this Worker's process, with the record's own pid
   * already folded in as evidence of life. `unknown` retains — see the header.
   */
  liveness: WorkerProcessVerdict;
  /**
   * Epoch-ms of the record's last write, or `null` when the record carries no
   * readable instant. A record whose settled instant cannot be read is RETAINED
   * and reported: the janitor never guesses an age it could not measure.
   */
  updatedAtMs: number | null;
  /** The outcome the record last recorded, carried into the verdict so the
   * reclaim reports WHAT it removed and not merely that it removed something. */
  outcome: string;
}

export type WorkerStateRecordVerdictKind =
  /** The daemon names this Worker — the veto that outranks the retention. */
  | "worker-live"
  /** The daemon did not answer, or its answer is stale. Never a death. */
  | "liveness-unknown"
  /** No readable `updated_at`: the record's age is unmeasurable, so it stays. */
  | "no-settled-instant"
  /** The Worker is gone, but the record settled inside the retention window. */
  | "within-retention"
  /** Gone, settled, and past the retention: the only verdict that releases bytes. */
  | "settled-reclaimable";

/** One record, one verdict, one reason. */
export interface WorkerStateRecordVerdict {
  worker_id: string;
  path: string;
  liveness: WorkerProcessVerdict;
  outcome: string;
  /** How long the record has been settled, in ms, or `null` when unmeasurable. */
  age_ms: number | null;
  reclaim: boolean;
  verdict: WorkerStateRecordVerdictKind;
  reason: string;
}

export interface WorkerStateRecordReclaimTotals {
  considered: number;
  reclaim: number;
  retain: number;
}

export interface WorkerStateRecordReclaimPlan {
  reclaim: WorkerStateRecordVerdict[];
  retain: WorkerStateRecordVerdict[];
  totals: WorkerStateRecordReclaimTotals;
}

export interface WorkerStateRecordReclaimOptions {
  /** The instant the retention is measured against. Injected, so this is pure. */
  nowMs: number;
  /** Retention override for tests. Defaults to {@link WORKER_STATE_RECORD_RETENTION_MS}. */
  retentionMs?: number;
}

function judge(
  entry: WorkerStateRecordEntry,
  nowMs: number,
  retentionMs: number,
): WorkerStateRecordVerdict {
  const ageMs = entry.updatedAtMs === null ? null : Math.max(0, nowMs - entry.updatedAtMs);
  const base = {
    worker_id: entry.worker_id,
    path: entry.path,
    liveness: entry.liveness,
    outcome: entry.outcome,
    age_ms: ageMs,
  } as const;
  const retain = (
    verdict: WorkerStateRecordVerdictKind,
    reason: string,
  ): WorkerStateRecordVerdict => ({ ...base, reclaim: false, verdict, reason });

  if (entry.liveness === "alive") {
    return retain(
      "worker-live",
      "the daemon names this Worker, so its record is the record of a running Worker",
    );
  }
  if (entry.liveness === "unknown") {
    return retain(
      "liveness-unknown",
      "nothing could vouch for this Worker's process, and an unanswered question is not a death",
    );
  }
  if (ageMs === null) {
    return retain(
      "no-settled-instant",
      "this record carries no readable last-write instant, so its age cannot be measured",
    );
  }
  if (ageMs <= retentionMs) {
    return retain(
      "within-retention",
      `settled ${ageMs}ms ago, inside the ${retentionMs}ms retention`,
    );
  }
  return {
    ...base,
    reclaim: true,
    verdict: "settled-reclaimable",
    reason:
      `the daemon calls this Worker gone and its record has been settled for ${ageMs}ms, ` +
      `past the ${retentionMs}ms retention`,
  };
}

/**
 * Plan the reclaim for a set of Worker state records.
 *
 * The plan is total: every entry appears exactly once across `reclaim` and
 * `retain`, and `totals` states that identity.
 */
export function planWorkerStateRecordReclaim(
  entries: readonly WorkerStateRecordEntry[],
  options: WorkerStateRecordReclaimOptions,
): WorkerStateRecordReclaimPlan {
  const retentionMs = options.retentionMs ?? WORKER_STATE_RECORD_RETENTION_MS;
  const reclaim: WorkerStateRecordVerdict[] = [];
  const retain: WorkerStateRecordVerdict[] = [];
  // Counted from the INPUT, never from the output arrays, so the accounting
  // identity in `totals` is a real assertion rather than a tautology.
  let considered = 0;
  for (const entry of entries) {
    considered += 1;
    const verdict = judge(entry, options.nowMs, retentionMs);
    if (verdict.reclaim) reclaim.push(verdict);
    else retain.push(verdict);
  }
  return {
    reclaim,
    retain,
    totals: { considered, reclaim: reclaim.length, retain: retain.length },
  };
}
