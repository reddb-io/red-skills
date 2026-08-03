import { doLanding, type LandingDeps, type LandingInput, type LandingHookContexts } from "../src/core/landing.js";
import { createFileLandLock, type LandLock, type LandLockDeps, type LandLockFs } from "../src/core/land-lock.js";

export { doLanding, createFileLandLock, type LandLock, type LandLockDeps, type LandLockFs };
import type { ExecResult } from "../src/core/merge.js";
import { readsPull, restPullBody } from "./support/gh-rest-fixtures.js";

// doLanding owns the flag-toggled landing (ADR 0030 amended by #842 / 0031):
// push → pre_merge → integrate → land → (direct conflict self-resolve) →
// post_merge. Before this extraction the sequence was only exercised through
// process-issue's integration tests; here it has a direct surface. Every git/gh
// touch is the injected mergeExec / remoteGit fake, and the merge hooks are the
// injected fireHook.
//
// Landing MODE is the `openPr` flag (afk.worktree_launches_pull_request), NOT the
// lock — the lock only resolves `base` (#842). The "lock × flag matrix" suite
// below covers all four cells; the legacy path suites default the flag to the
// pre-#842 coupling (locked → direct, unlocked → PR) so they keep their meaning.

// The isolated landing worktree the DIRECT path runs every git op in (#572). The
// primary checkout (`/repo`) is never `git -C`'d destructively — see the
// "primary checkout is sacred" suite below.
export const WT = "/wt";

// The isolated worker-branch worktree the PR path's pre-merge rebase runs in
// (#1006). Distinct from WT so a test can assert the fetch/rebase/force-push
// never `git -C`'d the primary checkout (`/repo`).
export const RWT = "/rwt";
export const DEFAULT_BRANCH_TIP = "feedfacecafebeef";

export interface Harness {
  deps: LandingDeps;
  input: LandingInput;
  hooks: LandingHookContexts;
  mergeCalls: string[][];
  pushedAttempt: string[][];
  firedHooks: string[];
  removedWorktrees: string[];
  removedRebaseWorktrees: string[];
  /** cwds the conflict resolver was dispatched in. */
  resolverCwds: string[];
  /** dirs the post-merge gate was invoked with (#1335). */
  postMergeGateDirs: string[];
  /** dirs the mechanical rebase-conflict resolver was invoked with (#2072). */
  mechanicalResolverDirs: string[];
  /** dirs the agent rebase-conflict resolver was invoked with (#2075). */
  agentResolverDirs: string[];
  /** landing visibility phase transitions published for statusline (#1427). */
  landingPhases: string[];
  /** landing heartbeat events with per-step detail (#2433). */
  landingEvents: { phase: string; detail: Record<string, unknown> }[];
}

