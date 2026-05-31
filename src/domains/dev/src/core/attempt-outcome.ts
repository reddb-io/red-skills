// attempt-outcome — the SINGLE OWNER of the AFK "how an attempt ended, and what
// it means" vocabulary.
//
// Historically this knowledge was smeared across three parallel enums that had
// to stay in sync by hand — `ProcessOutcome` (process-issue.ts), `BlockedReason`
// (envelope-emit.ts), and `RecoveryReason` (recovery.ts) — plus a hand-written
// bridge (`recoveryReasonOf`). Adding one terminal ending touched four files and
// any drift silently produced a wrong label or a wrong routing decision.
//
// This module collapses that into ONE owner:
//   - `AttemptOutcome`     — every terminal ending an iteration can have.
//   - `RecoveryReason`     — the recoverable subset's policy keys (recovery.ts
//                            consumes this; its cap table is keyed on it).
//   - `blockedLabelFor`    — outcome → DESCRIPTIVE `blocked:<reason>` label.
//   - `recoveryReasonFor`  — outcome → BOUNDED-recovery policy key (or null).
//
// It is PURE (no IO) — decision/mapping only. Execution (editLabels, comment, the
// cascade gh, routeRecovery) stays at the call sites. The two functions are the
// canonical source for both the observability label and the recovery routing key,
// so the 3-enum-desync bug class becomes impossible.

/**
 * Every terminal ending an AFK iteration can have — the UNION of what
 * process-issue can return and the two reasons sourced from outside the
 * per-issue lifecycle:
 *   - `stalled` — the supervisor stall-reaper hard-killed the slot.
 *   - `infra`   — worktree/base/push setup failed before the agent ran.
 *
 * Successful or abandoned endings (`done`, `claim-lost`) are members so every
 * mapping is total, but they carry no typed label (null).
 */
export type AttemptOutcome =
  | "done"
  | "blocked"
  | "no-sentinel"
  | "merge-conflict"
  | "feedback-failed"
  | "claim-lost"
  | "hook-aborted"
  | "exhausted"
  | "stalled"
  | "infra";

/**
 * The recovery-policy view of a terminal failure — the RECOVERABLE subset of the
 * outcomes, under their policy names (what *kind* of transient failure happened):
 *   - exhausted     → `quota`
 *   - no-sentinel   → `crashed`
 *   - hook-aborted  → `policy`
 *   - merge-conflict→ `merge-conflict`
 *
 * recovery.ts keys its bounded retry-cap table on these. Outcomes outside this
 * subset are NON-recoverable (always escalate, see `recoveryReasonFor`).
 */
export type RecoveryReason = "quota" | "merge-conflict" | "crashed" | "policy";

/**
 * Pure mapping from a terminal outcome to its DESCRIPTIVE `blocked:<…>`
 * observability label, or null when the outcome carries no typed label
 * (`done` / `claim-lost`). The "nice" recovery names live in these strings.
 *
 * OBSERVABILITY ONLY — this never changes where an issue routes; the caller adds
 * the returned label ALONGSIDE the routing label (ready-for-human /
 * ready-for-agent).
 */
export function blockedLabelFor(o: AttemptOutcome): string | null {
  switch (o) {
    case "exhausted":
      return "blocked:quota";
    case "merge-conflict":
      return "blocked:merge-conflict";
    case "blocked":
      return "blocked:spec";
    case "feedback-failed":
      return "blocked:validation";
    case "no-sentinel":
      return "blocked:crashed";
    case "hook-aborted":
      return "blocked:policy";
    case "stalled":
      return "blocked:stalled";
    case "infra":
      return "blocked:infra";
    case "done":
    case "claim-lost":
      return null;
  }
}

/**
 * Pure mapping from a terminal outcome to its BOUNDED auto-recovery policy key,
 * or null when the outcome is NOT auto-recoverable. The recoverable outcomes are
 * exactly the four transient classes that often clear on a fresh attempt:
 *   - exhausted     → `quota`
 *   - no-sentinel   → `crashed`
 *   - hook-aborted  → `policy`
 *   - merge-conflict→ `merge-conflict`
 *
 * Everything else (`blocked`, `feedback-failed`, `stalled`, `infra`, `done`,
 * `claim-lost`) returns null — those route straight to a human / carry no
 * recovery budget, preserving today's behaviour exactly.
 */
export function recoveryReasonFor(o: AttemptOutcome): RecoveryReason | null {
  switch (o) {
    case "exhausted":
      return "quota";
    case "no-sentinel":
      return "crashed";
    case "hook-aborted":
      return "policy";
    case "merge-conflict":
      return "merge-conflict";
    case "blocked":
    case "feedback-failed":
    case "stalled":
    case "infra":
    case "done":
    case "claim-lost":
      return null;
  }
}
