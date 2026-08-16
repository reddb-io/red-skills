// worker-outcome — the SINGLE OWNER of the AFK "how a worker run ended, and what
// it means" vocabulary.
//
// Historically this knowledge was smeared across three parallel enums that had
// to stay in sync by hand — `ProcessOutcome` (process-issue.ts), `BlockedReason`
// (envelope-emit.ts), and `RecoveryReason` (recovery.ts) — plus a hand-written
// bridge (`recoveryReasonOf`). Adding one terminal ending touched four files and
// any drift silently produced a wrong label or a wrong routing decision.
//
// This module collapses that into ONE owner:
//   - `WorkerOutcome`     — every terminal ending an iteration can have.
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
import type { SpinPattern } from "@reddb-io/red-castle/engine";
import {
  LABEL_QUOTA,
  LABEL_RUNNER_TRANSIENT,
  LABEL_HOST_CONFIG,
  LABEL_MERGE_CONFLICT,
  LABEL_CI,
  LABEL_SPEC,
  LABEL_VALIDATION,
  LABEL_VALIDATION_INFRA,
  LABEL_RUNNER,
  LABEL_SIGNAL_KILLED,
  LABEL_POLICY,
  LABEL_STALLED,
  LABEL_SPIN,
  LABEL_WALL_CLOCK_CAPPED,
  LABEL_INFRA,
  LABEL_BUDGET,
  LABEL_TRUNK_DIVERGED,
  LABEL_BASE_STALE,
} from "./triage-labels.js";

export type SpinOutcome = `spin:${SpinPattern}`;

const SPIN_OUTCOMES: readonly SpinOutcome[] = [
  "spin:repeated-action-observation",
  "spin:error-streak",
  "spin:monologue",
  "spin:alternating-ping-pong",
];

export function spinOutcome(pattern: SpinPattern): SpinOutcome {
  return `spin:${pattern}`;
}

export function isSpinOutcome(value: string): value is SpinOutcome {
  return (SPIN_OUTCOMES as readonly string[]).includes(value);
}

export function spinPatternFromOutcome(value: SpinOutcome): SpinPattern {
  return value.slice("spin:".length) as SpinPattern;
}

/**
 * Every terminal ending an AFK iteration can have — the UNION of what
 * process-issue can return and the two reasons sourced from outside the
 * per-issue lifecycle:
 *   - `stalled` — the supervisor stall-reaper hard-killed the slot.
 *   - `infra`   — worktree/base/push setup failed before the agent ran.
 *
 * Successful endings (`done`, `review-requested`) and the ABANDONED one
 * (`claim-lost`) are members so every mapping is total, but they carry no typed
 * `blocked:*` label (null). **Successful and abandoned are not one group** — they
 * share the label mapping and nothing else. `claim-lost` is a withdrawal with a
 * cause, and grouping it with `done` is what let its explanation be deleted with
 * its workspace (#3156); see {@link sweepDiscardsWorkspace}.
 */
