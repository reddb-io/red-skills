// boot — the AFK boot-time sequence, ported from afk.sh's top-level startup
// (lines ~3344-3395: precheck → bootstrap → prune_orphans → cap_issue_attempts
// → prune_completed_attempt_branches → prune_completed_remote_live_branches →
// prune_completed_local_branches → sweep_unblocked → straggler_check), plus the
// SKILL.md "Bootstrap / Hard Preconditions / Orphan Cleanup / Attempt Cap /
// Snapshot Branch Grace Cleanup / Unblock Sweep / Straggler Check" sections.
//
// This module is PURE SEQUENCING. It owns only the ORDER of the boot steps and
// the compose-decider-then-apply pattern: every step composes one of the already
// ported pure deciders (reclaim.ts / branch-cleanup.ts / boot-sweep.ts) and then
// applies the plan's side effects through injected gh/fs/git IO. No real gh, git,
// or fs call lives here — the deciders perform no IO, and `runBoot` performs IO
// only through the injected `deps`.

import {
  decideOrphanFate,
  planAttemptCap,
  resolveAttemptKeep,
  resolveAttemptTtlS,
  type AttemptDir,
  type IssueOpenState,
} from "./reclaim.js";
import {
  planAttemptSnapshotCleanup,
  planLiveBranchCleanup,
  planLocalBranchCleanup,
  branchesToReap,
  resolveSnapshotGraceS,
  type BranchRef,
  type IssueLookup,
} from "./branch-cleanup.js";
import {
  planUnblockSweep,
  planReconcileSweep,
  stragglerCounts,
  shouldWarnStragglers,
  type BlockerStateLookup,
  type StragglerCountLookup,
  type StragglerCounts,
  type UnblockCandidate,
  type ReconcileSweepCandidate,
  type ReconcileSweepPlan,
} from "./boot-sweep.js";

// ---------- precheck (hard preconditions) ----------

/** The hard preconditions the precheck enforces, in afk.sh order. A failure
 * names exactly which precondition tripped so the caller can `die` with a
 * faithful message. Mirrors precheck()'s `die` ladder. */
export type Precondition =
  | "gh-missing"
  | "gh-unauthenticated"
  | "not-a-git-repo"
  | "https-remote-forbidden"
  | "no-main-branch"
  | "not-on-main"
  | "pnpm-missing";

/** Facts the precheck consumes. The caller resolves each via real IO (command
 * lookups, `gh auth status`, `git remote -v`, `git branch --show-current`) and
 * injects them so the precheck stays a pure rule over inputs. */
export interface PrecheckFacts {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  isGitRepo: boolean;
  /** Every remote URL from `git remote -v` (deduped is fine). */
  remoteUrls: readonly string[];
  hasMainBranch: boolean;
  /** `git branch --show-current` in the primary checkout. */
  currentBranch: string;
  /**
   * The currently locked branch from `.red/tmp/branch-lock.yaml`, or
   * `undefined` when the session is unlocked. When set, the precheck gates on
   * `currentBranch === lockedBranch` rather than `currentBranch === "main"`,
   * so a locked checkout is on the lock branch, not main.
   */
  lockedBranch?: string;
  pnpmInstalled: boolean;
}

/** A pass/fail precheck verdict. On failure, `failed` names the precondition and
 * `detail` carries the offending value (e.g. the https URL, the wrong branch).
 * pnpm-missing is a WARNING in afk.sh (`log "warn: …"`), not a `die`; it is
 * surfaced via `warnings` while the verdict still passes. */
export type PrecheckResult =
  | { ok: true; warnings: string[] }
  | { ok: false; failed: Precondition; detail?: string };

/** Evaluate the hard preconditions in afk.sh order. The `die` ladder is:
 *   gh installed → gh authenticated → is-git-repo → no https remote →
 *   local main exists → on main. pnpm is the lone soft check (warn, not die),
 *   evaluated last so a clean pass still reports the warning. */
