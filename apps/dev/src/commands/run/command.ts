import { parseRunnerFlag, detectRunner } from "../../core/runner-detection.js";
import { callerProcessTreeNative } from "../../runtime/caller-process.js";
import {
  runModeForCandidate,
  type SessionContext,
  type SessionIssueTemplate,
  type IssueCandidate,
} from "../../core/session.js";
import { genWorkerId } from "../../core/session.js";
import { SUPERVISOR_LANE_ENV } from "../../core/supervisor-lane.js";
import { runBoot, type BootDeps, type BootOptions, type BootResult, type BootstrapInput } from "../../core/boot.js";
import { processIssue, type ProcessIssueDeps, type ProcessIssueInput, type ProcessIssueResult } from "../../core/process-issue.js";
import { remoteTrackingBaseRef } from "../../core/process-issue/types.js";
import { isRunner, type Runner } from "../../types/runner.js";
import { zeroAttemptDispatchFailure } from "../../core/go.js";
import {
  formatOrphanBranchListing,
  isPushOnlyDispatch,
  issueFromBranchRef,
  listOrphanBranches,
  orphanedWorkDispatchFailure,
  type OrphanBranch,
} from "../../core/orphan-branch.js";
import {
  afkPaths,
  collectBootPrecheckFacts,
  collectBootOptions,
  collectMonitorInputs,
  buildBootDeps,
  buildMinimalBootDeps,
  resolveRepoContext,
  resolveRunSettings,
} from "../../runtime/wire.js";
import { workerDir as workerDirPath, workerPidFile, buildWorkerAttemptPath } from "../../core/worker-paths.js";
import * as ghx from "../../runtime/gh.js";
import * as fsx from "../../runtime/fs.js";
import { migrateLegacyDevPaths } from "../../runtime/red-path-migration.js";
import type { GhContext } from "../../runtime/gh.js";
import { getConfig, loadConfig, readValidationResourceBudget } from "../../core/config.js";
import { resolveHooks, validateHookConfig, UnknownHookError, type HookName } from "../../core/hook-config.js";
import { dispatchHooks } from "../../core/hook-dispatcher.js";
import {
  createEnginePaths,
  readHostCapabilityProfile,
  runCastleWorkerDrain,
  type CastleSessionHookName,
  type CastleWorkerDrainDeps,
  type HostCapabilityProfile,
} from "@reddb-io/red-castle/engine";
import { rmSync, writeFileSync } from "node:fs";
import { isLivePid } from "../../runtime/kill-tree.js";
import { specialUserRequestBlock } from "../../core/runner-spawn.js";
import { makeHookExec, makeHookResolveOptions, hookEnv } from "../../runtime/hooks.js";
import { makeFeedbackWorktree } from "../../runtime/feedback-worktree.js";
import {
  installProcessSafety,
  fileSafetyLogger,
  safetyLogPath,
} from "../../core/process-safety.js";
import { dirname, join } from "node:path";
import { workerIdentity } from "../../core/host-identity.js";
import { initStateSync, readPidStartTime, updateState, workerStatePath, writeIdentitySync } from "../../core/state.js";
import { createCastleWorkerLaneBridge } from "../../core/castle-worker-lane-bridge.js";
import { HOST_CONFIG_EXIT_CODE } from "../../core/worker-outcome.js";

