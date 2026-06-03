// landing — the lock-toggled landing of a completed Attempt's worker branch
// into its base (ADR 0030/0031). Carved out of process-issue so the
// push → pre_merge → integrate → land → (locked conflict self-resolve) →
// post_merge sequence lives in ONE place that owns "how lock-toggled landing
// works", with a direct test surface of its own.
//
// PURE SEQUENCING over injected ports — exactly the slice process-issue used to
// inline. The push, the merge-stage executor, the conflict resolver, the merge
// hooks, and the headShortSha read are all injected; no real git/gh runs here.
// The git/gh argv and the step ordering are UNCHANGED from the inline version —
// this is a behaviour-preserving move.
//
// Landing is lock-toggled (ADR 0030):
//   - LOCKED   → `landMerge` (git merge --no-ff into the locked branch + push),
//                with a one-shot inner-agent self-resolve of merge conflicts.
//   - UNLOCKED → `landPr` (admin-merged PR carrying the attempt history).
//
// The caller maps a non-ok result to its merge-conflict terminal-failure path.
// On success the caller reads the FINAL merge sha (post post_merge) and runs the
// done close — the final sha read stays in the caller to preserve the exact
// current ordering (it is read AFTER post_merge, identical to before).

import {
  integrateOrigin,
  landMerge,
  landPr,
  resolveMergeConflict,
  type ConflictResolver,
  type Exec as MergeExec,
  type WaitForReviewInput,
} from "./merge.js";
import { pushAttempt, type GitExec } from "./remote-branch.js";

/** Everything the landing needs, all side effects injected — mirroring how
 * process-issue called each of these inline. */
export interface LandingDeps {
  /** git executor for merge.ts (integrateOrigin / landMerge / landPr / the
   * locked conflict resolve + abort/reset/push). */
  mergeExec: MergeExec;
  /** git executor for remote-branch.ts (pushAttempt). */
  remoteGit: GitExec;
  /** git -C primary rev-parse --short HEAD — read once as the captured
   * pre-merge tip (rollback anchor) before landing. */
  headShortSha(): Promise<string>;
  /** Fire a lifecycle hook (pre_merge / post_merge); returns false when the hook
   * aborted. Wraps process-issue's fireHook so the landing never touches the
   * dispatcher directly. */
  fireHook(name: "pre_merge" | "post_merge", context: string): Promise<boolean>;
  /** One-shot inner-agent merge-conflict resolver (locked path only). Absent →
   * a locked merge conflict goes straight to the failure path. */
  conflictResolver?: ConflictResolver;
  /**
   * Opt-in advisory-review wait for the UNLOCKED admin-PR landing
   * (`afk.merge.wait_for_review`, ADR 0048). Present → landPr holds until the
   * named review check concludes before the admin-merge, then merges regardless
   * of the verdict. Absent (the default) → admin-merge ignores advisory checks.
   * Ignored on the locked path, which never opens a PR.
   */
  waitForReview?: WaitForReviewInput;
}

/** Static per-landing inputs the caller already resolved. */
export interface LandingInput {
  /** True when the session is locked — drives the landMerge vs landPr toggle. */
  locked: boolean;
  /** `owner/repo` slug for gh (landPr). */
  repo: string;
  /** Primary checkout dir for git -C. */
  repoDir: string;
  /** Remote name (e.g. `origin`). */
  remote: string;
  /** The worker branch sandcastle committed on (push + land source). */
  branch: string;
  /** Resolved base branch (lock > pin > main). */
  base: string;
  /** Issue number, for the merge/PR message + hook contexts. */
  issue: number;
  /** Issue title, for the merge/PR message + hook contexts. */
  title: string;
}

/** The pre_merge / post_merge hook context builders the caller owns (so the
 * exact JSON shape stays defined once, next to the other hook contexts). */
export interface LandingHookContexts {
  preMerge(): string;
  postMerge(): string;
}

/** Result of a landing. On success the caller reads the final merge sha + runs
 * the done close; on failure the caller maps `reason` to the merge-conflict
 * terminal-failure path. `locked` echoes the path taken for the result shape. */
export type LandingResult =
  | { ok: true; locked: boolean }
  | { ok: false; reason: "pre_merge-abort" | "integrate-failed" | "land-failed"; locked: boolean };

