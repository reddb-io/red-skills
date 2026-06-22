// commands/supervise.ts — the NATIVE fleet supervisor (the hidden `__supervise`
// command fleet.ts spawns instead of supervisor.sh).
//
// It writes the supervisor pid file, polls the stop file, and drives
// runSupervisor over real SupervisorDeps. Each slot spawns a `run --once` of
// THIS SAME BUNDLE (node process.execPath bin __run-once), so the whole fleet is
// native — no bash anywhere in the loop.

import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, writeFileSync, writeSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  type FleetHeartbeat,
  initSupervisorState,
  resolveSupervisorConfig,
  runSupervisor,
  type SupervisorDeps,
} from "../core/supervisor.js";
import { appendRecord } from "../core/jsonl-log.js";
import {
  afkPaths,
  resolveRepoSlug,
  collectPrecheckFacts,
  collectBootOptions,
  buildBootDeps,
  type RepoContext,
} from "../runtime/wire.js";
import { runBoot, type BootResult, type BootstrapInput } from "../core/boot.js";
import { inspectProcessTreeNative } from "../runtime/proc-tree.js";
import {
  agentLaneMtimeFor,
  parkedSlotWorkFor,
  resolveIterDirInfo,
  teardownIterDirNative,
} from "../runtime/supervisor-fs.js";
import * as ghx from "../runtime/gh.js";
import * as gitx from "../runtime/git.js";
import { planReconcileSweep, executeUnblockSweep } from "../core/boot-sweep.js";
import { removeDir as removeDirNative } from "../runtime/fs.js";
import { killTreeAndWait } from "../runtime/kill-tree.js";
import { resolveFleetHooks } from "../core/fleet-hook-config.js";
import { dispatchFleetHook } from "../core/fleet-hook-dispatcher.js";
import { makeHookExec, makeHookResolveOptions } from "../runtime/hooks.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fleetHeartbeatMessage(hb: FleetHeartbeat): string {
  return `fleet tick ready=${hb.readyForAgent} busy=${hb.slotsBusy} free=${hb.slotsFree} spawns=${hb.spawnsThisTick}`;
}

function fleetHeartbeatState(hb: FleetHeartbeat): string {
  return JSON.stringify(
    {
      ts: hb.ts,
      epoch: hb.epoch,
      last_progress_epoch: hb.lastProgressEpoch > 0 ? hb.lastProgressEpoch : undefined,
      runner: hb.runner,
      ready_for_agent: hb.readyForAgent,
      slots: {
        busy: hb.slotsBusy,
        free: hb.slotsFree,
        total: hb.slotsTotal,
        parked: hb.slotsParked,
      },
      spawns_this_tick: hb.spawnsThisTick,
    },
    null,
    2,
  );
}

function writeFleetStateAtomic(path: string, hb: FleetHeartbeat): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, fleetHeartbeatState(hb), "utf8");
  renameSync(tmp, path);
}

/**
 * Internal supervisor-only RED_AFK_* env vars that must NOT pass through to
 * spawned workers. These either drive the supervisor itself (target / poll /
 * breaker / stall thresholds) or are wired through dedicated paths (request,
 * runner, per-slot _BASE). Anything else prefixed `RED_AFK_` IS forwarded so an
 * operator can `export RED_AFK_SKIP_PERF=1` before launching the fleet and have
 * it reach every worker without writing a hook. Mirrors supervisor.sh's
 * PASSTHROUGH_DENYLIST exactly.
 */
export const PASSTHROUGH_DENYLIST: readonly string[] = [
  "RED_AFK_TARGET",
  "RED_AFK_REQUEST",
  "RED_AFK_RUNNER",
  // #623: the supervisor sets this explicitly on every spawned worker (below) so
  // the worker boots bootstrap+claim only. Deny it from the inherited passthrough
  // so an operator's stray `export RED_AFK_SWEEPS_DONE=1` can never reach a worker
  // by accident — only the supervisor's own re-pin grants it.
  "RED_AFK_SWEEPS_DONE",
  "RED_AFK_POLL_S",
  "RED_AFK_STALL_POLL_S",
  "RED_AFK_STALL_THRESHOLD_S",
  "RED_AFK_STALL_KILL_THRESHOLD_S",
  "RED_AFK_CIRCUIT_K",
  "RED_AFK_CIRCUIT_WINDOW_S",
  "RED_AFK_PLUGIN_DIR",
  "RED_AFK_SLOT",
  "RED_AFK_WORKER_ID",
  "RED_AFK_EXIT_CODE",
  "RED_AFK_DURATION_S",
];

