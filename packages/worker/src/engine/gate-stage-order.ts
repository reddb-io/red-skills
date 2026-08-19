// gate-stage-order — the gate's stages in CHEAP → EXPENSIVE order, and the fold
// that turns their outcomes into ONE verdict (ADR 0119, issue #2245).
//
// The order used to live beside the dev bundle's escalation sink, which was
// fine while the dev bundle was the only body that ran a gate. It is not any
// more: `redskilled acp-worker` runs the declared stages LOCALLY, inside the
// Worker process, before it asks the daemon to publish (issue #4020, ADR 0148).
// Restating the order there would be two tables that agree only until someone
// edits one, so the order moved down here — to the package both bodies embed —
// and `apps/dev/src/core/shared-gate.ts` re-exports it for its own callers.
//
// **The order is the contract, not the evaluation sequence.** A caller may
// evaluate stages in whatever sequence its plumbing makes convenient and may
// hand over only the stages it has run so far; the fold always names the
// EARLIEST blocker, so "which stage decided this" never depends on the order
// somebody happened to loop in.

/**
 * The gate's stages, in CHEAP → EXPENSIVE order.
 *
 * `feedback` is the package test/typecheck/lint suite; `backpressure` is the
 * operator's extra commands; `review` is the diff review, last because it is
 * the most expensive. Later stages do not run once an earlier one blocks, and a
 * stage with nothing to run is skipped rather than failed — so a review that
 * cannot run degrades the gate instead of blocking the work.
 */
export const GATE_STAGE_ORDER = ["feedback", "backpressure", "review"] as const;

export type GateStage = (typeof GATE_STAGE_ORDER)[number];

/** One stage's contribution to the gate verdict. */
export interface GateStageOutcome {
  stage: GateStage;
  /** False → this stage BLOCKS the landing. */
  ok: boolean;
  /** True when the stage was not wired or had nothing to run; never blocks. */
  skipped?: boolean;
}

/** ONE verdict for the whole gate: green, or the first stage that blocked it. */
export interface GateVerdict {
  /** True only when no stage blocked. */
  ok: boolean;
  /** The earliest blocking stage in {@link GATE_STAGE_ORDER}. */
  failedStage?: GateStage;
}

/**
 * Fold the stage outcomes into ONE verdict. PURE — no IO.
 *
 * The caller may pass the stages in any order and may pass only the stages it
 * has run so far; the fold always reports the earliest blocker in
 * {@link GATE_STAGE_ORDER}, so "which stage decided this" does not depend on the
 * order the caller happened to evaluate them in. A skipped stage never blocks.
 */
export function gateVerdict(outcomes: readonly GateStageOutcome[]): GateVerdict {
  const ordered = [...outcomes].sort(
    (a, b) => GATE_STAGE_ORDER.indexOf(a.stage) - GATE_STAGE_ORDER.indexOf(b.stage),
  );
  for (const outcome of ordered) {
    if (outcome.skipped === true || outcome.ok) continue;
    return { ok: false, failedStage: outcome.stage };
  }
  return { ok: true };
}
