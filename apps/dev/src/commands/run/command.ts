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
import { zeroAttemptDispatchFailure } from "../../core/go.js";
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
import { parseTrustPolicy, resolveActorTrust } from "../../core/trust-gate.js";
import { resolveNotesLoopConfig } from "../../core/notes-loop.js";
import { resolveOutputShapingConfig } from "../../core/output-shaping.js";
import {
  classifyIssue,
  resolveReviewGate,
  type IssueClassificationMetadata,
} from "../../core/issue-classifier.js";
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

import { checkBootGuard, isNamespacedDispatch, parseRunFlags, resolveRunDispatchIdentity, type RunOptions } from "./flags.js";
import { buildProcessDeps, parseSlot, type CurrentAttempt } from "./process-deps.js";
import { makeBootReconcileRunner, runReconcileWorker } from "./reconcile.js";
import { nextAttemptSync, openRunnerCircuit, recordBootError, runnerCircuitOpen } from "./state.js";

export async function runCommand(options: RunOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();

  const flags = parseRunFlags(options.args);
  const dispatchIdentity = resolveRunDispatchIdentity(flags);
  // --model / --effort pre-set the env override (flag > env). Setting them on the
  // process env makes the override flow through both the in-process `--once` path
  // (resolveTier reads process.env) and the fleet path (buildWorkerEnv passes
  // RED_AFK_MODEL/RED_AFK_EFFORT through to workers — not in PASSTHROUGH_DENYLIST).
  if (flags.model) process.env.RED_AFK_MODEL = flags.model;
  if (flags.effort) process.env.RED_AFK_EFFORT = flags.effort;
  const detection = detectRunner({
    flag: flags.runnerFlag ?? parseRunnerFlag(options.args),
    processTree: callerProcessTreeNative(),
    scriptPath: process.argv[1],
  });
  const runner: Runner = isRunner(detection.runner) ? detection.runner : "claude";

  const ctx = await resolveRepoContext(cwd);
  const settings = resolveRunSettings(cwd, process.env, runner);
  const paths = afkPaths(cwd);

  // One-time boot migration: relocate any legacy `.red/tmp` durable artifacts to
  // canonical state or supervisor tmp lanes before this worker reads/writes supervisor/circuit state
  // (issue #1685). Idempotent + best-effort — a second boot is a no-op.
  await migrateLegacyDevPaths(cwd).catch(() => undefined);

  // Boot guard (#1027): refuse to start if a fleet supervisor is already live.
  // Supervisor-dispatched paths bypass this: --reconcile-issue workers are
  // spawned by the running supervisor; RED_AFK_SWEEPS_DONE=1 workers are
  // fleet-owned and the supervisor already holds the pid. A `/go`/`--scout`
  // dispatch (#1087) is exempt too: its isolated namespace/lane/origin can
  // never collide with the fleet, so it must boot whether or not a fleet is up.
  if (flags.reconcileIssue === undefined && process.env.RED_AFK_SWEEPS_DONE !== "1") {
    const pidFile = paths.supervisorPidPath;
    const exempt = isNamespacedDispatch({
      origin: dispatchIdentity.origin,
      kind: dispatchIdentity.kind,
      lane: dispatchIdentity.lane,
    });
    const guard = await checkBootGuard(pidFile, flags.force, process.stdout, isLivePid, exempt);
    if (guard === "refused") return 1;
  }

  // Worker id — probe the workers root for collisions.
  const existing = new Set((await collectMonitorInputs(cwd)).workers.map((w) => w.state.worker_id));
  const workerId = genWorkerId(Math.random, (id) => existing.has(id));
  const pidStartTime = readPidStartTime(process.pid) ?? "";
  // Emit the per-slot boot-stamp immediately so the supervisor's slot log
  // captures this worker's ID before any failure. The circuit-trip sweep
  // (sweepParkedSlot) parses `[afk] worker: wXXXX` lines from the slot log
  // to resolve all workers that ran in a parked slot — this stamp must appear
  // even when the worker fast-dies before writing worker.pid.
  process.stdout.write(`[afk] worker: ${workerId}\n`);

  // AFK runner improvement — Pattern 5 diagnostic: every spike worker died
  // post-commit + vitest with no exit code / signal / stack trace. Install
  // process-level death detectors that record every fatal event to a
  // per-worker diagnostic log at `.red/tmp/diagnostics/<id>.log`. The next
  // session (or a human running `cat` on the log) can then correlate
  // "agent idle for 1 minute → process absent" with the actual cause.
  // Opt-out via RED_AFK_NO_PROCESS_SAFETY=1 for environments where the
  // file IO itself is the suspected cause of the death.
  if (process.env.RED_AFK_NO_PROCESS_SAFETY !== "1") {
    installProcessSafety(
      fileSafetyLogger(safetyLogPath(paths.tmpDir, workerId)),
      { workerId, pid: process.pid },
    );
  }

  // Supervisor-dispatched reconcile worker: bypass the normal boot+session and
  // validate-and-land the specific parked branch for `--reconcile-issue <n>`.
  if (flags.reconcileIssue !== undefined) {
    return runReconcileWorker(flags.reconcileIssue, runner, ctx, paths, workerId);
  }

  const facts = await collectPrecheckFacts(ctx);
  const nowS = Math.floor(Date.now() / 1000);

  // Fleet supervisor owns the boot (#623): a worker spawned by the supervisor
  // carries RED_AFK_SWEEPS_DONE, signalling the shared sweeps already ran once
  // pre-spawn. Such a worker boots bootstrap+claim only — it skips every sweep
  // (cheap respawns; no race over `.red/tmp`). A solo `run` has no marker and
  // runs the full sweep suite exactly as before.
  const sweepsDone = process.env.RED_AFK_SWEEPS_DONE === "1";

  const sessionCtx: SessionContext = {
    runner,
    workerId,
    iterCap: flags.iterCap,
    once: flags.once,
    filter: flags.filter,
    alternate: flags.alternate,
    bootOnly: flags.bootOnly,
    // Reported by the --boot-only line so the dry-run states whether this worker
    // ran the sweeps or inherited them from the supervisor.
    sweepsSkipped: sweepsDone,
    issueTemplate: {
      tmpDir: paths.tmpDir,
      repo: ctx.repo,
      repoDir: ctx.root,
      remote: ctx.remote,
      model: settings.model,
    },
  };

  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

  // Boot discovery: orphan dirs, attempt-cap groups, branch refs, unblock
  // candidates. Resolved from disk/branches; gh state lookups stay lazy in the
  // boot deps.
  const bootstrap: BootstrapInput = {
    tmpDir: paths.tmpDir,
    stateDir: paths.stateDir,
    gitignorePath: paths.gitignorePath,
    workerDir: workerDirPath(paths.tmpDir, workerId),
    workerPidFile: workerPidFile(paths.tmpDir, workerId),
    workerPid: process.pid,
  };
  let bootOptions: BootOptions;
  let bootDeps: BootDeps;
  try {
    if (sweepsDone) {
      // Supervisor-owned boot (#623): skip the expensive discovery (branch
      // listings, orphan walk, unblock-candidate + parked-mechanical gh probes)
      // AND the sweep work itself. The minimal options carry empty sweep inputs
      // + skipSweeps:true; the minimal deps wire only the bootstrap fs calls.
      bootOptions = {
        precheck: facts,
        bootstrap,
        orphans: [],
        attemptCap: { byIssue: new Map() },
        branches: { remoteLiveRefs: [], localLiveRefs: [] },
        unblockCandidates: [],
        skipSweeps: true,
      };
      bootDeps = buildMinimalBootDeps(ctx, nowS);
    } else {
      bootOptions = await collectBootOptions(ctx, facts, bootstrap, nowS);
      bootDeps = await buildBootDeps(ctx, bootOptions, nowS);
    }
  } catch (err) {
    await recordBootError(bootstrap.workerDir, "boot-error", err).catch(() => {
      process.stderr.write(`[afk] boot-error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return 1;
  }

  // Feedback worktree manager — checks out the worker branch for the gate.
  // AFK runner improvement (Pattern 2): `feedbackRebaseBase` is set only when
  // the `afk.feedback.rebase_on_base` flag is on; undefined → no rebase
  // (default behaviour unchanged).
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  const feedback = makeFeedbackWorktree(ctx.root, paths.feedbackWorktreesDir, undefined, {
    rebaseOnto: settings.feedbackRebaseBase,
    resourceBudget: readValidationResourceBudget(config),
  });

  // Wire the boot reconcile runner into bootDeps (step 7, ADR 0055). A
  // supervisor-owned boot skips every sweep (including reconcile) and the fleet
  // dispatches reconcile per-tick instead, so the runner is wired only on the
  // solo / sweep-running path.
  if (!sweepsDone) {
    bootDeps = { ...bootDeps, reconcileRunner: makeBootReconcileRunner(ctx, paths, workerId, runner, feedback) };
  }

  // Per-issue mutable attempt context the process deps' envelope/iter-log close
  // over; buildProcessInput resets it before each processIssue call.
  const current: CurrentAttempt = { attemptDir: "" };
  const castleBridge = createCastleWorkerLaneBridge({
    redRoot: join(ctx.root, ".red"),
    workerId,
    attemptDir: () => current.attemptDir,
  });

  // --request/-r special block, threaded into the handoff the agent reads.
  const requestBlock = specialUserRequestBlock(flags.request);
  const sessionHooks = {
    config: loadConfig(afkPaths(ctx.root).configPath),
    resolveOptions: makeHookResolveOptions(ctx.root),
    exec: makeHookExec(ctx.root),
    env: hookEnv(ctx.repo, ctx.root, parseSlot(process.env.RED_AFK_SLOT), runner),
  };
  const resolvedSessionHooks = resolveHooks(sessionHooks.config, sessionHooks.resolveOptions);

  const deps: CastleWorkerDrainDeps<
    BootDeps,
    BootOptions,
    BootResult,
    ProcessIssueDeps,
    ProcessIssueInput,
    ProcessIssueResult,
    SessionIssueTemplate
  > = {
    gh: { listCandidates: () => ghx.listCandidates(ghCtx, dispatchIdentity.lane) },
    runBoot,
    bootDeps,
    bootOptions,
    // Wrap the per-issue orchestrator so the attempt's state file is marked
    // not-live once it returns. Without this a terminal-but-preserved attempt
    // (e.g. blocked → dir kept) would keep showing the still-live orchestrator
    // pid and read as a live worker in `monitor`. Guarded by pathExists: on the
    // DONE path the completion sweep already removed the dir, and updateState
    // would mkdir it back, resurrecting a reaped attempt — so skip when gone.
    processIssue: async (pd, pi) => {
      const result = await processIssue(pd, pi);
      if (result.outcome === "runner-transient") {
        await openRunnerCircuit(paths.runnerCircuitDir, pi.runner, Math.floor(Date.now() / 1000), process.env).catch(() => {});
      }
      // Abandon means DELETE (#644): buildProcessInput pre-creates the attempt
      // dir + state (current.number, live pid) BEFORE the claim, so a lost race
      // leaves them naming an issue this worker never owned. The next boot's
      // orphan sweep would misread that as a mid-issue crash and restore
      // ready-for-agent over the live winner's `running` label.
      if (result.outcome === "claim-lost") {
        await fsx.removeDir(pi.attemptDir).catch(() => {});
        return result;
      }
      const sp = join(pi.attemptDir, "afk.state.toon");
      if (await fsx.pathExists(sp)) {
        await updateState(sp, { pid: 0 }, { allowPidReset: true }).catch(() => {});
        await castleBridge.snapshot().catch(() => {});
      }
      return result;
    },
    processDeps: buildProcessDeps(
      ctx,
      settings.model,
      settings.sandbox,
      feedback,
      current,
      flags.fallbackRunner,
      runner,
      undefined,
      settings.maxIterations,
      settings.laneIdle,
      flags.verifyCommand,
      flags.goVerifyRetries,
      workerId,
    ),
    // Session-scoped lifecycle hooks (PRD #207): the castle drain owns the
    // session state machine, while dev supplies the existing hook dispatcher so
    // the configured hook surface and output stay unchanged.
    dispatchSessionHook: async (name: CastleSessionHookName, context: string) => {
      const result = await dispatchHooks(
        name as HookName,
        resolvedSessionHooks[name as HookName],
        context,
        sessionHooks.exec,
        {
          env: sessionHooks.env,
          log: (line) => process.stdout.write(`${line}\n`),
        },
      );
      return { aborted: result.aborted };
    },
    runnerCircuit: {
      isOpen: (r) => runnerCircuitOpen(paths.runnerCircuitDir, r, Math.floor(Date.now() / 1000)),
    },
    buildProcessInput: (candidate: IssueCandidate, c: SessionContext): ProcessIssueInput => {
      const recoveryOrdinal = nextAttemptSync(c.issueTemplate.tmpDir, candidate.number);
      // Long-running workers key workspaces by workerId+issueId. The retry
      // ordinal remains separate policy data for per-class recovery caps and
      // prior-failure prompt context; it no longer shapes the directory name.
      const attempt = 1;
      const attemptDir = buildWorkerAttemptPath(c.issueTemplate.tmpDir, c.workerId, candidate.number, attempt);
      // Point the session-scoped envelope/iter-log closures at this attempt.
      current.attemptDir = attemptDir;
      // Native-path observability (sibling of #350): the shell era's iter_open
      // initialised afk.state.toon here; the TS port's ensureAttemptDir is
      // mkdir-only, so every live native worker was invisible to `monitor` /
      // `statusline` and the fleet stall-detector (which key off this file's
      // pid + current.{number,activity} and its mtime). Restore it: write the
      // initial state with the live orchestrator pid so the worker shows up;
      // recordAgentEvent advances current.activity, and the processIssue wrapper
      // marks it not-live (pid:0) on terminal.
      //
      // SYNCHRONOUS on purpose: the agent-event sink + heartbeat fire async
      // `updateState` read-modify-writes against this same path. A fire-and-forget
      // async seed here raced them — a sink write that read the file before the
      // seed landed got the schema DEFAULT (pid 0, number "", worker_id ""),
      // patched only its vitals, and wrote that back, stranding the worker with
      // vitals but NO identity (rendered as a pid-0 `?`/idle ghost in monitor /
      // statusline). Seeding synchronously guarantees the identity exists before
      // any updateState runs, so every later read preserves it.
      const statePath = join(attemptDir, "afk.state.toon");
      const startedAt = new Date().toISOString();
      try {
        initStateSync(statePath, {
          worker_id: c.workerId,
          pid: process.pid,
          pid_start_time: pidStartTime,
          runner: c.runner,
          // Spawn-time provenance (issue #930): stamped once here, never mutated.
          // The entry point (`/afk`, `/go`) passes `--origin <label>`.
          origin: dispatchIdentity.origin,
          log: join(attemptDir, "afk.log"),
          started_at: startedAt,
          "current.kind": dispatchIdentity.kind,
          "current.number": candidate.number,
          "current.title": candidate.title,
          "current.worktree": join(attemptDir, "worktree"),
          "current.handoff": join(attemptDir, "handoff.md"),
          "current.started_at": startedAt,
          "current.runner": c.runner,
          "current.model": c.issueTemplate.model ?? "",
          "current.effort": settings.effort ?? "",
          "current.activity": "setup",
          // Macro-lifecycle phase seed (issue #811): the calm signal the
          // task-mirror title surfaces. `coding` is stamped on the first inner-
          // agent stream event; `validating`/`merging` by the orchestrator at the
          // gate/landing steps (deps.markPhase).
          "current.phase": "setup",
        });
        // Durable write-once identity sidecar (issue #1219): the immutable
        // worker_id/runner/origin/number/started_at the isolation fallback in
        // readWorkerState reads so a live isolation worker whose host-side
        // afk.state.toon is still zeroed renders its real identity instead of the
        // `?  run=-  00:00:00` ghost. Never clobbered by vitals updateState writes.
        writeIdentitySync(attemptDir, {
          worker_id: c.workerId,
          runner: c.runner,
          origin: dispatchIdentity.origin,
          number: candidate.number,
          started_at: startedAt,
        });
        void castleBridge.snapshot().catch(() => {});
      } catch {
        // Best-effort — a failed seed must never block the worker's actual work.
      }
      // Append the --request block into the handoff body so the inner agent
      // (which reads handoff.md as its prompt) sees the special request.
      const body = requestBlock ? `${candidate.body}\n\n${requestBlock}` : candidate.body;
      return {
        issue: candidate.number,
        title: candidate.title,
        body,
        runner: c.runner,
        workerId: c.workerId,
        // ADR 0066 claimant identity: `host:worker_id`, unique per worker process
        // per host so the GitHub-native claim never collides across machines. The
        // host half is a fingerprint, never the raw name — it lands in public
        // issue comments (#1327).
        claimant: workerIdentity(c.workerId),
        tmpDir: c.issueTemplate.tmpDir,
        attempt,
        recoveryOrdinal,
        attemptDir,
        repo: c.issueTemplate.repo,
        repoDir: c.issueTemplate.repoDir,
        remote: c.issueTemplate.remote,
        baseInput: { issueBody: candidate.body },
        runMode: runModeForCandidate(candidate, flags.prePr ? "no-mistakes" : flags.runMode),
        // Lane-aware claim preflight (#1045): the pre-claim state-validity recheck
        // must validate against the label this issue was SELECTED under (the
        // `--lane` value), not a hardcoded `ready-for-agent`. `flags.lane` is
        // undefined for `/afk` (→ defaults to `ready-for-agent` in processIssue)
        // and `lane:go`/`lane:scout` for the isolated `/go`/scout lanes.
        laneLabel: dispatchIdentity.lane,
      };
    },
    emit: (line: string) => process.stdout.write(`${line}\n`),
  };

  let summary;
  try {
    summary = await runCastleWorkerDrain(deps, sessionCtx);
  } catch (err) {
    await recordBootError(bootstrap.workerDir, "session-error", err).catch(() => {
      process.stderr.write(`[afk] session-error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return 1;
  } finally {
    await feedback.cleanup();
  }

  if (!summary.boot.precheck.ok) {
    const failed = summary.boot.precheck.failed;
    process.stderr.write(`[afk] precheck failed: ${failed}\n`);
    return 1;
  }

  // Runner exhaustion (single without --fallback-runner, or both runners under
  // it) ends the run with exit 75 (EX_TEMPFAIL) so a supervisor retries once the
  // quota resets, rather than treating it as a clean drain (0) or hard fail (1).
  if (summary.exhausted) {
    process.stderr.write(`[afk] runner exhausted — exiting 75 (EX_TEMPFAIL); rerun when quota resets\n`);
    return 75;
  }
  if (summary.runnerTransient) {
    process.stderr.write(`[afk] runner transport/setup failed — exiting 75 (EX_TEMPFAIL); rerun when the runner backend is healthy\n`);
    return 75;
  }

  // A targeted dispatch that attempted nothing is a failure, never a clean drain
  // (#2385): `/go` reported `progress: 1/1 (100%)` + exit 0 over a claim the
  // worker conceded without doing any work.
  const zeroAttempt = zeroAttemptDispatchFailure(flags.filter?.kind === "issues", summary.processed);
  if (zeroAttempt) {
    process.stderr.write(`[afk] targeted dispatch attempted no work: ${zeroAttempt} — exiting 1\n`);
    return 1;
  }

  return 0;
}
