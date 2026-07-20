import { parseRunnerFlag, detectRunner } from "../../core/runner-detection.js";
import { callerProcessTreeNative } from "../../runtime/caller-process.js";
import {
  runModeForCandidate,
  type SessionContext,
  type SessionIssueTemplate,
  type SelectionFilter,
  type IssueCandidate,
} from "../../core/session.js";
import { genWorkerId } from "../../core/session.js";
import { runBoot, type BootDeps, type BootOptions, type BootResult, type BootstrapInput, type ReconcileBootRunner } from "../../core/boot.js";
import { reconcile, type ReconcileDeps, type ReconcileInput } from "../../core/reconcile.js";
import { resolveBase } from "../../core/base-resolver.js";
import { findOwnedBranch, type ReconcileSweepPlan } from "../../core/boot-sweep.js";
import {
  classifyConflictedFileKind,
  partitionConflicts,
  type ConflictFinding,
} from "../../core/merge-conflict-reconcile.js";
import { processIssue, type ProcessIssueDeps, type ProcessIssueInput, type ProcessIssueResult } from "../../core/process-issue.js";
import { passExitBarrier, passTerminalBarrier } from "../../core/exit-barrier.js";
import {
  toMemoryPayload,
  resolveMemoryCli,
  type AttemptRecordPayload,
} from "../../core/attempt-record.js";
import { isRunner, type Runner } from "../../types/runner.js";
import {
  afkPaths,
  collectPrecheckFacts,
  collectBootOptions,
  collectMonitorInputs,
  buildBootDeps,
  buildMinimalBootDeps,
  makeRunAgent,
  resolveRepoContext,
  resolveRunSettings,
  type RepoContext,
  type AfkPaths,
} from "../../runtime/wire.js";
import type { LaneIdleStallConfig } from "../../core/lane-idle-reaper.js";
import { workerDir as workerDirPath, workerPidFile } from "../../core/worker-paths.js";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { pluginEnabledInConfig } from "@reddb-io/shared/plugin-gate.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import { Output } from "@reddb-io/red-castle";
import * as ghx from "../../runtime/gh.js";
import * as gitx from "../../runtime/git.js";
import * as fsx from "../../runtime/fs.js";
import { migrateLegacyDevPaths } from "../../runtime/red-path-migration.js";
import { configFile } from "@reddb-io/shared/red-paths.js";
import type { GhContext } from "../../runtime/gh.js";
import { buildReviewGh } from "../../runtime/review-gh.js";
import type { GitContext } from "../../runtime/git.js";
import { execTool, type ExecFn } from "../../runtime/exec.js";
import { getConfig, loadConfig, readBackpressure, readPostAttemptFormat, readValidationResourceBudget, resolveTier, resolveCiTimeoutSeconds } from "../../core/config.js";
import {
  makeExtractAdversarialReview,
  resolveAdversarialReviewConfig,
  type AdversarialReviewFindings,
} from "../../core/adversarial-review.js";
import { reviewFindingsSchema } from "../../core/review-extract.js";
import { defaultSandcastleDeps } from "../../core/execution.js";
import { parseTrustPolicy, resolveActorTrust } from "../../core/trust-gate.js";
import { resolveNotesLoopConfig } from "../../core/notes-loop.js";
import { resolveOutputShapingConfig } from "../../core/output-shaping.js";
import {
  classifyIssue,
  resolveReviewGate,
  type IssueClassificationMetadata,
} from "../../core/issue-classifier.js";
import { toAgentRunner } from "../../core/runner-spec.js";
import { LABEL_READY_FOR_REVIEW, LABEL_GO_LANE, LABEL_SCOUT_LANE, LABEL_MERGE_CONFLICT } from "../../core/triage-labels.js";
import { GO_KIND, GO_ORIGIN } from "../../core/go.js";
import { SCOUT_ORIGIN, SCOUT_WORKERS_SEGMENT } from "../../core/scout.js";
import { resolveHooks, type HookName } from "../../core/hook-config.js";
import { dispatchHooks } from "../../core/hook-dispatcher.js";
import { runCastleWorkerDrain, type CastleSessionHookName, type CastleWorkerDrainDeps } from "@reddb-io/red-castle/engine";
import { attemptLedgerContext, formatAttemptContext, highestAttempt, type AttemptDirEntry } from "../../core/attempt-ledger.js";
import { isValidWorkerId, WORKER_NAMESPACES } from "../../core/worker-paths.js";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isLivePid } from "../../runtime/kill-tree.js";
import { specialUserRequestBlock, claudeSpawnArgs, codexSpawnArgs } from "../../core/runner-spawn.js";
import { buildWorkerAttemptPath } from "../../core/worker-paths.js";
import { createLandLock } from "../../runtime/land-lock.js";
import { branchLockPath, readLockedBranch, isLocked } from "../../runtime/lock.js";
import { makeHookExec, makeHookResolveOptions, hookEnv } from "../../runtime/hooks.js";
import { makeFeedbackWorktree, type FeedbackWorktree } from "../../runtime/feedback-worktree.js";
import {
  installProcessSafety,
  fileSafetyLogger,
  safetyLogPath,
  deathCauseForRecoveredWorker,
} from "../../core/process-safety.js";
import { join } from "node:path";
import { hostFingerprintPrefix, workerIdentity } from "../../core/host-identity.js";
import { appendAgentRecord, appendRecordToonlTaggedRow } from "../../core/jsonl-log.js";
import { initStateSync, readPidStartTime, updateState, writeIdentitySync } from "../../core/state.js";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "../../core/toon-snapshot.js";
import { buildProgressHeartbeat, formatIterationMarker } from "../../core/heartbeat.js";
import { resolveAttemptLoc, locMemoPath, type LocMemo } from "../../core/loc-memo.js";
import { createActivityMeter } from "../../core/activity-meter.js";
import { createCastleWorkerLaneBridge } from "../../core/castle-worker-lane-bridge.js";
import { DEFAULT_MAX_ITERATIONS } from "../../core/execution.js";
import type { AgentStreamEvent } from "../../core/execution.js";
import { makeStaleClaimPredicate, resolveClaimStalenessConfig } from "../../core/claim-staleness.js";
import { renderClaimComment } from "../../core/claim.js";

import { deriveActivity } from "./activity.js";
import { makeAgentConflictResolver, makeMechanicalConflictResolver } from "./reconcile.js";
import {
  castleWorktreeUnder,
  decodeLocMemoSnapshot,
  encodeLocMemoSnapshot,
  readCapturedWorktreePath,
} from "./state.js";

