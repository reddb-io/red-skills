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
//   - `envelopeStatusFor`  — outcome → the terminal `data-attempt-status` facet
//                            of the emitted Envelope (envelope-emit.ts).
//
// It is PURE (no IO) — decision/mapping only. Execution (editLabels, comment, the
// cascade gh, routeRecovery) stays at the call sites. The functions are the
// canonical source for the observability label, the recovery routing key, and the
// envelope status, so the multi-enum-desync bug class becomes impossible.

import type { AttemptStatus } from "./envelope.js";
import {
  LABEL_QUOTA,
  LABEL_RUNNER_TRANSIENT,
  LABEL_MERGE_CONFLICT,
  LABEL_SPEC,
  LABEL_VALIDATION,
  LABEL_CRASHED,
  LABEL_POLICY,
  LABEL_STALLED,
  LABEL_INFRA,
} from "./triage-labels.js";

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
  | "runner-transient"
  | "stalled"
  | "infra";

/**
 * The recovery-policy view of a terminal failure — the RECOVERABLE subset of the
 * outcomes, under their policy names (what *kind* of transient failure happened):
 *   - exhausted     → `quota`
 *   - runner-transient → `runner-transient`
 *   - no-sentinel   → `crashed`
 *   - hook-aborted  → `policy`
 *   - merge-conflict→ `merge-conflict`
 *
 * recovery.ts keys its bounded retry-cap table on these. Outcomes outside this
 * subset are NON-recoverable (always escalate, see `recoveryReasonFor`).
 */
export type RecoveryReason = "quota" | "runner-transient" | "merge-conflict" | "crashed" | "policy";

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
      return LABEL_QUOTA;
    case "runner-transient":
      return LABEL_RUNNER_TRANSIENT;
    case "merge-conflict":
      return LABEL_MERGE_CONFLICT;
    case "blocked":
      return LABEL_SPEC;
    case "feedback-failed":
      return LABEL_VALIDATION;
    case "no-sentinel":
      return LABEL_CRASHED;
    case "hook-aborted":
      return LABEL_POLICY;
    case "stalled":
      return LABEL_STALLED;
    case "infra":
      return LABEL_INFRA;
    case "done":
    case "claim-lost":
      return null;
  }
}

/**
 * Pure mapping from a terminal outcome to the `data-attempt-status` facet of the
 * Envelope emitted for it (envelope-emit.ts `AttemptStatus`). This is the THIRD
 * facet of "what the outcome means", alongside the typed label and the recovery
 * key, so it belongs with the single owner.
 *
 * The mapping mirrors EXACTLY the status passed at each `emitFailure(common,
 * <status>, …)` call site in process-issue:
 *   - no-sentinel     → "no-sentinel"
 *   - blocked         → "blocked"
 *   - feedback-failed → "blocked"        (a feedback failure emits a `blocked`
 *                                          envelope, NOT a `feedback-failed` one)
 *   - merge-conflict  → "merge-conflict"
 *   - done            → "done"
 *
 * The remaining outcomes (`hook-aborted`, `exhausted`, `runner-transient`,
 * `claim-lost`, `stalled`, `infra`) emit NO terminal failure envelope from the per-issue lifecycle (they
 * route via routeRecovery / short-circuit only), so they have no live call site;
 * they map to the generic `blocked` failure bucket — the same bucket
 * envelope-emit's `defaultHistoryEvent` folds non-done terminals into — to keep
 * the mapping total without inventing a new status.
 */
export function envelopeStatusFor(o: AttemptOutcome): AttemptStatus {
  switch (o) {
    case "done":
      return "done";
    case "no-sentinel":
      return "no-sentinel";
    case "merge-conflict":
      return "merge-conflict";
    case "blocked":
    case "feedback-failed":
    case "hook-aborted":
    case "exhausted":
    case "runner-transient":
    case "claim-lost":
    case "stalled":
    case "infra":
      return "blocked";
  }
}

/**
 * Pure mapping from a terminal outcome to its BOUNDED auto-recovery policy key,
 * or null when the outcome is NOT auto-recoverable. The recoverable outcomes are
 * exactly the transient classes that often clear on a fresh attempt:
 *   - exhausted     → `quota`
 *   - runner-transient → `runner-transient`
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
    case "runner-transient":
      return "runner-transient";
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
