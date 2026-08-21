// landing — the flag-toggled landing of a completed Attempt's worker branch
// into its base (ADR 0030 amended by #842 / 0031). Carved out of process-issue
// so the push → pre_merge → land → (direct-merge conflict self-resolve) →
// post_merge sequence has one owner and a direct test surface.
//
// PURE SEQUENCING over injected ports. The push, the merge-stage executor, the
// conflict resolver, the merge hooks, and the landing-worktree provisioner are
// all injected; no real git/gh runs here.
//
// LANDING MODE IS DECOUPLED FROM THE LOCK (#842). The branch-lock (ADR 0031)
// only resolves the target `base` (lock > pin > main); the `openPr` flag —
// `afk.worktree_launches_pull_request`, default true — independently chooses the
// landing MODE. Neither mode touches the primary checkout (issue #572):
//   - openPr=false (DIRECT) → merge --no-ff + push + conflict self-resolution
//                run inside an isolated detached worktree at <base>.
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
  promoteFleetTrunkMirror,
  preMergeRebase,
  resolveMergeConflict,
  type ConflictResolver,
  type CiAwaitInput,
  type CiGreenEvidence,
  type Exec as MergeExec,
  type LandingWaitPollEvent,
  type MergeQueueWaitInput,
  type WaitForReviewInput,
} from "./merge.js";
import { resolveLandSerialization, type LandLock } from "./land-lock.js";
import { landHeadPrecondition } from "./land-precondition.js";
import { landingMergeTitle } from "./landing-merge-title.js";
import { resolveRemoteBranchTip } from "./stale-head.js";
import type { LandVerdictGate } from "@reddb-io/shared/land-verdict.js";
import { pushAttempt, type GitExec } from "./remote-branch.js";
import { restagePiPackages } from "./pi-package-restage.js";
import type {
  QueueCustodyHandoffResult,
  QueueCustodyIdentity,
} from "./queue-custodian.js";

/** Landing side effects, all injected as they were in process-issue. */
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
   * {@link removeRebaseWorktree}. Absent → the PR landing is refused as infra
   * before the admin-merge; fresh-base integration is a mandatory PR-path
   * precondition (#1212). Only the PR path uses it; the direct path already
   * integrates origin inside its own detached landing worktree.
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
   * Agent conflict resolver for the PR path's pre-merge rebase (issue #2075).
   * Runs after the mechanical resolver declines, while the land-lock is held,
   * and before the exact post-merge gate revalidates the resolved tree.
   */
  resolveAgentConflict?: (repo: string) => Promise<boolean>;
  /** Small attempt budget for the agent resolver; defaults in merge.ts. */
  maxAgentConflictResolveAttempts?: number;
  /**
   * Opt-in advisory-review wait for the admin-PR landing
   * (`afk.merge.wait_for_review`, ADR 0048). Present → landPr holds until the
   * named review check concludes before the admin-merge, then merges regardless
   * of the verdict. Absent (the default) → admin-merge ignores advisory checks.
   * Ignored on the direct path, which never opens a PR.
   */
  waitForReview?: WaitForReviewInput;
  /**
   * Opt-in CI-aware merge for the UNLOCKED PR landing (#812). Present →
   * landPr polls the PR's merge state and merges only once it is genuinely
   * ready (CLEAN), routing the distinct failure modes (`ci-failed` / `ci-pending`)
   * instead of collapsing them to merge-conflict. Absent (the default) → merge
   * immediately. Ignored on the locked path, which never opens a PR.
   */
  ciAwait?: CiAwaitInput;
  /**
   * Budget for the post-enqueue merge confirmation on a native-merge-queue base
   * (#2986). Absent → merge.ts defaults with a real timer. The sleep/probe
   * settings of {@link LandingDeps.ciAwait} are reused when this is absent, so a
   * caller that already injected a test clock does not get a live one here.
   */
  mergeQueueWait?: MergeQueueWaitInput;
  /**
   * Slot-release point for PR landings (#2427). Absent/`merge` preserves the
   * synchronous landing. `ci` and `none` return a deferred tail to the caller.
   */
  landingWait?: "merge" | "ci" | "none";
  /**
   * Native merge-queue custody. The callback arms the supplied forge intent,
   * persists the hand-off, and returns only after both are established.
   */
  queueCustody?: (
    identity: QueueCustodyIdentity,
    armNativeIntent: () => Promise<{ readonly ok: boolean; readonly reason?: string }>,
  ) => Promise<QueueCustodyHandoffResult>;
  /**
   * Non-blocking observability hook (issue #1279): invoked by the PR landing path
   * the moment the PR number is RESOLVED (open-or-reused, before the merge), so
   * the caller can attach the aggregated backpressure evidence review to the PR.
   * Best-effort and fully DECOUPLED — landPr swallows any rejection and the hook
   * never affects whether/how the PR merges. Absent (the default) or on the
   * direct path (no PR) → never called.
   */
  onPrResolved?: (prNumber: number) => Promise<void | "abort">;
  /**
   * Opt-in post-merge-integration gate (#1335). When present, the landing re-runs
   * the package-scoped feedback gate against the INTEGRATED tree (the worker branch
   * merged with current origin/<base>) BEFORE pushing to the remote base. A failure
   * aborts the landing and routes through the existing recovery instead of merging
   * an unvalidated or stale-main-broken result. Absent (the default) → skipped,
   * so existing callers that have not yet wired the dep are unchanged.
   *
   * Called with the path of the already-integrated worktree:
   *   - direct path: the detached landing worktree after `integrateOrigin`
   *   - PR path: the isolated rebase worktree after `preMergeRebase`
   */
  postMergeGate?: (mergedTreeDir: string) => Promise<{ ok: boolean }>;
  /**
   * Deterministic intent barrier (#3279), run on the integrated tree before any
   * PR is opened or attempt commit is merged. A refusal is never auto-repaired.
   */
  intentGate?: (integratedTreeDir: string) => Promise<{ ok: boolean }>;
  /**
   * When true, a landing that cannot use fresh PR CI must have `postMergeGate`.
   * This lets validation-aware callers fail as infra instead of silently landing
   * without either CI provenance or a local fallback.
   */
  requirePostMergeValidation?: boolean;
  /**
   * Global AFK land-lock (#1337). Present → the landing critical section
   * (integrate/rebase → revalidate → merge → push) runs under mutual exclusion, so
   * only one worker at a time lands into `<base>` and each one rebases onto a tip
   * no concurrent worker can move underneath it. A wait timeout aborts the landing
   * as `infra` rather than pushing unserialized. Ignored when `<base>` has a native
   * merge queue ({@link LandingInput.nativeMergeQueue}) — the forge serializes
   * better than we can. Absent (the default) → lands unserialized, the pre-#1337
   * behaviour, so callers that have not wired the dep are unchanged.
   */
  landLock?: LandLock;
  /**
   * Best-effort landing visibility sink (#1427). The caller wires this to the
   * attempt's worker-shaped state (`current.phase` + `current.started_at`) so
   * statusline/monitor readers see the post-agent landing lane after the inner
   * agent has exited. Uses the normal WorkerVitals `phase` field, not a parallel
   * state vocabulary.
   */
  landingPhase?(phase: LandingPhase, detail?: Record<string, unknown>): void | Promise<void>;
  /**
   * ADR 0154's land precondition, as the port `land-precondition.ts` builds
   * (#4138): the ledger is asked whether a non-voided PASSING verdict judges
   * the head this landing is about to merge, and a refusal stops the merge
   * before the pre_merge hook. Which callers supply one is declared in
   * `LAND_ENTRY_POINTS` and pinned by its ratchet, so an unarmed landing is a
   * stated fact rather than a silence.
   */
  verdictGate?: LandVerdictGate;
}