export function precheck(facts: PrecheckFacts): PrecheckResult {
  if (!facts.ghInstalled) return { ok: false, failed: "gh-missing" };
  if (!facts.ghAuthenticated) return { ok: false, failed: "gh-unauthenticated" };
  if (!facts.isGitRepo) return { ok: false, failed: "not-a-git-repo" };
  for (const url of facts.remoteUrls) {
    if (url.startsWith("https://")) {
      return { ok: false, failed: "https-remote-forbidden", detail: url };
    }
  }
  if (!facts.hasMainBranch) return { ok: false, failed: "no-main-branch" };
  const expectedBranch = facts.lockedBranch ?? "main";
  if (facts.currentBranch !== expectedBranch) {
    return { ok: false, failed: "not-on-main", detail: facts.currentBranch };
  }
  const warnings: string[] = [];
  if (!facts.pnpmInstalled) {
    warnings.push("pnpm not on PATH; feedback loops will be skipped");
  }
  return { ok: true, warnings };
}

// ---------- injected IO ----------

/** Filesystem side effects the boot sequence needs. All are best-effort in
 * afk.sh (`|| true`); the injected impl decides real semantics. */
export interface BootFs {
  /** mkdir -p */
  ensureDir(path: string): Promise<void>;
  /** Append a line to .gitignore iff not already present (grep -qxF guard). */
  ensureGitignoreLine(gitignorePath: string, line: string): Promise<void>;
  /** Write the per-worker `worker.pid` (printf '%s' $$ > worker.pid). */
  writeWorkerPid(pidFile: string, pid: number): Promise<void>;
  /** rm -rf an orphaned attempt dir. */
  removeDir(path: string): Promise<void>;
}

/** gh side effects: label edits and audit/recovery comments. Best-effort. */
export interface BootGh {
  /** gh issue edit --remove-label … --add-label … */
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
  /** gh issue comment --body … */
  comment(issue: number, body: string): Promise<void>;
}

/** git side effects: delete a remote or local branch ref. Best-effort. The
 * scope (remote vs local) is carried by the planner that produced the ref. */
export interface BootGit {
  /** Delete an origin branch (git push origin --delete <branch>). */
  deleteRemoteBranch(branch: string): Promise<void>;
  /** Delete a local branch (git branch -D <branch>). */
  deleteLocalBranch(branch: string): Promise<void>;
}

/** Injected lookups the deciders need. Each mirrors a `gh issue view`/`gh issue
 * list` call in afk.sh, kept out of this module so it stays IO-free. */
export interface BootLookups {
  /** Orphan-cleanup per-dir lookup: issue state + decision label + envelope
   * flag. ghOk=false models a failed `gh issue view`. Mirrors the per-dir gh
   * read inside prune_orphans. */
  orphanState(issue: number): Promise<{
    ghOk: boolean;
    state: IssueOpenState;
    label: string | null;
    envelopePosted: boolean;
  }>;
  /** Branch-cleanup issue-state lookup (branch-cleanup.ts IssueLookup). */
  branchIssue: IssueLookup;
  /** Unblock-sweep blocker-state lookup (boot-sweep.ts BlockerStateLookup). */
  blockerState: BlockerStateLookup;
  /** Straggler per-bucket count lookups (boot-sweep.ts StragglerCountLookup). */
  straggler: StragglerCountLookup;
}

/** Outcome of one boot reconcile run — a coarser view of `ReconcileResult`
 * that only carries what the sweep needs to log and bucket. */
export type ReconcileBootOutcome = "landed" | "parked" | "skipped";

/** A runner the boot reconcile sweep invokes once per planned issue. Fully
 * owns the reconcile call — builds its own `ReconcileDeps` + `ReconcileInput`
 * from closed-over context. When absent, the reconcile sweep is a no-op. */
export type ReconcileBootRunner = (plan: ReconcileSweepPlan) => Promise<{ outcome: ReconcileBootOutcome }>;

/** All injected IO + lookups for the boot run. */
export interface BootDeps {
  fs: BootFs;
  gh: BootGh;
  git: BootGit;
  lookups: BootLookups;
  /** Current epoch seconds (date +%s), injected so the run is deterministic. */
  nowS: number;
  /** Env for the cap/grace resolvers (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** When provided, the reconcile sweep (step 7) validates and lands each
   * owned parked-mechanical branch without re-running the agent. */
  reconcileRunner?: ReconcileBootRunner;
}

// ---------- step inputs ----------

