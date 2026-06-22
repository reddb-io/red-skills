// landing — the flag-toggled landing of a completed Attempt's worker branch
// into its base (ADR 0030 amended by #842 / 0031). Carved out of process-issue
// so the push → pre_merge → land → (direct-merge conflict self-resolve) →
// post_merge sequence lives in ONE place that owns "how landing works", with a
// direct test surface of its own.
//
// PURE SEQUENCING over injected ports. The push, the merge-stage executor, the
// conflict resolver, the merge hooks, and the landing-worktree provisioner are
// all injected; no real git/gh runs here.
//
// LANDING MODE IS DECOUPLED FROM THE LOCK (#842). The branch-lock (ADR 0031)
// only resolves the target `base` (lock > pin > main); the `openPr` flag —
// `afk.worktree_launches_pull_request`, default true — independently chooses the
// landing MODE. NEITHER mode destructively touches the primary checkout's
// working tree — the primary branch is sacred (issue #572):
//   - openPr=false (DIRECT) → merge --no-ff + push + (one-shot self-resolve of
//                conflicts) run inside an ISOLATED detached worktree at <base>,
//                so a push reject's `reset --hard` only rewinds that throwaway
//                checkout, never the primary's WIP.
//   - openPr=true  (PR)     → `landPr` (admin-merged PR into <base> carrying the
//                attempt history). The merge is remote, so no pre-merge local
//                integrate runs — that step used to fail the whole landing on a
//                diverged primary.
//
// The caller maps a non-ok result to its merge-conflict terminal-failure path.
// On success it closes; for the direct path the merge sha is carried back on the
// result (`mergeSha`) since the primary HEAD no longer advances.

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
  /** Fire a lifecycle hook (pre_merge / post_merge); returns false when the hook
   * aborted. Wraps process-issue's fireHook so the landing never touches the
   * dispatcher directly. */
  fireHook(name: "pre_merge" | "post_merge", context: string): Promise<boolean>;
  /** One-shot inner-agent merge-conflict resolver (locked path only). Absent →
   * a locked merge conflict goes straight to the failure path. */
  conflictResolver?: ConflictResolver;
  /**
   * Provision an ISOLATED, detached worktree at `<base>` for the DIRECT-merge
   * landing (issue #572). The direct merge / push / rollback run there instead of
   * the primary checkout, so a `reset --hard` on a push reject can never discard
   * the primary checkout's uncommitted/untracked WIP — the primary branch is
   * sacred. Returns the worktree dir, or null when one could not be created (a
   * `null` direct landing is refused rather than mutating the primary). Paired
   * with {@link removeLandingWorktree}. Absent → the direct landing is refused
   * too, since there is no safe checkout to operate in. The PR path never needs
   * it (the PR is admin-merged remotely).
   */
  makeLandingWorktree?(base: string): Promise<string | null>;
  /** Tear down a worktree returned by {@link makeLandingWorktree} (best-effort). */
  removeLandingWorktree?(dir: string): Promise<void>;
  /**
   * Opt-in advisory-review wait for the admin-PR landing
   * (`afk.merge.wait_for_review`, ADR 0048). Present → landPr holds until the
   * named review check concludes before the admin-merge, then merges regardless
   * of the verdict. Absent (the default) → admin-merge ignores advisory checks.
   * Ignored on the direct path, which never opens a PR.
   */
  waitForReview?: WaitForReviewInput;
}

/** Static per-landing inputs the caller already resolved. */
export interface LandingInput {
  /**
   * Landing MODE, decoupled from the lock (#842): `true` → admin-merged PR
   * (`landPr`) into `base`; `false` → direct merge (`landMerge`) into `base`.
   * Resolved from `afk.worktree_launches_pull_request` (default `true`). The lock
   * no longer toggles this — it only resolves `base` (see {@link locked}).
   */
  openPr: boolean;
  /**
   * True when the session is locked to a branch. The lock now ONLY resolves the
   * target `base` (done by the caller, ADR 0031); it no longer toggles the
   * landing mode. Carried here purely so the result can echo it for the caller's
   * observability — see {@link LandingResult.locked}.
   */
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
  postMerge(mergeSha?: string): string;
}

/** Result of a landing. On success the caller closes; `mergeSha` carries the
 * landed merge commit when the direct-merge worktree path captured it (the
 * primary checkout's HEAD no longer advances on the direct path, #572), so the
 * caller prefers it over re-reading the primary HEAD. On failure the caller maps
 * `reason` to the merge-conflict terminal-failure path. `locked` echoes the
 * session's lock state (input.locked) for the caller's result shape — it is
 * observational and no longer implies the landing mode (#842). */
export type LandingResult =
  | { ok: true; locked: boolean; mergeSha?: string }
  | { ok: false; reason: "pre_merge-abort" | "integrate-failed" | "land-failed"; locked: boolean };