export type LandingPhase = "gate" | "push-pr" | "merge" | "cascade" | "wait" | "close";

/** Static per-landing inputs the caller already resolved. */
export interface LandingInput {
  /**
   * Landing MODE, decoupled from the lock (#842): `true` → PR merge (`landPr`)
   * into `base`; `false` → direct merge (`landMerge`) into `base`. Resolved from
   * `afk.worktree_launches_pull_request` (default `true`). The lock no longer
   * toggles this — it only resolves `base` (see {@link locked}).
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
  /** The gate-validated worker tip (reconcile; #4134 stale-head guard). */
  validatedBranchTip?: string;
  /** Resolved base branch (lock > pin > main). */
  base: string;
  /** Immutable base commit shared by the Landing integration and intent geometry. */
  intentBaseRef?: string;
  /**
   * The configured Trunk (`plugins.dev.trunk`, default `main`; ADR 0083). Kept
   * for caller compatibility and observability; trunk freshness is resolved
   * before landing by the fleet-owned `red-trunk` mirror, not by inspecting the
   * primary checkout's local trunk branch.
   */
  trunk: string;
  /** Issue number, for the merge/PR message + hook contexts. */
  issue: number;
  /** Issue title, for the merge/PR message + hook contexts. */
  title: string;
  /** Issue labels used to derive the landing-created conventional merge title. */
  labels?: readonly string[];
  /** Changed files in the worker branch, used to classify fallback landing titles. */
  changedFiles?: readonly string[];
  /**
   * `<base>` has the forge's native merge queue configured (#1337). True → the PR
   * landing ENQUEUES (`gh pr merge --auto`) and takes NO local land-lock: the queue
   * already serializes entries and rebases + revalidates each onto the current tip.
   * Only meaningful on the PR path — a direct merge never opens a PR, so a queued
   * base falls back to the land-lock there. Defaults false/undefined.
   */
  nativeMergeQueue?: boolean;
  /**
   * True when the landing Worker holds this issue's claim (#3377). The claim is
   * what licenses the gate's push step to RECONCILE a diverged `afk/*` tip with
   * a leased force instead of parking: the attempt namespace belongs to the
   * claim holder, so a tip it did not write is a dead attempt's leftover.
   * Absent/false → a diverged tip stays a failure, exactly as before.
   */
  claimHeld?: boolean;
}

/** The pre_merge / post_merge hook context builders the caller owns (so the
 * exact JSON shape stays defined once, next to the other hook contexts). */
export { landingMergeTitle };

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
export interface DeferredLandingTail {
  readonly prNumber: number;
  readonly waitForCi: boolean;
  run(ciAlreadyGreen?: boolean): Promise<LandingResult>;
}

