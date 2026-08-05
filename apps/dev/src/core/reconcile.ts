// reconcile — the NO-AGENT worker mode (ADR 0055).
//
// For an issue AFK *owns* — one carrying an `afk/{id}/{N}-*` worker branch that
// was parked under a MECHANICAL failure class (`blocked:stalled` /
// `blocked:crashed`, or, inline, a just-fired attempt-progress-guard timeout) —
// reconcile validates the pushed branch and lands it WITHOUT re-running the
// agent. The agent re-run stays recovery.ts; this is the cheaper path that
// catches the common case where the agent finished the work but stalled / exited
// before a final non-committing step, so a complete-and-green branch was left
// parked.
//
// The flow mirrors the DONE path's tail, composing the SAME building blocks — no
// new merge code:
//   1. guard      — mechanical class only (never blocked:spec / a non-mechanical
//                    active `## Current blocker`).
//   2. fetch gate — branchPresent() fetches origin-only branches before the diff.
//   3. commits gate — the branch must carry work (changedFiles vs base).
//   4. runFeedback — the scoped gate is the verdict, the SAME authority the DONE
//                    path trusts.
//   4a. green     → doLanding (landing.ts) + close + drop blocked:*/ready-for-human.
//   4b. red       → ready-for-human with the REAL failing checks (blocked:validation).
//
// PURE SEQUENCING over injected IO: every git/gh/pnpm/fs touch is a port, so the
// whole decision tree is unit-testable with zero subprocesses. Since #2665 the
// EFFECTFUL COLLABORATORS are ports too (landing, the feedback gate, the
// envelope emitter, the remote-branch pair, and the label vocabulary), so the
// module's only runtime imports are pure companions. The nested member shapes
// still mirror `ProcessIssueDeps`, and the two real construction sites
// (`commands/run/reconcile.ts`, `commands/requeue.ts`) spread ONE host wiring
// constant, `HOST_RECONCILE_PORTS` (core/reconcile-ports.ts).

// PORTIFIED IMPORTS: every EFFECTFUL collaborator below is imported `type`-only
// and injected through {@link ReconcileDeps}. The value-imports that used to sit
// here (`doLanding`, `runFeedback` + its four helpers, `emitEnvelope`,
// `pushAttempt`/`deleteRemote`, and the `LABEL_*` constants) are gone, so this
// module carries no runtime edge into the host — the precondition for crossing
// it into the castle engine. The remaining value-imports are PURE companions
// that cross WITH reconcile (`blocker-state`, `boot-sweep` planners,
// `disposition`).
import type {
  buildValidationRecord,
  formatValidationLine,
  runFeedback,
  isInfraFeedbackFailure,
  Exec as PnpmExec,
  FeedbackCommandExec,
  FeedbackCheck,
  PackageLayout,
  RunFeedbackResult,
} from "./feedback.js";
import type { gateScopes } from "./validation-scope.js";
import type { doLanding, LandingFailureReason, LandingPostMergeValidation } from "./landing.js";
import { type CiAwaitInput, type ConflictResolver, type Exec as MergeExec, type WaitForReviewInput } from "./merge.js";
import type { deleteRemote, pushAttempt, GitExec } from "./remote-branch.js";
import { type LandLock } from "./land-lock.js";
import type { emitEnvelope, EmitEnvelopeDeps } from "./envelope-emit.js";
import { parseCurrentBlocker } from "./blocker-state.js";
import { cascadeAuditCommentFor, parseReqLabels, planCloseCascade, promotionLaneNote, type DependentIssue } from "./boot-sweep.js";
import { type RecoveryEnv } from "./recovery.js";
import { dispose } from "./disposition.js";
import { MECHANICAL_BLOCKER_KINDS, parkOrHuman, transitionLabels, type StateTransition } from "./state-transition.js";
import type { AttemptStatus } from "./envelope.js";
import type { HistoryClock } from "./history.js";
import type { Runner } from "../types/runner.js";
import type { TriageLabelConfig } from "./triage-labels.js";

/**
 * The blocked-failure classes reconcile is allowed to act on: MECHANICAL ones
 * that a fresh validate-and-land can clear without a human decision. A stalled or
 * crashed (or merge-conflict) branch may simply carry complete, green work; a
 * `spec` / `validation` / `dependency` block needs a human to change something,
 * so reconcile never auto-lands those.
 */
/**
 * Labels that DISQUALIFY an issue from reconcile outright — the human-decision
 * blocked classes. `blocked:spec` is the boundary the ADR calls out explicitly;
 * `blocked:validation` means a prior gate already failed for a reason a human
 * must resolve, `blocked:dependency` is a dependency wait, and policy/infra
 * blocks need operator action outside the worker branch.
 */
function nonMechanicalLabels(labels: TriageLabelConfig): string[] {
  return [labels.spec, labels.validation, labels.dependency, labels.policy, labels.infra];
}

// ---------- injected IO ----------

/** gh side effects reconcile drives — a strict subset of process-issue's `ProcessGh`. */
export interface ReconcileGh {
  /** gh issue edit --remove-label … --add-label … (returns false on failure). */
  editLabels(issue: number, remove: string[], add: string[]): Promise<boolean>;
  /** Idempotently create a label on the fly (best-effort). */
  ensureLabel(name: string): Promise<void>;
  /** gh issue comment --body … */
  comment(issue: number, body: string): Promise<void>;
  /** gh issue close --reason completed. */
  close(issue: number): Promise<void>;
  /** List open issues carrying `label` — backs the close cascade's dependent lookup. */
  listByLabel(label: string): Promise<{ number: number; labels: string[] }[]>;
  /** Resolve whether issue `n` is CLOSED (a transient failure resolves to false). */
  issueClosed(n: number): Promise<boolean>;
  /** Optional human-facing metadata lookup for rendered dependency refs. */
  issueReference?(issue: number): Promise<{ number: number; title?: string; url?: string } | undefined>;
}