export function parseSlot(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function buildProcessDeps(
  ctx: RepoContext,
  model: string,
  sandbox: ReturnType<typeof resolveRunSettings>["sandbox"],
  feedback: FeedbackWorktree,
  current: CurrentAttempt,
  fallbackRunner: boolean,
  runner: Runner,
  exec?: ExecFn,
  maxIterations?: number,
  laneIdle?: LaneIdleStallConfig,
  inlineVerifyCommand?: string,
  goVerifyRetries?: number,
  workerId = "unknown",
): ProcessIssueDeps {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo, exec };
  const gitCtx: GitContext = { cwd: ctx.root, exec };
  const paths = afkPaths(ctx.root);
  const castleBridge = createCastleWorkerLaneBridge({
    redRoot: join(ctx.root, ".red"),
    workerId,
    attemptDir: () => current.attemptDir,
  });
  const lockPath = branchLockPath(ctx.root);
  // Per-agentic-iteration boundary tracking (observability): when sandcastle's
  // re-invocation count (event.iteration) ticks, emit "iteration N ended/started"
  // markers. Reset per attempt — a new attempt's run restarts at iteration 1
  // (detected by the attempt dir changing or the count going backwards).
  const iterMax = maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let lastIter = 0;
  let lastIterDir = "";
  // Per-attempt stream-activity meter (slice 1 liveness metrics): counts
  // toolCall/text events and derives waiting windows. Re-created when the
  // attempt dir changes so counts never bleed across the attempt boundary.
  let activityMeter = createActivityMeter();
  let activityMeterDir = "";
  // Last diff volume observed by the heartbeat sink, so the on_heartbeat vitals
  // provider (#832) can report loc_added/loc_removed alongside the meter's
  // activity counters without re-shelling `git diff`.
  let lastHeartbeatDiff = { added: 0, removed: 0 };
  // Per-attempt peak diff: the largest diff seen by the heartbeat for this attempt.
  // Reset at attempt boundaries (same guard as activityMeter). Written to the state
  // file so the statusline can show a sticky last-known value when the live diff
  // transiently drops to 0 (e.g. during the feedback gate).
  let peakLocAdded = 0;
  let peakLocRemoved = 0;
  let peakLocDir = "";

  // ---- lifecycle hooks: load config + resolve built-in defaults + real exec ----
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  // Trust policy for the guidance-channel source-trust projection (issue #1100).
  const trustPolicy = parseTrustPolicy(config);
  const resolveOptions = makeHookResolveOptions(ctx.root);
  // resolveHooks runs once here to surface a malformed-hook-name error early;
  // process-issue re-resolves per run from the same config + options.
  resolveHooks(config, resolveOptions);

  // Merge-gate policy (ADR 0048). Default off → the unlocked admin-merge ignores
  // advisory review checks (drift-guard + in-process backpressure stay the
  // binding gates). When `afk.merge.wait_for_review` is true, the unlocked
  // landing holds until the configured review check (`afk.merge.review_check`)
  // concludes, then merges regardless of the verdict.
  const waitForReview =
    getConfig(config, "afk.merge.wait_for_review") === "true"
      ? {
          check: getConfig(config, "afk.merge.review_check") || "CodeRabbit",
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        }
      : undefined;

  // CI-aware merge (#812). Default off → the unlocked admin-merge fires
  // immediately (fine on a base with NO required status checks). When
  // `afk.merge.ci_aware` is true, the unlocked landing first polls the PR's merge
  // state and admin-merges ONLY once it settles — because an admin-merge cannot
  // bypass required checks on an `enforce_admins` base, so merging a just-opened
  // PR with checks pending is rejected and was mislabelled `merge-conflict`. The
  // poll budget comes from `RED_AFK_MERGE_CI_TIMEOUT_S` (default 1800s) at a fixed
  // 10s cadence; on timeout the open, MERGEABLE PR is handed off (no agent re-run).
  const ciAwait =
    getConfig(config, "afk.merge.ci_aware") === "true"
      ? {
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          intervalMs: 10_000,
          maxPolls: Math.max(1, Math.ceil(resolveCiTimeoutSeconds(process.env) / 10)),
        }
      : undefined;

  // PR review gate (ADR 0064 §10, #749). Default off → AFK keeps fast-merging
  // every tier. When enabled, a NON-mechanical attempt (classified tier at/above
  // `afk.review_gate.threshold`) gets `ready-for-review` on its PR and holds the
  // merge for a fresh-agent review; mechanical/trivial work fast-merges as today.
  const reviewGate = resolveReviewGate(config);
  const adversarialReview = resolveAdversarialReviewConfig((key) => getConfig(config, key));
  const extractAdversarialReview =
    adversarialReview.enabled
      ? async (input: {
          context: Parameters<ReturnType<typeof makeExtractAdversarialReview>>[0]["context"];
          runner: Runner;
          model: string;
          effort?: ProcessIssueDeps["effort"];
          maxIterations: number;
        }): Promise<AdversarialReviewFindings> => {
          const sandcastle = await defaultSandcastleDeps();
          const extract = makeExtractAdversarialReview({
            run: sandcastle.run as Parameters<typeof makeExtractAdversarialReview>[0]["run"],
            agentFor: sandcastle.agentFor,
            sandboxFor: (mode) => sandcastle.sandboxFor(mode),
            output: ({ tag, schema, maxRetries }) => Output.object({ tag, schema, maxRetries }),
            cwd: ctx.root,
          });
          return extract({ ...input, runner: toAgentRunner(input.runner) });
        }
      : undefined;

  // Landing-mode flag (ADR 0030 amended, #842), decoupled from the lock. Default
  // true → the attempt lands via an admin-merged PR into the resolved base; false
  // → a direct merge into that base (offline, no PR). The lock only resolves the
  // base (ADR 0031). Honours the namespaced + legacy fallback via loadConfig.
  const worktreeLaunchesPr = getConfig(config, "afk.worktree_launches_pull_request") !== "false";

  // Serialized landing (#1337, Spec #1333 root cause 2). Two workers finishing in
  // the same window used to both integrate-and-push into the base: the second push
  // was rejected non-fast-forward, and re-integrating an overlapping diff conflicted.
  //
  //   afk.merge.native_queue: true → `<base>` has the forge's merge queue; the PR is
  //     ENQUEUED and no local lock is taken (the queue rebases + revalidates each
  //     entry onto the current tip itself).
  //   otherwise → a global land-lock at `.red/tmp/afk-land.lock`, scoping mutual
  //     exclusion to every AFK worker landing into this repo on this host. Default
  //     ON; `afk.merge.land_lock: false` opts out into the pre-#1337 unserialized land.
  const nativeMergeQueue = getConfig(config, "afk.merge.native_queue") === "true";
  const landLock =
    nativeMergeQueue || getConfig(config, "afk.merge.land_lock") === "false"
      ? undefined
      : createLandLock(paths.tmpDir, `pid-${process.pid}`);

  // Intra-attempt notes-loop (Track C, #924). Default OFF → exactly one agent
  // call. When enabled, processIssue wraps the inner invocation in a bounded
  // outer loop carrying an accumulated `notes.md` between iterations.
  const notesLoop = resolveNotesLoopConfig(config);
  const outputShaping = resolveOutputShapingConfig(config);

  const backpressureCommands = readBackpressure(config);
  const mergedBackpressureCommands =
    inlineVerifyCommand && inlineVerifyCommand.trim() !== ""
      ? [...backpressureCommands, inlineVerifyCommand.trim()]
      : backpressureCommands;

  return {
    gh: {
      viewLabels: (issue) => ghx.viewLabels(ghCtx, issue),
      editLabels: (issue, remove, add) => ghx.editLabels(ghCtx, issue, remove, add),
      ensureLabel: async (name) => {
        try {
          await ghx.ensureLabel(ghCtx, name);
        } catch {
          // best-effort: a missing typed label must never fail the close.
        }
      },
      comment: (issue, body) => ghx.comment(ghCtx, issue, body),
      editBody: (issue, body) => ghx.editBody(ghCtx, issue, body),
      close: (issue) => ghx.closeIssue(ghCtx, issue),
      listByLabel: (label) => ghx.listByLabel(ghCtx, label),
      issueClosed: (n) => ghx.issueClosed(ghCtx, n),
      issueReference: (n) => ghx.issueReference(ghCtx, n),
      // Trust-gate provenance (#621): author + ready-for-agent label actor, read
      // from the issue timeline. Consulted at claim time only when an allowlist
      // is configured (plugins.dev.afk.trust-gate.allowlist) or the repo fails
      // closed (public + no allowlist, #1101).
      issueTrust: (issue) => ghx.issueTrust(ghCtx, issue),
      // Repository visibility (#1101): folds into the trust policy so a PUBLIC
      // repo with no allowlist fails closed while a private one stays permissive.
      repoVisibility: () => ghx.repoVisibility(ghCtx),
      // Dynamic-base trust signals (write-access / CODEOWNERS) for the fail-closed
      // default's author + promoter maintainer check (#1101, reusing #747).
      actorTrustSignals: (actor) => ghx.actorTrustSignals(ghCtx, actor),
      // HITL decision card (#935, S11a): post/update the card on escalation.
      // Best-effort: errors are caught in routeRecovery so they never block
      // the recovery path. Runs in the worktree root so gh resolves the repo.
      renderDecisionCard: async (issue) => {
        const { hitlCardCommand } = await import("../hitl-card.js");
        await hitlCardCommand(["render", `--issue=${issue}`, `--root=${ctx.root}`]);
      },
      listMainRedRepairIssues: () => ghx.listMainRedRepairIssues(ghCtx),
      findMainRedRepairIssue: (failures) => ghx.findMainRedRepairIssue(ghCtx, failures),
      createMainRedRepairIssue: (spec) => ghx.createMainRedRepairIssue(ghCtx, spec),
      updateMainRedRepairIssue: (issue, spec) => ghx.updateMainRedRepairIssue(ghCtx, issue, spec),
      closeMainRedRepairIssue: (issue, closeComment) => ghx.closeMainRedRepairIssue(ghCtx, issue, closeComment),
    },
    claimGh: {
      // ADR 0066: the atomic GitHub-native claim arbiter. Numeric comment ids
      // (via `gh api`) are the cross-host total order.
      postClaim: (issue, body) => ghx.postClaimComment(ghCtx, issue, body),
      listClaims: (issue) => ghx.listClaimComments(ghCtx, issue),
      concede: async (issue, body) => {
        try {
          await ghx.postClaimComment(ghCtx, issue, body);
        } catch {
          // best-effort: a failed concede ages out via the staleness predicate.
        }
      },
      // One human-visible audit comment when we recover a stale cross-host claim
      // (#627). Best-effort: a failed audit never abandons the won claim.
      audit: async (issue, body) => {
        try {
          await ghx.comment(ghCtx, issue, body);
        } catch {
          // best-effort observability; the claim is already won.
        }
      },
    },
    // Cross-host stale-claim recovery (#627, ADR 0066): a claim whose owner
    // stopped refreshing past `cadence × (tolerance + 1)` is presumed dead and
    // released by this sweep. The clock is sampled once per issue at deps build;
    // the policy comes from RED_AFK_CLAIM_REFRESH_S / RED_AFK_CLAIM_STALE_TOLERANCE.
    claimStale: makeStaleClaimPredicate(
      Math.floor(Date.now() / 1000),
      resolveClaimStalenessConfig(process.env),
    ),
    // AFK runner improvement (Pattern 5 — make the diagnostic actionable): when
    // a stale-claim recovery releases a SAME-HOST predecessor, read its
    // process-safety diagnostic log and surface the death cause in the recovery
    // audit comment. The self identity only needs the host for the same-host
    // gate (a cross-host predecessor's log isn't on this filesystem).
    recoveredWorkerDeathCause: (recoveredWorker) =>
      deathCauseForRecoveredWorker(paths.tmpDir, recoveredWorker, hostFingerprintPrefix()),
    claimLock: {
      // Atomic POSIX mkdir lock (#434): a non-recursive mkdir that fails EEXIST,
      // so two simultaneous boots cannot both claim the same issue. The prior
      // pathExists+ensureDir form was check-then-act and raced into dup PRs.
      acquire: (issue) => fsx.tryAcquireClaimDir(`${paths.tmpDir}/claims/${issue}`, process.pid),
      release: async (issue) => {
        await fsx.removeDir(`${paths.tmpDir}/claims/${issue}`);
      },
    },
    fs: {
      ensureAttemptDir: (dir) => fsx.ensureDir(dir),
      writeHandoff: (path, content) => fsx.writeHandoff(path, content),
      // $ITER_DIR/validation.jsonl — the machine-readable feedback sidecar the
      // Memory bridge consumes (SKILL.md §Validation Sidecar).
      writeValidationSidecar: (path, lines) => fsx.writeValidationSidecar(path, lines),
      completionSweep: (issue) => fsx.completionSweep(paths.workersRoot, issue),
    },
    git: {
      headShortSha: () => gitx.headShortSha(gitCtx),
      deleteLocalBranch: (branch) => gitx.deleteLocalBranch(gitCtx, branch),
      // Make the resolved base ref current before sandcastle forks off it
      // (ADR 0031/#1380). Online workers fork from freshly-fetched
      // origin/<base>; offline workers may use the local base only when it is not
      // behind the last-known origin tip.
      resolveFreshBase: (input) => gitx.resolveFreshBase(gitCtx, input),
      fetchBase: async (base) => {
        await gitx.gitExec(gitCtx)(["fetch", ctx.remote, base]);
      },
      prepareFreshWorkerBranch: (input) =>
        gitx.prepareFreshWorkerBranch(gitCtx, { ...input, remote: ctx.remote }),
    },
    mergeExec: gitx.mergeExec(gitCtx),
    remoteGit: gitx.gitExec(gitCtx),
    // Commit-leftovers salvage: when the inner agent emits DONE / exits without
    // committing (observed with codex), commit its dirty worktree onto the worker
    // branch so the feedback gate + landing see the work instead of an empty
    // merge. No-op when the worktree is clean. Best-effort.
    salvageUncommitted: (branch) => gitx.salvageUncommitted(gitCtx, branch, ctx.remote),
    // ADR 0083 §4 exit barrier (DONE tracer, #1020): the single owner of the DONE
    // path's terminal exit — salvage-commit dirty worktree paths, push the branch
    // to origin (retry once), and return the auditable receipt. Bound over the same
    // GitContext: salvage reuses `salvageUncommitted`, push uses `pushBranch`, and
    // the head sha is read from the pushed local ref.
    exitBarrier: (branch) =>
      passExitBarrier(
        {
          salvage: (b) => gitx.salvageUncommitted(gitCtx, b, ctx.remote),
          push: (b) => gitx.pushBranch(gitCtx, b, ctx.remote),
          headSha: async (b) => (await gitx.branchHead(gitCtx, b)) ?? "",
          nowIso: () => new Date().toISOString(),
        },
        branch,
      ),
    // ADR 0083 §4 exit barrier (every-terminal, #1021): the FAILURE-terminal
    // crossing bound over the SAME GitContext as the DONE barrier — guard abort,
    // stall-kill, crash teardown, and (via reconcile) the no-agent lane all pass
    // through it. Unlike the DONE barrier it never throws; a rejected push is
    // recorded in the receipt (`pushed:false`) so the failing attempt still
    // terminates but the branch state is reported truthfully.
    terminalExitBarrier: (branch) =>
      passTerminalBarrier(
        {
          salvage: (b) => gitx.salvageUncommitted(gitCtx, b, ctx.remote),
          push: (b) => gitx.pushBranch(gitCtx, b, ctx.remote),
          headSha: async (b) => (await gitx.branchHead(gitCtx, b)) ?? "",
          nowIso: () => new Date().toISOString(),
        },
        branch,
      ),
    // Feedback runs against a checkout of the worker branch — the feedback
    // worktree manager materialises it and rebases pnpm/layout onto it.
    pnpm: feedback.pnpm,
    validationResourceBudget: readValidationResourceBudget(config),
    layout: feedback.layout,
    // Backpressure gate (#430, PRD #429): operator-declared `afk.backpressure`
    // shell commands run against the same worker-branch checkout after feedback.
    backpressure: feedback.backpressure,
    backpressureCommands: mergedBackpressureCommands,
    outputShaping,
    // Non-blocking backpressure evidence review (#1279): render the executed
    // backpressure checks as ONE aggregated `event: COMMENT` review on the PR.
    // Reuses ReviewGh.postReview (COMMENT-only, no APPROVE/REQUEST_CHANGES) with
    // no inline comments — purely a top-level evidence ledger. Observability only;
    // it never touches the merge/park decision.
    postBackpressureReview: (pr, body) =>
      buildReviewGh(ghCtx).postReview(pr, { summary: body, comments: [] }),
    adversarialReview,
    extractAdversarialReview,
    postAdversarialReview: async ({ pr, issue, body }) => {
      await buildReviewGh(ghCtx).comment(pr, body);
      await ghx.comment(ghCtx, issue, body);
    },
    goVerifyRetries,
    // Post-attempt-format step (#1015): operator-declared `afk.post_attempt_format`
    // commands run BEFORE the feedback gate and auto-commit any formatting delta.
    postAttemptFormat: feedback.postAttemptFormat,
    postAttemptFormatCommands: readPostAttemptFormat(config),
    // Thread a live activity probe off this attempt's activity meter. The
    // progress guard uses it as a soft progress signal when armed.
    runAgent: makeRunAgent(
      sandbox,
      process.env,
      maxIterations,
      laneIdle,
      () => activityMeter.peek(),
    ),
    sandboxMode: sandbox,
    sandboxAvailable: async (mode) => {
      const run = exec ?? execTool;
      return (await run("sh", ["-c", `command -v ${mode}`], { cwd: ctx.root })).code === 0;
    },
    model,
    classifyIssue: makeIssueClassifier(config, runner, ctx.root, exec),
    resolveTier: (activeRunner, taskClass = "think") => resolveTier(config, activeRunner, taskClass, process.env),
    fallbackRunner,
    waitForReview,
    ciAwait,
    worktreeLaunchesPr,
    landLock,
    nativeMergeQueue,
    reviewGate,
    reviewGateLabel: LABEL_READY_FOR_REVIEW,
    // One-shot merge-conflict resolver (merge_resolve_conflict): re-enter the
    // configured runner in the LANDING WORKTREE (`cwd`, the isolated checkout the
    // locked merge happens in, #572) with the resolver prompt. The merge primitive
    // verifies git state afterwards, so a non-zero / thrown runner here is
    // swallowed. Mirrors run_claude / run_codex on the conflicted checkout.
    conflictResolver: async (prompt: string, cwd: string) => {
      const conflictTier = resolveTier(config, runner, "think", process.env);
      const invocation =
        runner === "codex"
          ? codexSpawnArgs({
              prompt,
              worktree: cwd,
              lastMessagePath: paths.mergeResolveScratchPath,
              model: conflictTier.model,
              effort: conflictTier.effort,
            })
          : claudeSpawnArgs({ prompt, worktree: cwd });
      const { execTool } = await import("../../runtime/exec.js");
      await execTool(invocation.command, invocation.args, { cwd });
    },
    resolveMechanicalConflict: makeMechanicalConflictResolver(gitCtx),
    resolveAgentConflict: makeAgentConflictResolver({ config, runner, paths }),
    maxAgentConflictResolveAttempts: 2,
    // Isolated landing worktree for the LOCKED path (#572): a detached worktree at
    // <base> so the locked merge/push/rollback never `git -C`'s the primary
    // checkout. The primary branch is sacred — a rejected push's `reset --hard`
    // only rewinds this throwaway worktree, never the primary's WIP. A stale dir
    // from a prior crash is removed first so `worktree add` does not collide.
    makeLandingWorktree: async (base: string) => {
      const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
      const slug = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "base";
      const dest = join(paths.landingWorktreesDir, `${slug}-${slot}`);
      await gitx.worktreeRemove(gitCtx, dest);
      const ok = await gitx.worktreeAdd(gitCtx, dest, base);
      return ok ? dest : null;
    },
    removeLandingWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
    // Isolated worker-branch worktree for the PR path's pre-merge rebase (#1006):
    // fetch base + rebase the branch + force-push run here, never the primary.
    makeRebaseWorktree: async (branch: string) => {
      const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
      const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
      const dest = join(paths.rebaseWorktreesDir, `${slug}-${slot}`);
      await gitx.worktreeRemove(gitCtx, dest);
      const ok = await gitx.worktreeAdd(gitCtx, dest, branch);
      return ok ? dest : null;
    },
    removeRebaseWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
    hooks: {
      config,
      resolveOptions,
      exec: makeHookExec(ctx.root),
      env: hookEnv(ctx.repo, ctx.root, parseSlot(process.env.RED_AFK_SLOT), runner),
    },
    lookups: {
      base: {
        readLockedBranch: () => readLockedBranch(lockPath),
        configLockedBranch: getConfig(config, "dev.lock.branch") || undefined,
        configTrunk: getConfig(config, "dev.trunk") || undefined,
        fetchIssueBody: (n) => ghx.issueBody(ghCtx, n),
      },
      isLocked: () => isLocked(lockPath),
      // Source-trust classification for the guidance channel (issue #1100): each
      // comment's author is resolved through the `resolveActorTrust` primitive so
      // only a trusted-source directive can become authoritative `<human-guidance>`.
      comments: (issue) =>
        ghx.issueComments(ghCtx, issue, (actor) =>
          resolveActorTrust(trustPolicy, actor, (login) => ghx.actorTrustSignals(ghCtx, login)),
        ),
      issueUrl: (issue) => ghx.issueUrl(ghCtx, issue),
      // Restart-informed retry block (#255): read the prior attempt's markers
      // (failure.reason / snapshot-branch.ref) via the attempt-ledger.
      priorAttemptContext: async (issue) => {
        try {
          const context = await attemptLedgerContext(paths.tmpDir, issue);
          return context ? formatAttemptContext(context) : undefined;
        } catch {
          return undefined;
        }
      },
      changedFiles: (branch, base) => gitx.changedFiles(gitCtx, branch, base),
      diffstat: (branch, base) => gitx.diffstat(gitCtx, branch, base),
      // FIX E: confirm the sandcastle worker branch actually landed on the host
      // before the merge gate. Try once, fetch on a miss, then re-check — a still
      // -absent branch escalates instead of silently bypassing feedback.
      branchPresent: async (branch) => {
        if (await gitx.branchExists(gitCtx, branch)) return true;
        await gitx.fetchBranch(gitCtx, branch);
        return gitx.branchExists(gitCtx, branch);
      },
      // Goal predicate own-merge signal (ADR 0057): true iff the worker branch
      // already landed in <base>, distinguishing own-merge close (done) from a
      // foreign close (claim-lost) when the guard observes the issue CLOSED.
      branchMerged: (branch, base) => gitx.branchMergedInto(gitCtx, branch, base),
    },
    envelope: {
      git: gitx.gitExec(gitCtx),
      poster: async (issue, body) => {
        await ghx.comment(ghCtx, issue, body);
        return true;
      },
      // Markers/posted land in the CURRENT attempt dir, set per issue by
      // buildProcessInput before each processIssue call.
      writeMarkers: (markers) => fsx.writeFailureMarkers(current.attemptDir, markers),
      writePosted: (posted) => fsx.writeEnvelopePosted(current.attemptDir, posted),
      issueReference: (issue) => ghx.issueReference(ghCtx, issue),
    },
    nowEpoch: () => Math.floor(Date.now() / 1000),
    nowIso: () => new Date().toISOString(),
    // The per-iteration afk.log heartbeat boundary lives in the attempt dir.
    appendIterLog: (line) => {
      void fsx.appendLine(join(current.attemptDir, "afk.log"), line);
    },
    // Native-path liveness (#284 observability gap): sandcastle captures the
    // inner agent's stream itself, so on the native path nothing advances the
    // agent lane and its mtime freezes at iteration start — the stall detector
    // (reaper-signal) and monitor then read a live agent as silent. Forward
    // each sandcastle stream event to the clean agent lane (the liveness signal
    // supervisor-fs / reaper key off) and mirror it into the firehose afk.log.
    // Best-effort: lane-write failures are swallowed so observability can never
    // break a run (sandcastle also swallows any throw from this callback).
    recordAgentEvent: (event) => {
      const ts = new Date().toISOString();
      // Raw stdout lines (sandcastle 0.11.0 verbose stream `{type:"raw"}`) are
      // noisy per-line output, not assistant turns. Fan them to the FIREHOSE only
      // so a stuck/silent agent stays diagnosable, while the clean agent lane keeps
      // its one-record-per-turn invariant. Not a liveness/activity unit, so skip
      // the meter + iteration markers. Returning here also narrows `event` to the
      // non-raw variants for the rest of the handler.
      if (event.type === "raw") {
        void appendRecordToonlTaggedRow(join(current.attemptDir, "log.toonl"), "raw", {
          iteration: event.iteration,
          line: event.line,
        }, {
          ts,
        }).catch(() => {});
        return;
      }
      if (event.type === "sessionId") {
        void appendRecordToonlTaggedRow(join(current.attemptDir, "log.toonl"), "session", `session ${event.sessionId}`, {
          ts,
          fields: {
            extra: {
              kind: "sessionId",
              iteration: String(event.iteration),
              session_id: event.sessionId,
            },
          },
        }).catch(() => {});
        return;
      }
      // Agentic-iteration boundary markers (synthetic — afk.log + firehose, NEVER
      // the agent lane). Emit "iteration N ended" + "iteration N+1 started" when
      // sandcastle's re-invocation count advances, so a run burning through
      // iterations (re-validating instead of emitting DONE) is visible.
      const dir0 = current.attemptDir;
      if (dir0 !== lastIterDir) {
        lastIterDir = dir0;
        lastIter = 0; // new attempt → fresh iteration count
      }
      // New attempt → fresh activity meter (counts must not bleed across attempts).
      if (dir0 !== activityMeterDir) {
        activityMeterDir = dir0;
        activityMeter = createActivityMeter();
      }
      // New attempt → reset peak diff (peaks are per-attempt, not per-worker).
      if (dir0 !== peakLocDir) {
        peakLocDir = dir0;
        peakLocAdded = 0;
        peakLocRemoved = 0;
      }
      if (
        event.type === "text" ||
        event.type === "toolCall" ||
        event.type === "reasoning" ||
        event.type === "usage"
      ) {
        activityMeter.record(event);
      }
      if (event.iteration !== lastIter) {
        const emit = (line: string, phase: string, n: number): void => {
          void fsx.appendLine(join(dir0, "afk.log"), line);
          void appendRecordToonlTaggedRow(join(dir0, "log.toonl"), "iteration", line, {
            ts,
            fields: { extra: { iteration: String(n), phase } },
          }).catch(() => {});
        };
        if (lastIter > 0) emit(formatIterationMarker(lastIter, "ended", iterMax), "ended", lastIter);
        lastIter = event.iteration;
        emit(formatIterationMarker(lastIter, "started", iterMax), "started", lastIter);
        void updateState(join(dir0, "afk.state.toon"), { "current.iteration": String(lastIter) }).catch(() => {});
      }
      const msg =
        event.type === "text"
          ? event.message
          : event.type === "reasoning"
            ? `🧠 reasoning${
                event.tokens ? ` (${event.tokens} tok)` : event.message ? `: ${event.message.slice(0, 80)}` : ""
              }`
            : event.type === "usage"
              ? `💰 usage (in:${event.inputTokens} out:${event.outputTokens}${
                  event.reasoningTokens ? ` reason:${event.reasoningTokens}` : ""
                })`
              : event.type === "result"
                ? `result: ${event.result}`
                : `→ ${event.name} ${event.formattedArgs}`;
      void appendAgentRecord(join(current.attemptDir, "agent.log.toonl"), msg, {
        ts,
        fields: { extra: { iteration: String(event.iteration), kind: event.type } },
      }).catch(() => {});
      void castleBridge.record("worker.heartbeat", {
        event: event.type,
        iteration: String(event.iteration),
      }).catch(() => {});
      // Firehose lane (issue #250): every record in the uniform envelope. The
      // native port left this unopened; restore it so the post-mortem firehose
      // carries the agent turns alongside the (future) heartbeat/hook records.
      void appendRecordToonlTaggedRow(join(current.attemptDir, "log.toonl"), "agent", msg, {
        ts,
        fields: { extra: { iteration: String(event.iteration), kind: event.type } },
      }).catch(() => {});
      // The plaintext `[agent] …` mirror into afk.log is intentionally gone:
      // red-castle's file-log now points at the SAME afk.log (process-issue.ts), so
      // it already renders agent text + tool calls there — re-appending here would
      // double every turn. The structured per-event record stays in agent.log.toonl
      // + the firehose above, where the rich reasoning/usage glyphs live.
      // Advance the monitor's state view on recognised tool-call transitions
      // (bounded write rate vs every text chunk — the lane mtime above is the
      // stall-detector's liveness signal; this is the dashboard's activity/last).
      // `last_event_at` (the honest liveness clock, ADR 0065) is stamped on every
      // DISCRETE event — tool/reasoning/usage/result, not per-text-chunk — so it advances
      // every few seconds for an active worker even between commits.
      const activity = deriveActivity(event);
      const discrete =
        event.type === "toolCall" ||
        event.type === "reasoning" ||
        event.type === "usage" ||
        event.type === "result";
      // A `usage` event is the only carrier of the cost group, and for claude it
      // arrives exactly ONCE — on the terminal result line, AFTER the last
      // heartbeat poll and just before the agent exits. The ~60s heartbeat is
      // what normally folds the meter's cost into state, but it never fires again
      // once the agent completes, so a single-iteration claude run persisted
      // cost_usd=0 despite real token spend. Flush the cumulative cost from the
      // meter the instant a usage event lands (ADR 0065). Idempotent: codex emits
      // many usage events and each just re-stamps the running total.
      const costPatch =
        event.type === "usage"
          ? {
              "current.input_tokens": activityMeter.peek().inputTokens,
              "current.output_tokens": activityMeter.peek().outputTokens,
              "current.cost_usd": activityMeter.peek().costUsd,
            }
          : {};
      if (activity || discrete) {
        void updateState(join(current.attemptDir, "afk.state.toon"), {
          ...(activity ? { "current.activity": activity, "current.last_stream_line": msg.slice(0, 200) } : {}),
          // Any inner-agent stream activity means we are in the macro `coding`
          // phase (collapses explore/impl/tests/commit — the fine activity lives in
          // the description, so the title never flickers, issue #811). Idempotent:
          // re-stamping `coding` each event is a no-op write.
          "current.phase": "coding",
          "current.last_event_at": ts,
          ...costPatch,
        }).catch(() => {});
      }
    },
    // Externalized proof-of-life sink (PR-B): the attempt-guard fires this each
    // poll (~60s) with the progress signal. Append an enriched `type=heartbeat`
    // firehose record carrying the live LINE-DIFF (+A -R) AND mirror
    // `current.{last_progress_at,diff_added,diff_removed}` into the state file, so
    // each tick shows how the attempt is evolving and the monitor's +A -R stays
    // fresh between its sparse 10-min ticks (#448). Best-effort — swallowed.
    emitHeartbeat: (info) => {
      const ts = new Date().toISOString();
      const secs = Math.max(0, Math.floor((info.nowMs - info.lastProgressMs) / 1000));
      const lastProgressAt = new Date(info.lastProgressMs).toISOString();
      const head = info.head ?? "";
      void (async () => {
        // The castle creates the agent's worktree at
        // `{attemptDir}/.red-castle/worktrees/{slug}` (keyed workerId-issueId,
        // ADR 0103 — no attempt level), NOT the legacy `{attemptDir}/worktree`
        // the state seeds. Source of truth = the path the castle RECORDS from its
        // `onWorktreeReady` hook (its `pwd` in the real worktree); reconstructing
        // it from `attemptDir` (a `git worktree list` probe on the primary + a
        // filesystem walk) returned the dead legacy path at runtime for
        // mirror-owned worktrees, so every codex tick read a permanent `+0 -0`.
        // The probe/legacy fallbacks stay only for the window before the hook
        // runs. Persist the resolved path into `current.worktree` so the monitor
        // (which reads that field for its own diffstat) gets the live path too.
        const worktree =
          readCapturedWorktreePath(current.attemptDir) ??
          (await gitx.worktreePathUnder(gitCtx, current.attemptDir).catch(() => undefined)) ??
          castleWorktreeUnder(current.attemptDir) ??
          join(current.attemptDir, "worktree");
        // Fall back to the configured Trunk (ADR 0083), not a literal "main".
        const baseRef = info.base
          ? `origin/${info.base}`
          : `origin/${getConfig(config, "dev.trunk") || "main"}`;
        // Writer-side LOC ownership (#1210 Part B): the render paths no longer
        // shell out to `git diff --shortstat`, so this heartbeat is the runner-
        // agnostic owner that stamps loc_added/loc_removed for ALL runners (codex
        // included). The COMMITTED delta is EXPENSIVE but stable between commits,
        // so memoize it against the current HEAD sha in the attempt dir — computed
        // at most once per commit; while HEAD is unchanged the memoized volume is
        // served without spawning git. The UNCOMMITTED working-tree delta is
        // recomputed every tick and added on top (#1224 Part A): a codex worker
        // never commits, so its HEAD sha is frozen and ONLY the working-tree diff
        // reflects its work — memoizing the combined volume on HEAD sha would
        // freeze the first tick's `+0 -0` for the whole attempt. The claude
        // incremental path is unaffected: a new commit moves the delta into the
        // sha-keyed committed memo. Render stays git-free either way.
        const memoPath = locMemoPath(current.attemptDir, "/");
        const { added, removed } = await resolveAttemptLoc({
          headSha: head,
          compute: () =>
            gitx.diffstatCommitted({ cwd: worktree }, baseRef).catch(() => ({ added: 0, removed: 0 })),
          computeUncommitted: () =>
            gitx.diffstatUncommitted({ cwd: worktree }).catch(() => ({ added: 0, removed: 0 })),
          readMemo: () => {
            // The memo file is ABSENT on the first heartbeat of every attempt,
            // and a codex worker (no incremental commits) never creates one at
            // all — so `readFileSync` throws ENOENT here on EVERY tick. The
            // `resolveAttemptLoc` contract is that `readMemo` returns null when
            // "absent/unreadable"; an uncaught throw instead propagated out of
            // the heartbeat's async body BEFORE it stamped loc or wrote its
            // record, leaving codex vitals a permanent `+0 -0` (0 heartbeat
            // records). Fail closed to null so a missing/corrupt memo just forces
            // a recompute (the committed delta), never a lost stamp.
            try {
              return decodeLocMemoSnapshot(readFileSync(memoPath, "utf8"));
            } catch {
              return null;
            }
          },
          writeMemo: (m) => {
            try {
              writeFileSync(memoPath, encodeLocMemoSnapshot(m), "utf8");
            } catch {
              // best-effort, like the surrounding heartbeat writes
            }
          },
        });
        // Remember the volume for the on_heartbeat vitals provider (#832).
        lastHeartbeatDiff = { added, removed };
        // Update the per-attempt peak diff (only grows; never decreases).
        if (added > peakLocAdded) peakLocAdded = added;
        if (removed > peakLocRemoved) peakLocRemoved = removed;
        // Close this heartbeat window on the meter — derives the waiting count
        // (a window with no new stream events) and snapshots the cumulative
        // tool/text counts to fold into the record + state.
        const activity = activityMeter.snapshotWindow();
        const hb = buildProgressHeartbeat({
          secsSinceProgress: secs,
          lastProgressAt,
          head,
          added,
          removed,
          activity,
        });
        await appendRecordToonlTaggedRow(join(current.attemptDir, "log.toonl"), "heartbeat", hb.msg, {
          ts,
          fields: { extra: hb.extra },
        }).catch(() => {});
        await fsx.appendLine(join(current.attemptDir, "afk.log"), `[heartbeat] ${hb.msg}`);
        await updateState(join(current.attemptDir, "afk.state.toon"), {
          ...hb.statePatch,
          "current.loc_peak_added": peakLocAdded,
          "current.loc_peak_removed": peakLocRemoved,
          "current.worktree": worktree,
          ...(info.base ? { "current.base": info.base } : {}),
        }).catch(() => {});
        await castleBridge.record("worker.heartbeat", {
          signal: "attempt-guard",
          seconds_since_progress: secs,
          head,
        }).catch(() => {});
      })();
    },
    // Worker-vitals provider for the on_heartbeat hook context (ADR 0065/#832):
    // the live cumulative activity counters from the attempt's meter plus the
    // last-observed diff volume, under their canonical WorkerVitals names. Read
    // each attempt-guard poll right before the on_heartbeat hook fires.
    heartbeatVitals: () => {
      const a = activityMeter.peek();
      return {
        tools_called_count: a.toolsCalled,
        text_chunk_count: a.textChunks,
        reasoning_events: a.reasoningCount,
        reasoning_tokens: a.reasoningTokens,
        waiting_count: a.waiting,
        input_tokens: a.inputTokens,
        output_tokens: a.outputTokens,
        cost_usd: a.costUsd,
        loc_added: lastHeartbeatDiff.added,
        loc_removed: lastHeartbeatDiff.removed,
      };
    },
    // Intra-attempt notes-loop (Track C, #924). `notesLoop` is the resolved
    // `afk.notes_loop.*` config (default OFF). `writeNotes` persists the loop's
    // carried `notes.md` at the attempt dir — outside the worker branch's
    // worktree, so it is never committed. Best-effort: a write failure must never
    // fail the attempt.
    notesLoop,
    writeNotes: (path, content) => {
      try {
        writeFileSync(path, content, "utf8");
      } catch {
        /* best-effort: notes are also carried in-process */
      }
    },
    // Macro-lifecycle phase stamp (issue #811): processIssue calls this at the
    // orchestrator-owned points the agent stream can't see — `validating` at the
    // feedback gate, `merging` at landing. Best-effort, swallowed; the calm title
    // signal must never fail the run.
    markPhase: (phase) => {
      void (async () => {
        await updateState(join(current.attemptDir, "afk.state.toon"), {
          "current.phase": phase,
        }).catch(() => {});
        await castleBridge.snapshot().catch(() => {});
      })();
    },
    markState: (patch) => {
      void (async () => {
        await updateState(join(current.attemptDir, "afk.state.toon"), patch).catch(() => {});
        await castleBridge.snapshot().catch(() => {});
      })();
    },
    recordWorkerEvent: (kind, payload) => {
      void castleBridge.record(kind, payload).catch(() => {});
    },
    historyPath: paths.historyPath,
    historyClock: { ts: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000) },
    // BOUNDED auto-recovery reads its RED_AFK_RETRY_* caps from the process env.
    recoveryEnv: process.env,
    // ADR 0017: best-effort AFK→Memory "reasoning attempt" recording. Serialise
    // the payload to a temp JSON file under the attempt dir, then exec the memory
    // CLI DIRECTLY (`<memoryCli> attempt record --root <root>` with the payload on
    // stdin). The resolver gates on memory availability (ADR 0009) — a silent
    // no-op when memory is absent / not opted-in — replacing the old shell-bridge
    // hop. ALL errors are swallowed (one warn line), so a memory failure can
    // NEVER fail the close.
    recordAttempt: makeRecordAttempt(ctx.root, current, exec),
    recordOutcomeEvent: makeRecordOutcomeEvent(ctx.root, current, exec),
    // Spec cascade rebase (issue #1007): after a successful DONE landing, rebase
    // every open sibling branch (same spec:N, not held by a live worker) onto the
    // new base HEAD. Best-effort — failures log a warning, never fail the close.
    // Gated by `afk.landing.cascade_rebase` (default "true", checked in core).
    cascadeRebase: {
      async listAFKBranches() {
        const refs = await gitx.listRemoteBranches(gitCtx, "afk/");
        return refs.map((r) => r.branch);
      },
      isWorkerLive(workerId: string): boolean {
        try {
          const pidPath = workerPidFile(paths.tmpDir, workerId);
          const content = readFileSync(pidPath, "utf8").trim();
          if (!/^[1-9][0-9]*$/.test(content)) return false;
          process.kill(Number(content), 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "EPERM";
        }
      },
      async rebaseAndPush(repoDir: string, branch: string, newBase: string) {
        const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
        const dest = join(paths.cascadeWorktreesDir, `${slug}-${slot}`);
        try {
          await gitx.worktreeRemove(gitCtx, dest);
          const ok = await gitx.worktreeAdd(gitCtx, dest, branch);
          if (!ok) {
            return { ok: false, warn: `failed to create worktree for ${branch}` };
          }
          const run = exec ?? (await import("../../runtime/exec.js")).execTool;
          const rebaseR = await run("git", ["rebase", `origin/${newBase}`], { cwd: dest });
          if (rebaseR.code !== 0) {
            await run("git", ["rebase", "--abort"], { cwd: dest }).catch(() => {});
            return {
              ok: false,
              warn: `rebase of ${branch} onto ${newBase} conflicted: ${rebaseR.stderr.slice(0, 200)}`,
            };
          }
          const pushR = await run(
            "git",
            ["push", "origin", `HEAD:refs/heads/${branch}`, "--force-with-lease"],
            { cwd: dest },
          );
          if (pushR.code !== 0) {
            return {
              ok: false,
              warn: `--force-with-lease push rejected for ${branch}: ${pushR.stderr.slice(0, 200)}`,
            };
          }
          return { ok: true };
        } finally {
          await gitx.worktreeRemove(gitCtx, dest).catch(() => {});
        }
      },
    },
  };
}