/** Bootstrap paths, pre-resolved by the caller from worker-paths.ts so this
 * module never builds a path itself. */
export interface BootstrapInput {
  /** .red/tmp dir (mkdir -p). */
  tmpDir: string;
  /** .red/state dir (mkdir -p). */
  stateDir: string;
  /** Primary checkout .gitignore path. */
  gitignorePath: string;
  /** Per-worker dir (mkdir -p). */
  workerDir: string;
  /** Per-worker worker.pid path. */
  workerPidFile: string;
  /** This orchestrator's pid ($$). */
  workerPid: number;
}

/** One orphaned attempt dir the caller discovered (dead-worker attempt dir).
 * The caller has already stat'd the dir age and read the state file's issue
 * number / envelope flag; `issue` is null for a dir with no parseable issue
 * number (afk.sh's `-z issue_n` branch). */
export interface OrphanDir {
  path: string;
  /** Issue number from the state file, or null when there is no state file. */
  issue: number | null;
  /** Dir age in seconds (now - mtime). */
  ageS: number;
}

/** Attempt dirs grouped by issue for the cap pass (cap_issue_attempts walks
 * every worker, groups by issue, then caps each group). */
export interface AttemptCapInput {
  byIssue: ReadonlyMap<number, readonly AttemptDir[]>;
}

/** Branch refs for the three branch-cleanup reapers, pre-listed by the caller
 * (ls-remote / git branch). Local refs already exclude checked-out branches. */
export interface BranchCleanupInput {
  snapshotRefs: readonly BranchRef[];
  remoteLiveRefs: readonly BranchRef[];
  localLiveRefs: readonly BranchRef[];
}

/** A `.red/tmp/claims/<N>/` lock dir whose recorded pid the caller already
 * resolved as dead (or absent). The orphan step unconditionally reclaims these
 * — the liveness check happens at discovery, not here. Mirrors the stale
 * claim-lock sweep at the end of prune_orphans. */
export interface StaleClaimDir {
  /** Absolute path to the claim lock dir (`.red/tmp/claims/<N>`). */
  path: string;
}

/** The full set of per-step inputs the caller resolves before `runBoot`. */
export interface BootOptions {
  precheck: PrecheckFacts;
  bootstrap: BootstrapInput;
  orphans: readonly OrphanDir[];
  attemptCap: AttemptCapInput;
  branches: BranchCleanupInput;
  unblockCandidates: readonly UnblockCandidate[];
  /** Pre-cutover flat `.red/tmp/work-NNN` relic dirs whose orchestrator is dead.
   * Unconditionally wiped (#252). The caller has already filtered to dead ones.
   * Optional for back-compat with callers that predate the drain-wipe. */
  legacyWorkDirs?: readonly string[];
  /** `.red/tmp/claims/<N>/` lock dirs whose recorded pid is dead. Reclaimed
   * unconditionally. Optional for back-compat. */
  staleClaimDirs?: readonly StaleClaimDir[];
  /** Open issues labelled `blocked:stalled` or `blocked:crashed` that the
   * reconcile sweep (step 7) will attempt to validate-and-land. When absent the
   * sweep is a no-op. Optional for back-compat. */
  reconcileSweepCandidates?: readonly ReconcileSweepCandidate[];
}

// ---------- per-step results (for parity assertions / logging) ----------

export interface OrphanCleanupResult {
  removed: string[];
  restored: number[];
  /** Dirs kept (keep-until TTL not yet exceeded). */
  kept: string[];
  /** Pre-cutover `work-*` relic dirs wiped this run (#252). */
  legacyWiped: string[];
  /** Stale `claims/<N>` lock dirs reclaimed this run. */
  claimsReleased: string[];
}

export interface AttemptCapResult {
  reclaimed: string[];
}

export interface BranchCleanupResult {
  snapshotReaped: string[];
  remoteLiveReaped: string[];
  localLiveReaped: string[];
}

export interface UnblockSweepResult {
  promoted: number[];
}

export interface StragglerResult {
  counts: StragglerCounts;
  warn: boolean;
}

