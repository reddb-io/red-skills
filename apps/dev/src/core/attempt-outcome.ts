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
  LABEL_CI,
  LABEL_SPEC,
  LABEL_VALIDATION,
  LABEL_VALIDATION_INFRA,
  LABEL_CRASHED,
  LABEL_SIGNAL_KILLED,
  LABEL_POLICY,
  LABEL_STALLED,
  LABEL_INFRA,
  LABEL_BUDGET,
  LABEL_TRUNK_DIVERGED,
  LABEL_SENSITIVE_PATH,
  LABEL_MAIN_RED_UNTRACKED,
} from "./triage-labels.js";

/**
 * Every terminal ending an AFK iteration can have — the UNION of what
 * process-issue can return and the two reasons sourced from outside the
 * per-issue lifecycle:
 *   - `stalled` — the supervisor stall-reaper hard-killed the slot.
 *   - `infra`   — worktree/base/push setup failed before the agent ran.
 *
 * Successful or abandoned endings (`done`, `claim-lost`, `review-requested`) are
 * members so every mapping is total, but they carry no typed `blocked:*` label
 * (null).
 */
export type AttemptOutcome =
  | "done"
  | "review-requested"
  // Per-issue MANUAL-LANDING mode (issue #1049): a `landing:manual` issue ran the
  // full pipeline through PR creation, then intentionally HELD the merge for a
  // human's final click. Like `review-requested` it is a HANDOFF, not a failure —
  // the work is complete and committed on the open PR, the agent is NEVER re-run,
  // and it carries no typed `blocked:*` label. The issue closes on PR merge via
  // the `Closes #N` back-reference.
  | "manual-landing"
  | "blocked"
  | "no-sentinel"
  // External-signal kill (#1308): the inner process was terminated by an OS
  // signal (SIGKILL/SIGTERM from the harness or kernel OOM reaper). Carries
  // the signal name in the envelope notes for actionable crash records.
  // Same bounded recovery policy as `no-sentinel` (`crashed` cap) — an OOM
  // or watchdog kill may self-heal on a fresh attempt.
  | "signal-killed"
  | "merge-conflict"
  // AFK runner improvement (#812): an UNLOCKED admin-merge could not land a
  // completed, MERGEABLE PR because the `enforce_admins` base's required checks
  // are not satisfied. These are NOT merge conflicts — the branch merges cleanly
  // once CI is green — so they carry the distinct `blocked:ci` label and (unlike
  // merge-conflict) NEVER auto-recover to ready-for-agent, which would re-run the
  // whole inner agent on already-complete work:
  //   - ci-failed   — a required check FAILED; the next attempt should fix that check.
  //   - ci-pending  — checks still running past the CI-wait timeout; the open PR
  //                   is handed off for a human/CI-aware finisher.
  | "ci-failed"
  | "ci-pending"
  | "feedback-failed"
  | "feedback-failed-infra"
  | "claim-lost"
  | "hook-aborted"
  | "exhausted"
  | "runner-transient"
  | "stalled"
  // AFK runner improvement (#908): the per-attempt resource budget guard aborted
  // the attempt (token / cost / tool-call / waiting-window ceiling). Partial work
  // is salvaged through the same feedback gate, then parked for a human — NOT
  // auto-recovered (a runaway is not a transient flake to blind-retry).
  | "budget-exceeded"
  // ADR 0083 landing precondition (#1018): the Landing aborted because the
  // primary checkout's LOCAL trunk ref has DIVERGED from `origin/<trunk>` (it
  // carries commits origin does not). This is NOT a merge conflict and NOT lost
  // work — the attempt branch is intact; the local repository state a human owns
  // is out of sync. It carries the distinct `blocked:trunk-diverged` label and is
  // human-only (never auto-recovered): the Landing refuses to reset / stash /
  // auto-commit / force-push to repair it, so a bounded retry could only re-hit
  // the same precondition.
  | "trunk-diverged"
  // Sensitive-path guard (issue #1102): the landing diff touched a CI workflow
  // file, a package.json lifecycle script, a git hook, or `.red/` trust/gate
  // configuration. These are intent-class changes that require human review —
  // auto-landing them would bypass auditability regardless of test/CI status.
  // Human-only (non-recoverable): a bounded retry does not change the diff.
  | "sensitive-path"
  // Main-red tracking gate (#1237): admin-merge onto a red main is allowed only
  // while the auto-filed main-red repair issue is open. If the repair issue is
  // absent, landing refuses so the red baseline stays visible and tracked.
  | "main-red-untracked"
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
export type RecoveryReason = "quota" | "runner-transient" | "merge-conflict" | "crashed" | "policy" | "validation-infra";

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
    case "ci-failed":
    case "ci-pending":
      return LABEL_CI;
    case "blocked":
      return LABEL_SPEC;
    case "feedback-failed":
      return LABEL_VALIDATION;
    case "feedback-failed-infra":
      // AFK runner improvement: a feedback gate failure with an INFRA root
      // cause (worktree add / submodule init / pnpm install / OOM / ENOENT)
      // — distinct from a semantic test failure. Auto-recoverable via
      // `validation-infra` cap; the label is observability only.
      return LABEL_VALIDATION_INFRA;
    case "no-sentinel":
      return LABEL_CRASHED;
    case "signal-killed":
      return LABEL_SIGNAL_KILLED;
    case "hook-aborted":
      return LABEL_POLICY;
    case "stalled":
      return LABEL_STALLED;
    case "budget-exceeded":
      return LABEL_BUDGET;
    case "trunk-diverged":
      return LABEL_TRUNK_DIVERGED;
    case "sensitive-path":
      return LABEL_SENSITIVE_PATH;
    case "main-red-untracked":
      return LABEL_MAIN_RED_UNTRACKED;
    case "infra":
      return LABEL_INFRA;
    case "done":
    case "claim-lost":
    case "review-requested":
    // manual-landing is a HANDOFF (issue #1049), not a blocked failure: the PR is
    // open and the human owns the merge click, so it carries no typed `blocked:*`
    // label — like review-requested above.
    case "manual-landing":
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
    // signal-killed is still a death without a completion signal — emit the
    // same `no-sentinel` envelope status so the crash sections appear; the
    // signal name is visible in the notes/log section.
    case "signal-killed":
      return "no-sentinel";
    case "merge-conflict":
      return "merge-conflict";
    case "blocked":
    case "feedback-failed":
    case "feedback-failed-infra":
    // ci-failed / ci-pending describe a MERGEABLE PR blocked by CI, never a git
    // conflict — so they must NOT emit a `merge-conflict` envelope. They fold
    // into the generic `blocked` bucket (truthful: the issue is blocked, the work
    // is intact and committed on the open PR).
    case "ci-failed":
    case "ci-pending":
    case "hook-aborted":
    case "exhausted":
    case "runner-transient":
    case "claim-lost":
    case "stalled":
    case "budget-exceeded":
    // trunk-diverged (#1018) folds into the generic `blocked` bucket — the work
    // is intact on the attempt branch; the local trunk a human owns is out of
    // sync, so it emits a `blocked` envelope (never `merge-conflict`).
    case "trunk-diverged":
    // sensitive-path (#1102) folds into the generic `blocked` bucket — the diff
    // touched a sensitive path; a human must review it before landing.
    case "sensitive-path":
    // main-red-untracked (#1237) folds into the generic `blocked` bucket — the
    // branch passed its gate, but main is red without the auto-filed repair
    // issue that keeps continued delivery visible and tracked.
    case "main-red-untracked":
    case "infra":
    // review-requested is a handoff, not a failure: the per-issue lifecycle
    // emits no terminal failure envelope for it (it parks the issue + opens the
    // PR), so it folds into the generic `blocked` bucket only to keep the
    // mapping total — like claim-lost / exhausted above.
    case "review-requested":
    // manual-landing (issue #1049) DOES emit a terminal envelope (it carries the
    // PR URL + park reason), but it describes an intact, committed PR held for a
    // human merge — never a git conflict — so it folds into the generic `blocked`
    // status bucket, exactly like the ci-* holds above.
    case "manual-landing":
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
 *
 * AFK runner improvement: `feedback-failed-infra` (the gate failed for an
 * INFRA reason — worktree add / submodule init / pnpm install / OOM / ENOENT,
 * detected by `isInfraFeedbackFailure`) maps to the new `validation-infra`
 * recovery key. That key is bounded (default cap 2) so a stuck infra issue
 * still escalates, but a one-off submodule/OOM flake now self-heals instead
 * of parking a green branch.
 */
