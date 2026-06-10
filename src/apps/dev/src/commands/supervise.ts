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
import { afkPaths, resolveRepoSlug } from "../runtime/wire.js";
import { inspectProcessTreeNative } from "../runtime/proc-tree.js";
import {
  agentLaneMtimeFor,
  parkedSlotWorkFor,
  resolveIterDirInfo,
  teardownIterDirNative,
} from "../runtime/supervisor-fs.js";
import * as ghx from "../runtime/gh.js";
import { removeDir as removeDirNative } from "../runtime/fs.js";

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
  return out;
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
): SupervisorDeps {
  const bundle = process.argv[1];
  const now = () => Math.floor(Date.now() / 1000);
  // slot index → live orchestrator pid (SLOT_PIDS parity).
  const slotPids = new Map<number, number>();
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
          env: workerEnv,
          detached: true,
          stdio: ["ignore", slotFd, slotFd],
        });
        // Close the parent's copy — the child inherits it and keeps it open.
        closeSync(slotFd);
        child.unref();
        const pid = child.pid ?? 0;
        slotPids.set(slot, pid);
        return { pid, spawnEpoch: now() };
      },
      isAlive,
      killTree: async (pid) => {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
      },
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
      parkedSlotWork: (slot) => parkedSlotWorkFor(tmpDir, root, slot),
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
    },
    now,
    // Env for the bounded stalled re-claim cap (#402): RED_AFK_RETRY_STALLED.
    recoveryEnv: process.env,
    // Per-tick liveness line into afk-supervisor.log (best-effort). Makes a
    // healthy fleet's heartbeat — and a wedged one's silence — observable.
    log: (line) => {
      try {
        writeSync(logFd, `[${new Date().toISOString()}] ${line}\n`);
      } catch {
        // best-effort: a log-write failure must never affect the loop.
      }
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
  const deps = buildSupervisorDeps(root, tmp, logFd, firehoseFile, stateFile, config.runner, ghCtx, slotArgs);

  const stopRequested = (): boolean => existsSync(stopFile);

  try {
    await runSupervisor(state, deps, config, stopRequested);
  } finally {
    rmSync(pidFile, { force: true });
    rmSync(stopFile, { force: true });
  }
  return 0;
}