export interface ReconcileSweepResult {
  /** Issues successfully validated-green and landed without re-running the agent. */
  landed: number[];
  /** Issues re-parked with `blocked:validation` (gate failed or merge conflict). */
  parked: number[];
  /** Issues skipped (no owned branch, not mechanical, or reconcile guard rejected). */
  skipped: number[];
}

/** The boot run outcome. On a precheck failure the sequence short-circuits and
 * only `precheck` is populated (the bash `die` aborts before any other step). */
export interface BootResult {
  precheck: PrecheckResult;
  bootstrap?: { ok: true };
  orphanCleanup?: OrphanCleanupResult;
  attemptCap?: AttemptCapResult;
  branchCleanup?: BranchCleanupResult;
  unblockSweep?: UnblockSweepResult;
  reconcileSweep?: ReconcileSweepResult;
  straggler?: StragglerResult;
}

// ---------- the orchestration ----------

/**
 * Run the AFK boot sequence IN ORDER, composing each pure decider and applying
 * its plan through injected IO. The order is the parity target (afk.sh top-level
 * startup):
 *
 *   1. precheck             — hard preconditions; a failure aborts the run.
 *   2. bootstrap            — ensure .red/tmp + .red/state, gitignore lines,
 *                             per-worker dir + worker.pid (via fs).
 *   3. orphan cleanup       — decideOrphanFate per dead-worker attempt dir, then
 *                             apply remove / restore-and-remove / keep (gh + fs).
 *   4. attempt cap          — planAttemptCap per issue, remove the reclaimed dirs.
 *   5. branch cleanup       — planAttemptSnapshotCleanup, planLiveBranchCleanup,
 *                             planLocalBranchCleanup; delete reaped refs (git).
 *   6. unblock sweep        — planUnblockSweep; edit labels + audit comment (gh).
 *   7. reconcile sweep      — planReconcileSweep; validate-and-land each owned
 *                             parked-mechanical branch without re-running the agent
 *                             (ADR 0055). No-op when reconcileRunner is absent.
 *   8. straggler check      — stragglerCounts + shouldWarnStragglers → warn flag.
 *
 * Steps 3-8 run only after a passing precheck, mirroring the bash `die`/`set -e`
 * abort. The TTY "proceed anyway?" prompt is the caller's: this returns the
 * straggler warn flag, it does not block.
 */
export async function runBoot(deps: BootDeps, options: BootOptions): Promise<BootResult> {
  // ---- 1. precheck ----
  const pre = precheck(options.precheck);
  if (!pre.ok) return { precheck: pre };

  // ---- 2. bootstrap ----
  const b = options.bootstrap;
  await deps.fs.ensureDir(b.tmpDir);
  await deps.fs.ensureDir(b.stateDir);
  await deps.fs.ensureGitignoreLine(b.gitignorePath, ".red/tmp/");
  await deps.fs.ensureGitignoreLine(b.gitignorePath, ".red/state/");
  await deps.fs.ensureDir(b.workerDir);
  await deps.fs.writeWorkerPid(b.workerPidFile, b.workerPid);

  // ---- 3. orphan cleanup ----
  const orphanCleanup = await runOrphanCleanup(deps, options);

  // ---- 4. attempt cap ----
  const attemptCap = await runAttemptCap(deps, options.attemptCap);

  // ---- 5. snapshot grace + live/local branch cleanup ----
  const branchCleanup = await runBranchCleanup(deps, options.branches);

  // ---- 6. unblock sweep ----
  const unblockSweep = await runUnblockSweep(deps, options.unblockCandidates);

  // ---- 7. reconcile sweep (ADR 0055) ----
  const reconcileSweep = await runReconcileSweep(deps, options);

  // ---- 8. straggler check ----
  const straggler = await runStragglerCheck(deps);

  return {
    precheck: pre,
    bootstrap: { ok: true },
    orphanCleanup,
    attemptCap,
    branchCleanup,
    unblockSweep,
    reconcileSweep,
    straggler,
  };
}

/** Step 3: decideOrphanFate per dir, then apply the fate via gh + fs. Mirrors
 * the prune_orphans inner loop:
 *   - keep-until(ttl): remove iff the dir's age already exceeds the TTL; else keep.
 *   - restore-and-remove: edit labels (running → ready-for-agent) + recovery
 *     comment, then rm -rf.
 *   - remove: rm -rf. */
