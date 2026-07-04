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
  preMergeRebase,
  resolveMergeConflict,
  type ConflictResolver,
  type CiAwaitInput,
  type Exec as MergeExec,
  type WaitForReviewInput,
} from "./merge.js";
import { pushAttempt, type GitExec } from "./remote-branch.js";
import { checkSensitivePaths, type SensitivePathHit } from "./shared-gate.js";

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
   * Provision an ISOLATED worktree checked out on the worker `<branch>` for the
   * PR path's pre-merge rebase (#1006), so the fetch / rebase / force-push run OFF
   * the primary checkout — the primary branch is sacred (#572). Returns the
   * worktree dir, or null when one could not be provisioned. Paired with
   * {@link removeRebaseWorktree}. Absent → the pre-merge rebase is SKIPPED and the
   * PR lands exactly as before (opt-in). Only the PR path uses it; the direct path
   * already integrates origin inside its own detached landing worktree.
   */
  makeRebaseWorktree?(branch: string): Promise<string | null>;
  /** Tear down a worktree returned by {@link makeRebaseWorktree} (best-effort). */
  removeRebaseWorktree?(dir: string): Promise<void>;
  /**
   * Opt-in mechanical-conflict resolver for the PR path's pre-merge rebase
   * (issue #1095). When the rebase onto fresh base CONFLICTS, this is invoked
   * with the rebase worktree dir; it returns true when it auto-resolved EVERY
   * conflict on the closed mechanical allowlist and `git rebase --continue`d, so
   * the landing proceeds instead of parking `blocked:merge-conflict`. Returns
   * false for any non-mechanical conflict → abort as before. Absent (the
   * default) → every conflict aborts, so existing landings are unchanged.
   */
  resolveMechanicalConflict?: (repo: string) => Promise<boolean>;
  /**
   * Opt-in advisory-review wait for the admin-PR landing
   * (`afk.merge.wait_for_review`, ADR 0048). Present → landPr holds until the
   * named review check concludes before the admin-merge, then merges regardless
   * of the verdict. Absent (the default) → admin-merge ignores advisory checks.
   * Ignored on the direct path, which never opens a PR.
   */
  waitForReview?: WaitForReviewInput;
  /**
   * Opt-in sensitive-path guard (issue #1102). Present → the landing scans the
   * branch diff against the closed set of sensitive path patterns before pushing
   * or integrating; any hit aborts with `sensitive-paths` and pages a human.
   * Absent (the default) → the guard is skipped (safe for the direct path and
   * existing callers that have not yet wired the dep).
   */
  getDiffPaths?: () => Promise<{ changedFiles: string[]; packageJsonDiff: string }>;
  /**
   * Opt-in CI-aware merge for the UNLOCKED admin-PR landing (#812). Present →
   * landPr polls the PR's merge state and admin-merges only once it is genuinely
   * ready (CLEAN, or blocked only by a review `--admin` waives), routing the
   * distinct failure modes (`ci-failed` / `ci-pending`) instead of collapsing
   * them to merge-conflict. Absent (the default) → admin-merge immediately.
   * Ignored on the locked path, which never opens a PR.
   */
  ciAwait?: CiAwaitInput;
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
  /**
   * The configured Trunk (`plugins.dev.trunk`, default `main`; ADR 0083) — the
   * repo's focal branch. The landing precondition ({@link verifyTrunkPrecondition})
   * verifies the primary checkout's LOCAL `<trunk>` ref has not diverged from its
   * fresh-fetched `origin/<trunk>` before integrating any attempt branch. This is
   * distinct from {@link base}: `base` is the resolved landing target (which may be
   * a lock/pin branch), while the precondition guards the maintainer-owned trunk
   * the primary checkout tracks.
   */
  trunk: string;
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
  | {
      ok: false;
      // `ci-failed` / `ci-pending` (#812) are UNLOCKED-only: a completed,
      // MERGEABLE PR that the admin-merge could not land because the
      // `enforce_admins` base's required checks failed / are still pending. The
      // caller routes them to the distinct `blocked:ci` path (NOT merge-conflict,
      // NOT a full agent re-run), preserving the open PR.
      reason:
        | "pre_merge-abort"
        | "integrate-failed"
        | "land-failed"
        | "ci-failed"
        | "ci-pending"
        | "pr-conflict"
        | "pr-merge-failed"
        // ADR 0083 landing precondition (#1018): the primary checkout's LOCAL
        // `<trunk>` ref has DIVERGED from `origin/<trunk>`. The landing aborted
        // BEFORE integrating the attempt branch and NEVER repaired the divergence
        // (no reset / stash / auto-commit / force-push). The caller parks the
        // issue ready-for-human with a divergence envelope naming the two SHAs.
        | "trunk-diverged"
        // Sensitive-path guard (issue #1102): the branch diff touches a CI
        // workflow file, a package.json lifecycle script, a git hook, or `.red/`
        // trust/gate configuration. Never auto-lands; pages a human.
        | "sensitive-paths";
      locked: boolean;
      /** PR number left open for the CI-aware handoff (`ci-failed` / `ci-pending`). */
      prNumber?: number;
      /** ADR 0083 divergence (`trunk-diverged`): the primary's LOCAL `<trunk>` SHA. */
      localTrunkSha?: string;
      /** ADR 0083 divergence (`trunk-diverged`): the fresh-fetched `origin/<trunk>` SHA. */
      originTrunkSha?: string;
      /** Sensitive-path guard (`sensitive-paths`): the hits that triggered the guard. */
      sensitivePaths?: SensitivePathHit[];
    };

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
 *   only primary touch, and even that is SKIPPED on a LOCKED landing (ADR 0083
 *   §2, #1019) — the locked PR path integrates on `origin/<locked-branch>` and
 *   never writes to the primary at all.
 *
 *   openPr=false → {@link landDirectInWorktree}. The merge / push / rollback run
 *   inside an ISOLATED detached worktree (makeLandingWorktree) at `<base>`, so the
 *   `reset --hard` on a push reject only rewinds that throwaway worktree — the
 *   primary checkout and its WIP are never mutated. Inside it: integrateOrigin →
 *   capture the integrated tip → landMerge → one-shot conflict self-resolve →
 *   post_merge.
 */
/** Result of the ADR 0083 trunk landing precondition. `ok:true` → proceed with
 * the landing (local trunk absent, an ancestor of origin, or indeterminate);
 * `ok:false` → the local trunk DIVERGED, carrying both SHAs for the caller's
 * ready-for-human divergence envelope. */
type TrunkPreconditionResult = { ok: true } | { ok: false; localSha: string; originSha: string };

/**
 * ADR 0083 landing precondition (#1018). Verify the primary checkout's LOCAL
 * `<trunk>` ref has NOT diverged from its fresh-fetched `origin/<trunk>` before
 * any attempt branch is integrated.
 *
 * The trunk is always read as its fresh-fetched remote ref (ADR 0083), so the
 * check first fetches `origin/<trunk>` (best-effort — an offline fetch must not
 * fabricate a divergence; the comparison then falls back to the origin ref the
 * repo already knows). Then:
 *   - Local `<trunk>` ABSENT (the primary never checked it out) → nothing can
 *     diverge → `{ ok:true }`.
 *   - Local trunk is an ANCESTOR of `origin/<trunk>` (behind or equal) → the
 *     healthy case → `{ ok:true }`.
 *   - `git merge-base --is-ancestor` returns a definitive `1` (NOT an ancestor —
 *     the local trunk carries commits origin does not) → DIVERGED →
 *     `{ ok:false, localSha, originSha }`. Any OTHER non-zero code is a git error
 *     (e.g. a missing origin ref on a fresh repo), treated as indeterminate →
 *     `{ ok:true }` so a transient error never blocks a landing.
 *
 * READ-ONLY: it runs only `fetch` / `rev-parse` / `merge-base` against the
 * primary checkout. It NEVER resets, stashes, auto-commits, or force-pushes to
 * repair a divergence — that repair is a human-only decision (ADR 0083 + the
 * standing maintainer rules), so none of those verbs exist even as a fallback.
 */
async function verifyTrunkPrecondition(
  exec: MergeExec,
  input: { repoDir: string; remote: string; trunk: string },
): Promise<TrunkPreconditionResult> {
  const { repoDir, remote, trunk } = input;

  // Fresh-fetch the remote trunk so the comparison is against origin's real tip.
  // Best-effort: a fetch failure (offline) is ignored — we then compare against
  // whatever `origin/<trunk>` the local repo already knows.
  await exec(["git", "-C", repoDir, "fetch", remote, trunk, "--quiet"]);

  // Local trunk ABSENT → nothing to diverge; proceed.
  const local = await exec(["git", "-C", repoDir, "rev-parse", "--verify", "--quiet", "--short", `refs/heads/${trunk}`]);
  if (local.code !== 0) return { ok: true };
  const localSha = local.stdout.trim();

  // Local trunk is an ANCESTOR of origin/<trunk> (exit 0) → proceed. Only a
  // definitive exit 1 (NOT an ancestor) is a divergence; any other code is a git
  // error → indeterminate → proceed (never block on a transient error).
  const ancestor = await exec([
    "git", "-C", repoDir, "merge-base", "--is-ancestor", localSha, `${remote}/${trunk}`,
  ]);
  if (ancestor.code !== 1) return { ok: true };

  const origin = await exec(["git", "-C", repoDir, "rev-parse", "--short", `${remote}/${trunk}`]);
  return { ok: false, localSha, originSha: origin.stdout.trim() };
}

export async function doLanding(
  deps: LandingDeps,
  input: LandingInput,
  hooks: LandingHookContexts,
): Promise<LandingResult> {
  const { locked } = input;

  // 0a. Sensitive-path guard (issue #1102): scan the branch diff for sensitive
  // path patterns BEFORE any push or git integration. A hit is an intent-class
  // change (CI workflow, lifecycle script, git hook, .red/ config) that must
  // never auto-land — abort immediately and page a human. Opt-in: the guard is
  // skipped when getDiffPaths is absent (backwards-compatible default).
  if (deps.getDiffPaths) {
    const { changedFiles, packageJsonDiff } = await deps.getDiffPaths();
    const hits = checkSensitivePaths(changedFiles, packageJsonDiff);
    if (hits.length > 0) {
      return { ok: false, reason: "sensitive-paths", locked, sensitivePaths: hits };
    }
  }

  // 0. ADR 0083 landing precondition (#1018): the primary checkout's LOCAL
  // `<trunk>` ref must be an ANCESTOR of `origin/<trunk>`. Verified BEFORE any
  // attempt branch is pushed or integrated so a diverged local trunk fails loud
  // instead of silently eating the maintainer's work. On divergence the landing
  // ABORTS and NEVER repairs it (no reset / stash / auto-commit / force-push);
  // the caller parks the issue ready-for-human with the two SHAs. Local trunk
  // absent, an ancestor, or an indeterminate git error → proceed unchanged.
  const trunkCheck = await verifyTrunkPrecondition(deps.mergeExec, {
    repoDir: input.repoDir,
    remote: input.remote,
    trunk: input.trunk,
  });
  if (!trunkCheck.ok) {
    return {
      ok: false,
      reason: "trunk-diverged",
      locked,
      localTrunkSha: trunkCheck.localSha,
      originTrunkSha: trunkCheck.originSha,
    };
  }

  // 1. push the worker branch so landMerge/landPr have a remote ref.
  // NOT best-effort: if the push fails the remote has no commits and any merge
  // attempt produces a false "zero-diff" land-failed (the true cause is a push
  // failure, not a merge conflict). Fail early with the real reason so no work
  // is silently lost and the issue is not mis-labelled blocked:merge-conflict.
  const pushed = await pushAttempt(deps.remoteGit, input.repoDir, input.branch, input.branch);
  if (!pushed.ok) {
    return { ok: false, reason: "land-failed", locked };
  }

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
 * `<base>` state. `locked` is echoed for the caller's result observability AND
 * passed to {@link landPr}: on a LOCKED landing landPr skips its best-effort local
 * fast-forward so the primary checkout is never written to (ADR 0083 §2, #1019).
 */
async function landAdminPr(deps: LandingDeps, input: LandingInput): Promise<LandingResult> {
  // Pre-merge rebase (#1006): rebase the worker branch onto the fetched base tip
  // in an ISOLATED worktree and force-push it before opening/merging the PR, so
  // the admin-merge is never rejected as a stale non-fast-forward and then
  // false-flagged blocked:merge-conflict. A real rebase conflict — or a
  // --force-with-lease reject that survives the bounded retry — parks
  // blocked:merge-conflict through the existing `pr-conflict` route. Opt-in:
  // without the worktree provisioner the rebase is skipped (today's behaviour).
  const rebaseFail = await preMergeRebaseInWorktree(deps, input);
  if (rebaseFail) return rebaseFail;

  const r = await landPr(deps.mergeExec, {
    repo: input.repo,
    gitRepo: input.repoDir,
    remote: input.remote,
    branch: input.branch,
    target: input.base,
    n: input.issue,
    title: input.title,
    waitForReview: deps.waitForReview,
    ciAwait: deps.ciAwait,
    // Untouchable primary (ADR 0083 §2, #1019): on a LOCKED landing landPr skips
    // its step-4 local fast-forward, so the integration reaches the maintainer
    // only via `origin/<locked-branch>` (they promote by pulling). The lock only
    // resolved `base` (#842); this is the one primary write the locked PR path
    // still had.
    locked: input.locked,
  });
  if (r.ok) return { ok: true, locked: input.locked };
  // Route the CI-aware failure modes (#812) distinctly. A failed required check
  // or a still-pending PR is NOT a merge conflict — preserve the open PR and hand
  // it to the `blocked:ci` path rather than the merge-conflict re-run. Everything
  // else (real conflict / push / no-PR / admin-merge rejection) stays land-failed.
  // `locked` echoes the session's lock state (#842): the admin-PR path is no
  // longer unlocked-only — lock=X + openPr=true also lands through here.
  if (r.reason === "ci-failed") return { ok: false, reason: "ci-failed", locked: input.locked, prNumber: r.prNumber };
  if (r.reason === "ci-pending") return { ok: false, reason: "ci-pending", locked: input.locked, prNumber: r.prNumber };
  if (r.reason === "conflict") return { ok: false, reason: "pr-conflict", locked: input.locked, prNumber: r.prNumber };
  if (r.reason === "merge-failed" && r.prNumber !== undefined) {
    return { ok: false, reason: "pr-merge-failed", locked: input.locked, prNumber: r.prNumber };
  }
  return { ok: false, reason: "land-failed", locked: input.locked, prNumber: r.prNumber };
}

/**
 * Pre-merge rebase step for the PR path (#1006). Provision an isolated worktree
 * on the worker branch and {@link preMergeRebase} it onto the fetched base,
 * force-pushing the result. Returns a failing {@link LandingResult} to abort the
 * landing (parked as blocked:merge-conflict via `pr-conflict`) on a real conflict
 * or an exhausted force-with-lease retry; returns `undefined` — "proceed to the
 * admin-merge" — on success, when no provisioner is wired (opt-in), or when a
 * worktree could not be provisioned (skip rather than risk the primary; the
 * CI-aware poll still catches a genuinely stale base). The worktree is always
 * torn down.
 */
async function preMergeRebaseInWorktree(
  deps: LandingDeps,
  input: LandingInput,
): Promise<LandingResult | undefined> {
  if (!deps.makeRebaseWorktree) return undefined;
  const dir = await deps.makeRebaseWorktree(input.branch);
  if (!dir) return undefined;
  try {
    const rebased = await preMergeRebase(deps.mergeExec, {
      repo: dir,
      remote: input.remote,
      base: input.base,
      branch: input.branch,
      resolveMechanical: deps.resolveMechanicalConflict,
    });
    if (rebased.ok) return undefined;
    // Real conflict / exhausted force-with-lease retries → park merge-conflict.
    return { ok: false, reason: "pr-conflict", locked: input.locked };
  } finally {
    await deps.removeRebaseWorktree?.(dir);
  }
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