/**
 * The set of operator `RED_AFK_*` vars forwarded to a worker: every `RED_AFK_*`
 * key in `source` that is NOT in {@link PASSTHROUGH_DENYLIST} and NOT a per-slot
 * `_BASE` build-isolation var. Pure over the injected env bag. Mirrors the
 * `compgen -e | grep '^RED_AFK_'` scan in build_passthrough_env, exposed
 * separately so the denylist logic is unit-testable.
 */
export function passthroughKeys(source: Record<string, string | undefined>): string[] {
  const deny = new Set(PASSTHROUGH_DENYLIST);
  return Object.keys(source)
    .filter((key) => key.startsWith("RED_AFK_") && !deny.has(key) && !key.endsWith("_BASE"))
    .sort();
}

/**
 * Build the full worker env for a spawned slot. Start from the supervisor's
 * environment, STRIP every internal supervisor knob ({@link PASSTHROUGH_DENYLIST})
 * and every per-slot `_BASE` build-isolation var so they can never leak to the
 * worker, then re-pin `RED_AFK_RUNNER` to the supervisor's runner. Operator-set
 * `RED_AFK_*` vars and the rest of the environment pass through untouched. Pure
 * over the injected env bag for testing (build_passthrough_env intent).
 */
export function buildWorkerEnv(
  source: Record<string, string | undefined>,
  runner: string,
): Record<string, string> {
  const deny = new Set(PASSTHROUGH_DENYLIST);
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(source)) {
    if (val === undefined) continue;
    if (key.startsWith("RED_AFK_") && (deny.has(key) || key.endsWith("_BASE"))) continue;
    out[key] = val;
  }
  out.RED_AFK_RUNNER = runner;
  // Fleet supervisor owns the boot (#623): mark every spawned worker so it boots
  // bootstrap+claim only (skips the shared sweeps the supervisor already ran
  // pre-spawn). Read by `run`'s runCommand → BootOptions.skipSweeps. The marker
  // is the sole grant — it is in PASSTHROUGH_DENYLIST so it can't leak in from
  // the operator env, exactly mirroring how RED_AFK_RUNNER is re-pinned above.
  out.RED_AFK_SWEEPS_DONE = "1";
  return out;
}

/**
 * Pin RED_AFK_SLOT on a worker env for a specific fleet slot. The base env
 * was stripped of RED_AFK_SLOT by buildWorkerEnv (it is in PASSTHROUGH_DENYLIST
 * so it cannot leak from one slot to another); this re-adds it per-slot so the
 * cargo/gradle pre_worktree defaults can resolve the correct per-slot build dir.
 */
export function buildSlotEnv(
  workerEnv: Record<string, string>,
  slot: number,
): Record<string, string> {
  return { ...workerEnv, RED_AFK_SLOT: String(slot) };
}

/**
 * Parse the supervisor's own argv (forwarded by fleet.ts) into the filter /
 * runner-swap policy flags each slot's `run --once` must carry, so a supervised
 * fleet honours the same PRD/issue filter + alternate/fallback policy a single
 * `/afk run` would. Recognises the value flags `--prd` / `--issues` / `--request`
 * (with `-r`) and the boolean flags `--alternate` / `--fallback-runner`, all in
 * both `--flag value` and `--flag=value` forms. Unknown args are dropped (the
 * supervisor only forwards the known filter/policy surface). Returns the argv
 * fragment to append after `run --once --runner <r>`.
 */