/** git reads/cleanup reconcile needs beyond the merge/remote primitives. */
export interface ReconcileGit {
  /** git -C primary rev-parse --short HEAD after a successful merge. */
  headShortSha(): Promise<string>;
  /** git -C primary branch -d <branch> after landing (best-effort). */
  deleteLocalBranch(branch: string): Promise<{ ok: true } | { ok: false; error: string } | void>;
}

/** filesystem side effects: completion sweep + the optional validation sidecar. */
export interface ReconcileFs {
  /** Remove every attempt dir for a completed issue (completion_sweep_issue). */
  completionSweep(issue: number): Promise<string[]>;
  /** Write the machine-readable validation sidecar (best-effort; optional). */
  writeValidationSidecar?(path: string, lines: string[]): Promise<void>;
}

/** Injected lookups: the branch's changed files + host presence + lock state. */
export interface ReconcileLookups {
  /** Changed files of the worker branch vs the base, for feedback scope resolution. */
  changedFiles(branch: string, base: string): Promise<string[]>;
  /** Optional before/after content evidence for safe root-manifest narrowing. */
  changedFileContents?(
    branch: string,
    base: string,
    file: string,
  ): Promise<{ before: string; after: string } | undefined>;
  /** Confirm the worker branch actually reached the host (optional → assume present). */
  branchPresent?(branch: string): Promise<boolean>;
  /** True when the session is locked to a branch. Since #842 the lock only
   * resolves the base; landing mode is the `worktreeLaunchesPr` flag. */
  isLocked(): Promise<boolean>;
}

/** The landing port: the host's `doLanding`, injected instead of imported. */
export interface ReconcileLandingPort {
  doLanding: typeof doLanding;
}

/** The feedback-gate port: `runFeedback` plus the four helpers reconcile reads
 * around it (scope resolution, the infra-root classifier, and the two
 * validation-record formatters used by the post-merge sidecar line).
 * Scope resolution is `gateScopes`, NOT the raw nearest-package `relevantScopes`:
 * mapping a changed file to its nearest package sends the mandatory changeset to
 * the root, whose `test` script is the whole workspace (#2984). */
export interface ReconcileFeedbackPort {
  runFeedback: typeof runFeedback;
  gateScopes: typeof gateScopes;
  isInfraFeedbackFailure: typeof isInfraFeedbackFailure;
  buildValidationRecord: typeof buildValidationRecord;
  formatValidationLine: typeof formatValidationLine;
}

/**
 * The envelope-emitter port. Named `envelopeEmit`, NOT `envelope`, because
 * {@link ReconcileDeps.envelope} already names the emitter's injected IO
 * (poster / marker writer / posted writer / git) — the function and the IO it
 * consumes are two different ports and both are needed.
 */
export interface ReconcileEnvelopeEmitPort {
  emitEnvelope: typeof emitEnvelope;
}

/**
 * The remote-branch port. Named `remoteBranch`, NOT `remoteGit`, because
 * {@link ReconcileDeps.remoteGit} already names the `GitExec` these two
 * functions (and `doLanding`) execute through — portifying the functions does
 * not remove the executor reconcile must still thread into the landing deps.
 */
export interface ReconcileRemoteBranchPort {
  pushAttempt: typeof pushAttempt;
  deleteRemote: typeof deleteRemote;
}

function remoteTrackingBaseRef(remote: string, base: string): string {
  if (/^[0-9a-f]{7,40}$/i.test(base) || base.startsWith("refs/") || base.startsWith(`${remote}/`)) {
    return base;
  }
  return `${remote}/${base}`;
}

/**
 * All injected IO for one reconcile. Deliberately a structural SUBSET of
 * `ProcessIssueDeps` (same nested member shapes) so process-issue can pass its
 * own `deps` (augmented with the landing `fireHook`) directly. Tests build a
 * minimal object matching exactly this interface.
 */