export type LandingResult =
  | {
      ok: true;
      locked: boolean;
      mergeSha?: string;
      postMergeValidation?: LandingPostMergeValidation;
      deferred?: DeferredLandingTail;
      custody?: { readonly prNumber: number; readonly outcome: "handed-off" };
    }
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
        | "infra"
        // An `onPrResolved` callback asked to stop before the merge. Review no
        // longer uses this (it is the gate fold's third stage now, #2730); the
        // route survives for any other pre-merge observer that must abort.
        | "pr-resolved-abort"
        // Legacy ADR 0083 landing-precondition route. New trunk freshness uses
        // the fleet-owned `red-trunk` mirror and no longer emits this from
        // landing, but older callers/tests may still reference the result shape.
        | "trunk-diverged"
        // Post-merge-integration gate (#1335): the feedback gate failed on the
        // integrated (worker branch merged with current origin/<base>) tree. The
        // landing aborted BEFORE pushing anything to the remote base. The caller
        // routes this through the existing merge-conflict/validation recovery so
        // an unvalidated or stale-main-broken result is never merged.
        | "post-merge-gate"
        // Geometric after-fork reversion/test-count intent finding (#3279).
        // The integrated tree is discarded before a PR or base write occurs.
        | "intent-finding"
        // Land-lock serialization (#2596): another worker held the land-lock past
        // the wait timeout. This is a BACKOFF signal, not an infra failure — the
        // caller routes it to self-requeue rather than parking the issue.
        | "land-lock-timeout"
        // #4134: the branch advanced after the gate validated its tip, and the
        // advance is not a clean rebase of the validated work (stable patch-id
        // differs). Landing the live head would merge commits nothing
        // validated; landing the validated tip would silently drop the
        // advance. Refuse, naming both SHAs in `message`.
        | "stale-head"
        // #4138: nothing in the verdicts ledger authorizes the head this
        // landing would merge — no row, a voided one, a judgement of a
        // different tree, or a verifier that refused or could not conclude.
        // `message` carries the refusal and the repair it names.
        | "unverified-head";
      locked: boolean;
      /** PR number left open for the CI-aware handoff (`ci-failed` / `ci-pending`). */
      prNumber?: number;
      /** Legacy ADR 0083 divergence (`trunk-diverged`): the primary's LOCAL `<trunk>` SHA. */
      localTrunkSha?: string;
      /** Legacy ADR 0083 divergence (`trunk-diverged`): the fresh-fetched `origin/<trunk>` SHA. */
      originTrunkSha?: string;
      /** Actionable refusal text for the terminal note, when the route carries one. */
      message?: string;
      /** Infra failure (`infra`): actionable refusal text for the terminal note. */
      infraReason?: string;
    };

/** Why a landing refused, as one named union the callers can route on (#2864). */
export type LandingFailureReason = Extract<LandingResult, { ok: false }>["reason"];