async function runOrphanCleanup(
  deps: BootDeps,
  options: BootOptions,
): Promise<OrphanCleanupResult> {
  const orphans = options.orphans;
  const removed: string[] = [];
  const restored: number[] = [];
  const kept: string[] = [];
  const legacyWiped: string[] = [];
  const claimsReleased: string[] = [];

  // Drain-first cutover (#252): unconditionally wipe any leftover pre-cutover
  // flat `work-*` dir whose orchestrator the caller already found dead. This
  // mirrors the `rm -rf "$TMP_DIR"/work-*/` loop at the top of prune_orphans and
  // runs BEFORE the nested attempt-dir sweep, exactly as bash does.
  for (const path of options.legacyWorkDirs ?? []) {
    await deps.fs.removeDir(path);
    legacyWiped.push(path);
  }

  for (const dir of orphans) {
    const hasStateFile = dir.issue !== null;
    let state: IssueOpenState = "OPEN";
    let label: string | null = null;
    let envelopePosted = false;
    let ghOk = true;

    if (hasStateFile && dir.issue !== null) {
      const r = await deps.lookups.orphanState(dir.issue);
      ghOk = r.ghOk;
      state = r.state;
      label = r.label;
      envelopePosted = r.envelopePosted;
    }

    const fate = decideOrphanFate({
      issueState: state,
      label,
      envelopePosted,
      hasStateFile,
      ageS: dir.ageS,
      ghOk,
    });

    if (fate.kind === "remove") {
      await deps.fs.removeDir(dir.path);
      removed.push(dir.path);
    } else if (fate.kind === "restore-and-remove") {
      await deps.gh.editLabels(dir.issue!, ["running"], ["ready-for-agent"]);
      await deps.gh.comment(
        dir.issue!,
        "🤖 /afk orchestrator died mid-issue; restoring ready-for-agent.",
      );
      restored.push(dir.issue!);
      await deps.fs.removeDir(dir.path);
      removed.push(dir.path);
    } else {
      // keep-until(ttlS): remove only once the dir has aged past the TTL.
      if (dir.ageS > fate.ttlS) {
        await deps.fs.removeDir(dir.path);
        removed.push(dir.path);
      } else {
        kept.push(dir.path);
      }
    }
  }

  // Stale claim-lock sweep: reclaim any `.red/tmp/claims/<N>/` lock whose
  // recorded pid the caller already resolved as dead. Mirrors the trailing
  // `for c in "$TMP_DIR"/claims/*/` loop in prune_orphans. Runs last, after the
  // attempt-dir sweep, so a freshly-released claim is never re-examined.
  for (const claim of options.staleClaimDirs ?? []) {
    await deps.fs.removeDir(claim.path);
    claimsReleased.push(claim.path);
  }

  return { removed, restored, kept, legacyWiped, claimsReleased };
}

/** Step 4: planAttemptCap per issue with the resolved age/count caps, then rm
 * -rf each reclaimed dir. Mirrors cap_issue_attempts. */
async function runAttemptCap(deps: BootDeps, input: AttemptCapInput): Promise<AttemptCapResult> {
  const ttlS = resolveAttemptTtlS(deps.env);
  const keep = resolveAttemptKeep(deps.env);
  const reclaimed: string[] = [];

  for (const [, attempts] of input.byIssue) {
    const reaped = planAttemptCap(attempts, { ttlS, keep, nowS: deps.nowS });
    for (const dir of reaped) {
      await deps.fs.removeDir(dir.path);
      reclaimed.push(dir.path);
    }
  }

  return { reclaimed };
}

/** Step 5: the three branch-cleanup planners, deleting only the reaped refs.
 * Snapshot refs delete remotely (afk-attempts/*), remote-live refs delete
 * remotely (afk/*), local-live refs delete locally. Order mirrors afk.sh:
 * prune_completed_attempt_branches → _remote_live → _local. */