export interface ReconcileDeps {
  gh: ReconcileGh;
  git: ReconcileGit;
  fs: ReconcileFs;
  lookups: ReconcileLookups;
  /** The landing implementation (`core/landing.ts` on this host). */
  landing: ReconcileLandingPort;
  /** The feedback gate + its four helpers (`core/feedback.ts` on this host). */
  feedback: ReconcileFeedbackPort;
  /** The envelope emitter (`core/envelope-emit.ts` on this host). */
  envelopeEmit: ReconcileEnvelopeEmitPort;
  /** The remote-branch push/delete pair (`core/remote-branch.ts` on this host). */
  remoteBranch: ReconcileRemoteBranchPort;
  /** The triage-label vocabulary, injected as config (castle convention). */
  labels: TriageLabelConfig;
  /** The TYPE labels this repo declares HUMAN-ONLY (`afk.labels.hitl_types`,
   * #2966). A close cascade routes a dependent carrying one to the human lane.
   * Absent → none declared, and every promotion keeps the agent lane. */
  hitlTypes?: readonly string[];
  /** git executor for merge.ts (integrateOrigin / landMerge / landPr). */
  mergeExec: MergeExec;
  /** git executor for remote-branch.ts (pushAttempt / deleteRemote). */
  remoteGit: GitExec;
  /** pnpm executor for the feedback gate. */
  pnpm: PnpmExec;
  /** Declared replacement for script discovery; `undefined` preserves discovery. */
  feedbackCommands?: readonly string[];
  /** Shell executor for declared feedback commands. */
  feedbackCommandExec?: FeedbackCommandExec;
  /** Package layout probe for feedback scope resolution. */
  layout: PackageLayout;
  /**
   * Directory probe proving a declared validation worktree exists (#3041).
   * Absent → the gate resolves its target but never refuses; it cannot claim a
   * directory is gone without having looked.
   */
  dirExists?: (dir: string) => boolean;
  /** One-shot inner-agent merge-conflict resolver for the DIRECT land (optional). */
  conflictResolver?: ConflictResolver;
  /**
   * Opt-in mechanical-conflict resolver for the PR path's pre-merge rebase
   * (issue #1095): auto-resolve whitespace-only / closed-allowlist conflicts
   * when re-landing a `blocked:merge-conflict` branch on fresh trunk, instead of
   * parking. Threaded straight into {@link doLanding}'s `resolveMechanicalConflict`.
   * Absent → any rebase conflict parks `blocked:merge-conflict` as before.
   */
  resolveMechanicalConflict?: (repo: string) => Promise<boolean>;
  /** Agent conflict resolver for semantic rebase conflicts after mechanical declines (#2075). */
  resolveAgentConflict?: (repo: string) => Promise<boolean>;
  /** Small attempt budget for `resolveAgentConflict`; defaults in merge.ts. */
  maxAgentConflictResolveAttempts?: number;
  /**
   * Landing-mode flag, decoupled from the lock (#842). `true`/undefined → land via
   * an admin-merged PR; `false` → a direct merge. Threaded from process-issue's
   * deps so a reconcile-land honours the same `afk.worktree_launches_pull_request`
   * posture as the DONE-path landing.
   */
  worktreeLaunchesPr?: boolean;
  /**
   * Isolated landing-worktree provisioner/teardown for the DIRECT land (#572):
   * the direct merge/push/rollback runs in a throwaway worktree, never the
   * primary checkout. Threaded from process-issue's deps; absent → the direct
   * land is refused rather than mutating the primary.
   */
  makeLandingWorktree?(base: string): Promise<string | null>;
  removeLandingWorktree?(dir: string): Promise<void>;
  /**
   * Isolated worker-branch worktree provisioner/teardown for the PR path's
   * pre-merge rebase (#1006). Threaded from process-issue's deps; absent → the
   * rebase is skipped and the PR lands as before.
   */
  makeRebaseWorktree?(branch: string): Promise<string | null>;
  removeRebaseWorktree?(dir: string): Promise<void>;
  /** Opt-in advisory-review wait for the admin-PR landing (optional). */
  waitForReview?: WaitForReviewInput;
  /** Opt-in CI-aware merge wait for the admin-PR landing (optional). */
  ciAwait?: CiAwaitInput;
  /** Global AFK land-lock (#1337), threaded into no-agent relands too. */
  landLock?: LandLock;
  /** Envelope-emit IO (poster / marker writer / posted writer / git push). */
  envelope: EmitEnvelopeDeps;
  /**
   * Fire a landing lifecycle hook (pre_merge / post_merge), threaded from
   * process-issue's dispatcher so reconcile lands with the SAME hooks the DONE
   * path fires. Optional → when absent the landing runs with no merge hooks.
   */
  fireHook?(name: "pre_merge" | "post_merge", context: string): Promise<boolean>;
  /** Clock: epoch seconds. */
  nowEpoch(): number;
  /** Append one plain line to the iteration's afk.log. */
  appendIterLog(line: string): void;
  /**
   * Advance the caller's worker-presence stage as reconcile crosses its
   * validate → land phases (issue #1306). Optional — the autonomous AFK caller
   * leaves it unset (its stage is driven by the agent-event sink); the
   * `/requeue --adopt-branch` presence lane wires it to update its short-lived
   * `origin="requeue"` presence state file so the live-worker surfaces show
   * `validating` then `landing`. Best-effort at the call site — a failed update
   * never fails the reconcile.
   */
  markStage?(stage: "validating" | "landing"): Promise<void>;
  /** History ledger path + clock for the terminal envelope (optional). */
  historyPath?: string;
  historyClock?: HistoryClock;
  /**
   * AFK runner improvement: env slice for the recovery policy lookup, threaded
   * from the CLI's `process.env` so the bounded-retry cap on infra failures
   * (default 2) is overridable per-deployment via RED_AFK_RETRY_VALIDATION_INFRA.
   * When absent the caps resolve to their defaults exactly like process-issue's
   * `recoveryEnv` does. Reconciliation infra-retry would otherwise have no
   * signal that an attempt is over the cap.
   */
  recoveryEnv?: RecoveryEnv;
}

/** Static per-reconcile inputs the caller resolves before `reconcile`. */
export interface ReconcileInput {
  issue: number;
  title: string;
  body: string;
  /** The issue's CURRENT label set (routing + blocked + domain labels). */
  labels: string[];
  /** The worker branch to validate-and-land (`afk/{id}/{N}-{slug}`). */
  branch: string;
  /** Resolved base branch (lock > pin > main). */
  base: string;
  /**
   * The configured Trunk (`plugins.dev.trunk`, default `main`; ADR 0083) — the
   * focal branch the primary checkout tracks. doLanding verifies the LOCAL trunk
   * has not diverged from `origin/<trunk>` before integrating the branch (#1018);
   * distinct from {@link base}, which may be a lock/pin branch.
   */
  trunk: string;
  repo: string;
  repoDir: string;
  remote: string;
  workerId: string;
  attempt: number;
  attemptDir: string;
  runner: Runner;
  /**
   * Trust the PRIOR green validation and SKIP re-running the scoped feedback
   * gate (issue #1095). Set by the merge-conflict auto-reconcile route: the
   * branch already validated green BEFORE the land-time trunk conflict, so the
   * no-agent reland rebases onto fresh trunk (via doLanding's #1006 pre-merge
   * rebase) and lands through the PR — whose CI is the merge gate — WITHOUT
   * re-running the full local suite. Default undefined/false → the standard
   * reconcile runs the scoped gate as its verdict, unchanged.
   */
  trustPriorValidation?: boolean;
}

// ---------- result ----------

export type ReconcileSkipReason =
  | "not-mechanical"
  | "active-blocker"
  | "no-commits"
  | "branch-absent"
  | "already-closed"
  /** Another worker held the land-lock past the wait timeout — a BACKOFF, so the
   * branch is left exactly as it was for the next sweep (#2864). */
  | "land-lock-timeout";

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
    default:
      return "infra";
  }
}