/**
 * Land a completed attempt's worker branch into its base, lock-toggled. Owns the
 * whole sequence, IDENTICAL in ordering and argv to the previous inline version:
 *
 *   1. pushAttempt — make the worker branch's origin state certain so
 *      landMerge/landPr have a ref to merge.
 *   2. fireHook("pre_merge") — abort → { ok:false, reason:"pre_merge-abort" }.
 *   3. integrateOrigin — fail → { ok:false, reason:"integrate-failed" }.
 *   4. headShortSha — capture the integrated tip as the rollback anchor.
 *   5. landMerge (locked) | landPr (unlocked).
 *   6. locked-only one-shot conflict self-resolve (when a resolver is injected):
 *      on resolve, push the locked branch (reset on push-reject); else
 *      `git merge --abort`.
 *   7. land still failed → { ok:false, reason:"land-failed" }.
 *   8. fireHook("post_merge") → { ok:true }.
 */
export async function doLanding(
  deps: LandingDeps,
  input: LandingInput,
  hooks: LandingHookContexts,
): Promise<LandingResult> {
  const { locked } = input;

  // 1. push the worker branch so landMerge/landPr have a remote ref.
  await pushAttempt(deps.remoteGit, input.repoDir, input.branch, input.branch);

  // 2. pre_merge hook.
  if (!(await deps.fireHook("pre_merge", hooks.preMerge()))) {
    return { ok: false, reason: "pre_merge-abort", locked };
  }

  // 3. integrate origin/<base> into local <base>.
  const integrated = await integrateOrigin(deps.mergeExec, {
    repo: input.repoDir,
    remote: input.remote,
    branch: input.base,
    stillBehind: true,
    inSync: false,
  });
  if (!integrated.ok) {
    return { ok: false, reason: "integrate-failed", locked };
  }

  // 4. capture the integrated tip (rollback anchor for the locked push reject).
  const preMergeSha = await deps.headShortSha();

  // 5. land per lock state.
  let landed: boolean;
  if (locked) {
    const r = await landMerge(deps.mergeExec, {
      repo: input.repoDir,
      remote: input.remote,
      branch: input.branch,
      target: input.base,
      n: input.issue,
      title: input.title,
      preMergeSha,
    });
    landed = r.ok;
  } else {
    const r = await landPr(deps.mergeExec, {
      repo: input.repo,
      gitRepo: input.repoDir,
      remote: input.remote,
      branch: input.branch,
      target: input.base,
      n: input.issue,
      title: input.title,
      waitForReview: deps.waitForReview,
    });
    landed = r.ok;
  }

  // 6. One-shot self-resolve (merge_resolve_conflict, SKILL.md step 8): when the
  // `git merge --no-ff` left conflicts, dispatch the configured runner once to
  // resolve + commit the merge in the primary checkout. On success the landing
  // continues to close, otherwise we `git merge --abort` and fall through to the
  // ready-for-human merge-conflict path. Only attempted on the LOCKED path,
  // where the merge happens locally — the unlocked PR path never merges in this
  // checkout (gh admin-merges remotely), so there is nothing to resolve here.
  if (!landed && locked && deps.conflictResolver) {
    const resolved = await resolveMergeConflict(deps.mergeExec, deps.conflictResolver, {
      repo: input.repoDir,
      branch: input.branch,
      n: input.issue,
      title: input.title,
      target: input.base,
    });
    if (resolved.resolved) {
      const push = await deps.mergeExec(["git", "-C", input.repoDir, "push", input.remote, input.base]);
      if (push.code === 0) {
        landed = true;
      } else {
        await deps.mergeExec(["git", "-C", input.repoDir, "reset", "--hard", preMergeSha]);
      }
    } else {
      // Still conflicting → abandon the merge so the checkout is clean for the
      // next iteration, then surface ready-for-human below.
      await deps.mergeExec(["git", "-C", input.repoDir, "merge", "--abort"]);
    }
  }
  if (!landed) {
    return { ok: false, reason: "land-failed", locked };
  }

  // 8. post_merge hook (best-effort; abort here does not unwind the landing,
  // matching the inline version which never branched on its result).
  await deps.fireHook("post_merge", hooks.postMerge());

  return { ok: true, locked };
}
