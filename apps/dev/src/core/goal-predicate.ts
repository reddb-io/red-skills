/**
 * The AFK goal predicate (ADR 0057).
 *
 * The `<promise>` sentinel stays the agent's canonical exit (ADR 0028); this
 * predicate is a SEPARATE, orthogonal terminator that fires only when the
 * attempt's goal is ALREADY reflected in the world — the claimed issue is CLOSED.
 * It exists to kill the 2026-06-09 incident class: a worker that spun 20+ minutes
 * re-verifying an issue that had already been merged and closed.
 *
 * This module is the SINGLE OWNER of the closed-issue → outcome mapping. It is a
 * pure function over a resolved issue state so the (load-bearing) mapping is
 * fully unit-testable with no gh/network/clock dependency. The orchestration
 * (execution.ts guard poll + process-issue terminal handling) reads the issue
 * state and resolves the own-merge signal; this decides the verdict.
 */

/** The resolved goal state of the claimed issue at one guard poll. */
export interface IssueGoalState {
  /**
   * Is the issue CLOSED? `true` / `false` from a successful gh read; `undefined`
   * when the read FAILED (gh / network error). Only a definite `true` ever
   * terminates — `false` and `undefined` are both no-ops, so a flaky read can
   * never kill an attempt on uncertainty.
   */
  closed: boolean | undefined;
  /**
   * When closed: did the close carry THIS attempt's OWN merge (its worker branch
   * landed)? `true` → the work is already done (`done`); `false` / absent → a
   * foreign lander closed it (`claim-lost`). Irrelevant when the issue is open.
   */
  ownMerge?: boolean;
}

/**
 * `continue` — the attempt keeps running (open issue, or an uncertain read).
 * `done` — the issue is closed by this attempt's own merge; the goal is met.
 * `claim-lost` — the issue is closed by a foreign lander; this attempt is moot.
 */
export type GoalVerdict = "continue" | "done" | "claim-lost";

/**
 * Decide the goal verdict for a resolved issue state. Pure and total over the
 * `boolean | undefined` state domain.
 *
 * - `closed !== true` (open OR read-failed) → `continue` (never terminate on
 *   uncertainty — the only safe default when the world is unknown).
 * - `closed === true` + `ownMerge` → `done` (the close carries our own merge).
 * - `closed === true` + no own-merge signal → `claim-lost` (foreign close; we
 *   never claim credit for a landing we cannot attribute to this attempt).
 */
export function evaluateGoalPredicate(state: IssueGoalState): GoalVerdict {
  if (state.closed !== true) return "continue";
  return state.ownMerge ? "done" : "claim-lost";
}