export type ReconcileResult =
  | { outcome: "landed"; mergeSha: string; locked: boolean; posted: boolean }
  | {
      outcome: "parked";
      // AFK runner improvement: `feedback-failed-infra` is a new parked reason
      // for an INFRA-rooted feedback failure (worktree/submodule/pnpm/OOM)
      // that the `validation-infra` recovery policy re-queues (or escalates
      // when the cap is exhausted). The original `feedback-failed` keeps its
      // semantic meaning (the worker's code really has a problem, page human).
      // The landing refusals each park under their own reason (#2864), so
      // `merge-conflict` names a branch that really conflicts and nothing else.
      reason: ReconcileParkReason;
      posted: boolean;
    }
  | { outcome: "skipped"; reason: ReconcileSkipReason };

// ---------- the orchestration ----------

/**
 * Validate a parked-or-just-stalled worker branch and land it WITHOUT re-running
 * the agent (ADR 0055). Returns:
 *   - `landed`  — the scoped gate passed and the branch merged + the issue closed.
 *   - `parked`  — the gate (or the land) failed; routed to ready-for-human with
 *                 the real failing checks.
 *   - `skipped` — the issue is not a mechanical reconcile candidate, or the branch
 *                 carries no work; the caller proceeds with its own routing.
 */
export async function reconcile(deps: ReconcileDeps, input: ReconcileInput): Promise<ReconcileResult> {
  const { issue, branch, base, labels, body } = input;
  const baseRef = remoteTrackingBaseRef(input.remote, base);

  // ---- 1. guard: mechanical class only ----
  const disqualifier = mechanicalDisqualifier(labels, body, deps.labels);
  if (disqualifier) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (${disqualifier}) — not a mechanical reconcile candidate; leaving routing to the caller.`,
    );
    return { outcome: "skipped", reason: disqualifier };
  }

  // ---- 1b. pre-fetch safety push ----
  // Before checking whether the branch is present on the remote, push any
  // LOCAL-ONLY commits. A worker that hit a continuous-push failure may have
  // COMMITTED work that never reached origin — the branch exists locally (in
  // .git/refs/heads/) but the remote is at main's HEAD; pushing here makes those
  // commits visible to the fetch gate and changedFiles(). ADR 0103: only
  // committed work is preserved — a dirty worktree is never salvage-committed
  // here. Best-effort: a failed push is logged and reconcile falls through to the
  // normal fetch gate (which then skips with "branch-absent" / "no-commits").
  const safetyPush = await deps.remoteBranch.pushAttempt(deps.remoteGit, input.repoDir, branch, branch);
  if (!safetyPush.ok) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: pre-fetch push failed (${safetyPush.warn ?? "unknown"}) — continuing to fetch gate`,
    );
  }

  // ---- 2. fetch gate: materialize origin-only branches before the commits diff ----
  // branchPresent() fetches from origin on a local miss, so a branch force-pushed
  // by a now-dead worker (present on origin, absent locally) is available for the
  // three-dot diff below. Without this fetch, changedFiles() would silently return
  // [] for the missing ref, triggering a false skipped:no-commits.
  if (deps.lookups.branchPresent && !(await deps.lookups.branchPresent(branch))) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (branch-absent) — \`${branch}\` is not present on the host; cannot validate.`,
    );
    return { outcome: "skipped", reason: "branch-absent" };
  }

  const validatedBranchTip = await resolveFreshRemoteBranchTip(deps.mergeExec, {
    repoDir: input.repoDir,
    remote: input.remote,
    branch,
  });
  if (!validatedBranchTip) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (branch-absent) — \`${branch}\` did not resolve to a fetched \`${input.remote}/${branch}\` tip.`,
    );
    return { outcome: "skipped", reason: "branch-absent" };
  }
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: validating fetched \`${input.remote}/${branch}\` tip \`${validatedBranchTip.slice(0, 12)}\`.`,
  );

  // ---- 3. commits gate: the branch must carry work ----
  // changedFiles() is a three-dot diff that returns [] for an EMPTY branch.
  // The fetch gate above guarantees the branch is local, so [] here means
  // genuinely no commits — not a missing ref.
  const changedFiles = await deps.lookups.changedFiles(branch, baseRef);
  if (changedFiles.length === 0) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (no-commits) — \`${branch}\` carries no work vs \`${base}\`.`,
    );
    return { outcome: "skipped", reason: "no-commits" };
  }
  const rootPackageJson = changedFiles.includes("package.json")
    ? await deps.lookups.changedFileContents?.(branch, baseRef, "package.json").catch(() => undefined)
    : undefined;
  const feedbackScopes = deps.feedback.gateScopes(
    deps.layout,
    changedFiles,
    rootPackageJson ? { rootPackageJson } : undefined,
  );

  // ---- 4. feedback gate (the verdict — SAME authority as the DONE path) ----
  // The merge-conflict reland route (#1095) trusts the prior green validation
  // and skips the gate; every other reland runs it exactly as the DONE path does.
  const startedEpoch = deps.nowEpoch();
  // Presence stage (#1306): the adopt-landing lane's row now shows `validating`.
  await deps.markStage?.("validating").catch(() => {});
  let feedback: RunFeedbackResult;
  if (input.trustPriorValidation) {
    // #1095 merge-conflict reland: the branch validated green before the
    // land-time trunk conflict, so the scoped gate is NOT re-run here — the
    // opened PR's CI is the merge gate. Stand in a trusted-green result so the
    // envelope / close cascade below read a coherent (empty) validation summary.
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: merge-conflict reland — trusting the prior green validation; NOT re-running the local suite (the PR's CI gates the merge).`,
    );
    feedback = {
      ok: true,
      checks: [],
      sidecar: ["merge-conflict reland: prior validation trusted; local suite not re-run (#1095)"],
      baselineInconclusive: [],
      quarantined: [],
    };
  } else {
    // AFK runner improvement: pass `base` as the `baselineWorktree` so the
    // comparison probe can classify a branch failure that also reproduces on
    // the base as `inconclusive` rather than the branch's fault (#2380).
    // Mirrors the DONE path.
    feedback = await deps.feedback.runFeedback(deps.pnpm, {
      worktree: branch,
      scopes: feedbackScopes,
      layout: deps.layout,
      now: deps.nowEpoch,
      baselineWorktree: input.base,
      ...(deps.feedbackCommands === undefined
        ? {}
        : { commands: deps.feedbackCommands, commandExec: deps.feedbackCommandExec }),
    });
    await writeValidationSidecar(deps, input.attemptDir, feedback.sidecar);

    // ---- 4b. RED → ready-for-human with the real failing checks ----
    // AFK runner improvement: an INFRA-rooted failure (worktree / submodule /
    // pnpm install / OOM) is NOT a parked branch — it is a flaky environment
    // and the recovery policy should retry it (bounded, default cap 2). Skip
    // the park-to-human path; let `routeRecovery` re-queue or escalate the
    // same way the DONE path does, so the green branch isn't stranded.
    if (!feedback.ok && deps.feedback.isInfraFeedbackFailure(feedback)) {
      return await parkInfraRetry(deps, input, feedback, startedEpoch);
    }
    if (!feedback.ok) {
      return await park(deps, input, feedback, startedEpoch);
    }
  }

  // ---- 4a-pre. re-verify the issue is still open immediately before landing ----
  // The candidate list and the claim window can go stale between selection and
  // here: a concurrent worker or a human may have closed the issue. Landing +
  // closing an already-closed issue churns labels on a closed thread (#568), so
  // bail before doLanding when it is no longer open.
  if (await deps.gh.issueClosed(issue)) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (already-closed) — issue closed since selection; not landing.`,
    );
    return { outcome: "skipped", reason: "already-closed" };
  }

  // ---- 4a. GREEN → land via the existing landing path, then close ----
  // Landing mode is the `worktreeLaunchesPr` flag (default true), decoupled from
  // the lock which only resolved `base` (#842); `locked` is read for the echo.
  const locked = await deps.lookups.isLocked();
  const openPr = deps.worktreeLaunchesPr !== false;
  // Presence stage (#1306): the adopt-landing lane's row now shows `landing`.
  await deps.markStage?.("landing").catch(() => {});
  const landing = await deps.landing.doLanding(
    {
      mergeExec: deps.mergeExec,
      remoteGit: deps.remoteGit,
      fireHook: deps.fireHook ?? (async () => true),
      conflictResolver: deps.conflictResolver,
      resolveMechanicalConflict: deps.resolveMechanicalConflict,
      resolveAgentConflict: deps.resolveAgentConflict,
      maxAgentConflictResolveAttempts: deps.maxAgentConflictResolveAttempts,
      waitForReview: deps.waitForReview,
      ciAwait: deps.ciAwait,
      landLock: deps.landLock,
      makeLandingWorktree: deps.makeLandingWorktree,
      removeLandingWorktree: deps.removeLandingWorktree,
      makeRebaseWorktree: deps.makeRebaseWorktree,
      removeRebaseWorktree: deps.removeRebaseWorktree,
      postMergeGate: async (mergedTreeDir) => {
        const mergedFeedback = await deps.feedback.runFeedback(deps.pnpm, {
          worktree: mergedTreeDir,
          // A provisioned DIRECTORY, not a branch token (#3041) — a missing one
          // is an infrastructure error, never a red validation verdict.
          worktreeKind: "checkout",
          ...(deps.dirExists === undefined ? {} : { dirExists: deps.dirExists }),
          scopes: feedbackScopes,
          layout: deps.layout,
          now: deps.nowEpoch,
          baselineWorktree: input.base,
          ...(deps.feedbackCommands === undefined
            ? {}
            : { commands: deps.feedbackCommands, commandExec: deps.feedbackCommandExec }),
        });
        if (!mergedFeedback.ok) {
          await writeValidationSidecar(deps, input.attemptDir, mergedFeedback.sidecar);
          return { ok: false };
        }
        feedback = mergedFeedback;
        await writeValidationSidecar(deps, input.attemptDir, mergedFeedback.sidecar);
        return { ok: true };
      },
      requirePostMergeValidation: true,
    },
    {
      openPr,
      locked,
      repo: input.repo,
      repoDir: input.repoDir,
      remote: input.remote,
      branch,
      validatedBranchTip,
      base,
      trunk: input.trunk,
      issue,
      title: input.title,
      labels: input.labels,
    },
    {
      preMerge: () => landingHookContext(input, branch, { mergeBase: input.base }),
      postMerge: (mergeSha?: string) => landingHookContext(input, branch, { mergeSha }),
    },
  );
  if (!landing.ok) {
    if (landing.reason === "infra") {
      return await parkInfraLanding(
        deps,
        input,
        landing.infraReason ?? "landing infrastructure precondition failed",
        startedEpoch,
      );
    }
    // #2864: park under the terminal the REFUSAL names, never a blanket
    // merge-conflict. A land-lock timeout is a backoff — leave the branch as it
    // is and let the next sweep take it.
    const parkReason = routeLandingFailure(landing.reason);
    if (parkReason === null) {
      deps.appendIterLog(
        `🤖 /afk reconcile #${issue}: skipped (land-lock-timeout) — another worker holds the land-lock; \`${branch}\` is untouched for the next sweep.`,
      );
      return { outcome: "skipped", reason: "land-lock-timeout" };
    }
    return await parkLandingRefusal(deps, input, parkReason, landing.message, startedEpoch);
  }

  if (landing.postMergeValidation) {
    feedback = {
      ...feedback,
      sidecar: [...feedback.sidecar, postMergeValidationSidecarLine(deps, landing.postMergeValidation)],
    };
    await writeValidationSidecar(deps, input.attemptDir, feedback.sidecar);
  }

  // ---- close: done envelope → gh close + drop routing/blocked labels → cleanup ----
  // Prefer the sha doLanding captured (the locked landing runs in an isolated
  // worktree, #572, so the primary HEAD no longer advances); fall back to the
  // primary HEAD for the unlocked path.
  const mergeSha = landing.mergeSha ?? (await deps.git.headShortSha());
  const durationS = deps.nowEpoch() - startedEpoch;
  const posted = await emitDone(deps, input, mergeSha, durationS, feedback.sidecar);
  await deps.gh.close(issue);
  await deps.gh.editLabels(issue, landDropLabels(labels, deps.labels), []);
  await deps.remoteBranch.deleteRemote(deps.remoteGit, input.repoDir, branch);
  await deps.git.deleteLocalBranch(branch);
  await deps.fs.completionSweep(issue);
  await runCloseCascade(deps, issue);
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: \`${branch}\` tip \`${validatedBranchTip.slice(0, 12)}\` validated green and landed without re-running the agent (merge \`${mergeSha}\`).`,
  );
  return { outcome: "landed", mergeSha, locked, posted };
}