export interface Opts {
  locked?: boolean;
  /**
   * Make the primary checkout's working tree DIRTY (`git status --porcelain`
   * returns a modified path). Drives the fastForwardLocalTarget WIP guard: a
   * dirty primary must skip the post-merge promotion (ADR 0083 §2's #1019
   * safety intent), even though §2's literal no-write rule is relaxed.
   */
  dirtyPrimary?: boolean;
  /**
   * Landing MODE (#842), decoupled from the lock. Defaults to `!locked` so the
   * pre-#842 coupling is preserved for the existing path tests (locked → direct,
   * unlocked → PR); the (lock × flag) matrix suite below sets it explicitly to
   * exercise the two newly-reachable cells.
   */
  openPr?: boolean;
  /** Abort one of the merge hooks. */
  abortHook?: "pre_merge" | "post_merge";
  /** rc the integrate fast-forward returns (1 → integrate fails). */
  integrateCode?: number;
  /** rc the locked `merge --no-ff` returns (1 → conflict). */
  mergeNoFfCode?: number;
  /** "resolve" → resolver clears the conflict; "fail" → leaves it; undefined → no resolver. */
  conflictResolve?: "resolve" | "fail";
  /** rc the post-resolve `push <remote> HEAD:refs/heads/<base>` returns (1 → reject → reset). */
  resolvePushCode?: number;
  /** Enable the opt-in advisory-review wait (afk.merge.wait_for_review). */
  waitForReview?: boolean;
  /** Enable the opt-in CI-aware merge (#812) and drive the `pr view` verdict. */
  ciAware?: "merge" | "ci-failed" | "ci-pending" | "conflict" | "skipped";
  /** rc the final `gh pr merge` returns (1 → PR exists but merge is rejected). */
  prMergeCode?: number;
  /** Make the landing-worktree provisioner fail (returns null). */
  noWorktree?: boolean;
  /** Commits ahead of base returned by `git rev-list --count`. Default 3. */
  commitCount?: number;
  /** Resolved origin/<branch> tip used by stale-local-ref regressions. */
  branchTip?: string;
  /** Enable the PR-path pre-merge rebase provisioner (#1006). Defaults true for PR landings (#1212). */
  rebaseWorktree?: boolean;
  /** The rebase provisioner returns null (could not provision → rebase skipped). */
  noRebaseWorktree?: boolean;
  /** rc the rebase in the rebase worktree returns (1 → real conflict → abort). */
  rebaseCode?: number;
  /** First-attempt PR-path mechanical rebase-conflict resolver result. */
  mechanicalConflictResolve?: "resolve" | "decline";
  /** First-attempt PR-path agent rebase-conflict resolver result. */
  agentConflictResolve?: "resolve" | "decline";
  /** rc the force-with-lease push returns (1 → reject on every attempt). */
  rebasePushCode?: number;
  /**
   * ADR 0083 landing precondition (#1018): drive the local-trunk-vs-origin check.
   *   - "diverged" → `merge-base --is-ancestor` exits 1 (local trunk carries
   *     commits origin does not) → the landing aborts with `trunk-diverged`.
   *   - "absent"   → `rev-parse --verify refs/heads/<trunk>` exits 1 (the primary
   *     never checked the trunk out) → the precondition proceeds.
   * Unset → the local trunk reads as an ancestor of origin → proceeds.
   */
  trunk?: "diverged" | "absent";
  /** Issue labels used to derive the landing-created conventional merge title. */
  labels?: string[];
  /** Changed files used for fallback conventional-title classification (#1373). */
  changedFiles?: string[];
  /** Force the admin PR path to create a PR instead of reusing an open one. */
  createPr?: boolean;
  /**
   * Post-merge-integration gate (#1335). When true, wire `deps.postMergeGate`
   * so the test can assert which dirs the gate was called with. When false or
   * absent, `postMergeGate` is absent → the gate is skipped (backwards-compat).
   */
  postMergeGate?: boolean;
  /** When true AND `postMergeGate` is wired, the gate returns `{ ok: false }`. */
  postMergeGateFails?: boolean;
  /** Require post-merge validation even when the postMergeGate dep is absent. */
  requirePostMergeValidation?: boolean;
  /**
   * Global land-lock (#1337). Present → wire `deps.landLock` with this port, so a
   * test can observe when the landing entered and left the critical section.
   * Absent → the dep is unwired and the land runs unserialized (pre-#1337).
   */
  landLock?: LandLock;
  /** Native merge queue (#1337): set `input.nativeMergeQueue`. */
  nativeMergeQueue?: boolean;
  /**
   * Model an ENQUEUE rather than a synchronous merge (#2986). Absent → the
   * confirmation's first probe already reports a MERGED pull request.
   *   - `merged`   → queued first, then merged.
   *   - `rejected` → queued first, then the auto-merge request disappears.
   *   - `pending`  → still queued for the whole (test-sized) budget.
   */
  queueOutcome?: "merged" | "rejected" | "pending";
  /** Explicit PR-resolved callback abort used by adversarial correction before merge. */
  onPrResolvedAbort?: boolean;
  /**
   * Stale-branch landing guard (#2481). Present → the rebase worktree answers a
   * fork point, this many commits ahead of it, and a fork commit this many hours
   * old, so `preMergeRebase` can evaluate the refusal. Absent → the fork probe
   * answers nothing, the guard is unmeasurable, and the landing behaves as before.
   */
  staleBranch?: { ahead: number; ageHours: number };
  /**
   * rc the landing's opening `pushAttempt` returns (#2811). Non-zero → the push
   * exits non-zero, and `remoteTipSha`/`localTipSha` decide whether the
   * verification proves the branch reached origin anyway.
   */
  pushAttemptCode?: number;
  /** sha `ls-remote origin refs/heads/<branch>` answers (#2811 verification). */
  remoteTipSha?: string;
  /** sha the local `rev-parse` answers (#2811 verification). */
  localTipSha?: string;
}