export type LandingPostMergeValidation =
  | {
      path: "satisfied-by-ci";
      reason: string;
      prNumber: number;
      checkCount: number;
    }
  | {
      path: "local-rerun";
      reason: string;
      prNumber?: number;
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
 *   3. SERIALIZE the land (#1337) — native merge queue when `<base>` has one, else
 *      the global land-lock when wired, so no two workers integrate-and-push into
 *      the same base concurrently. Everything after this point is the critical
 *      section; the lock is always released, on success and on failure alike.
 *
 *   openPr=true → {@link landAdminPr}. The PR is admin-merged REMOTELY into
 *   `<base>`, so there is nothing to integrate locally first; the prior pre-merge
 *   `merge --ff-only origin/<base>` is dropped (it failed the whole landing on a
 *   diverged primary, #572). After a successful non-queued merge, landPr
 *   promotes the fleet-owned `red-trunk` mirror with `update-ref`, never the
 *   primary checkout.
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
  const landingInput = input;

  // 1. push the worker branch so landMerge/landPr have a remote ref.
  // NOT best-effort: if the push fails the remote has no commits and any merge
  // attempt produces a false "zero-diff" land-failed (the true cause is a push
  // failure, not a merge conflict). Fail early with the real reason so no work
  // is silently lost and the issue is not mis-labelled blocked:merge-conflict.
  await deps.landingPhase?.("gate", { step: "push", status: "start" });
  const pushed = await pushAttempt(deps.remoteGit, input.repoDir, input.branch, input.branch, {
    claimHeld: input.claimHeld === true,
  });
  if (!pushed.ok) {
    // Carry the REAL failure into the terminal record (#2576): a generic
    // land-failed with no diagnostic was being misread as a merge conflict.
    //
    // #2811: route the push refusal to `infra`, NOT `land-failed`. `land-failed`
    // funnels into the merge-conflict terminal, so the record said
    // `kind: merge-conflict` under a summary stating the cause was the push and
    // not a merge conflict, and told the next human to resolve a conflict that
    // does not exist. `infra` is the honest kind for a push that never landed a
    // byte, and its next-action ("fix the failure, then requeue") applies.
    // `pushed.status` keeps "the git call never ran" distinct from "the remote
    // refused it" — both were previously narrated as *the push failed*.
    const detail = pushed.warn ? `: ${pushed.warn}` : "";
    return {
      ok: false,
      reason: "infra",
      locked,
      infraReason:
        pushed.status === "skipped"
          ? `worker branch push did not run${detail} — nothing reached origin and nothing was merged`
          : `worker branch push failed${detail} — the branch is not on origin at its local tip, so nothing was merged`,
    };
  }
  await deps.landingPhase?.("gate", { step: "push", status: "done" });
  // The head this merge would ship must be the head the gate validated (#4134)
  // AND the head some other identity judged (#4138) — one precondition, because
  // both fail for one reason: the merged tree is not the judged tree.
  const refusal = await landHeadPrecondition(deps.mergeExec, input, deps.verdictGate);
  if (refusal) return { ok: false, reason: refusal.reason, locked, message: refusal.message };


  // 2. pre_merge hook.
  await deps.landingPhase?.("gate", { step: "pre_merge", status: "start" });
  if (!(await deps.fireHook("pre_merge", hooks.preMerge()))) {
    return { ok: false, reason: "pre_merge-abort", locked };
  }
  await deps.landingPhase?.("gate", { step: "pre_merge", status: "done" });

  // 3. Serialize the land (#1337). Everything below — integrate/rebase onto the
  // fresh base, revalidate the integrated tree, merge, push — is the critical
  // section two near-simultaneous workers used to race in: A pushes, B's push is
  // rejected non-fast-forward, B re-integrates, and overlapping diffs conflict.
  //
  //   native-merge-queue → the forge serializes; take no local lock.
  //   land-lock          → only one worker at a time enters, so each rebases onto
  //                        a tip no concurrent land can move underneath it.
  //   unserialized       → no lock wired (pre-#1337 default): land as before.
  //
  // A wait timeout ABORTS the landing as `infra` — pushing unserialized after
  // failing to serialize would reintroduce exactly the race the lock exists for.
  const serialization = resolveLandSerialization({
    // The native queue is a PR-path mechanism: a direct merge never opens a PR, so
    // a queued base still needs the local lock there.
    nativeMergeQueue: input.openPr && input.nativeMergeQueue === true,
    hasLandLock: deps.landLock !== undefined,
  });

  let release: (() => Promise<void>) | null = null;
  if (serialization === "land-lock") {
    release = (await deps.landLock?.acquire()) ?? null;
    if (!release) {
      return { ok: false, reason: "land-lock-timeout", locked };
    }
  }

  let landed: LandingResult;
  try {
    landed = landingInput.openPr ? await landAdminPr(deps, landingInput) : await landDirectInWorktree(deps, landingInput);
  } finally {
    await release?.();
  }
  if (!landed.ok) return landed;
  if (landed.custody) return landed;
  if (landed.deferred) {
    const deferred = landed.deferred;
    return {
      ...landed,
      deferred: {
        ...deferred,
        run: async (ciAlreadyGreen?: boolean) => {
          let tailRelease: (() => Promise<void>) | null = null;
          if (serialization === "land-lock") {
            tailRelease = (await deps.landLock?.acquire()) ?? null;
            if (!tailRelease) {
              return { ok: false, reason: "land-lock-timeout", locked };
            }
          }
          let completed: LandingResult;
          try {
            completed = await deferred.run(ciAlreadyGreen);
          } finally {
            await tailRelease?.();
          }
          if (!completed.ok) return completed;
          await deps.landingPhase?.("cascade");
          await deps.fireHook("post_merge", hooks.postMerge(completed.mergeSha));
          return completed;
        },
      },
    };
  }

  // post_merge hook (best-effort; an abort here does not unwind the landing,
  // matching the prior behaviour which never branched on its result).
  await deps.landingPhase?.("cascade");
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
 * `<base>` state. `locked` is echoed for the caller's result observability;
 * mirror promotion is identical for locked and unlocked PR landings.
 */
async function landAdminPr(deps: LandingDeps, input: LandingInput): Promise<LandingResult> {
  // Pre-merge rebase (#1006): rebase the worker branch onto the fetched base tip
  // in an ISOLATED worktree and force-push it before opening/merging the PR, so
  // the admin-merge is never rejected as a stale non-fast-forward and then
  // false-flagged blocked:merge-conflict. A real rebase conflict — or a
  // --force-with-lease reject that survives the bounded retry — parks
  // blocked:merge-conflict through the existing `pr-conflict` route. Missing or
  // failed provisioning is infra, never a silent skip (#1212).
  const prepared = await preparePrRebaseWorktree(deps, input);
  if (!prepared.ok) return prepared.result;

  let postMergeValidation: LandingPostMergeValidation | undefined;
  let missingPostMergeFallback = false;
  let cleanupDeferred = false;
  const waitForReview = decorateReviewWait(deps, input);
  const ciAwait = decorateCiAwait(deps, input);
  try {
    const restageFailure = await restagePiPackages(deps, input, prepared.dir, true);
    if (restageFailure) return restageFailure;
    if (deps.intentGate && !(await deps.intentGate(prepared.dir)).ok) {
      return { ok: false, reason: "intent-finding", locked: input.locked };
    }
    await deps.landingPhase?.("push-pr", { step: "pr", status: "start" });
    const r = await landPr(deps.mergeExec, {
      repo: input.repo,
      gitRepo: input.repoDir,
      remote: input.remote,
      branch: input.branch,
      target: input.base,
      n: input.issue,
      title: input.title,
      mergeTitle: landingMergeTitle(input),
      waitForReview,
      ciAwait,
      releaseAt: deps.landingWait === "ci" || deps.landingWait === "none"
        ? deps.landingWait
        : undefined,
      // Non-blocking backpressure evidence review (#1279): threaded through so
      // landPr can attach the ledger the moment it resolves the PR number.
      onPrResolved: deps.onPrResolved,
      // Native merge queue (#1337): enqueue rather than merge on the spot, letting
      // the forge serialize + rebase + revalidate every entry onto the current tip.
      mergeQueue: input.nativeMergeQueue === true,
      // #2986: the enqueue is not the merge. This budget owns the hold between
      // `--auto` exiting 0 and the forge reporting `merged: true`.
      mergeQueueWait: decorateMergeQueueWait(deps, input),
      ...(deps.queueCustody
        ? {
            queueHandoff: (prNumber: number, armNativeIntent: () => Promise<{ ok: boolean; reason?: string }>) =>
              deps.queueCustody!(
                {
                  repo: input.repo,
                  prNumber,
                  ownerTicket: input.issue,
                  branch: input.branch,
                  base: input.base,
                },
                armNativeIntent,
              ),
          }
        : {}),
      // #3030: the confirmation's ONE repair for a PR the queue can never accept.
      // The pre-merge rebase worktree is already provisioned and already on this
      // branch, so the repair is the same integration step run once more against
      // the base as it stands NOW — the base moved under the branch while CI ran,
      // which is how a landing arrives at a conflicted PR in the first place.
      rebaseOntoBase: async () => {
        await deps.landingPhase?.("gate", { step: "rebase", status: "start" });
        const rebased = await preMergeRebase(deps.mergeExec, {
          repo: prepared.dir,
          remote: input.remote,
          base: input.base,
          branch: input.branch,
          resolveMechanical: deps.resolveMechanicalConflict,
          resolveAgent: deps.resolveAgentConflict,
          maxAgentResolveAttempts: deps.maxAgentConflictResolveAttempts,
        });
        await deps.landingPhase?.("gate", { step: "rebase", status: "done" });
        return rebased.ok;
      },
      // Untouchable primary (ADR 0083 / 0108): landPr promotes the fleet mirror,
      // not a local primary branch. `locked` is observability only.
      locked: input.locked,
      beforeMerge: async ({ prNumber, ciEvidence }) => {
        if (ciEvidence) {
          postMergeValidation = ciSatisfiedValidation(prNumber, ciEvidence);
          return { ok: true };
        }
        if (!deps.postMergeGate && deps.requirePostMergeValidation) {
          missingPostMergeFallback = true;
          return { ok: false };
        }
        if (!deps.postMergeGate) return { ok: true };
        await deps.landingPhase?.("gate", { step: "re-validation", pr_number: prNumber, status: "start" });
        const gateResult = await deps.postMergeGate!(prepared.dir);
        postMergeValidation = {
          path: "local-rerun",
          reason: `PR #${prNumber} CI evidence was absent or unusable; local post-merge validation fallback ran.`,
          prNumber,
        };
        return gateResult.ok ? { ok: true } : { ok: false };
      },
    });
    const mapResult = (result: typeof r): LandingResult => {
      if (result.ok) {
        return {
          ok: true,
          locked: input.locked,
          ...(result.custody && result.prNumber != null
            ? { custody: { prNumber: result.prNumber, outcome: "handed-off" as const } }
            : {}),
          ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}),
          ...(postMergeValidation ? { postMergeValidation } : {}),
        };
      }
      if (result.reason === "ci-failed") return { ok: false, reason: "ci-failed", locked: input.locked, prNumber: result.prNumber };
      if (result.reason === "ci-pending") return { ok: false, reason: "ci-pending", locked: input.locked, prNumber: result.prNumber };
      // #2986: the merge queue handed the PR back. Nothing merged, so route it to
      // the `blocked:ci` park that keeps the issue open and the branch on origin —
      // never to a success the close/cleanup steps would act on.
      if (result.reason === "queue-rejected") {
        return {
          ok: false,
          reason: "pr-merge-failed",
          locked: input.locked,
          prNumber: result.prNumber,
          message: result.queueDetail ?? "the merge queue rejected the pull request; nothing was merged",
        };
      }
      // Still queued when the confirmation budget ran out: the merge may yet land,
      // so this is `ci-pending` (hold the open PR), not a failure of the work.
      if (result.reason === "queue-pending") {
        return { ok: false, reason: "ci-pending", locked: input.locked, prNumber: result.prNumber };
      }
      // #3160: the confirmation went BLIND, which says nothing about the PR. Route
      // it to `infra` — the thing that is broken is this host's ability to read
      // GitHub, and an operator told `ci-pending` would go look at the wrong thing.
      if (result.reason === "queue-probe-failing") {
        return {
          ok: false,
          reason: "infra",
          locked: input.locked,
          prNumber: result.prNumber,
          infraReason:
            result.queueDetail ?? "the merge confirmation could not read the pull request",
        };
      }
      if (result.reason === "pr-resolved-abort") {
        return { ok: false, reason: "pr-resolved-abort", locked: input.locked, prNumber: result.prNumber };
      }
      if (result.reason === "before-merge-failed") {
        if (missingPostMergeFallback) {
          return {
            ok: false,
            reason: "infra",
            locked: input.locked,
            prNumber: result.prNumber,
            infraReason: "Post-merge validation fallback is not configured and PR CI evidence was absent or unusable.",
          };
        }
        return { ok: false, reason: "post-merge-gate", locked: input.locked, prNumber: result.prNumber };
      }
      // #3030: a conflict the confirmation detected carries what it observed, so
      // the human card names the conflicting PR instead of a bare park.
      if (result.reason === "conflict") {
        return {
          ok: false,
          reason: "pr-conflict",
          locked: input.locked,
          prNumber: result.prNumber,
          ...(result.queueDetail ? { message: result.queueDetail } : {}),
        };
      }
      if (result.reason === "merge-failed" && result.prNumber !== undefined) {
        return {
          ok: false,
          reason: "pr-merge-failed",
          locked: input.locked,
          prNumber: result.prNumber,
          // #2807: carry the OBSERVED rejection cause so the terminal names what
          // the PR reported instead of guessing at branch protection.
          ...(result.mergeFailure ? { message: result.mergeFailure.summary } : {}),
        };
      }
      // #2864: a branch that never reached a pull request never conflicted with
      // anything. Route the two no-merge-attempted modes to `infra` so neither
      // can land on a conflict terminal by falling through.
      if (result.reason === "push-failed" || result.reason === "no-pr") {
        return {
          ok: false,
          reason: "infra",
          locked: input.locked,
          prNumber: result.prNumber,
          infraReason:
            result.reason === "push-failed"
              ? "the worker branch could not be force-pushed before the pull request was opened; nothing was merged"
              : "no pull request could be opened or reused for the worker branch; nothing was merged",
        };
      }
      return {
        ok: false,
        reason: "land-failed",
        locked: input.locked,
        prNumber: result.prNumber,
        message: `landing failed at the merge step (underlying reason: ${String((result as { reason?: string }).reason ?? "unmapped")})`,
      };
    };
    if (r.deferred) {
      cleanupDeferred = true;
      const deferred = r.deferred;
      return {
        ok: true,
        locked: input.locked,
        deferred: {
          prNumber: deferred.prNumber,
          waitForCi: deferred.waitForCi,
          run: async (ciAlreadyGreen?: boolean) => {
            try {
              return mapResult(await deferred.run(ciAlreadyGreen));
            } finally {
              await deps.removeRebaseWorktree?.(prepared.dir);
            }
          },
        },
      };
    }
    if (r.ok) return mapResult(r);
    // Route the CI-aware failure modes (#812) distinctly. A failed required check
    // or a still-pending PR is NOT a merge conflict — preserve the open PR and hand
    // it to the `blocked:ci` path rather than the merge-conflict re-run. A push or
    // PR-open failure is infra (#2864); only an unmapped merge-step refusal is
    // left as land-failed.
    // `locked` echoes the session's lock state (#842): the admin-PR path is no
    // longer unlocked-only — lock=X + openPr=true also lands through here.
    return mapResult(r);
  } finally {
    if (!cleanupDeferred) await deps.removeRebaseWorktree?.(prepared.dir);
  }
}

/**
 * Pre-merge rebase step for the PR path (#1006). Provision an isolated worktree
 * on the worker branch and {@link preMergeRebase} it onto the fetched base,
 * force-pushing the result. Returns a failing {@link LandingResult} to abort the
 * landing (parked as blocked:merge-conflict via `pr-conflict`) on a real conflict
 * or the #2481 stale-branch refusal; returns an infra failure when the rebase
 * worktree provisioner is absent or cannot create a checkout, when the base
 * could not be fetched, or when the force-with-lease race outlived its retries
 * (#2864 — none of those is a conflict); returns
 * `undefined` — "proceed to the admin-merge" — only on completed integration.
 * The worktree is always torn down.
 */
function ciSatisfiedValidation(prNumber: number, evidence: CiGreenEvidence): LandingPostMergeValidation {
  return {
    path: "satisfied-by-ci",
    reason: `PR #${prNumber} had fresh green CI evidence from ${evidence.requiredCheckCount} required check(s); local post-merge validation skipped.`,
    prNumber,
    checkCount: evidence.checkCount,
  };
}

async function preparePrRebaseWorktree(
  deps: LandingDeps,
  input: LandingInput,
): Promise<{ ok: true; dir: string } | { ok: false; result: LandingResult }> {
  if (!deps.makeRebaseWorktree) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "infra",
        infraReason: "pre-merge rebase worktree could not be provisioned",
        locked: input.locked,
      },
    };
  }
  const dir = await deps.makeRebaseWorktree(input.branch);
  if (!dir) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "infra",
        infraReason: "pre-merge rebase worktree could not be provisioned",
        locked: input.locked,
      },
    };
  }
  try {
    await deps.landingPhase?.("gate", { step: "rebase", status: "start" });
    const rebased = await preMergeRebase(deps.mergeExec, {
      repo: dir,
      remote: input.remote,
      base: input.base,
      ...(input.intentBaseRef ? { baseRef: input.intentBaseRef } : {}),
      branch: input.branch,
      resolveMechanical: deps.resolveMechanicalConflict,
      resolveAgent: deps.resolveAgentConflict,
      maxAgentResolveAttempts: deps.maxAgentConflictResolveAttempts,
    });
    if (!rebased.ok) {
      await deps.removeRebaseWorktree?.(dir);
      // #2864: `pr-conflict` — and the `blocked:merge-conflict` park behind it —
      // is reserved for a branch that GENUINELY conflicts. A real rebase conflict
      // qualifies and now names its conflicting paths; a `stale-branch` refusal
      // (#2481) qualifies because its whole finding is that replaying this branch
      // would conflict commit by commit, and it carries its own actionable text.
      // A failed fetch and an exhausted force-with-lease race are neither: the
      // rebase never conflicted, so they route to `infra` with the observed
      // reason instead of sending a human to resolve a conflict that never was.
      if (rebased.reason === "conflict" || rebased.reason === "stale-branch") {
        return {
          ok: false,
          result: {
            ok: false,
            reason: "pr-conflict",
            locked: input.locked,
            ...(rebased.message ? { message: rebased.message } : {}),
          },
        };
      }
      return {
        ok: false,
        result: {
          ok: false,
          reason: "infra",
          locked: input.locked,
          infraReason: rebased.message ?? `the pre-merge rebase failed (${rebased.reason ?? "unexplained"}); nothing was merged`,
        },
      };
    }
    await deps.landingPhase?.("gate", { step: "rebase", status: "done" });
    return { ok: true, dir };
  } catch (error) {
    await deps.removeRebaseWorktree?.(dir);
    throw error;
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

  let postMergeValidation: LandingPostMergeValidation | undefined;
  try {
    // Integrate origin/<base> into the detached worktree HEAD (not the primary).
    const integrated = input.intentBaseRef
      ? await deps.mergeExec(["git", "-C", landDir, "reset", "--hard", input.intentBaseRef])
          .then((result) => ({ ok: result.code === 0, action: "fast-forward" as const }))
      : await integrateOrigin(deps.mergeExec, {
          repo: landDir,
          remote: input.remote,
          branch: input.base,
          stillBehind: true,
          inSync: false,
        });
    if (!integrated.ok) return { ok: false, reason: "integrate-failed", locked: input.locked };

    const branchTip = input.validatedBranchTip ?? (await resolveRemoteBranchTip(deps.mergeExec, {
      repo: landDir,
      remote: input.remote,
      branch: input.branch,
    }));
    if (!branchTip) return { ok: false, reason: "land-failed", locked: input.locked };

    // Zero-commit guard: `merge --no-ff` succeeds on an empty branch (a no-op
    // merge commit) and would close the issue with no work delivered; the PR
    // path refuses naturally, so mirror it here as land-failed.
    const baseComparisonRef = input.intentBaseRef ?? `origin/${input.base}`;
    const countRes = await deps.mergeExec([
      "git", "-C", landDir,
      "rev-list", "--count", `${baseComparisonRef}..${branchTip}`,
    ]);
    const commitCount = parseInt(countRes.stdout.trim(), 10);
    if (countRes.code !== 0 || !Number.isInteger(commitCount) || commitCount === 0) {
      return { ok: false, reason: "land-failed", locked: input.locked };
    }

    // Capture the integrated tip from the worktree as the rollback anchor.
    const preMergeSha = (await deps.mergeExec(["git", "-C", landDir, "rev-parse", "--short", "HEAD"])).stdout.trim();
    const validateIntegratedTree = async (): Promise<LandingResult | undefined> => {
      const restageFailure = await restagePiPackages(deps, input, landDir, false);
      if (restageFailure) return restageFailure;
      if (deps.intentGate && !(await deps.intentGate(landDir)).ok) {
        return { ok: false, reason: "intent-finding", locked: input.locked };
      }
      if (!deps.postMergeGate && deps.requirePostMergeValidation) {
        return {
          ok: false,
          reason: "infra",
          locked: input.locked,
          infraReason: "Post-merge validation fallback is not configured for a direct landing that bypassed PR CI.",
        };
      }
      if (!deps.postMergeGate) return undefined;
      await deps.landingPhase?.("gate", { step: "re-validation", status: "start" });
      const gateResult = await deps.postMergeGate(landDir);
      if (!gateResult.ok) return { ok: false, reason: "post-merge-gate", locked: input.locked };
      postMergeValidation = {
        path: "local-rerun",
        reason: "Direct landing bypassed PR CI; local post-merge validation fallback ran.",
      };
      return undefined;
    };

    const fastForwardable = await deps.mergeExec([
      "git", "-C", landDir,
      "merge-base", "--is-ancestor", baseComparisonRef, branchTip,
    ]);
    if (fastForwardable.code === 0) {
      await deps.landingPhase?.("merge", { step: "fast-forward", status: "start" });
      const ff = await deps.mergeExec(["git", "-C", landDir, "merge", "--ff-only", branchTip]);
      if (ff.code !== 0) return { ok: false, reason: "land-failed", locked: input.locked };
      const validationFailure = await validateIntegratedTree();
      if (validationFailure) {
        await deps.mergeExec(["git", "-C", landDir, "reset", "--hard", preMergeSha]);
        return validationFailure;
      }
      const push = await deps.mergeExec([
        "git",
        "-C",
        landDir,
        "push",
        input.remote,
        `HEAD:refs/heads/${input.base}`,
      ]);
      if (push.code !== 0) {
        await deps.mergeExec(["git", "-C", landDir, "reset", "--hard", preMergeSha]);
        return { ok: false, reason: "land-failed", locked: input.locked };
      }
      const mergeSha = (await deps.mergeExec(["git", "-C", landDir, "rev-parse", "--short", "HEAD"])).stdout.trim();
      await promoteFleetTrunkMirror(deps.mergeExec, { gitRepo: input.repoDir, remote: input.remote, target: input.base });
      return {
        ok: true,
        locked: input.locked,
        mergeSha: mergeSha || undefined,
        ...(postMergeValidation ? { postMergeValidation } : {}),
      };
    }

    await deps.landingPhase?.("merge", { step: "merge", status: "start" });
    const merged = await landMerge(deps.mergeExec, {
      repo: landDir,
      remote: input.remote,
      branch: branchTip,
      target: input.base,
      n: input.issue,
      title: input.title,
      mergeTitle: landingMergeTitle(input),
      preMergeSha,
      push: false,
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
        landed = true;
      } else {
        await deps.mergeExec(["git", "-C", landDir, "merge", "--abort"]);
      }
    }
    if (!landed) return { ok: false, reason: "land-failed", locked: input.locked };
    const validationFailure = await validateIntegratedTree();
    if (validationFailure) {
      await deps.mergeExec(["git", "-C", landDir, "reset", "--hard", preMergeSha]);
      return validationFailure;
    }
    const push = await deps.mergeExec([
      "git",
      "-C",
      landDir,
      "push",
      input.remote,
      `HEAD:refs/heads/${input.base}`,
    ]);
    if (push.code !== 0) {
      await deps.mergeExec(["git", "-C", landDir, "reset", "--hard", preMergeSha]);
      return { ok: false, reason: "land-failed", locked: input.locked };
    }

    // The merge commit lives on the worktree's HEAD (and now origin/<base>); the
    // primary HEAD did not advance, so carry the landed sha back for the close.
    const mergeSha = (await deps.mergeExec(["git", "-C", landDir, "rev-parse", "--short", "HEAD"])).stdout.trim();
    await promoteFleetTrunkMirror(deps.mergeExec, { gitRepo: input.repoDir, remote: input.remote, target: input.base });
    return {
      ok: true,
      locked: input.locked,
      mergeSha: mergeSha || undefined,
      ...(postMergeValidation ? { postMergeValidation } : {}),
    };
  } finally {
    await deps.removeLandingWorktree?.(landDir);
  }
}