async function resolveFreshRemoteBranchTip(
  exec: MergeExec,
  input: { repoDir: string; remote: string; branch: string },
): Promise<string | undefined> {
  const fetched = await exec(["git", "-C", input.repoDir, "fetch", input.remote, input.branch, "--quiet"]);
  if (fetched.code !== 0) return undefined;
  const resolved = await exec([
    "git", "-C", input.repoDir,
    "rev-parse", "--verify", "--quiet", `${input.remote}/${input.branch}`,
  ]);
  const tip = resolved.stdout.trim();
  return resolved.code === 0 && tip !== "" ? tip : undefined;
}

// ---------- guard ----------

/**
 * The reason an issue is NOT a mechanical reconcile candidate, or null when it
 * is. Disqualified when it carries a human-decision blocked label
 * (`blocked:spec` / `blocked:validation` / `blocked:dependency` /
 * `blocked:policy` / `blocked:infra`), or an ACTIVE `## Current blocker` whose
 * kind is not mechanical (stalled / crashed / merge-conflict). A stalled /
 * crashed blocker is mechanical and therefore allowed — it is exactly the parked
 * state reconcile exists to clear.
 */
export function mechanicalDisqualifier(
  labels: string[],
  body: string,
  config: TriageLabelConfig,
): "not-mechanical" | "active-blocker" | null {
  const nonMechanical = nonMechanicalLabels(config);
  if (labels.some((l) => nonMechanical.includes(l))) return "not-mechanical";
  const blocker = parseCurrentBlocker(body);
  if (blocker && !MECHANICAL_BLOCKER_KINDS.has(blocker.kind)) return "active-blocker";
  return null;
}