export function harness(opts: Opts = {}): Harness {
  const mergeCalls: string[][] = [];
  const pushedAttempt: string[][] = [];
  const firedHooks: string[] = [];
  const removedWorktrees: string[] = [];
  const removedRebaseWorktrees: string[] = [];
  const resolverCwds: string[] = [];
  const postMergeGateDirs: string[] = [];
  const mechanicalResolverDirs: string[] = [];
  const agentResolverDirs: string[] = [];
  const landingPhases: string[] = [];
  const landingEvents: { phase: string; detail: Record<string, unknown> }[] = [];
  let mergeResolved = false;
  let prCreated = false;
  let queuePolls = 0;

  const deps: LandingDeps = {
    mergeExec: async (argv): Promise<ExecResult> => {
      mergeCalls.push(argv);
      const j = argv.join(" ");
      // #2481 stale-branch guard probes, answered only in the rebase worktree so
      // no other path's git surface changes shape.
      if (opts.staleBranch && j.startsWith(`git -C ${RWT} `)) {
        if (j === `git -C ${RWT} merge-base origin/main HEAD`) {
          return { code: 0, stdout: "forksha\n", stderr: "" };
        }
        if (j.includes("rev-list") && j.includes("--count")) {
          return { code: 0, stdout: `${opts.staleBranch.ahead}\n`, stderr: "" };
        }
        if (j.includes("log -1 --format=%ct")) {
          const forkEpochS = Math.floor(Date.now() / 1000) - opts.staleBranch.ageHours * 3600;
          return { code: 0, stdout: `${forkEpochS}\n`, stderr: "" };
        }
      }
      // Legacy primary-promotion probes. They stay here so tests can fail if a
      // path accidentally reintroduces the old primary fast-forward.
      if (j.includes("symbolic-ref --short HEAD")) {
        return { code: 0, stdout: `${input.base}\n`, stderr: "" };
      }
      if (j.includes("status --porcelain")) {
        return { code: 0, stdout: opts.dirtyPrimary ? " M apps/dev/src/x.ts\n" : "", stderr: "" };
      }
      if (j.includes("merge-base --is-ancestor origin/")) {
        return { code: opts.branchTip ? 0 : 1, stdout: "", stderr: "" };
      }
      // ADR 0083 landing precondition (#1018), against the primary checkout.
      // `merge-base --is-ancestor local origin/<trunk>` — exit 1 = diverged.
      if (j.includes("merge-base --is-ancestor")) {
        return { code: opts.trunk === "diverged" ? 1 : 0, stdout: "", stderr: "" };
      }
      // The primary's LOCAL trunk ref probe — exit 1 = absent (proceed).
      if (j.includes("rev-parse --verify --quiet --short refs/heads/")) {
        return opts.trunk === "absent"
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: "1oca1sha\n", stderr: "" };
      }
      // origin/<trunk> SHA, captured for the divergence envelope.
      if (j.includes("rev-parse --short origin/")) {
        return { code: 0, stdout: "0r1g1nsha\n", stderr: "" };
      }
      if (j === `git -C /repo rev-parse --verify --quiet origin/${input.base}`) {
        return { code: 0, stdout: "0r1g1nsha\n", stderr: "" };
      }
      if (j === `git -C /repo rev-parse origin/${input.base}`) {
        return { code: 0, stdout: "0r1g1nsha\n", stderr: "" };
      }
      // #1006 pre-merge rebase, in the isolated worker-branch worktree (RWT).
      if (j === `git -C ${RWT} rebase origin/main`) {
        return { code: opts.rebaseCode ?? 0, stdout: "", stderr: "" };
      }
      if (j.startsWith(`git -C ${RWT} push origin HEAD:refs/heads/`) && j.includes("--force-with-lease")) {
        return { code: opts.rebasePushCode ?? 0, stdout: "", stderr: "" };
      }
      if (argv.includes("pr") && argv.includes("list")) {
        if (opts.createPr && !prCreated) return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      if (argv.includes("pr") && argv.includes("create")) {
        prCreated = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      // The rollback anchor + landed sha the locked worktree path reads.
      if (j.includes("rev-parse --short HEAD")) {
        return { code: 0, stdout: "abc1234\n", stderr: "" };
      }
      if (j.includes("rev-list") && j.includes("--count")) {
        return { code: 0, stdout: `${opts.commitCount ?? 3}\n`, stderr: "" };
      }
      if (j.includes("rev-parse --verify --quiet origin/afk/wAAAA/9-fix-the-thing")) {
        return { code: 0, stdout: `${opts.branchTip ?? DEFAULT_BRANCH_TIP}\n`, stderr: "" };
      }
      if (opts.integrateCode !== undefined && j.includes("merge --ff-only")) {
        return { code: opts.integrateCode, stdout: "", stderr: "" };
      }
      if (opts.mergeNoFfCode !== undefined && j.includes("merge --no-ff")) {
        return { code: opts.mergeNoFfCode, stdout: "", stderr: "" };
      }
      // The post-resolve push of the locked branch (from the worktree HEAD).
      if (opts.resolvePushCode !== undefined && j === `git -C ${WT} push origin HEAD:refs/heads/main`) {
        return { code: opts.resolvePushCode, stdout: "", stderr: "" };
      }
      if (j.includes("diff --name-only --diff-filter=U")) {
        const unresolved = opts.conflictResolve === "fail" || !mergeResolved;
        return { code: 0, stdout: unresolved ? "src/x.ts\n" : "", stderr: "" };
      }
      if (j.includes("rev-parse -q --verify MERGE_HEAD")) {
        const pending = opts.conflictResolve === "fail" || !mergeResolved;
        return { code: pending ? 0 : 1, stdout: "", stderr: "" };
      }
      if (j.includes("pr checks")) {
        return { code: 0, stdout: JSON.stringify([{ name: "CodeRabbit", state: "SUCCESS" }]), stderr: "" };
      }
      // #2986 post-enqueue merge confirmation. The queue accepts the PR on the
      // first poll (auto-merge request present, not yet merged) and resolves on
      // the second, so a landing that skipped the wait cannot pass by accident.
      // The confirmation reads one pull request by number, so it routes to REST
      // (#3094) and answers a REST body.
      if (readsPull(argv)) {
        queuePolls += 1;
        const accepted = restPullBody({ state: "OPEN", mergedAt: null, mergeCommitOid: null, autoMerge: true });
        // Unset → the forge merged on the spot and the very first confirmation
        // says so. A test that opts in models the ENQUEUE: accepted first, then
        // its outcome, so the landing has something to actually wait through.
        const outcome = opts.queueOutcome;
        if (outcome !== undefined && (queuePolls === 1 || outcome === "pending")) {
          return { code: 0, stdout: JSON.stringify(accepted), stderr: "" };
        }
        if (outcome === "rejected") {
          return {
            code: 0,
            stdout: JSON.stringify(
              restPullBody({ state: "OPEN", mergedAt: null, mergeCommitOid: null, autoMerge: false }),
            ),
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify(
            restPullBody({
              state: "MERGED",
              mergedAt: "2026-08-01T00:00:00Z",
              mergeCommitOid: "abc1234",
              autoMerge: false,
            }),
          ),
          stderr: "",
        };
      }
      if (j.includes("pr view") && j.includes("mergeCommit")) {
        // #2261: doLanding reads the landed commit SHA via
        // `gh pr view <n> --json mergeCommit --jq .mergeCommit.oid`. Return the
        // canonical fixture SHA so the unlocked admin-PR path reports the real
        // merge commit, matching the locked path's rev-parse fixture.
        return { code: 0, stdout: "abc1234\n", stderr: "" };
      }
      if (j.includes("pr view")) {
        // #812 CI-aware poll: drive the mergeStateStatus + rollup per opts.ciAware.
        const map: Record<string, { mergeStateStatus: string; mergeable: string; baseRefOid: string; statusCheckRollup: unknown[] }> = {
          merge: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", baseRefOid: "0r1g1nsha", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }] },
          "ci-failed": { mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", baseRefOid: "0r1g1nsha", statusCheckRollup: [{ name: "ci", state: "FAILURE" }] },
          "ci-pending": { mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", baseRefOid: "0r1g1nsha", statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS" }] },
          conflict: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING", baseRefOid: "0r1g1nsha", statusCheckRollup: [] },
          skipped: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", baseRefOid: "0r1g1nsha", statusCheckRollup: [{ name: "ci", conclusion: "SKIPPED" }] },
        };
        return { code: 0, stdout: JSON.stringify(map[opts.ciAware ?? "merge"]), stderr: "" };
      }
      if (j.includes("api repos/o/r/branches/main/protection/required_status_checks/contexts")) {
        return { code: 0, stdout: JSON.stringify(["ci"]), stderr: "" };
      }
      if (j.includes("pr merge")) {
        return { code: opts.prMergeCode ?? 0, stdout: "", stderr: opts.prMergeCode ? "merge rejected" : "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    remoteGit: async (argv) => {
      const j = argv.join(" ");
      // #2811 push verification reads — recorded, but not counted as pushes.
      if (j.includes("ls-remote")) {
        return { code: 0, stdout: opts.remoteTipSha ? `${opts.remoteTipSha}\trefs/heads/x\n` : "", stderr: "" };
      }
      if (j.includes("rev-parse")) {
        return { code: opts.localTipSha ? 0 : 1, stdout: opts.localTipSha ?? "", stderr: "" };
      }
      pushedAttempt.push(argv);
      return { code: opts.pushAttemptCode ?? 0, stdout: "", stderr: "" };
    },
    async fireHook(name) {
      firedHooks.push(name);
      return opts.abortHook !== name;
    },
    conflictResolver: opts.conflictResolve
      ? async (_prompt, cwd) => {
          resolverCwds.push(cwd);
          if (opts.conflictResolve === "resolve") mergeResolved = true;
        }
      : undefined,
    waitForReview: opts.waitForReview ? { check: "CodeRabbit", sleep: async () => {} } : undefined,
    ciAwait: opts.ciAware ? { sleep: async () => {}, maxPolls: 2 } : undefined,
    // #2986: always injected so no queue landing under test can reach a real timer.
    mergeQueueWait: { sleep: async () => {}, maxPolls: 3 },
    makeLandingWorktree: async () => (opts.noWorktree ? null : WT),
    removeLandingWorktree: async (dir) => {
      removedWorktrees.push(dir);
    },
    // #1212: PR-path fresh-base integration is mandatory, so the harness wires a
    // working rebase worktree by default. Tests that exercise infra provisioning
    // failures opt out explicitly.
    makeRebaseWorktree: opts.rebaseWorktree === false ? undefined : async () => (opts.noRebaseWorktree ? null : RWT),
    removeRebaseWorktree: opts.rebaseWorktree !== false
      ? async (dir) => {
          removedRebaseWorktrees.push(dir);
        }
      : undefined,
    resolveMechanicalConflict: opts.mechanicalConflictResolve
      ? async (dir) => {
          mechanicalResolverDirs.push(dir);
          return opts.mechanicalConflictResolve === "resolve";
        }
      : undefined,
    resolveAgentConflict: opts.agentConflictResolve
      ? async (dir) => {
          agentResolverDirs.push(dir);
          return opts.agentConflictResolve === "resolve";
        }
      : undefined,
    onPrResolved: opts.onPrResolvedAbort ? async () => "abort" : undefined,
    // Post-merge-integration gate (#1335): only wired when the test opts in.
    postMergeGate: opts.postMergeGate
      ? async (dir) => {
          postMergeGateDirs.push(dir);
          return { ok: !opts.postMergeGateFails };
        }
      : undefined,
    requirePostMergeValidation: opts.requirePostMergeValidation,
    // Global land-lock (#1337): only wired when the test opts in.
    landLock: opts.landLock,
    landingPhase: async (phase, detail = {}) => {
      if (landingPhases[landingPhases.length - 1] !== phase || detail.step === "re-validation") {
        landingPhases.push(phase);
      }
      landingEvents.push({ phase, detail });
    },
  };

  const input: LandingInput = {
    locked: opts.locked ?? false,
    // Default the mode to the pre-#842 coupling (locked → direct, unlocked → PR)
    // unless the test pins the flag to exercise a decoupled cell.
    openPr: opts.openPr ?? !(opts.locked ?? false),
    repo: "o/r",
    repoDir: "/repo",
    remote: "origin",
    branch: "afk/wAAAA/9-fix-the-thing",
    base: "main",
    // ADR 0083 landing precondition (#1018): the configured Trunk. The default
    // permissive mergeExec below returns code 0 for the precondition's
    // fetch/rev-parse/is-ancestor calls, so the local trunk reads as an ancestor
    // → the precondition proceeds and the existing path assertions are unchanged.
    trunk: "main",
    issue: 9,
    title: "Fix the thing",
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.changedFiles ? { changedFiles: opts.changedFiles } : {}),
    nativeMergeQueue: opts.nativeMergeQueue,
  };

  const hooks: LandingHookContexts = {
    preMerge: () => "pre_merge-ctx",
    postMerge: () => "post_merge-ctx",
  };

  return {
    deps,
    input,
    hooks,
    mergeCalls,
    pushedAttempt,
    firedHooks,
    removedWorktrees,
    removedRebaseWorktrees,
    resolverCwds,
    postMergeGateDirs,
    mechanicalResolverDirs,
    agentResolverDirs,
    landingPhases,
    landingEvents,
  };
}

export const joined = (calls: string[][]): string[] => calls.map((c) => c.join(" "));