export function slotFilterArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  const valueFlags = new Map<string, string>([
    ["--prd", "--prd"],
    ["--issues", "--issues"],
    ["--request", "--request"],
    ["-r", "--request"],
  ]);
  const boolFlags = new Set(["--alternate", "--fallback-runner"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      const head = arg.slice(0, eq);
      const canonical = valueFlags.get(head);
      if (canonical) {
        out.push(canonical, arg.slice(eq + 1));
        continue;
      }
    }
    const canonical = valueFlags.get(arg);
    if (canonical) {
      const value = args[i + 1];
      if (value !== undefined) {
        out.push(canonical, value);
        i += 1;
      }
      continue;
    }
    if (boolFlags.has(arg)) {
      out.push(arg);
      continue;
    }
  }
  return out;
}

/**
 * Render a one-line summary of a {@link BootResult} for the supervisor log
 * (#623). A precheck failure is reported as such (workers still run their own);
 * otherwise the per-sweep counts are listed so an operator can confirm the
 * fleet's single boot did its work. Pure over the result.
 */
export function formatBootSweepResult(result: BootResult): string {
  if (!result.precheck.ok) {
    return `boot sweeps: precheck FAILED (${result.precheck.failed}) — workers will run their own precheck`;
  }
  const oc = result.orphanCleanup;
  const ac = result.attemptCap;
  const bc = result.branchCleanup;
  const us = result.unblockSweep;
  const st = result.straggler;
  return (
    "boot sweeps complete: " +
    `orphans removed=${oc?.removed.length ?? 0} restored=${oc?.restored.length ?? 0} kept=${oc?.kept.length ?? 0}` +
    ` | attempt-cap reclaimed=${ac?.reclaimed.length ?? 0}` +
    ` | branches snapshot=${bc?.snapshotReaped.length ?? 0} remote=${bc?.remoteLiveReaped.length ?? 0} local=${bc?.localLiveReaped.length ?? 0}` +
    ` | unblocked=${us?.promoted.length ?? 0}` +
    ` | stragglers unlabeled=${st?.counts.unlabeled ?? 0} triage=${st?.counts.needsTriage ?? 0} info=${st?.counts.needsInfo ?? 0}`
  );
}

/**
 * Build the supervisor's pre-spawn boot closure (#623). Runs the FULL shared
 * sweep suite a single time — precheck, bootstrap, orphan cleanup, attempt cap,
 * branch cleanup, unblock sweep, straggler check — over real IO, then logs the
 * result via `log`. The reconcile sweep (boot step 7) is intentionally NOT wired
 * (no reconcileRunner): the fleet dispatches reconcile per-tick instead, so
 * landing parked branches at boot would duplicate that path. A throw propagates
 * to runSupervisor, which logs it and spawns workers anyway.
 *
 * The bootstrap writes a supervisor-scoped `afk-supervisor-boot.pid` alongside
 * the supervisor pid file (NOT a worker dir), so it is never mistaken for a live
 * worker by the monitor or a later orphan sweep.
 */
export function buildSupervisorBootSweeps(
  root: string,
  repo: string,
  log: (line: string) => void,
): () => Promise<void> {
  const ctx: RepoContext = { root, repo, remote: "origin" };
  const paths = afkPaths(root);
  return async (): Promise<void> => {
    const nowS = Math.floor(Date.now() / 1000);
    const facts = await collectPrecheckFacts(ctx);
    const bootstrap: BootstrapInput = {
      tmpDir: paths.tmpDir,
      stateDir: paths.stateDir,
      gitignorePath: paths.gitignorePath,
      workerDir: paths.tmpDir,
      workerPidFile: join(paths.tmpDir, "afk-supervisor-boot.pid"),
      workerPid: process.pid,
    };
    const options = await collectBootOptions(ctx, facts, bootstrap, nowS);
    const bootDeps = await buildBootDeps(ctx, options, nowS);
    const result = await runBoot(bootDeps, options);
    log(formatBootSweepResult(result));
  };
}

/**
 * Build SupervisorDeps backed by REAL process / filesystem / gh IO. Every
 * closure mirrors a supervisor.sh function (see runtime/proc-tree.ts +
 * runtime/supervisor-fs.ts) and is best-effort: a failed ps / stat / gh degrades
 * to the SAFE value and never throws out of the closure.
 *
 * Slot pids are tracked in a per-slot map keyed by slot index. `spawnSlot`
 * records the pid; the fs/proc closures resolve the live worker through it
 * (mirroring SLOT_PIDS[$slot] in bash, which is how find_slot_iter_dir /
 * agentLaneMtime / inspectTree all reach the running worker tree).
 */
