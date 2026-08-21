/**
 * reconcile-landing-refusal — one landing refusal, one terminal, one sentence.
 *
 * A landing refuses for a dozen distinct reasons and a park records ONE. The
 * mapping between them is where the lie used to live: every non-infra refusal
 * funnelled into `blocked:merge-conflict`, so a branch that was merely behind
 * its base sent a human to resolve a conflict that did not exist (#2864). Both
 * halves of the honest answer live here — the route from refusal to terminal,
 * and the one summary sentence each terminal is narrated with — because they
 * are the same decision written twice and drift the moment they are apart.
 *
 * Carved out of `reconcile.ts` (#4138) so the orchestration module holds the
 * orchestration; nothing here reaches IO, so both functions are pure.
 */
import type { LandingFailureReason } from "./landing.js";

/** The reasons a reconcile park records, one per landing refusal class (#2864). */
export type ReconcileParkReason =
  | "feedback-failed"
  | "feedback-failed-infra"
  | "merge-conflict"
  | "ci-failed"
  | "ci-pending"
  | "hook-aborted"
  | "trunk-diverged"
  | "infra";

/**
 * Route a LANDING refusal to the terminal that names it (#2864).
 *
 * The reconcile lane used to funnel every non-infra landing failure into
 * `parkMergeConflict`, so a PR that was merely BEHIND its base — zero conflicts,
 * zero failing checks, `mergeable=true`, one `gh pr update-branch` from
 * merging — was parked `blocked:merge-conflict` and a human was sent to resolve
 * a conflict that did not exist. `behind` and `dirty` are different states and
 * the forge reports them differently, so the park must be too:
 *
 *   - `pr-conflict`        → `merge-conflict`. The ONLY route to that label: the
 *                            rebase genuinely conflicted (and names its paths).
 *   - `ci-failed` /
 *     `pr-merge-failed`    → `ci-failed`. A merge the forge REJECTED on a
 *                            mergeable PR — a stale base, a red required check,
 *                            an unsatisfied protection rule. The landing already
 *                            re-read the PR and repaired the one cause it owns
 *                            (an out-of-date branch, #2807); what reaches here is
 *                            the refusal the PR itself explained.
 *   - `ci-pending`         → `ci-pending`. Checks still running on an intact PR.
 *   - `post-merge-gate`    → `feedback-failed`. The integrated tree failed the
 *                            gate; the rebase before it succeeded (#2339).
 *   - `pre_merge-abort`    → `hook-aborted`. A hook, not a conflict.
 *   - `trunk-diverged`     → `trunk-diverged`.
 *   - `land-lock-timeout`  → null. A backoff: nothing to park.
 *   - everything else      → `infra`, carrying the observed reason verbatim.
 */
export function routeLandingFailure(reason: LandingFailureReason): ReconcileParkReason | null {
  switch (reason) {
    case "pr-conflict":
      return "merge-conflict";
    case "ci-failed":
    case "pr-merge-failed":
      return "ci-failed";
    case "ci-pending":
      return "ci-pending";
    case "post-merge-gate":
      return "feedback-failed";
    case "pre_merge-abort":
      return "hook-aborted";
    case "trunk-diverged":
      return "trunk-diverged";
    case "land-lock-timeout":
      return null;
    // #4134 / #4138: the head moved, or nothing judged it. Neither is an
    // infrastructure failure, but both park the same way and the refusal text
    // the landing carried is what names the real cause and its repair, so the
    // terminal stays `infra` rather than growing a label nothing else reads.
    case "stale-head":
    case "unverified-head":
      return "infra";
    default:
      return "infra";
  }
}
/**
 * The one line a landing refusal records, per park reason (#2864). It states
 * what was OBSERVED — never a probable cause — because the note is the whole
 * brief the next human reads. `observed` is the landing's own message when it
 * carried one (the conflicting paths, the forge's rejection cause); absent, the
 * line still says which refusal happened rather than falling back to a conflict.
 */
export function landingRefusalSummary(reason: ReconcileParkReason, observed?: string): string {
  const detail = observed && observed.trim() !== "" ? observed.trim() : undefined;
  switch (reason) {
    case "merge-conflict":
      return detail ?? "the worker branch conflicts with its base and could not be rebased for the landing";
    case "ci-failed":
      return detail ?? "the forge rejected the merge on the open PR and the PR state did not explain it";
    case "ci-pending":
      return detail ?? "required status checks had not reported a verdict on the open PR";
    case "feedback-failed":
      return "the post-merge integration gate failed on the rebased tree; nothing was merged";
    case "hook-aborted":
      return detail ?? "a pre_merge hook aborted the landing before anything merged";
    case "trunk-diverged":
      return detail ?? "the local trunk has diverged from its remote, so the landing refused to merge";
    case "feedback-failed-infra":
    case "infra":
      return detail ?? "the landing failed before anything merged";
  }
}