/** Routing/blocked labels to shed on a successful land — domain labels (type:,
 * priority:, slice:, req:) are left untouched. */
function landDropLabels(labels: string[], config: TriageLabelConfig): string[] {
  return labels.filter(
    (l) =>
      l === config.running ||
      l === config.human ||
      l === config.ready ||
      l.startsWith(config.blockedPrefix),
  );
}

// ---------- red / merge-conflict parking ----------

/**
 * RED gate → ready-for-human carrying the REAL failing checks. Sheds any
 * mechanical `blocked:*` reason + the routing labels, adds
 * `ready-for-human` + `blocked:validation` (the now-known reason), comments the
 * failing-check summaries, and emits the feedback failure envelope.
 */
async function park(
  deps: ReconcileDeps,
  input: ReconcileInput,
  feedback: RunFeedbackResult,
  startedEpoch: number,
): Promise<ReconcileResult> {
  const { issue, labels } = input;
  const failed = feedback.checks.filter((c) => c.status === "failed");
  // The composer owns the typed blocked label + envelope status for this terminal
  // (core/disposition); the transition planner owns the label delta (#2663) and
  // reconcile keeps only its context-specific failing-checks comment.
  const disp = dispose("feedback-failed", input.attempt, deps.recoveryEnv ?? {});
  const typed = disp.typedLabel!;
  await deps.gh.ensureLabel(typed);
  await applyReconcileTransition(deps, issue, labels, parkOrHuman(typed));
  await deps.gh.comment(
    issue,
    `🤖 /afk reconcile validated parked branch \`${input.branch}\` WITHOUT re-running the agent — validation FAILED, so it was not landed:\n${formatFailingChecks(failed)}`,
  );
  const validationSummary = feedback.sidecar.join("\n");
  const posted = await emitFailure(deps, input, disp.envelopeStatus, startedEpoch, {
    validation: validationSummary,
  });
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: \`${input.branch}\` failed re-validation — parked to ready-for-human with the failing checks.`,
  );
  return { outcome: "parked", reason: "feedback-failed", posted };
}

/**
 * AFK runner improvement: a feedback-failed with an INFRA root cause
 * (worktree / submodule / pnpm install / OOM / ENOENT — the gate's environment
 * is broken, NOT the worker code) is a FLAKY environment, not a parked branch.
 * Apply the same bounded-retry policy the DONE path uses: retry while the
 * `validation-infra` cap (default 2) has budget left, escalate to a human once
 * the budget is exhausted. The branch is preserved on the remote (deleteRemote
 * is NOT called) so the next attempt can re-validate it.
 */