function makeIssueClassifier(
  config: import("../../core/config.js").ConfigValues,
  runner: Runner,
  cwd: string,
  exec?: ExecFn,
): (metadata: IssueClassificationMetadata) => Promise<import("../../core/config.js").AfkModelTier> {
  return async (metadata) => {
    const validateTier = resolveTier(config, runner, "validate", process.env);
    return classifyIssue(metadata, async ({ prompt }) => {
      const run = exec ?? (await import("../../runtime/exec.js")).execTool;
      const common = { cwd, timeoutMs: 45_000, maxBuffer: 1024 * 1024 };
      const result =
        runner === "codex"
          ? await run(
              "codex",
              [
                "exec",
                "--model",
                validateTier.model,
                "-c",
                `model_reasoning_effort=${validateTier.effort}`,
                "-C",
                cwd,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                prompt,
              ],
              common,
            )
          : await run(
              "claude",
              [
                "--model",
                validateTier.model,
                "--effort",
                validateTier.effort,
                "--permission-mode",
                "bypassPermissions",
                "--print",
                prompt,
              ],
              common,
            );
      return result.code === 0 ? result.stdout.trim() : undefined;
    });
  };
}

/** Read the `version` field of a JSON manifest file, or undefined when the file
 * is missing / unparseable / has no version. The version-keyed cache-bundle
 * candidate in {@link resolveMemoryCli} uses this to locate the fetched CLI. */