export type WorkerOutcome =
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
  // or watchdog kill may self-heal on a fresh worker run.
  | "signal-killed"
  | "merge-conflict"
  // AFK runner improvement (#812): an UNLOCKED admin-merge could not land a
  // completed, MERGEABLE PR because the `enforce_admins` base's required checks
  // are not satisfied. These are NOT merge conflicts — the branch merges cleanly
  // once CI is green — so they carry the distinct `blocked:ci` label and (unlike
  // merge-conflict) NEVER auto-recover to ready-for-agent, which would re-run the
  // whole inner agent on already-complete work:
  //   - ci-failed   — a required check FAILED; the next worker run should fix that check.
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
  // Permanent runner-host defect: a required interpreter or cwd is missing.
  // No cooldown/fallback retry can repair host configuration.
  | "host-config"
  | "stalled"
  // Wall-clock cap (#2701): the supervisor cut the worker off at the per-issue
  // wall-clock ceiling while it was still making progress. NOT a stall and NOT
  // a no-sentinel death — the run was terminated by policy, so its branch/PR is
  // live work handed forward to the next worker rather than an abandoned
  // attempt. Shares the `stalled` retry budget so the hand-forward stays
  // bounded.
  | "wall-clock-capped"
  // AFK runner improvement (#908): a per-worker resource ceiling aborted the
  // run (token / cost / tool-call / waiting-window). Parked for a human —
  // NOT auto-recovered (a runaway is not a transient flake to blind-retry). The
  // guard that produced it died with the attempt model (ADR 0103); the terminal
  // name + `blocked:budget` label survive until the disposition vocabulary is
  // contracted alongside the worker-state schema.
  | "budget-exceeded"
  // ADR 0083 landing precondition (#1018): the Landing aborted because the
  // primary checkout's LOCAL trunk ref has DIVERGED from `origin/<trunk>` (it
  // carries commits origin does not). This is NOT a merge conflict and NOT lost
  // work — the worker branch is intact; the local repository state a human owns
  // is out of sync. It carries the distinct `blocked:trunk-diverged` label and is
  // human-only (never auto-recovered): the Landing refuses to reset / stash /
  // auto-commit / force-push to repair it, so a bounded retry could only re-hit
  // the same precondition.
  | "trunk-diverged"
  // Base freshness guard (#1380): remote fetch failed and the local base branch is
  // behind the last-known remote-tracking tip. The worker never starts from that
  // rotten local base; the issue parks for a human/network recovery.
  | "base-stale"
  | "infra"
  | SpinOutcome;

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
 * Does the terminal path itself DELETE this ending's per-worker workspace, so a
 * diagnostic written into that directory does not outlive the iteration?
 *
 * **The grouping is what made the deletion invisible** (#3156). `claim-lost`
 * shares this fate with `done` — for a good reason each: `done` is swept because
 * the work landed, `claim-lost` because the workspace names an issue this worker
 * never owned and the next boot's orphan sweep would misread it as a mid-issue
 * crash (#644). But the two have opposite DIAGNOSTIC needs: `done` has nothing to
 * say, and `claim-lost` is a failure whose entire value is its `reason`. Sharing
 * the sweep must therefore never mean sharing the silence — every ending that
 * answers true here owes its account to a durable lane (`claimLost` writes the
 * arbitration record to `.red/state/castle/history.toonl`).
 *
 * Every other ending keeps its directory through the terminal path; a later
 * reclaim may release it, but the explanation is readable in the meantime.
 */
export function sweepDiscardsWorkspace(o: WorkerOutcome): boolean {
  switch (o) {
    case "done":
    case "claim-lost":
      return true;
    default:
      return false;
  }
}

/**
 * Pure mapping from a terminal outcome to its DESCRIPTIVE `blocked:<…>`
 * observability label, or null when the outcome carries no typed label
 * (`done` / `claim-lost`). The "nice" recovery names live in these strings.
 *
 * OBSERVABILITY ONLY — this never changes where an issue routes; the caller adds
 * the returned label ALONGSIDE the routing label (ready-for-human /
 * ready-for-agent).
 */
export function blockedLabelFor(o: WorkerOutcome): string | null {
  if (isSpinOutcome(o)) return LABEL_SPIN;
  switch (o) {
    case "exhausted":
      return LABEL_QUOTA;
    case "runner-transient":
      return LABEL_RUNNER_TRANSIENT;
    case "host-config":
      return LABEL_HOST_CONFIG;
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
      // An environment-attributed gate failure whose one Verdict-owned ledger
      // exhausted (or whose signature repeated). It parks as infra and never
      // enters a second, outer recovery economy.
      return LABEL_VALIDATION_INFRA;
    case "no-sentinel":
      return LABEL_RUNNER;
    case "signal-killed":
      return LABEL_SIGNAL_KILLED;
    case "hook-aborted":
      return LABEL_POLICY;
    case "stalled":
      return LABEL_STALLED;
    case "wall-clock-capped":
      return LABEL_WALL_CLOCK_CAPPED;
    case "budget-exceeded":
      return LABEL_BUDGET;
    case "trunk-diverged":
      return LABEL_TRUNK_DIVERGED;
    case "base-stale":
      return LABEL_BASE_STALE;
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
export function envelopeStatusFor(o: WorkerOutcome): AttemptStatus {
  if (isSpinOutcome(o)) return "blocked";
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
    // #2701: a wall-clock cap NAMES ITSELF in the envelope. Reporting it as
    // `no-sentinel` was the bug — the run did produce work and was stopped
    // mid-flight, so the terminal status must say which of the two happened.
    case "wall-clock-capped":
      return "wall-clock-capped";
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
    case "host-config":
    case "claim-lost":
    case "stalled":
    case "budget-exceeded":
    // trunk-diverged (#1018) folds into the generic `blocked` bucket — the work
    // is intact on the worker branch; the local trunk a human owns is out of
    // sync, so it emits a `blocked` envelope (never `merge-conflict`).
    case "trunk-diverged":
    // base-stale (#1380) folds into the generic `blocked` bucket — no worker ran;
    // the local base is too stale to trust while the remote is unreachable.
    case "base-stale":
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
 * exactly the transient classes that often clear on a fresh worker run:
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
 * Environment gate failures have already spent the Verdict-owned environment
 * ledger before they become terminal. They are therefore non-recoverable here:
 * a second outer retry policy would be a rival environment budget.
 */
export function recoveryReasonFor(o: WorkerOutcome): RecoveryReason | null {
  // Persistent Spin already spent the Worker's in-place Re-seed ladder. A
  // second, outer recovery budget would restart the same futile loop.
  if (isSpinOutcome(o)) return null;
  switch (o) {
    case "exhausted":
      return "quota";
    case "runner-transient":
      return "runner-transient";
    case "no-sentinel":
    // signal-killed shares the `crashed` recovery policy: an OOM or watchdog
    // kill may be transient, so a bounded fresh worker run is warranted.
    case "signal-killed":
      return "crashed";
    case "hook-aborted":
      return "policy";
    case "merge-conflict":
      return "merge-conflict";
    // ci-failed / ci-pending are NON-recoverable on purpose (#812): the work is
    // already complete on the open PR, so a bounded auto-retry would re-run the
    // whole inner agent and re-spend tokens for no reason. They escalate to a
    // human / CI-aware finisher who drives the existing PR to merge.
    case "ci-failed":
    case "ci-pending":
    case "blocked":
    case "host-config":
    case "feedback-failed":
    case "feedback-failed-infra":
    case "stalled":
    // wall-clock-capped carries no PER-ISSUE recovery budget, exactly like
    // `stalled`: the supervisor owns the bounded hand-forward (disposition's
    // `policyKeyFor`, #2701), so the per-issue lifecycle never auto-retries it.
    case "wall-clock-capped":
    // #908: a budget abort is NOT auto-recoverable — re-running the inner agent
    // on a runaway just re-spends the budget. Escalate to a human with the
    // salvaged partial work intact.
    case "budget-exceeded":
    // trunk-diverged (#1018) is NON-recoverable by construction: a bounded
    // auto-retry cannot un-diverge the maintainer's local trunk, and the Landing
    // refuses to repair it — only a human reconciling the local state clears it.
    case "trunk-diverged":
    // base-stale (#1380) is NON-recoverable in-process: a bounded agent retry
    // cannot make the remote reachable or refresh the local base safely.
    case "base-stale":
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

/** sysexits(3) EX_CONFIG: permanent host configuration failure. */
export const HOST_CONFIG_EXIT_CODE = 78;