function decorateReviewWait(deps: LandingDeps, input: LandingInput): WaitForReviewInput | undefined {
  if (!deps.waitForReview) return undefined;
  return {
    ...deps.waitForReview,
    onPoll: async (event) => {
      await deps.waitForReview?.onPoll?.(event);
      await emitLandingWaitHeartbeat(deps, input, event);
    },
  };
}

/**
 * Confirmation budget for a queued merge (#2986). Only the queue path calls it,
 * so it is built unconditionally: the clock and probe bound come from `ciAwait`
 * when one is wired (a test clock stays a test clock), the poll budget is the
 * queue's own, and every poll narrates through the same landing heartbeat the CI
 * wait uses — a wait nobody can see is how a 10-minute hold reads as a hang.
 */
function decorateMergeQueueWait(deps: LandingDeps, input: LandingInput): MergeQueueWaitInput {
  const configured = deps.mergeQueueWait;
  const sleep = configured?.sleep ?? deps.ciAwait?.sleep;
  const probeTimeoutMs = configured?.probeTimeoutMs ?? deps.ciAwait?.probeTimeoutMs;
  return {
    ...(sleep ? { sleep } : {}),
    ...(probeTimeoutMs ? { probeTimeoutMs } : {}),
    ...(configured?.maxPolls !== undefined ? { maxPolls: configured.maxPolls } : {}),
    ...(configured?.intervalMs !== undefined ? { intervalMs: configured.intervalMs } : {}),
    onPoll: async (event) => {
      await configured?.onPoll?.(event);
      // The FIRST probe is the confirmation itself — a synchronous merge answers
      // it immediately and never waited for anything. Narrate a wait only once
      // there is one, so the phase trail of an ordinary landing is unchanged. A
      // probe that FAILED is narrated from the first one (#3160): a confirmation
      // that cannot see is never the ordinary landing this silence was for.
      if (event.attempt > 1 || event.status === "probe-failed") {
        await emitLandingWaitHeartbeat(deps, input, event);
      }
    },
  };
}