/**
 * Land a completed attempt's worker branch into its base, flag-toggled (#842).
 * Owns the whole sequence. The two landing paths diverge after the shared push +
 * pre_merge hook on the `openPr` flag — NOT the lock, which only resolved `base`
 * upstream — and neither destructively touches the primary checkout's working
 * tree (issue #572, the primary branch is sacred):
 *
 *   1. pushAttempt — make the worker branch's origin state certain so
 *      landMerge/landPr have a ref to merge.
 *   2. fireHook("pre_merge") — abort → { ok:false, reason:"pre_merge-abort" }.
 *
 *   openPr=true → {@link landAdminPr}. The PR is admin-merged REMOTELY into
 *   `<base>`, so there is nothing to integrate locally first; the prior pre-merge
 *   `merge --ff-only origin/<base>` is dropped (it failed the whole landing on a
 *   diverged primary, #572). landPr's own best-effort local fast-forward is the
 *   only primary touch and never gates the land.
 *
 *   openPr=false → {@link landDirectInWorktree}. The merge / push / rollback run
 *   inside an ISOLATED detached worktree (makeLandingWorktree) at `<base>`, so the
 *   `reset --hard` on a push reject only rewinds that throwaway worktree — the
 *   primary checkout and its WIP are never mutated. Inside it: integrateOrigin →
 *   capture the integrated tip → landMerge → one-shot conflict self-resolve →
 *   post_merge.
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

  const landed = input.openPr ? await landAdminPr(deps, input) : await landDirectInWorktree(deps, input);
  if (!landed.ok) return landed;

  // post_merge hook (best-effort; an abort here does not unwind the landing,
  // matching the prior behaviour which never branched on its result).
  await deps.fireHook("post_merge", hooks.postMerge(landed.mergeSha));
  return landed;
}

/**
 * PR landing (openPr=true): admin-merge a PR into `<base>` (ADR 0030 amended,
 * #842). `<base>` is the lock branch when locked, else the pin, else main — the
 * lock resolved the target upstream; this path is chosen by the flag, not the
 * lock. The merge happens remotely on the forge, so no local integrate runs first
 * — that was the only step that could fail the landing on a diverged primary
 * checkout (#572). The landing succeeds independent of the primary's local
 * `<base>` state. `locked` is echoed for the caller's result observability.
 */
async function landAdminPr(deps: LandingDeps, input: LandingInput): Promise<LandingResult> {
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
  return r.ok
    ? { ok: true, locked: input.locked }
    : { ok: false, reason: "land-failed", locked: input.locked };
}

/**
 * DIRECT landing (openPr=false) in an ISOLATED worktree (#572). Provision a
 * detached worktree at `<base>` (the lock branch when locked, else pin/main),
 * integrate origin into it, merge the attempt + push there, and on any push
 * reject `reset --hard` only that throwaway worktree — the primary checkout is
 * never `git -C`'d destructively, so its WIP survives a failed land. When no
 * worktree can be provisioned the land is REFUSED (returns land-failed) rather
 * than falling back to mutating the primary. The worktree is always torn down.
 */
async function landDirectInWorktree(deps: LandingDeps, input: LandingInput): Promise<LandingResult> {
  const landDir = deps.makeLandingWorktree ? await deps.makeLandingWorktree(input.base) : null;
  if (!landDir) {
    // No isolated checkout → refuse rather than risk the primary working tree.
    return { ok: false, reason: "land-failed", locked: input.locked };
  }

  try {
    // Integrate origin/<base> into the detached worktree HEAD (not the primary).
    const integrated = await integrateOrigin(deps.mergeExec, {
      repo: landDir,
      remote: input.remote,
      branch: input.base,
      stillBehind: true,
      inSync: false,
    });
    if (!integrated.ok) return { ok: false, reason: "integrate-failed", locked: input.locked };

    // Zero-commit guard: `git merge --no-ff` succeeds on a branch with no new
    // commits (it creates a no-op merge commit), which would incorrectly close
    // the issue as done without delivering any work. The PR path rejects this
    // naturally — `gh pr create` fails on an empty branch — so mirror that guard
    // here: route a zero-commit direct landing to land-failed.
    const countRes = await deps.mergeExec([
      "git", "-C", landDir,
      "rev-list", "--count", `origin/${input.base}..origin/${input.branch}`,
    ]);
    const commitCount = parseInt(countRes.stdout.trim(), 10);
    if (countRes.code !== 0 || !Number.isInteger(commitCount) || commitCount === 0) {
      return { ok: false, reason: "land-failed", locked: input.locked };
    }

    // Capture the integrated tip from the worktree as the rollback anchor.
    const preMergeSha = (await deps.mergeExec(["git", "-C", landDir, "rev-parse", "--short", "HEAD"])).stdout.trim();

    const merged = await landMerge(deps.mergeExec, {
      repo: landDir,
      remote: input.remote,
      branch: input.branch,
      target: input.base,
      n: input.issue,
      title: input.title,
      preMergeSha,
    });
    let landed = merged.ok;

    // One-shot self-resolve (merge_resolve_conflict, SKILL.md step 8): when the
    // `git merge --no-ff` left conflicts, dispatch the configured runner once to
    // resolve + commit the merge in the worktree. On success push the resolved
    // base (reset the worktree on a push reject); else `git merge --abort` the
    // worktree and fall through to the ready-for-human merge-conflict path.
    if (!landed && deps.conflictResolver) {
      const resolved = await resolveMergeConflict(deps.mergeExec, deps.conflictResolver, {
        repo: landDir,
        branch: input.branch,
        n: input.issue,
        title: input.title,
        target: input.base,
      });
      if (resolved.resolved) {
        const push = await deps.mergeExec([
          "git",
          "-C",
          landDir,
          "push",
          input.remote,
          `HEAD:refs/heads/${input.base}`,
        ]);
        if (push.code === 0) {
          landed = true;
        } else {
          await deps.mergeExec(["git", "-C", landDir, "reset", "--hard", preMergeSha]);
        }
      } else {
        await deps.mergeExec(["git", "-C", landDir, "merge", "--abort"]);
      }
    }
    if (!landed) return { ok: false, reason: "land-failed", locked: input.locked };

    // The merge commit lives on the worktree's HEAD (and now origin/<base>); the
    // primary HEAD did not advance, so carry the landed sha back for the close.
    const mergeSha = (await deps.mergeExec(["git", "-C", landDir, "rev-parse", "--short", "HEAD"])).stdout.trim();
    return { ok: true, locked: input.locked, mergeSha: mergeSha || undefined };
  } finally {
    await deps.removeLandingWorktree?.(landDir);
  }
}