import { checkBootGuard, isNamespacedDispatch, parseRunFlags, resolveRunDispatchIdentity, shouldSkipBootSweeps, type RunOptions } from "./flags.js";
import { buildProcessDeps, parseSlot, type CurrentAttempt } from "./process-deps.js";
import { makeBootReconcileRunner, runReconcileWorker } from "./reconcile.js";
import { initBootWorkerState, openRunnerCircuit, recordBootError, requeueOrdinalSync, runnerCircuitOpen } from "./state.js";

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
  const hostProfile = await readHostCapabilityProfile(
    createEnginePaths(join(ctx.root, ".red")),
  );

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
  //
  // A Worker born through the host daemon is HANDED its id (`RED_AFK_WORKER_ID`,
  // #2851): the daemon already recorded that string as the Worker's identity on
  // the host event lane before this process existed, so minting a second one
  // here would leave the host and the work naming the same Worker differently
  // and no surface able to join them. A directly-invoked `run` still mints,
  // which is what keeps the standalone lane working with no daemon in it.
  const existing = new Set((await collectMonitorInputs(cwd)).workers.map((w) => w.state.worker_id));
  const assigned = (process.env.RED_AFK_WORKER_ID ?? "").trim();
  const workerId = assigned !== "" && !existing.has(assigned)
    ? assigned
    : genWorkerId(Math.random, (id) => existing.has(id));
  const pidStartTime = readPidStartTime(process.pid) ?? "";
  // Emit the per-slot boot-stamp immediately so the supervisor's slot log
  // captures this worker's ID before any failure. The circuit-trip sweep
  // (sweepParkedSlot) parses `[afk] worker: wXXXX` lines from the slot log
  // to resolve all workers that ran in a parked slot — this stamp must appear
  // even when the worker fast-dies before writing worker.pid.
  process.stdout.write(`[afk] worker: ${workerId}\n`);
  const bootStatePath = await initBootWorkerState({
    tmpDir: paths.tmpDir,
    workerId,
    pid: process.pid,
    pidStartTime,
    runner,
    origin: dispatchIdentity.origin,
    kind: dispatchIdentity.kind,
    model: settings.model,
    effort: settings.effort,
  }).catch(() => undefined);

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

  const facts = await collectBootPrecheckFacts(ctx, {
    log: (line) => process.stdout.write(`[afk] ${line}\n`),
  });
  const nowS = Math.floor(Date.now() / 1000);

  // Fleet workers inherit completed sweeps (#623). Explicit issue dispatches
  // defer shared hygiene to fleet/untargeted boots (#2487), so reconcile work
  // cannot delay the named target before claim. Both paths use minimal boot.
  const supervisorSweepsDone = process.env.RED_AFK_SWEEPS_DONE === "1";
  const skipSweeps = shouldSkipBootSweeps(flags.filter, supervisorSweepsDone);

  const sessionCtx: SessionContext & { hostProfile?: HostCapabilityProfile } = {
    runner,
    workerId,
    iterCap: flags.iterCap,
    once: flags.once,
    filter: flags.filter,
    alternate: flags.alternate,
    bootOnly: flags.bootOnly,
    // Reported by the --boot-only line so the dry-run states whether this worker
    // ran the sweeps or inherited them from the supervisor.
    sweepsSkipped: skipSweeps,
    ...(hostProfile !== undefined ? { hostProfile } : {}),
    issueTemplate: {
      tmpDir: paths.tmpDir,
      repo: ctx.repo,
      repoDir: ctx.root,
      remote: ctx.remote,
      model: settings.model,
    },
  };

  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

  // Concretize a `--user @me` territory facet before anything consumes the
  // filter, so the castle drain, the session preview, and every forwarded
  // `--selector` all carry a real login.
  if (sessionCtx.filter.kind === "selector" && sessionCtx.filter.selector.user === "@me") {
    sessionCtx.filter = {
      kind: "selector",
      selector: await ghx.resolveSelectorUser(sessionCtx.filter.selector, () =>
        ghx.resolveViewerLogin(ghCtx),
      ),
    };
  }

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
    if (skipSweeps) {
      // Minimal boot (#623, #2487): skip the expensive discovery (branch
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

  // Wire the boot reconcile runner only when this boot actually owns sweeps.
  if (!skipSweeps) {
    bootDeps = { ...bootDeps, reconcileRunner: makeBootReconcileRunner(ctx, paths, workerId, runner, feedback) };
  }

  // Per-issue mutable attempt context the process deps' envelope/iter-log close
  // over; buildProcessInput resets it before each processIssue call.
  const current: CurrentAttempt = { attemptDir: "" };
  const castleBridge = createCastleWorkerLaneBridge({
    redRoot: join(ctx.root, ".red"),
    workerId,
    attemptDir: () => current.attemptDir,
    supervisorLane: process.env[SUPERVISOR_LANE_ENV] || undefined,
  });

  // --request/-r special block, threaded into the handoff the agent reads.
  const requestBlock = specialUserRequestBlock(flags.request);
  const sessionHooksConfig = loadConfig(afkPaths(ctx.root).configPath);

  // Validate hook names once before the session loop. An unknown hook name
  // (including a misspelled name where the user intended a list entry) must not
  // crash the worker at first issue pick-up and trigger a supervisor churn loop.
  // Write the retire file so the supervisor does not respawn this slot on exit.
  try {
    validateHookConfig(sessionHooksConfig);
  } catch (err) {
    const msg = err instanceof UnknownHookError
      ? `[afk:config] fatal: ${err.message} in .red/config.yaml — fix the hook name and restart the fleet`
      : `[afk:config] fatal: hook config error: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`${msg}\n`);
    const retireFile = process.env.RED_AFK_RETIRE_FILE;
    if (retireFile) {
      try { writeFileSync(retireFile, ""); } catch { /* best-effort */ }
    }
    return 1;
  }

  const sessionHooks = {
    config: sessionHooksConfig,
    resolveOptions: makeHookResolveOptions(ctx.root),
    exec: makeHookExec(ctx.root),
    env: hookEnv(ctx.repo, ctx.root, parseSlot(process.env.RED_AFK_SLOT), runner),
  };
  const resolvedSessionHooks = resolveHooks(sessionHooks.config, sessionHooks.resolveOptions);

  // Held in a binding rather than inlined into `deps`: the same lookups the
  // lifecycle uses to discover branches answer the exit-time orphaned-work
  // census (#2893), and a second wiring would be a second thing to keep true.
  const processDeps = buildProcessDeps({
    ctx,
    model: settings.model,
    sandbox: settings.sandbox,
    feedback,
    current,
    fallbackRunner: flags.fallbackRunner,
    runner,
    maxIterations: settings.maxIterations,
    laneIdle: settings.laneIdle,
    inlineVerifyCommand: flags.verifyCommand,
    goVerifyRetries: flags.goVerifyRetries,
    workerId,
  });

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
      const sp = workerStatePath(pi.attemptDir);
      if (await fsx.pathExists(sp)) {
        await updateState(sp, { pid: 0 }, { allowPidReset: true }).catch(() => {});
        await castleBridge.snapshot().catch(() => {});
      }
      return result;
    },
    processDeps,
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
      if (bootStatePath) {
        rmSync(dirname(bootStatePath), { recursive: true, force: true });
      }
      const recoveryOrdinal = requeueOrdinalSync(paths.historyPath, candidate.number);
      // Long-running workers key workspaces by workerId+issueId. The re-queue
      // ordinal remains separate policy data for the per-class recovery caps; it
      // is counted off the history ledger, never off a directory name (ADR 0103).
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
      const statePath = workerStatePath(attemptDir);
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
  if (summary.hostConfig) {
    process.stderr.write(
      `[afk] fatal host configuration — exiting ${HOST_CONFIG_EXIT_CODE} (EX_CONFIG); fix the required shell/workspace before restarting this worker\n`,
    );
    return HOST_CONFIG_EXIT_CODE;
  }

  // A targeted dispatch that attempted nothing is a failure, never a clean drain
  // (#2385): `/go` reported `progress: 1/1 (100%)` + exit 0 over a claim the
  // worker conceded without doing any work.
  const zeroAttempt = zeroAttemptDispatchFailure(flags.filter?.kind === "issues", summary.processed);
  if (zeroAttempt) {
    process.stderr.write(`[afk] targeted dispatch attempted no work: ${zeroAttempt} — exiting 1\n`);
    return 1;
  }

  // A dispatch answers for the work it pushed (#2893). Commits sitting on a
  // branch with no open pull request have no route to `main`, and a run that
  // exits 0 over them is recorded as successful — so nothing re-dispatches and
  // the branch sits on origin until a human reads `git branch -r` by hand.
  const trunk = getConfig(config, "dev.trunk") || "main";
  const orphans = await censusOrphanedWork({
    lookups: processDeps.lookups,
    fetchBase: processDeps.git.fetchBase?.bind(processDeps.git),
    issues: summary.processed.map((p) => p.issue),
    trunk,
    // Against the FRESH REMOTE trunk, never the local branch (ADR 0083): a
    // stale local `main` does not carry what already landed, so every merged
    // branch would read as commits ahead and the check would accuse the work it
    // just finished landing.
    base: remoteTrackingBaseRef(ctx.remote, trunk),
  });
  if (orphans.length > 0) {
    for (const line of formatOrphanBranchListing(orphans)) {
      process.stderr.write(`[afk] orphaned work: ${line}\n`);
    }
  }
  const orphanFailure = orphanedWorkDispatchFailure({
    targeted: flags.filter?.kind === "issues",
    pushOnly: isPushOnlyDispatch({
      kind: dispatchIdentity.kind,
      runMode: flags.runMode,
      localMerge: flags.localMerge,
    }),
    orphans,
  });
  if (orphanFailure) {
    process.stderr.write(
      `[afk] dispatch left work with no route to ${trunk}: ${orphanFailure} — exiting 1\n`,
    );
    return 1;
  }

  return 0;
}

/**
 * Ask the same lookups the lifecycle uses what each processed issue's branch
 * holds, and which of those branches no open pull request carries (#2893).
 *
 * Best-effort throughout: a probe that cannot answer yields an unknown commit
 * count, which is listed but never fails the run. A run whose lookups are absent
 * entirely (a minimal/faked wiring) censuses nothing.
 */
async function censusOrphanedWork(input: {
  lookups: ProcessIssueDeps["lookups"];
  fetchBase: ((base: string) => Promise<void>) | undefined;
  issues: readonly number[];
  trunk: string;
  base: string;
}): Promise<OrphanBranch[]> {
  if (input.issues.length === 0) return [];
  const { lookups } = input;
  try {
    // Refresh the remote trunk first: the census is only as true as the base it
    // counts against, and a ref last fetched when the attempt started reads the
    // work this very run landed as still ahead.
    await input.fetchBase?.(input.trunk).catch(() => {});
    const refs = await lookups.discoverBranches?.() ?? [];
    const scope = new Set(input.issues);
    const mine = refs.filter((ref) => {
      const issue = issueFromBranchRef(ref.branch);
      return issue !== null && scope.has(issue);
    });
    if (mine.length === 0) return [];
    const branches = await Promise.all(
      mine.map(async (ref) => ({
        branch: ref.branch,
        commitsAhead: await lookups.branchCommitsAhead?.(ref.branch, input.base).catch(() => undefined),
      })),
    );
    // The open-PR census is per-issue in the lookup's signature but repo-wide in
    // its implementation; one call is enough and every issue reads the same list.
    const openPullRequests = await lookups.discoverOpenPullRequests?.(input.issues[0] as number) ?? [];
    return listOrphanBranches({ branches, openPullRequests, issues: input.issues });
  } catch {
    return [];
  }
}