async function parkInfraRetry(
  deps: ReconcileDeps,
  input: ReconcileInput,
  feedback: RunFeedbackResult,
  startedEpoch: number,
): Promise<ReconcileResult> {
  const { issue, labels } = input;
  // The composer owns the retry-vs-escalate decision, the cap, the typed label,
  // and the envelope status (core/disposition, validation-infra is bounded-
  // recoverable). reconcile keeps its context-specific label removals + the
  // failing-checks comments.
  const disp = dispose("feedback-failed-infra", input.attempt, deps.recoveryEnv ?? {});
  const typed = disp.typedLabel!;
  const cap = disp.cap ?? 2;
  const failed = feedback.checks.filter((c) => c.status === "failed");
  const failedSummary = formatFailingChecks(failed);

  if (disp.decision === "retry") {
    // Re-queue: the planner drops `running` (already shed by the claim step)
    // + every stale `blocked:*` reason (including the now-misleading
    // `blocked:validation-infra` from a prior attempt) and adds
    // `ready-for-agent` so the issue resurfaces. The branch is left on the
    // remote (no deleteRemote) — the next attempt can re-validate it.
    await applyReconcileTransition(deps, issue, labels, { kind: "queue" });
    await deps.gh.comment(
      issue,
      `🤖 /afk reconcile #${issue}: feedback gate failed for an INFRA reason (worktree/submodule/pnpm install/OOM) on \`${input.branch}\` — auto-retrying (attempt ${input.attempt}/${cap}):\n${failedSummary}`,
    );
    const posted = await emitFailure(deps, input, disp.envelopeStatus, startedEpoch, {
      validation: feedback.sidecar.join("\n"),
    });
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: \`${input.branch}\` failed re-validation for INFRA reason (attempt ${input.attempt}/${cap}) — re-queued to ready-for-agent.`,
    );
    return { outcome: "parked", reason: "feedback-failed-infra", posted };
  }

  // Cap exhausted → escalate to ready-for-human (page a maintainer). The
  // infra flake is sticky; the issue needs a human to look at the gate setup.
  await deps.gh.ensureLabel(typed);
  await applyReconcileTransition(deps, issue, labels, parkOrHuman(disp.typedLabel));
  await deps.gh.comment(
    issue,
    `🤖 /afk reconcile #${issue}: feedback gate INFRA failure retry budget exhausted (attempt ${input.attempt}/${cap}) on \`${input.branch}\` — escalating to ready-for-human:\n${failedSummary}`,
  );
  const posted = await emitFailure(deps, input, disp.envelopeStatus, startedEpoch, {
    validation: feedback.sidecar.join("\n"),
  });
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: \`${input.branch}\` failed re-validation for INFRA reason and the retry budget is exhausted (attempt ${input.attempt}/${cap}) — escalating.`,
  );
  return { outcome: "parked", reason: "feedback-failed-infra", posted };
}

/** Landing infrastructure failed before integration could safely run. This is
 * not a merge conflict and must not consume the merge-conflict recovery budget. */
async function parkInfraLanding(
  deps: ReconcileDeps,
  input: ReconcileInput,
  reason: string,
  startedEpoch: number,
): Promise<ReconcileResult> {
  const { issue, labels } = input;
  const disp = dispose("infra", input.attempt, deps.recoveryEnv ?? {});
  const typed = disp.typedLabel ?? deps.labels.infra;
  await deps.gh.ensureLabel(typed);
  await applyReconcileTransition(deps, issue, labels, parkOrHuman(typed));
  const posted = await emitFailure(deps, input, disp.envelopeStatus, startedEpoch, {
    log: `reconcile land infra failure: ${reason}`,
  });
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: \`${input.branch}\` passed validation but landing infrastructure failed (${reason}) — escalating.`,
  );
  return { outcome: "parked", reason: "infra", posted };
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

/**
 * The land path refused the validated branch → park under the terminal that
 * NAMES the refusal (#2864).
 *
 * Every non-infra refusal used to park `blocked:merge-conflict`, so a branch
 * that was merely behind its base sent a human to resolve a conflict that did
 * not exist. The composer owns the typed label + envelope status; reconcile
 * ALWAYS parks a failed land to a human here (the land path already exhausted
 * its own gates), so it uses the typed label and status but not the composer's
 * retry-vs-escalate decision.
 */
async function parkLandingRefusal(
  deps: ReconcileDeps,
  input: ReconcileInput,
  reason: ReconcileParkReason,
  observed: string | undefined,
  startedEpoch: number,
): Promise<ReconcileResult> {
  const { issue, labels } = input;
  const summary = landingRefusalSummary(reason, observed);
  const disp = dispose(reason, input.attempt, deps.recoveryEnv ?? {});
  const typed = disp.typedLabel;
  if (typed) await deps.gh.ensureLabel(typed);
  await applyReconcileTransition(deps, issue, labels, parkOrHuman(typed));
  const posted = await emitFailure(deps, input, disp.envelopeStatus, startedEpoch, {
    log: `reconcile land failed (${reason}): ${summary}`,
  });
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: \`${input.branch}\` validated green but the land was refused — ${summary} — parked to ready-for-human as ${typed ?? reason}.`,
  );
  return { outcome: "parked", reason, posted };
}

/**
 * Apply one reconcile-lane state transition through the transition planner
 * (ADR 0122 rule 5, #2663). It replaces the hand-rolled `parkDropLabels` /
 * disp-set edits: the plan is computed over the issue's REAL label set, so it
 * sheds every stale state role, the `running` projection, and every stale
 * `blocked:*` reason in ONE edit — and proves the one-state-role invariant
 * BEFORE the tracker call rather than trusting a filter to have covered it.
 *
 * A refusal is logged and left unapplied: a refused plan means the REQUEST is
 * malformed, and half-applying it is exactly the failure mode the planner
 * exists to prevent. Refusal is unreachable for the park transitions (a park
 * always lands on exactly `ready-for-human`); the re-queue can refuse when
 * `req:*` edges survive, which the mechanical-disqualifier gate already
 * excludes from this lane.
 */