function decorateCiAwait(deps: LandingDeps, input: LandingInput): CiAwaitInput | undefined {
  if (!deps.ciAwait) return undefined;
  return {
    ...deps.ciAwait,
    onPoll: async (event) => {
      await deps.ciAwait?.onPoll?.(event);
      await emitLandingWaitHeartbeat(deps, input, event);
    },
  };
}

async function emitLandingWaitHeartbeat(
  deps: LandingDeps,
  input: LandingInput,
  event: LandingWaitPollEvent,
): Promise<void> {
  const step = event.kind === "review" ? "review-wait" : "merge-poll";
  await deps.landingPhase?.("wait", {
    step,
    // #3160: a probe that ANSWERED and one that did not are different states, and
    // publishing both as `poll` is what let a slot burn on a blind probe while
    // every observability surface read it as healthy waiting.
    status: event.status ?? "poll",
    issue: input.issue,
    pr_number: event.prNumber,
    attempt: event.attempt,
    max_polls: event.maxPolls,
    interval_ms: event.intervalMs,
    ...(event.probeTimeoutMs ? { probe_timeout_ms: event.probeTimeoutMs } : {}),
    ...(event.check ? { check: event.check } : {}),
    ...(event.unobservedStreak !== undefined ? { unobserved_probes: event.unobservedStreak } : {}),
    ...(event.probeExitCode !== undefined ? { probe_exit_code: event.probeExitCode } : {}),
    ...(event.probeStderr ? { probe_stderr: event.probeStderr } : {}),
  });
}

