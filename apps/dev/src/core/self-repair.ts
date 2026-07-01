// self-repair — the UNIFIED attempt-level self-repair loop (#940, PRD #928).
//
// Historically an attempt had THREE independent "the worker did not land clean"
// guardrails, each with its own trigger, its own preserve-the-work path, and its
// own give-up threshold:
//   1. structured-output-invalid — the worker never emitted a valid completion
//      (the `AgentOutput` schema / `<promise>DONE</promise>` sentinel, #932/ADR
//      0082); recovered by the `crashed` retry cap.
//   2. commit-fail — the worker finished but left work uncommitted (the
//      DONE-without-commit class, #788); rescued by `salvageUncommitted`, which
//      force-pushes the dirty tree onto the worker branch.
//   3. gate-reject — the feedback / backpressure gate rejected the branch;
//      recovered by the `validation` caps.
// The slot-circuit breaker (core/slot-circuit.ts) layered a FOURTH counter on top
// at the fleet level: K fast deaths trip the slot open.
//
// Four counters, three preserve-the-work paths, one recurring failure: work
// silently lost, or a stuck attempt blind-retried past the point of usefulness.
//
// This module folds the three attempt-level failure kinds into ONE mechanism:
//   - ONE consecutive-failure counter spans all three kinds. A `gate-reject`
//     followed by a `commit-fail` is TWO consecutive strikes, not two separate
//     budgets that each reset the other.
//   - EACH failed iteration seeds the next with an explicit repair instruction
//     (`repairInstructionFor`) — the next attempt is told exactly what to fix,
//     with the prior work still on the branch.
//   - After N consecutive failed repairs (three-strike, default 3) the loop
//     ABORTS: park `ready-for-human` with the work preserved, never discarded.
//   - A single successful iteration RESETS the counter to zero (the transient
//     flake cleared; the budget is for *consecutive* failure, like the
//     slot-circuit's close-on-success).
//
// It is PURE (no IO) — a reducer over the counter, mirroring slot-circuit.ts and
// recovery.ts. Execution (salvage, editLabels, routeRecovery) stays at the call
// sites; the "work is never lost" guarantee is a CONTRACT this module documents
// and the caller honours: on BOTH `repair` and `abort` the salvaged branch is
// left intact — this module never signals a discard.

import type { AttemptOutcome } from "./attempt-outcome.js";

/**
 * The three attempt-level failure kinds the unified loop consolidates. Each maps
 * to an existing {@link AttemptOutcome} (see {@link outcomeForFailureKind}) so a
 * three-strike abort routes through the SAME `ready-for-human` escalation the
 * per-outcome recovery caps already use — this is a consolidation, not a fourth
 * parallel escalation path.
 */
export type SelfRepairFailureKind =
  /** No valid structured completion emitted (`AgentOutput` schema / sentinel). */
  | "structured-output-invalid"
  /** The worker finished but left work uncommitted (DONE-without-commit). */
  | "commit-fail"
  /** The feedback / backpressure gate rejected the branch. */
  | "gate-reject";

export interface SelfRepairConfig {
  /**
   * RED_AFK_SELF_REPAIR_MAX — N consecutive failed repairs before the loop
   * aborts to `ready-for-human` (the "three-strike"). Default 3. A value ≤ 0 is
   * ignored (falls back to the default) so the loop can never be configured to
   * abort before it has even tried to repair once.
   */
  maxConsecutiveFailures: number;
}

/** Three-strike default — three consecutive failed repairs, then a human. */
export const SELF_REPAIR_DEFAULTS: SelfRepairConfig = {
  maxConsecutiveFailures: 3,
};

/**
 * Resolve the self-repair config from the environment. `RED_AFK_SELF_REPAIR_MAX`
 * overrides the three-strike default; an unparseable / non-positive value keeps
 * the default (never let the loop abort before its first repair).
 */
export function resolveSelfRepairConfig(env: NodeJS.ProcessEnv = process.env): SelfRepairConfig {
  const raw = (env.RED_AFK_SELF_REPAIR_MAX ?? "").trim();
  const n = Number.parseInt(raw, 10);
  return {
    maxConsecutiveFailures:
      Number.isInteger(n) && n > 0 ? n : SELF_REPAIR_DEFAULTS.maxConsecutiveFailures,
  };
}

/** The single unified counter carried across iterations of one attempt. */
export interface SelfRepairState {
  /**
   * Count of CONSECUTIVE failed repair iterations, across ALL three failure
   * kinds. Reset to 0 by any successful iteration. Persisted on the attempt
   * state so it survives sandcastle re-invocation.
   */
  consecutiveFailures: number;
}

/** The counter's zero — a fresh attempt has repaired nothing yet. */
export const INITIAL_SELF_REPAIR_STATE: SelfRepairState = { consecutiveFailures: 0 };