function buildSupervisorDeps(
  root: string,
  tmpDir: string,
  logFd: number,
  firehosePath: string,
  statePath: string,
  runner: string,
  ghCtx: ghx.GhContext,
  slotArgs: readonly string[],
  hookEnvBase: Record<string, string>,
): SupervisorDeps {
  const bundle = process.argv[1];
  const now = () => Math.floor(Date.now() / 1000);
  // Per-tick / boot liveness line into afk-supervisor.log (best-effort). Shared
  // by `log` and the pre-spawn boot sweeps so both land in the supervisor log.
  const logLine = (line: string): void => {
    try {
      writeSync(logFd, `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      // best-effort: a log-write failure must never affect the loop.
    }
  };
  // Fleet hook resolution: library defaults-dir + project .red/hooks/ layering,
  // same convention as worker hooks (ADR 0026, #830, #833).
  const resolveOptions = makeHookResolveOptions(root);
  const fleetHooks = resolveFleetHooks({
    libraryHooksDir: resolveOptions.libraryHooksDir,
    projectHooksDir: resolveOptions.projectHooksDir,
  });
  const fleetHookExec = makeHookExec(root, resolveOptions.libraryHooksDir);
  // slot index → live orchestrator pid (SLOT_PIDS parity).
  const slotPids = new Map<number, number>();
  // slot index → exit code of the most recent worker for that slot.
  const slotExitCodes = new Map<number, number>();
  // Worker env (build_passthrough_env parity): start from the supervisor's full
  // env, then STRIP every internal supervisor knob in PASSTHROUGH_DENYLIST plus
  // every per-slot `_BASE` build-isolation var, so they never leak to the worker
  // (gap 4). Operator-set RED_AFK_* vars (RED_AFK_SKIP_PERF, etc) and the rest of
  // the environment survive. RED_AFK_RUNNER is re-added explicitly below so the
  // worker's detection cascade pins the supervisor's runner.
  const workerEnv = buildWorkerEnv(process.env, runner);

  return {
    proc: {
      spawnSlot: async (slot) => {
        // Forward the PRD/issue filter + runner-swap policy so a supervised
        // fleet honours the same filter a single `/afk run` would (gap 5).
        const runArgs = ["run", "--once", "--runner", runner, ...slotArgs];
        // Each slot gets its own log file so the circuit-trip sweep can
        // resolve which worker IDs ran in the slot via parseWorkerIdsFromLog
        // (mirrors spawn_slot's per-slot slot_log in supervisor.sh).
        const slotLogFile = join(tmpDir, `afk-supervisor-slot-${slot}.log`);
        const slotFd = openSync(slotLogFile, "a");
        const child = spawn(process.execPath, [bundle, ...runArgs], {
          cwd: root,
          env: buildSlotEnv(workerEnv, slot),
          detached: true,
          stdio: ["ignore", slotFd, slotFd],
        });
        // Close the parent's copy — the child inherits it and keeps it open.
        closeSync(slotFd);
        child.on("exit", (code) => {
          // null means killed by signal; treat as non-clean (1).
          slotExitCodes.set(slot, code ?? 1);
        });
        child.unref();
        const pid = child.pid ?? 0;
        slotPids.set(slot, pid);
        return { pid, spawnEpoch: now() };
      },
      spawnReconcileWorker: async (slot, candidate) => {
        const runArgs = [
          "run", "--once", "--runner", runner,
          "--reconcile-issue", String(candidate.issue),
          ...slotArgs,
        ];
        const child = spawn(process.execPath, [bundle, ...runArgs], {
          cwd: root,
          env: buildSlotEnv(workerEnv, slot),
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.on("exit", (code) => {
          // null means the process was killed by a signal; treat as non-clean (1).
          slotExitCodes.set(slot, code ?? 1);
        });
        child.unref();
        const pid = child.pid ?? 0;
        slotPids.set(slot, pid);
        return { pid, spawnEpoch: now() };
      },
      lastExitCode: (slot) => slotExitCodes.get(slot) ?? null,
      isAlive,
      // Wait-and-escalate killer (#580): SIGTERM → grace → SIGKILL → CONFIRM the
      // tree is gone, then return whether it actually died. The reaper gates its
      // `rm -rf` worktree teardown on this, so a SIGTERM-ignoring worker can
      // never be torn down out from under itself.
      killTree: (pid) => killTreeAndWait(pid),
      // Real ps-backed tree sample. A ps failure returns a CONSERVATIVE BUSY
      // snapshot (never []), so a transient ps error can never authorise a reap.
      inspectTree: (pid) => inspectProcessTreeNative(pid),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    fs: {
      agentLaneMtime: (slot) => agentLaneMtimeFor(tmpDir, slotPids.get(slot) ?? null),
      resolveIterDir: (slot) => resolveIterDirInfo(tmpDir, slotPids.get(slot) ?? null, now()),
      teardownIterDir: async (info) => {
        await teardownIterDirNative(info, root);
      },
      parkedSlotWork: (slot, lastPid) => parkedSlotWorkFor(tmpDir, slot, lastPid),
      removeDir: async (path) => {
        try {
          await removeDirNative(path);
        } catch {
          // best-effort
        }
      },
    },
    gh: {
      comment: async (issue, body) => {
        try {
          await ghx.comment(ghCtx, issue, body);
        } catch {
          // best-effort
        }
      },
      editLabels: async (issue, add, remove) => {
        try {
          await ghx.editLabels(ghCtx, issue, remove, add);
        } catch {
          // best-effort
        }
      },
      ensureRunnerErrorLabel: async () => {
        try {
          await ghx.ensureRunnerErrorLabel(ghCtx);
        } catch {
          // best-effort
        }
      },
      ensureLabel: async (name) => {
        try {
          await ghx.ensureLabel(ghCtx, name);
        } catch {
          // best-effort
        }
      },
      readyQueueDepth: async () => {
        try {
          return await ghx.countReadyForAgent(ghCtx);
        } catch {
          return 0;
        }
      },
      findReconcileCandidate: async () => {
        try {
          const [candidates, remoteBranches] = await Promise.all([
            ghx.listParkedMechanicalCandidates(ghCtx),
            gitx.listRemoteBranches({ cwd: root }, "afk/"),
          ]);
          const branchNames = remoteBranches.map((r) => r.branch);
          const plans = planReconcileSweep(candidates, branchNames);
          if (plans.length === 0) return null;
          const first = plans[0]!;
          return { issue: first.number, branch: first.branch };
        } catch {
          return null;
        }
      },
      // #815: running-supervisor crash reconcile. Resolve whether a dead worker's
      // claimed issue is still stranded in `running` with no terminal envelope.
      crashedClaimState: async (issue) => {
        try {
          return await ghx.crashedClaimState(ghCtx, issue);
        } catch {
          return { ghOk: false, stillRunning: false, envelopePosted: false };
        }
      },
    },
    now,
    // Env for the bounded stalled re-claim cap (#402): RED_AFK_RETRY_STALLED.
    recoveryEnv: process.env,
    // Per-tick liveness line into afk-supervisor.log (best-effort). Makes a
    // healthy fleet's heartbeat — and a wedged one's silence — observable.
    log: logLine,
    // Fleet supervisor owns the boot (#623): runSupervisor calls this ONCE before
    // the initial spawn. Runs the full shared sweep suite over real IO and logs
    // the result; each worker then boots bootstrap+claim only.
    bootSweeps: buildSupervisorBootSweeps(root, ghCtx.repo, logLine),
    // Periodic dependency Unblock Sweep on the supervisor tick (#844). Re-uses the
    // boot sweep's executeUnblockSweep core over fresh gh reads: list open
    // blocked:dependency issues, resolve each req:* blocker, promote only the
    // fully-unblocked ones. Short-circuits to [] when nothing is dependency-blocked
    // (one cheap `gh issue list`), so a drained tracker costs ~nothing. Best-effort:
    // any gh failure resolves to [] and is retried on the next due tick.
    unblockSweep: async () => {
      try {
        const candidates = await ghx.listUnblockCandidates(ghCtx);
        if (candidates.length === 0) return [];
        return await executeUnblockSweep(
          candidates,
          (issue) => ghx.blockerState(ghCtx, issue),
          {
            editLabels: async (issue, remove, add) => {
              await ghx.editLabels(ghCtx, issue, remove, add);
            },
            comment: async (issue, body) => {
              await ghx.comment(ghCtx, issue, body);
            },
          },
        );
      } catch {
        return [];
      }
    },
    // Fleet-scoped lifecycle hooks (#833). Commands are resolved from the same
    // .red/hooks/<point>/ + library layering as worker hooks. Best-effort:
    // a dispatch failure is returned to the caller; the caller catches and logs.
    dispatchFleetHook: async (name, context) => {
      const commands = fleetHooks[name];
      return dispatchFleetHook(name, commands, context, fleetHookExec, {
        env: hookEnvBase,
        log: logLine,
      });
    },
    emitFleetHeartbeat: async (hb) => {
      try {
        writeFleetStateAtomic(statePath, hb);
      } catch {
        // best-effort: state-file failure must not affect the supervisor.
      }
      try {
        await appendRecord(firehosePath, "heartbeat", fleetHeartbeatMessage(hb), {
          ts: hb.ts,
          fields: {
            worker: "fleet",
            extra: {
              scope: "fleet",
              runner: hb.runner,
              ready_for_agent: String(hb.readyForAgent),
              slots_busy: String(hb.slotsBusy),
              slots_free: String(hb.slotsFree),
              slots_total: String(hb.slotsTotal),
              slots_parked: String(hb.slotsParked),
              spawns_this_tick: String(hb.spawnsThisTick),
            },
          },
        });
      } catch {
        // best-effort: firehose failure must not affect the supervisor.
      }
    },
  };
}

/**
 * Drive the native fleet supervisor. Honours the same pid/stop-file protocol
 * fleet.ts's launch/stop already speak.
 */
export async function superviseCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const root = cwd;
  const paths = afkPaths(root);
  const tmp = paths.tmpDir;
  const pidFile = join(tmp, "afk-supervisor.pid");
  const stopFile = join(tmp, "afk-supervisor.stop");
  const logFile = join(tmp, "afk-supervisor.log");
  const firehoseFile = paths.fleetFirehosePath;
  const stateFile = paths.fleetStatePath;

  await import("../runtime/fs.js").then((m) => m.ensureDir(tmp));
  // single-supervisor lock
  if (existsSync(pidFile)) {
    try {
      const prev = Number(require("node:fs").readFileSync(pidFile, "utf8").trim());
      if (prev && isAlive(prev)) {
        process.stderr.write(`supervisor already running (pid=${prev})\n`);
        return 1;
      }
    } catch {
      // stale — overwrite
    }
  }
  writeFileSync(pidFile, String(process.pid), "utf8");
  // clear any stale stop file
  if (existsSync(stopFile)) rmSync(stopFile, { force: true });

  const logFd = openSync(logFile, "a");
  const config = resolveSupervisorConfig();
  const state = initSupervisorState(config.target);
  const repo = await resolveRepoSlug(root).catch(() => "");
  const ghCtx = { cwd: root, repo };
  // The filter/policy flags fleet.ts forwarded (--prd/--issues/--alternate/
  // --fallback-runner/--request), threaded into every slot's `run --once`.
  const slotArgs = slotFilterArgs(args);
  // Base env for fleet hooks: RED_AFK_REPO, RED_AFK_ROOT, RED_AFK_RUNNER.
  const hookEnvBase: Record<string, string> = {
    RED_AFK_ROOT: root,
    RED_AFK_WORKSPACE: root,
    RED_AFK_RUNNER: config.runner,
    ...(repo.length > 0 ? { RED_AFK_REPO: repo } : {}),
  };
  const deps = buildSupervisorDeps(root, tmp, logFd, firehoseFile, stateFile, config.runner, ghCtx, slotArgs, hookEnvBase);

  const stopRequested = (): boolean => existsSync(stopFile);

  try {
    await runSupervisor(state, deps, config, stopRequested);
  } finally {
    rmSync(pidFile, { force: true });
    rmSync(stopFile, { force: true });
  }
  return 0;
}