export function recoveryReasonFor(o: AttemptOutcome): RecoveryReason | null {
  switch (o) {
    case "exhausted":
      return "quota";
    case "runner-transient":
      return "runner-transient";
    case "no-sentinel":
    // signal-killed shares the `crashed` recovery policy: an OOM or watchdog
    // kill may be transient, so a bounded fresh attempt is warranted.
    case "signal-killed":
      return "crashed";
    case "hook-aborted":
      return "policy";
    case "merge-conflict":
      return "merge-conflict";
    case "feedback-failed-infra":
      return "validation-infra";
    // ci-failed / ci-pending are NON-recoverable on purpose (#812): the work is
    // already complete on the open PR, so a bounded auto-retry would re-run the
    // whole inner agent and re-spend tokens for no reason. They escalate to a
    // human / CI-aware finisher who drives the existing PR to merge.
    case "ci-failed":
    case "ci-pending":
    case "blocked":
    case "feedback-failed":
    case "stalled":
    // #908: a budget abort is NOT auto-recoverable — re-running the inner agent
    // on a runaway just re-spends the budget. Escalate to a human with the
    // salvaged partial work intact.
    case "budget-exceeded":
    // trunk-diverged (#1018) is NON-recoverable by construction: a bounded
    // auto-retry cannot un-diverge the maintainer's local trunk, and the Landing
    // refuses to repair it — only a human reconciling the local state clears it.
    case "trunk-diverged":
    // sensitive-path (#1102) is NON-recoverable: a retry runs the same diff and
    // hits the same guard. Only a human reviewing the sensitive change clears it.
    case "sensitive-path":
    // main-red-untracked (#1237) is NON-recoverable until the missing auto-filed
    // repair issue exists; rerunning the agent would re-hit the same visibility
    // gate.
    case "main-red-untracked":
    case "infra":
    case "done":
    case "claim-lost":
    case "review-requested":
    // manual-landing is NON-recoverable on purpose (issue #1049): the work is
    // complete and committed on the open PR, so an auto-retry would re-run the
    // whole inner agent for nothing. A human drives the merge; the agent never
    // re-runs — exactly like review-requested / the ci-* holds above.
    case "manual-landing":
      return null;
  }
}