async function runBranchCleanup(
  deps: BootDeps,
  input: BranchCleanupInput,
): Promise<BranchCleanupResult> {
  const graceS = resolveSnapshotGraceS(deps.env);

  const snapshotPlan = planAttemptSnapshotCleanup(
    input.snapshotRefs,
    deps.lookups.branchIssue,
    deps.nowS,
    graceS,
  );
  const snapshotReaped: string[] = [];
  for (const d of branchesToReap(snapshotPlan)) {
    await deps.git.deleteRemoteBranch(d.branch);
    snapshotReaped.push(d.branch);
  }

  const remoteLivePlan = planLiveBranchCleanup(
    input.remoteLiveRefs,
    deps.lookups.branchIssue,
    deps.nowS,
  );
  const remoteLiveReaped: string[] = [];
  for (const d of branchesToReap(remoteLivePlan)) {
    await deps.git.deleteRemoteBranch(d.branch);
    remoteLiveReaped.push(d.branch);
  }

  const localLivePlan = planLocalBranchCleanup(
    input.localLiveRefs,
    deps.lookups.branchIssue,
    deps.nowS,
  );
  const localLiveReaped: string[] = [];
  for (const d of branchesToReap(localLivePlan)) {
    await deps.git.deleteLocalBranch(d.branch);
    localLiveReaped.push(d.branch);
  }

  return { snapshotReaped, remoteLiveReaped, localLiveReaped };
}

/** Step 6: planUnblockSweep, then promote each planned issue (remove its holding
 * `blocked:dependency` label, add ready-for-agent) and post its audit comment.
 * Mirrors sweep_unblocked. */
async function runUnblockSweep(
  deps: BootDeps,
  candidates: readonly UnblockCandidate[],
): Promise<UnblockSweepResult> {
  const plans = await planUnblockSweep(candidates, deps.lookups.blockerState);
  // Resolve each promoted issue's holding label from its candidate label set.
  // The planner only promotes true dependency waits, but keep the fallback
  // defensive for older callers.
  const labelsByIssue = new Map<number, string[]>();
  for (const c of candidates) labelsByIssue.set(c.number, c.labels ?? []);
  const promoted: number[] = [];
  for (const p of plans) {
    const held = labelsByIssue.get(p.number) ?? [];
    const remove = held.includes("blocked:dependency") ? "blocked:dependency" : "ready-for-human";
    await deps.gh.editLabels(p.number, [remove], ["ready-for-agent"]);
    await deps.gh.comment(p.number, p.comment);
    promoted.push(p.number);
  }
  return { promoted };
}

/** Step 7: reconcile sweep (ADR 0055). For each owned parked-mechanical branch,
 * validate-and-land it through the scoped feedback gate WITHOUT re-running the
 * agent. A no-op when no `reconcileRunner` is wired in or no candidates are
 * provided. Sequenced AFTER the unblock sweep so any dependency-promotion from
 * step 6 is already in place before we attempt to land dependents. */
async function runReconcileSweep(deps: BootDeps, options: BootOptions): Promise<ReconcileSweepResult> {
  const result: ReconcileSweepResult = { landed: [], parked: [], skipped: [] };
  if (!deps.reconcileRunner) return result;
  const candidates = options.reconcileSweepCandidates ?? [];
  if (candidates.length === 0) return result;

  // The remote live refs already list every `afk/{worker}/{N}-{slug}` branch
  // on origin — reuse them rather than fetching again. Extract the branch names.
  const remoteBranches = options.branches.remoteLiveRefs.map((r) => r.branch);
  const plans = planReconcileSweep(candidates, remoteBranches);

  for (const plan of plans) {
    try {
      const { outcome } = await deps.reconcileRunner(plan);
      if (outcome === "landed") result.landed.push(plan.number);
      else if (outcome === "parked") result.parked.push(plan.number);
      else result.skipped.push(plan.number);
    } catch {
      // Best-effort: a runner crash skips the issue; the boot sweep is the safety net,
      // not the primary recovery path. The issue remains parked for the next boot.
      result.skipped.push(plan.number);
    }
  }
  return result;
}

/** Step 8: gather the straggler counts and decide whether to warn. The actual
 * TTY "proceed anyway?" prompt is the caller's — this only returns the flag.
 * Mirrors straggler_check. */
async function runStragglerCheck(deps: BootDeps): Promise<StragglerResult> {
  const counts = await stragglerCounts(deps.lookups.straggler);
  return { counts, warn: shouldWarnStragglers(counts) };
}
