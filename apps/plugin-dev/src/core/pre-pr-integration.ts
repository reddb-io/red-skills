// pre-pr-integration — integrate `<remote>/<base>` into the worker branch BEFORE
// the pull request is opened (issue #2936).
//
// A PR used to be born on whatever base the Worker saw when it started: the
// terminal sequence was `pushAttempt` → `openReviewPr`, with no fetch, no merge
// of the base, and no conflict check between them. A base that moved during the
// run therefore surfaced only much later, at landing time, through
// `preMergeRebase` — by which point the Worker is usually dead and a human
// inherits a `dirty` PR nobody warned them about.
//
// This is the EARLIER barrier: it runs while the Worker is still alive, so a
// conflict is reported at the moment it can still be resolved. It does NOT
// replace `preMergeRebase` — the landing keeps its own last barrier, because the
// base can move again between the PR opening and the merge.
//
// Like the rest of the merge layer this is a pure decision + argv construction
// layer over an injected `Exec`, so every step is observable in tests without
// touching a repository.

import { describeRebaseConflict, parseUnmergedPaths, type Exec } from "./merge.js";

/** Inputs for {@link integrateBaseBeforePr}. */
export interface IntegrateBaseBeforePrInput {
  /**
   * Dir passed to `git -C` — an ISOLATED worktree on the worker branch, never
   * the primary checkout. The caller provisions it from the freshly-fetched
   * `origin/<branch>` tip, so the integration is built on what was pushed rather
   * than on a local ref that may trail the remote.
   */
  repo: string;
  /** Remote name (e.g. `origin`). */
  remote: string;
  /** Base branch the PR will target (e.g. `main`). */
  base: string;
  /** Worker branch the PR will be opened from. */
  branch: string;
}

/**
 * Why the pre-PR integration did not leave the branch integrated.
 *
 * Only `conflict` is a statement about the BRANCH; `fetch-failed` and
 * `push-failed` are infrastructure faults on a branch that never conflicted, and
 * a caller must not spend `blocked:merge-conflict` on them (the same distinction
 * `preMergeRebase` draws).
 */
export type PrePrIntegrationFailReason = "fetch-failed" | "conflict" | "push-failed";

/** What the integration did. `skipped` means the caller could not provision an
 * isolated worktree, so no git ran and the landing barrier remains the only one. */
export type PrePrIntegrationAction = "skipped" | "already-integrated" | "merged";

export interface PrePrIntegrationResult {
  ok: boolean;
  /** Set on `ok:true` — which path the integration took. */
  action?: PrePrIntegrationAction;
  /** Set on `ok:false` — the distinct failure mode. */
  reason?: PrePrIntegrationFailReason;
  /** Human-facing refusal text, set on every `ok:false`. */
  message?: string;
  /**
   * The paths git reported UNMERGED when the merge stopped — the EVIDENCE that
   * this refusal really is a conflict, and the list the next attempt needs. Read
   * before `merge --abort` clears the index; empty when git could not answer,
   * which the message says rather than implying there are none.
   */
  conflictPaths?: readonly string[];
}

/**
 * Integrate the base into the worker branch before its PR exists (#2936):
 *   1. `git fetch <remote> <base>`, so the decision is made against the CURRENT
 *      base rather than the boot-time one;
 *   2. short-circuit when `<remote>/<base>` is already an ancestor of `HEAD` —
 *      the PR is already born integrated;
 *   3. `git merge --no-edit <remote>/<base>`; on conflict read the unmerged
 *      paths, `git merge --abort`, and report `conflict` WITH those paths;
 *   4. publish the integrated tip with `git push <remote> HEAD:refs/heads/<branch>`,
 *      so the PR GitHub opens is the integrated branch and not the stale one.
 *
 * The push is deliberately NOT forced: the only thing that could have advanced
 * `<branch>` under us is another writer, and clobbering it is worse than
 * reporting `push-failed` on a branch whose work is already safely on origin.
 */
export async function integrateBaseBeforePr(
  exec: Exec,
  input: IntegrateBaseBeforePrInput,
): Promise<PrePrIntegrationResult> {
  const { repo, remote, base, branch } = input;
  const baseRef = `${remote}/${base}`;

  const fetched = await exec(["git", "-C", repo, "fetch", remote, base, "--quiet"]);
  if (fetched.code !== 0) {
    return {
      ok: false,
      reason: "fetch-failed",
      message:
        `could not fetch ${baseRef} before opening the pull request — the branch was left as it is ` +
        `and the landing keeps its own pre-merge barrier`,
    };
  }

  const alreadyIntegrated = await exec(["git", "-C", repo, "merge-base", "--is-ancestor", baseRef, "HEAD"]);
  if (alreadyIntegrated.code === 0) return { ok: true, action: "already-integrated" };

  const merged = await exec(["git", "-C", repo, "merge", "--no-edit", baseRef]);
  if (merged.code !== 0) {
    // Name WHAT conflicts before the abort clears the index. This is the whole
    // point of the earlier barrier: the report happens while the Worker is still
    // alive, so the paths ride into the next attempt instead of into a human's lap.
    const unmerged = await exec(["git", "-C", repo, "diff", "--name-only", "--diff-filter=U"]);
    const conflictPaths = unmerged.code === 0 ? parseUnmergedPaths(unmerged.stdout) : [];
    await exec(["git", "-C", repo, "merge", "--abort"]);
    return {
      ok: false,
      reason: "conflict",
      conflictPaths,
      message: describeRebaseConflict(baseRef, conflictPaths),
    };
  }

  const pushed = await exec(["git", "-C", repo, "push", remote, `HEAD:refs/heads/${branch}`]);
  if (pushed.code !== 0) {
    return {
      ok: false,
      reason: "push-failed",
      message:
        `${baseRef} merged cleanly into ${branch} but the integrated tip could not be pushed — ` +
        `the branch on origin still carries the pre-integration work, which the landing will integrate`,
    };
  }

  return { ok: true, action: "merged" };
}