async function applyReconcileTransition(
  deps: ReconcileDeps,
  issue: number,
  labels: string[],
  transition: StateTransition,
  hitlTypes: readonly string[] = [],
): Promise<boolean> {
  const result = await transitionLabels(
    (remove, add) => deps.gh.editLabels(issue, remove, add),
    labels,
    transition,
    hitlTypes,
  );
  if (result.applied) return result.ok;
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: transition "${transition.kind}" refused by the state planner (${result.reason}) — labels left untouched.`,
  );
  return false;
}

function formatFailingChecks(failed: FeedbackCheck[]): string {
  if (failed.length === 0) return "- (no per-check detail captured)";
  return failed.map((c) => `- \`${c.name}\`: ${c.record.summary ?? "command exited non-zero"}`).join("\n");
}

// ---------- envelope emission (reused from envelope-emit) ----------

async function emitDone(
  deps: ReconcileDeps,
  input: ReconcileInput,
  mergeSha: string,
  durationS: number,
  validationSidecar: string[],
): Promise<boolean> {
  const result = await deps.envelopeEmit.emitEnvelope(deps.envelope, {
    status: "done",
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: input.branch,
    attempt: input.attempt,
    mergeSha,
    diff: "merged",
    sections: { validation: validationSidecar.join("\n") },
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner, merge_sha: mergeSha },
  });
  return result.posted;
}

async function emitFailure(
  deps: ReconcileDeps,
  input: ReconcileInput,
  status: AttemptStatus,
  startedEpoch: number,
  sections: { validation?: string; log?: string },
): Promise<boolean> {
  const result = await deps.envelopeEmit.emitEnvelope(deps.envelope, {
    status,
    issue: input.issue,
    worker: input.workerId,
    durationS: deps.nowEpoch() - startedEpoch,
    branch: input.branch,
    attempt: input.attempt,
    diff: "not-landed",
    repo: input.repo,
    repoDir: input.repoDir,
    worktreeRel: input.attemptDir,
    diffstat: "",
    sections,
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner },
  });
  return result.posted;
}

// ---------- validation sidecar ----------

async function writeValidationSidecar(deps: ReconcileDeps, attemptDir: string, lines: string[]): Promise<void> {
  if (!deps.fs.writeValidationSidecar) return;
  if (lines.length === 0) return;
  try {
    await deps.fs.writeValidationSidecar(`${attemptDir}/validation.jsonl`, lines);
  } catch {
    // best-effort: the sidecar is a Memory optimisation; never fail the reconcile.
  }
}

function postMergeValidationSidecarLine(deps: ReconcileDeps, validation: LandingPostMergeValidation): string {
  return deps.feedback.formatValidationLine(deps.feedback.buildValidationRecord({
    name: `post-merge:${validation.path}`,
    status: "passed",
    summary: validation.reason,
  }));
}

// ---------- close cascade (event-driven auto-unblock) ----------

/**
 * Re-evaluate the dependents of a just-closed issue and promote any whose
 * `req:*` dependencies are now ALL closed. The SAME cascade process-issue runs on
 * its DONE close — composed from boot-sweep's pure planner — so a reconcile-landed
 * issue unblocks its dependents exactly like an agent-landed one. Entirely
 * best-effort: any gh failure is swallowed (the boot Unblock Sweep is the net).
 */
async function runCloseCascade(deps: ReconcileDeps, closedIssue: number): Promise<void> {
  try {
    const dependentsRaw = await deps.gh.listByLabel(`req:${closedIssue}`);
    if (dependentsRaw.length === 0) return;

    const closedCache = new Map<number, boolean>([[closedIssue, true]]);
    const resolveClosed = async (n: number): Promise<boolean> => {
      const cached = closedCache.get(n);
      if (cached !== undefined) return cached;
      const closed = await deps.gh.issueClosed(n);
      closedCache.set(n, closed);
      return closed;
    };

    const dependents: DependentIssue[] = [];
    for (const dep of dependentsRaw) {
      const reqIds = parseReqLabels(dep.labels);
      const reqs: { n: number; closed: boolean }[] = [];
      for (const n of reqIds) reqs.push({ n, closed: await resolveClosed(n) });
      dependents.push({ number: dep.number, reqs });
    }

    // The promotion runs through the transition planner: `promote` consumes the
    // `req:*` edges, sheds `blocked:dependency` (and any other stale reason),
    // and lands on `ready-for-agent` in ONE proven edit (#2663). The planner
    // needs the dependent's CURRENT labels, which the listing already carried.
    const labelsOf = new Map(dependentsRaw.map((d) => [d.number, d.labels]));
    for (const dep of dependents) dep.labels = labelsOf.get(dep.number);
    // The dependent's own type decides the lane (#2966): a HUMAN-ONLY Ticket
    // parks for its human rather than rejoining the autonomous queue.
    const hitlTypes = deps.hitlTypes ?? [];
    for (const p of planCloseCascade(closedIssue, dependents, hitlTypes)) {
      await applyReconcileTransition(
        deps,
        p.number,
        labelsOf.get(p.number) ?? [deps.labels.dependency, ...p.reqLabels],
        { kind: "promote" },
        hitlTypes,
      );
      const reqs = p.refs.map((ref) => Number(ref.slice(1))).filter((n) => Number.isFinite(n));
      await deps.gh.comment(
        p.number,
        (await cascadeAuditCommentFor(reqs, deps.gh.issueReference)) +
          promotionLaneNote(p.lane, p.hitlTypes, hitlTypes),
      );
    }
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk reconcile close-cascade for #${closedIssue} failed (best-effort; boot sweep will retry): ${String(err)}`,
    );
  }
}

// ---------- hook context ----------

/** The pre_merge / post_merge hook context JSON, matching process-issue's shape. */
function landingHookContext(
  input: ReconcileInput,
  branch: string,
  opts: { mergeBase?: string; mergeSha?: string } = {},
): string {
  const out: Record<string, unknown> = {
    issue: { number: input.issue, title: input.title },
    workspace: input.repoDir,
    branch,
  };
  if (opts.mergeBase) out.merge_base = opts.mergeBase;
  if (opts.mergeSha) out.merge_commit = { sha: opts.mergeSha, short: opts.mergeSha.slice(0, 7) };
  return JSON.stringify(out);
}