/** What an iteration reported: it landed clean, or it failed in one of the kinds. */
export type SelfRepairEvent =
  | { type: "success" }
  | { type: "failure"; kind: SelfRepairFailureKind };

/**
 * The reducer's verdict for the iteration:
 *   - `reset`  — the iteration succeeded; the counter is back to 0, drain on.
 *   - `repair` — a failure below the three-strike threshold; seed the NEXT
 *                iteration with `instruction`, work preserved on the branch.
 *   - `abort`  — the Nth consecutive failure; park `ready-for-human` under
 *                `outcome`, work preserved on the branch.
 * `strike` is the 1-based consecutive-failure count for a `repair`/`abort`
 * (1 = first strike). `reset` carries no strike.
 */
export type SelfRepairDecision =
  | { action: "reset"; state: SelfRepairState }
  | {
      action: "repair";
      state: SelfRepairState;
      kind: SelfRepairFailureKind;
      strike: number;
      instruction: string;
    }
  | {
      action: "abort";
      state: SelfRepairState;
      kind: SelfRepairFailureKind;
      strike: number;
      instruction: string;
      outcome: AttemptOutcome;
    };

/**
 * Map a failure kind to the existing {@link AttemptOutcome} its three-strike
 * abort escalates under — so the unified loop reuses the established
 * `blocked:<reason>` labels + `ready-for-human` routing instead of inventing a
 * parallel terminal state:
 *   - structured-output-invalid → `no-sentinel`  (`blocked:crashed`)
 *   - commit-fail               → `no-sentinel`  (`blocked:crashed`)
 *   - gate-reject               → `feedback-failed` (`blocked:validation`)
 */
export function outcomeForFailureKind(kind: SelfRepairFailureKind): AttemptOutcome {
  switch (kind) {
    case "structured-output-invalid":
    case "commit-fail":
      return "no-sentinel";
    case "gate-reject":
      return "feedback-failed";
  }
}

/**
 * The explicit repair instruction seeded into the NEXT iteration for a given
 * failure kind. Every instruction opens with the "prior work is preserved on the
 * branch" guarantee so the next attempt REPAIRS in place instead of restarting —
 * the "work is never lost" contract, made legible to the agent.
 */
export function repairInstructionFor(kind: SelfRepairFailureKind): string {
  const preserved =
    "Your prior work is preserved on the worker branch (committed / salvaged) — " +
    "continue from it, do not restart from scratch.";
  switch (kind) {
    case "structured-output-invalid":
      return (
        `REPAIR: the previous iteration ended without a valid structured completion. ${preserved} ` +
        "Finish the task, then emit exactly one valid completion signal " +
        "(`<agent-output>…</agent-output>` for a schema-enabled runner, else " +
        "`<promise>DONE</promise>` / `<promise>BLOCKED</promise>` as your final line)."
      );
    case "commit-fail":
      return (
        `REPAIR: the previous iteration finished but left work uncommitted. ${preserved} ` +
        "Stage each changed path and commit it (`git add -- <path>` then commit; never `git add -A`) " +
        "with `Refs #<issue>` in the message, and verify `git status --short` is clean before you finish."
      );
    case "gate-reject":
      return (
        `REPAIR: the previous iteration was rejected by the merge / feedback gate. ${preserved} ` +
        "Read the gate output in the iteration log, make the listed gate commands pass locally, " +
        "then finish — do not exit until the gate is green."
      );
  }
}

/**
 * Advance the unified self-repair counter by one iteration's outcome.
 *
 * PURE reducer — the caller applies the returned `state` back to the attempt
 * state and acts on `action` (seed the repair instruction, or escalate). It
 * NEVER signals a discard: on both `repair` and `abort` the salvaged work stays
 * on the branch (the caller's `salvageUncommitted` already force-pushed it).
 *
 *   - success           → `reset`  (counter → 0)
 *   - failure, strike<N  → `repair` (counter → strike, seed instruction)
 *   - failure, strike=N  → `abort`  (counter → N, park ready-for-human)
 */
export function stepSelfRepair(
  state: SelfRepairState,
  event: SelfRepairEvent,
  config: SelfRepairConfig = SELF_REPAIR_DEFAULTS,
): SelfRepairDecision {
  if (event.type === "success") {
    return { action: "reset", state: INITIAL_SELF_REPAIR_STATE };
  }

  const strike = state.consecutiveFailures + 1;
  const next: SelfRepairState = { consecutiveFailures: strike };
  const instruction = repairInstructionFor(event.kind);

  if (strike >= config.maxConsecutiveFailures) {
    return {
      action: "abort",
      state: next,
      kind: event.kind,
      strike,
      instruction,
      outcome: outcomeForFailureKind(event.kind),
    };
  }
  return { action: "repair", state: next, kind: event.kind, strike, instruction };
}
