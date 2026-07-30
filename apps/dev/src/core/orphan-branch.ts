// orphan-branch — the exit-time census of pushed work that no pull request
// carries (#2893).
//
// #2865 taught the NEXT dispatched Worker to adopt the branch its issue already
// has, which stops the redo. It cannot stop the INVISIBILITY, because a run that
// exits 0 is recorded as successful and nothing re-dispatches: the branch simply
// sits on origin forever. Three finished slices were found that way in three
// days, each by a human reading `git branch -r` by hand.
//
// So the loss is caught where it happens — at the end of the dispatch that
// produced it. An exit code of 0 over commits with no route to `main` is a FALSE
// SUCCESS, and a false success is worse than a failure: a failure gets retried.
//
// PURE DECISION LAYER — the branch list, the commit counts and the open-PR
// census are all injected, so every rule here is observable in a test without a
// repository or a forge.

import { issueFromBranchRef, pullRequestMatchesAttempt, type AttemptPullRequest } from "./branch-resume.js";

export { issueFromBranchRef };

/** One branch as the probe read it: the ref, and what it carries ahead of the
 * base. `undefined` means the probe could not tell — never "empty". */
export interface OrphanBranchProbe {
  branch: string;
  commitsAhead: number | undefined;
}

/** A branch carrying work that no open pull request mentions. */
export interface OrphanBranch {
  branch: string;
  issue: number;
  commitsAhead: number | undefined;
}

/**
 * The branches carrying work that no open pull request carries to `main`
 * (#2893).
 *
 * A branch is covered when an open PR names its issue — through the PR's head
 * ref, through the same head branch, or through a closing reference in the body
 * — which is the same matching `/afk` adoption already trusts.
 *
 * A branch proven to hold ZERO commits is not an orphan: worktree creation
 * pushes `afk/<issue>-<slug>` before the agent writes a line, so an empty ref is
 * the ordinary shape of a dispatch that did nothing, not stranded work. A branch
 * the probe could NOT read is listed with an unknown count, because the whole
 * defect being fixed is work nobody could see.
 *
 * `issues`, when given, restricts the census to those issue numbers — a dispatch
 * answers for the work IT produced, not for every branch on the remote.
 */
export function listOrphanBranches(input: {
  branches: readonly OrphanBranchProbe[];
  openPullRequests: readonly AttemptPullRequest[];
  issues?: readonly number[];
}): OrphanBranch[] {
  const scope = input.issues ? new Set(input.issues) : null;
  const orphans: OrphanBranch[] = [];
  for (const probe of input.branches) {
    const issue = issueFromBranchRef(probe.branch);
    if (issue === null) continue;
    if (scope && !scope.has(issue)) continue;
    if (probe.commitsAhead === 0) continue;
    const covered = input.openPullRequests.some(
      (pr) => pr.headRefName === probe.branch || pullRequestMatchesAttempt(pr, issue),
    );
    if (covered) continue;
    orphans.push({ branch: probe.branch, issue, commitsAhead: probe.commitsAhead });
  }
  return orphans.sort((a, b) => a.issue - b.issue || a.branch.localeCompare(b.branch));
}

/**
 * True when this dispatch was NEVER going to open a pull request, so a branch it
 * left behind is the deliberate product of the run rather than a loss (#2893).
 *
 * - `scout` investigates read-only: no commits, no push, no PR.
 * - `/go --mode local-only` (`--local-merge`) lands by an approved local
 *   fast-forward; a PR is the thing the operator asked it to skip.
 *
 * Announcing either as orphaned work would train every operator to ignore the
 * warning, which costs more than the warning buys.
 */
export function isPushOnlyDispatch(input: {
  kind?: string | undefined;
  runMode?: string | undefined;
  localMerge?: boolean | undefined;
}): boolean {
  if (input.kind === "scout" || input.runMode === "scout") return true;
  return input.localMerge === true;
}

function describeCommits(commitsAhead: number | undefined): string {
  if (commitsAhead === undefined) return "an unread number of commits";
  return `${commitsAhead} commit${commitsAhead === 1 ? "" : "s"}`;
}

/** One human-readable line per orphan, naming branch, issue and commit count so
 * the recovery is one command instead of an investigation. */
export function formatOrphanBranchListing(orphans: readonly OrphanBranch[]): string[] {
  return orphans.map(
    (o) => `${o.branch} (#${o.issue}) — ${describeCommits(o.commitsAhead)} ahead of the base, no open pull request`,
  );
}

/**
 * The exit verdict for a dispatch (pure): the operator-facing reason a run must
 * exit non-zero, or `null` when nothing was stranded (#2893).
 *
 * Only PROVEN commits flip the exit code. A branch the probe could not read is
 * still listed by `listOrphanBranches` — silence about possible loss is the
 * defect — but a count of `undefined` is not evidence, and failing a run on a
 * probe that merely blinked would make the check noise.
 *
 * `targeted` mirrors the zero-attempt verdict (#2385) and gates only the EXIT
 * CODE: a dispatch aimed at one issue (`--issues N` — every `/go`) exists to
 * make that issue progress, so stranded work is its failure. An open-ended
 * `/afk` drain still reports the listing — the caller prints it either way —
 * but a supervisor-owned worker is not respawned over a branch a later Worker
 * will adopt.
 */
export function orphanedWorkDispatchFailure(input: {
  targeted: boolean;
  pushOnly: boolean;
  orphans: readonly OrphanBranch[];
}): string | null {
  if (!input.targeted) return null;
  if (input.pushOnly) return null;
  const proven = input.orphans.filter((o) => (o.commitsAhead ?? 0) > 0);
  if (proven.length === 0) return null;
  return `pushed work has no open pull request: ${formatOrphanBranchListing(proven).join("; ")}`;
}