function readManifestVersion(path: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the best-effort `recordAttempt` port (ADR 0017). On each call it resolves
 * the memory CLI ({@link resolveMemoryCli}, which gates on the ADR 0009 opt-in
 * config + the bridge's candidate order), writes the payload to a temp JSON file
 * under the current attempt dir, and execs the memory CLI DIRECTLY:
 * `<memoryCli> attempt record --root <gitRoot>` with the payload piped on stdin
 * — exactly what the bridge's `memory_record_attempt` did, minus the shell hop.
 * `MEMORY_REPO_ROOT` is set in the child env (as the bridge expected) so an
 * in-repo memory checkout resolves. When no CLI resolves the call is a silent
 * no-op (memory not installed). Every error (write failure, non-zero exit, spawn
 * error) is SWALLOWED — at most one warn line is written.
 *
 * `exec` is the test-injection seam (mirrors the rest of buildProcessDeps); in
 * production it is undefined and the real `execTool` is used.
 */
function makeRecordAttempt(
  gitRoot: string,
  current: CurrentAttempt,
  exec?: ExecFn,
): (payload: AttemptRecordPayload) => Promise<void> {
  return async (payload: AttemptRecordPayload): Promise<void> => {
    try {
      const env = { ...process.env, MEMORY_REPO_ROOT: process.env.MEMORY_REPO_ROOT ?? gitRoot };
      const memoryCli = resolveMemoryCli(gitRoot, env, {
        exists: existsSync,
        readJsonVersion: readManifestVersion,
        readText: (path) => {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return undefined;
          }
        },
      });
      if (!memoryCli) return; // memory not opted-in / no CLI resolves — silent skip.
      const dir = current.attemptDir || gitRoot;
      const payloadFile = join(dir, `memory-attempt-${payload.issueNumber}-a${payload.attemptNumber}.json`);
      await fsx.ensureDir(dir);
      const json = toMemoryPayload(payload);
      await writeFile(payloadFile, json, "utf8");
      const run = exec ?? (await import("../../runtime/exec.js")).execTool;
      const [cmd, ...head] = memoryCli;
      await run(cmd, [...head, "attempt", "record", "--root", gitRoot], {
        cwd: gitRoot,
        env,
        input: json,
      });
    } catch (err) {
      process.stderr.write(`[afk] memory attempt-record skipped (best-effort): ${String(err)}\n`);
    }
  };
}

function makeRecordOutcomeEvent(
  gitRoot: string,
  current: CurrentAttempt,
  exec?: ExecFn,
): (event: OutcomeEvent) => Promise<void> {
  return async (event: OutcomeEvent): Promise<void> => {
    try {
      const configPath = configFile(gitRoot);
      const configText = readFileSync(configPath, "utf8");
      if (!pluginEnabledInConfig(configText, "brain")) return;
      const env = { ...process.env, BRAIN_REPO_ROOT: process.env.BRAIN_REPO_ROOT ?? gitRoot };
      const brainCli = resolveBrainCli(gitRoot, env);
      if (!brainCli) return;
      const dir = current.attemptDir || gitRoot;
      await fsx.ensureDir(dir);
      const json = JSON.stringify(event);
      await writeFile(join(dir, `brain-outcome-event-${event.context?.issueNumber ?? "unknown"}-a${event.context?.attemptNumber ?? "unknown"}.json`), json, "utf8");
      const run = exec ?? (await import("../../runtime/exec.js")).execTool;
      const [cmd, ...head] = brainCli;
      await run(cmd, [...head, "outcome-event", "record", "--root", gitRoot], {
        cwd: gitRoot,
        env,
        input: json,
      });
    } catch (err) {
      process.stderr.write(`[afk] brain outcome-event skipped (best-effort): ${String(err)}\n`);
    }
  };
}

function resolveBrainCli(gitRoot: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const override = env.RED_BRAIN_CLI;
  if (override) return existsSync(override) ? ["node", override] : undefined;
  const pathHit = findOnPath("brain", env.PATH);
  if (pathHit) return ["brain"];
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? env.CODEX_PLUGIN_ROOT;
  if (pluginRoot) {
    const sibling = join(pluginRoot, "..", "brain", "dist", "cli.js");
    if (existsSync(sibling)) return ["node", sibling];
  }
  const inRepo = join(gitRoot, "plugins", "brain", "dist", "cli.js");
  if (existsSync(inRepo)) return ["node", inRepo];
  return undefined;
}

function findOnPath(bin: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Per-issue mutable context the session-scoped process deps close over — the
 * attempt dir the envelope markers / iter-log write into. buildProcessInput
 * resets it before each processIssue call. */
export interface CurrentAttempt {
  attemptDir: string;
}
