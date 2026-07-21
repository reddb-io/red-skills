// commands/supervise.ts — the NATIVE fleet supervisor (the hidden `__supervise`
// command fleet.ts spawns instead of supervisor.sh).
//
// It writes the supervisor pid file, polls the stop file, and drives
// runSupervisor over real SupervisorDeps. Each slot spawns a `run --once` of
// THIS SAME BUNDLE (node process.execPath bin __run-once), so the whole fleet is
// native — no bash anywhere in the loop.

import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBuildInfo } from "@reddb-io/build-info";
import {
  type FleetHeartbeat,
  type FleetHeartbeatEmitResult,
  type ElasticResizeRequest,
  type HeartbeatSlotPid,
  initSupervisorState,
  resolveSupervisorConfig,
  runSupervisor,
  terminateAll,
  type SpawnPolicy,
  type SupervisorDeps,
} from "../core/supervisor.js";
import { appendRecordToonlRow } from "../core/jsonl-log.js";
import {
  afkPaths,
  resolveRepoSlug,
  collectPrecheckFacts,
  collectBootOptions,
  buildBootDeps,
  readFleetState,
  type RepoContext,
} from "../runtime/wire.js";
import { formatPreconditionFailure, runBoot, type BootResult, type BootstrapInput } from "../core/boot.js";
import { inspectProcessTreeNative } from "../runtime/proc-tree.js";
import {
  workerLivenessFor,
  slotLogDir,
  slotLogPath,
  parkedSlotWorkFor,
  resolveIterDirInfo,
  sumWorkerCostUsd,
  teardownIterDirNative,
} from "../runtime/supervisor-fs.js";
import * as ghx from "../runtime/gh.js";
import * as gitx from "../runtime/git.js";
import { planReconcileSweep, executeUnblockSweep } from "../core/boot-sweep.js";
import { removeDir as removeDirNative } from "../runtime/fs.js";
import { killTreeAndWait } from "../runtime/kill-tree.js";
import { buildStateChangeWake } from "../runtime/state-watch.js";
import { resolveFleetHooks } from "../core/fleet-hook-config.js";
import { dispatchFleetHook } from "../core/fleet-hook-dispatcher.js";
import { makeHookExec, makeHookResolveOptions } from "../runtime/hooks.js";
import { getConfig, loadConfig } from "../core/config.js";
import { reapDeadSupervisorSnapshotDirs, reapStaleSupervisorState } from "../runtime/supervisor-state.js";
import {
  castleStateSnapshotPath,
  createEnginePaths,
  createCastleLaneWriters,
  writeCastleStateSnapshot,
} from "@reddb-io/red-castle/engine";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "../core/toon-snapshot.js";
import { resolveFleetFromArgs, FLEET_NAME_ENV } from "../core/fleet-name.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fleetHeartbeatMessage(hb: FleetHeartbeat): string {
  return `fleet tick target=${hb.target} runner=${hb.runner} shrink-mode=${hb.shrinkMode} ready=${hb.readyForAgent} busy=${hb.slotsBusy} free=${hb.slotsFree} spawns=${hb.spawnsThisTick}`;
}

/**
 * Serialize the fleet supervisor state snapshot as TOON (castle-engine write
 * surface — never raw JSON, ADR 0097). Exported so the castle-engine uniformity
 * test can enumerate this writer and assert it never emits JSON. Undefined-valued
 * keys are dropped before encoding (TOON `encode` rejects `undefined`), matching
 * the old `JSON.stringify` behaviour that omitted them.
 */
export function fleetHeartbeatState(hb: FleetHeartbeat): string {
  return encodeDevSnapshotToon({
    ts: hb.ts,
    epoch: hb.epoch,
    ...(hb.lastProgressEpoch > 0 ? { last_progress_epoch: hb.lastProgressEpoch } : {}),
    ...(hb.target !== undefined ? { target: hb.target } : {}),
    runner: hb.runner,
    ...(hb.shrinkMode !== undefined ? { shrink_mode: hb.shrinkMode } : {}),
    ...(hb.bundleVersion ? { bundle_version: hb.bundleVersion } : {}),
    ready_for_agent: hb.readyForAgent,
    slots: {
      busy: hb.slotsBusy,
      free: hb.slotsFree,
      total: hb.slotsTotal,
      parked: hb.slotsParked,
    },
    slot_pids: hb.slotPids.map((entry) => ({ slot: entry.slot, pid: entry.pid })),
    spawns_this_tick: hb.spawnsThisTick,
    ...(hb.trunkFreshness
      ? {
          trunk_freshness: {
            status: hb.trunkFreshness.status,
            refreshed_at_epoch: hb.trunkFreshness.refreshedAtEpoch,
            interval_s: hb.trunkFreshness.intervalS,
            ...(hb.trunkFreshness.nextDueEpoch !== undefined ? { next_due_epoch: hb.trunkFreshness.nextDueEpoch } : {}),
            ...(hb.trunkFreshness.remoteRef ? { remote_ref: hb.trunkFreshness.remoteRef } : {}),
            ...(hb.trunkFreshness.mirrorRef ? { mirror_ref: hb.trunkFreshness.mirrorRef } : {}),
            ...(hb.trunkFreshness.sha ? { sha: hb.trunkFreshness.sha } : {}),
            ...(hb.trunkFreshness.message ? { message: hb.trunkFreshness.message } : {}),
          },
        }
      : {}),
    churn: {
      deaths: hb.churn.deaths,
      respawns: hb.churn.respawns,
      window_s: hb.churn.windowS,
    },
    ...(hb.drainBudget
      ? {
          drain_budget: {
            tier: hb.drainBudget.tier,
            spent_usd: Number(hb.drainBudget.spentUsd.toFixed(4)),
            limit_usd: Number(hb.drainBudget.limitUsd.toFixed(4)),
            percent: Number((hb.drainBudget.percent * 100).toFixed(2)),
          },
        }
      : {}),
  });
}

function writeFleetStateAtomic(path: string, hb: FleetHeartbeat): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, fleetHeartbeatState(hb), "utf8");
  renameSync(tmp, path);
}

async function writeCastleSupervisorSnapshot(
  root: string,
  supervisorId: string,
  hb: FleetHeartbeat,
): Promise<void> {
  const paths = createEnginePaths(join(root, ".red"));
  await writeCastleStateSnapshot(
    castleStateSnapshotPath(paths, "supervisor", supervisorId),
    {
      kind: "supervisor",
      id: supervisorId,
      supervisor_id: supervisorId,
      version: 1,
      updated_at: hb.ts,
      runner: hb.runner,
      pid: process.pid,
      current: {
        epoch: hb.epoch,
        last_progress_epoch: hb.lastProgressEpoch,
        ...(hb.target !== undefined ? { target: hb.target } : {}),
        ...(hb.shrinkMode !== undefined ? { shrink_mode: hb.shrinkMode } : {}),
        ready_for_agent: hb.readyForAgent,
        slots: {
          busy: hb.slotsBusy,
          free: hb.slotsFree,
          total: hb.slotsTotal,
          parked: hb.slotsParked,
        },
        slot_pids: hb.slotPids.map((entry) => ({ slot: entry.slot, pid: entry.pid })),
        spawns_this_tick: hb.spawnsThisTick,
        ...(hb.trunkFreshness
          ? {
              trunk_freshness: {
                status: hb.trunkFreshness.status,
                refreshed_at_epoch: hb.trunkFreshness.refreshedAtEpoch,
                interval_s: hb.trunkFreshness.intervalS,
                ...(hb.trunkFreshness.nextDueEpoch !== undefined ? { next_due_epoch: hb.trunkFreshness.nextDueEpoch } : {}),
                ...(hb.trunkFreshness.remoteRef ? { remote_ref: hb.trunkFreshness.remoteRef } : {}),
                ...(hb.trunkFreshness.mirrorRef ? { mirror_ref: hb.trunkFreshness.mirrorRef } : {}),
                ...(hb.trunkFreshness.sha ? { sha: hb.trunkFreshness.sha } : {}),
                ...(hb.trunkFreshness.message ? { message: hb.trunkFreshness.message } : {}),
              },
            }
          : {}),
        churn: {
          deaths: hb.churn.deaths,
          respawns: hb.churn.respawns,
          window_s: hb.churn.windowS,
        },
        ...(hb.drainBudget
          ? {
              drain_budget: {
                tier: hb.drainBudget.tier,
                spent_usd: Number(hb.drainBudget.spentUsd.toFixed(4)),
                limit_usd: Number(hb.drainBudget.limitUsd.toFixed(4)),
                percent: Number((hb.drainBudget.percent * 100).toFixed(2)),
              },
            }
          : {}),
      },
      queue: [],
      completed: [],
    },
  );
}

function heartbeatWriteError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  "RED_AFK_TASK_TIER_DOWNGRADE",
  "RED_AFK_SHRINK_MODE",
  "RED_AFK_RETIRE_FILE",
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
  policy: SpawnPolicy = {},
  retireFile?: string,
): Record<string, string> {
  const out: Record<string, string> = { ...workerEnv, RED_AFK_SLOT: String(slot) };
  if (policy.taskTierDowngrade) out.RED_AFK_TASK_TIER_DOWNGRADE = "1";
  else delete out.RED_AFK_TASK_TIER_DOWNGRADE;
  if (retireFile !== undefined) out.RED_AFK_RETIRE_FILE = retireFile;
  else delete out.RED_AFK_RETIRE_FILE;
  return out;
}

function slotRetirePath(statePath: string, slot: number): string {
  return join(dirname(statePath), `afk-supervisor-slot-${slot}.retire`);
}

function readResizeRequest(path: string): ElasticResizeRequest | null {
  try {
    // Sniff-decode: the launcher writes the directive as TOON (encodeToon), but
    // tolerate a legacy JSON directive left by an older bundle. JSON.parse alone
    // would throw on the TOON body and silently drop every resize/runner
    // directive (the write side is TOON on main).
    const parsed = decodeDevSnapshotSniff(readFileSync(path, "utf8")) as {
      target?: unknown;
      runner?: unknown;
      shrink_mode?: unknown;
      shrinkMode?: unknown;
    };
    if (!Number.isInteger(parsed.target) || (parsed.target as number) < 0) return null;
    const rawMode = parsed.shrink_mode ?? parsed.shrinkMode;
    const shrinkMode =
      rawMode === "hard-kill" || rawMode === "drain-then-retire"
        ? rawMode
        : undefined;
    const runner = typeof parsed.runner === "string" && parsed.runner.length > 0 ? parsed.runner : undefined;
    return {
      target: parsed.target as number,
      ...(shrinkMode !== undefined ? { shrinkMode } : {}),
      ...(runner !== undefined ? { runner } : {}),
    };
  } catch {
    return null;
  }
}

function parseAdoptSlotPids(raw: string | undefined): HeartbeatSlotPid[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: HeartbeatSlotPid[] = [];
    const seen = new Set<number>();
    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object") continue;
      const rec = entry as { slot?: unknown; pid?: unknown };
      const slot = Number(rec.slot);
      const pid = Number(rec.pid);
      if (!Number.isSafeInteger(slot) || slot < 0 || seen.has(slot)) continue;
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      seen.add(slot);
      out.push({ slot, pid });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Parse the supervisor's own argv (forwarded by fleet.ts) into the filter /
 * runner-swap policy flags each slot's `run --once` must carry, so a supervised
 * fleet honours the same Spec/Ticket filter + alternate/fallback policy a single
 * `/afk run` would. Recognises the value flags `--spec` / `--issues` /
 * `--selector` (a named fleet's work scope) / `--request`
 * (with `-r`) and the boolean flags `--alternate` / `--fallback-runner`, all in
 * both `--flag value` and `--flag=value` forms. Unknown args are dropped (the
 * supervisor only forwards the known filter/policy surface). Returns the argv
 * fragment to append after `run --once --runner <r>`.
 */
export function slotFilterArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  const valueFlags = new Map<string, string>([
    ["--spec", "--spec"],
    ["--issues", "--issues"],
    ["--selector", "--selector"],
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
    return `boot sweeps: precheck FAILED (${formatPreconditionFailure(result.precheck)}) — workers will run their own precheck`;
  }
  const oc = result.orphanCleanup;
  const ac = result.attemptCap;
  const bc = result.branchCleanup;
  const tj = result.tmpJanitor;
  const ds = result.docsSweep?.plan;
  const us = result.unblockSweep;
  const st = result.straggler;
  return (
    "boot sweeps complete: " +
    `orphans removed=${oc?.removed.length ?? 0} restored=${oc?.restored.length ?? 0} kept=${oc?.kept.length ?? 0}` +
    ` | attempt-cap reclaimed=${ac?.reclaimed.length ?? 0}` +
    ` | branches remote=${bc?.remoteLiveReaped.length ?? 0} local=${bc?.localLiveReaped.length ?? 0}` +
    ` | tmp-janitor expired=${tj?.expiredLanes.length ?? 0} workers=${tj?.staleWorkers.length ?? 0} unknown=${tj?.unknownTmpRoots.length ?? 0} protected=${tj?.protectedLiveWorkers.length ?? 0}` +
    ` | docs-sweep ${ds?.action ?? "clean"} files=${ds?.files.length ?? 0}` +
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
  fleet?: string,
): () => Promise<void> {
  const ctx: RepoContext = { root, repo, remote: "origin" };
  const paths = afkPaths(root, fleet);
  return async (): Promise<void> => {
    const nowS = Math.floor(Date.now() / 1000);
    const facts = await collectPrecheckFacts(ctx);
    const bootstrap: BootstrapInput = {
      tmpDir: paths.tmpDir,
      stateDir: paths.stateDir,
      gitignorePath: paths.gitignorePath,
      workerDir: paths.tmpDir,
      workerPidFile: join(dirname(paths.supervisorPidPath), "afk-supervisor-boot.pid"),
      workerPid: process.pid,
    };
    const options = await collectBootOptions(ctx, facts, bootstrap, nowS);
    const bootDeps = await buildBootDeps(ctx, options, nowS, log);
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
  slotLogsDir: string,
  firehosePath: string,
  statePath: string,
  supervisorId: string,
  fleet: string,
  runner: string,
  ghCtx: ghx.GhContext,
  trunk: string,
  slotArgs: readonly string[],
  hookEnvBase: Record<string, string>,
  adoptSlotPids: readonly HeartbeatSlotPid[] = [],
): SupervisorDeps {
  const bundle = process.argv[1];
  const bundleVersion = readBuildInfo("dev").version;
  const now = () => Math.floor(Date.now() / 1000);
  // The lane lives INSIDE the fleet's runtime dir (`supervisors/<fleet>/s<pid>/`)
  // so two named fleets never share a lane namespace and each fleet's pid
  // discovery only ever sees its own supervisors.
  const supervisorWriter = createCastleLaneWriters(
    createEnginePaths(join(root, ".red")),
  ).supervisor(join(fleet, supervisorId));
  const emitSupervisorEvent: NonNullable<SupervisorDeps["emitSupervisorEvent"]> = async (record) => {
    await supervisorWriter.append({
      supervisor_id: supervisorId,
      ...record,
    });
  };
  // Legacy prose strings are retained only as a derived structured event. The
  // human view reads the supervisor lane; no supervisor-owned prose log is
  // dual-written.
  const logLine = (line: string): void => {
    void Promise.resolve(
      emitSupervisorEvent({
        kind: "supervisor.message",
        payload: { message: line },
      }),
    ).catch(() => undefined);
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
  const slotPids = new Map<number, number>(
    adoptSlotPids.map((entry) => [entry.slot, entry.pid] as const),
  );
  // slot index → exit code of the most recent worker for that slot.
  const slotExitCodes = new Map<number, number>();
  // Worker env (build_passthrough_env parity): start from the supervisor's full
  // env, then STRIP every internal supervisor knob in PASSTHROUGH_DENYLIST plus
  // every per-slot `_BASE` build-isolation var, so they never leak to the worker
  // (gap 4). Operator-set RED_AFK_* vars (RED_AFK_SKIP_PERF, etc) and the rest of
  // the environment survive. RED_AFK_RUNNER is re-added explicitly below so the
  // worker's detection cascade pins the supervisor's runner.
  let activeRunner = runner;
  // Stamp the fleet name into the worker env so spawned workers can write it to
  // their castle state snapshot (as supervisor_id). fleet_status reads this back
  // to partition workers without relying solely on the slot-pid map (issue #2345).
  let workerEnv = { ...buildWorkerEnv(process.env, activeRunner), [FLEET_NAME_ENV]: fleet };
  let hookEnv = { ...hookEnvBase, RED_AFK_RUNNER: activeRunner };

  return {
    proc: {
      spawnSlot: async (slot, policy) => {
        // Forward the Spec/Ticket filter + runner-swap policy so a supervised
        // fleet honours the same filter a single `/afk run` would (gap 5).
        const runArgs = ["run", "--once", "--runner", activeRunner, ...slotArgs];
        // Each slot gets its own log file so the circuit-trip sweep can
        // resolve which worker IDs ran in the slot via parseWorkerIdsFromLog
        // (mirrors spawn_slot's per-slot slot_log in supervisor.sh).
        const slotLogFile = slotLogPath(tmpDir, slot, slotLogsDir);
        const slotFd = openSync(slotLogFile, "a");
        const retireFile = slotRetirePath(statePath, slot);
        rmSync(retireFile, { force: true });
        const child = spawn(process.execPath, [bundle, ...runArgs], {
          cwd: root,
          env: buildSlotEnv(workerEnv, slot, policy, retireFile),
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
          "run", "--once", "--runner", activeRunner,
          "--reconcile-issue", String(candidate.issue),
          ...slotArgs,
        ];
        const slotLogFile = slotLogPath(tmpDir, slot, slotLogsDir);
        const slotFd = openSync(slotLogFile, "a");
        const child = spawn(process.execPath, [bundle, ...runArgs], {
          cwd: root,
          env: buildSlotEnv(workerEnv, slot, undefined, slotRetirePath(statePath, slot)),
          detached: true,
          stdio: ["ignore", slotFd, slotFd],
        });
        closeSync(slotFd);
        child.on("exit", (code) => {
          // null means the process was killed by a signal; treat as non-clean (1).
          slotExitCodes.set(slot, code ?? 1);
        });
        child.unref();
        const pid = child.pid ?? 0;
        slotPids.set(slot, pid);
        return { pid, spawnEpoch: now() };
      },
      slotPid: (slot) => slotPids.get(slot) ?? null,
      lastExitCode: (slot) => slotExitCodes.get(slot) ?? null,
      isAlive,
      requestSlotRetire: async (slot) => {
        writeFileSync(slotRetirePath(statePath, slot), "", "utf8");
      },
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
      workerLivenessVerdict: (slot, laneIdleMs, laneHardIdleMs) =>
        workerLivenessFor(tmpDir, slotPids.get(slot) ?? null, laneIdleMs, laneHardIdleMs),
      resolveIterDir: (slot) => resolveIterDirInfo(tmpDir, slotPids.get(slot) ?? null, now()),
      teardownIterDir: async (info) => {
        await teardownIterDirNative(info, root);
      },
      parkedSlotWork: (slot, lastPid) =>
        parkedSlotWorkFor(tmpDir, slot, lastPid, supervisorWriter.path, slotLogsDir),
      removeDir: async (path) => {
        try {
          await removeDirNative(path);
        } catch {
          // best-effort
        }
      },
      fleetCostUsd: () => sumWorkerCostUsd(tmpDir),
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
    // Event-driven wake (#934): a recursive fs.watch over the workers root resolves
    // the supervisor's inter-tick wait the instant a worker rewrites its
    // afk.state.toon (claim / stage / phase / progress transition), so the loop
    // reacts to a state change immediately instead of waiting out the safety-net
    // timer. Best-effort: a watch failure degrades to pure-timer polling.
    wake: buildStateChangeWake(join(tmpDir, "workers")),
    // Env for the bounded stalled re-claim cap (#402): RED_AFK_RETRY_STALLED.
    recoveryEnv: process.env,
    // Derived human-readable messages are stored in the structured supervisor
    // lane, not dual-written to a prose supervisor log.
    log: logLine,
    // Fleet supervisor owns the boot (#623): runSupervisor calls this ONCE before
    // the initial spawn. Runs the full shared sweep suite over real IO and logs
    // the result; each worker then boots bootstrap+claim only.
    bootSweeps: buildSupervisorBootSweeps(root, ghCtx.repo, logLine, fleet),
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
            issueReference: (issue) => ghx.issueReference(ghCtx, issue),
          },
        );
      } catch {
        return [];
      }
    },
    refreshTrunkMirror: async () => {
      const base = trunk.trim() || "main";
      const refreshed = await gitx.resolveFreshBase({ cwd: root }, { base, remote: "origin" });
      if (refreshed.ok) {
        return {
          status: "refreshed",
          remoteRef: `origin/${base}`,
          mirrorRef: refreshed.baseRef,
          sha: refreshed.sha,
        };
      }
      return {
        status: "failed",
        remoteRef: `origin/${base}`,
        mirrorRef: gitx.FLEET_TRUNK,
        ...(refreshed.sha ? { sha: refreshed.sha } : {}),
        message: refreshed.message,
      };
    },
    attemptBranchHead: (branch) => gitx.branchHead({ cwd: root }, branch),
    resizeRequest: async () => readResizeRequest(afkPaths(root, fleet).supervisorResizePath),
    configureRunner: (nextRunner) => {
      activeRunner = nextRunner;
      workerEnv = buildWorkerEnv(process.env, activeRunner);
      hookEnv = { ...hookEnvBase, RED_AFK_RUNNER: activeRunner };
    },
    // Fleet-scoped lifecycle hooks (#833). Commands are resolved from the same
    // .red/hooks/<point>/ + library layering as worker hooks. Best-effort:
    // a dispatch failure is returned to the caller; the caller catches and logs.
    dispatchFleetHook: async (name, context) => {
      const commands = fleetHooks[name];
      return dispatchFleetHook(name, commands, context, fleetHookExec, {
        env: hookEnv,
        log: logLine,
      });
    },
    emitFleetHeartbeat: async (hb): Promise<FleetHeartbeatEmitResult> => {
      const stamped = { ...hb, bundleVersion };
      let stateWritten = false;
      let firehoseWritten = false;
      let stateError: string | undefined;
      let firehoseError: string | undefined;
      try {
        writeFleetStateAtomic(statePath, stamped);
        stateWritten = true;
      } catch (err) {
        stateError = heartbeatWriteError(err);
      }
      try {
        await writeCastleSupervisorSnapshot(root, `s${process.pid}`, stamped);
      } catch {
        // best-effort: castle state mirroring must not affect the supervisor.
      }
      try {
        await appendRecordToonlRow(firehosePath, "heartbeat", fleetHeartbeatMessage(stamped), {
          ts: stamped.ts,
          fields: {
            worker: "fleet",
            extra: {
              scope: "fleet",
              runner: stamped.runner,
              target: String(stamped.target),
              shrink_mode: stamped.shrinkMode,
              bundle_version: stamped.bundleVersion ?? null,
              ready_for_agent: String(stamped.readyForAgent),
              slots_busy: String(stamped.slotsBusy),
              slots_free: String(stamped.slotsFree),
              slots_total: String(stamped.slotsTotal),
              slots_parked: String(stamped.slotsParked),
              spawns_this_tick: String(stamped.spawnsThisTick),
              drain_budget_tier: stamped.drainBudget?.tier ?? null,
              drain_budget_spent_usd: stamped.drainBudget?.spentUsd.toFixed(4) ?? null,
              drain_budget_limit_usd: stamped.drainBudget?.limitUsd.toFixed(4) ?? null,
              drain_budget_percent: stamped.drainBudget ? (stamped.drainBudget.percent * 100).toFixed(2) : null,
              trunk_freshness_status: stamped.trunkFreshness?.status ?? null,
              trunk_freshness_remote_ref: stamped.trunkFreshness?.remoteRef ?? null,
              trunk_freshness_mirror_ref: stamped.trunkFreshness?.mirrorRef ?? null,
              trunk_freshness_sha: stamped.trunkFreshness?.sha ?? null,
              trunk_freshness_refreshed_at_epoch: stamped.trunkFreshness
                ? String(stamped.trunkFreshness.refreshedAtEpoch)
                : null,
              trunk_freshness_next_due_epoch: stamped.trunkFreshness?.nextDueEpoch !== undefined
                ? String(stamped.trunkFreshness.nextDueEpoch)
                : null,
            },
          },
        });
        firehoseWritten = true;
      } catch (err) {
        firehoseError = heartbeatWriteError(err);
      }
      return {
        stateWritten,
        firehoseWritten,
        ...(stateError !== undefined ? { stateError } : {}),
        ...(firehoseError !== undefined ? { firehoseError } : {}),
      };
    },
    repairFleetHeartbeat: async (hb): Promise<FleetHeartbeatEmitResult> => {
      const stamped = { ...hb, bundleVersion };
      try {
        writeFleetStateAtomic(statePath, stamped);
        return { stateWritten: true };
      } catch (err) {
        return { stateWritten: false, stateError: heartbeatWriteError(err) };
      }
    },
    emitSupervisorEvent,
  };
}

/**
 * Drive the native fleet supervisor. Honours the same pid/stop-file protocol
 * fleet.ts's launch/stop already speak.
 */
export async function superviseCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const root = cwd;
  // Which named fleet this supervisor owns: the `--fleet` flag the launcher
  // forwarded, else the inherited RED_AFK_FLEET, else the default lane.
  const fleet = resolveFleetFromArgs(args);
  const paths = afkPaths(root, fleet);
  const tmp = paths.tmpDir;
  const stateAfk = dirname(paths.supervisorPidPath);
  const pidFile = paths.supervisorPidPath;
  const stopFile = paths.supervisorStopPath;
  const firehoseFile = paths.fleetFirehosePath;
  const stateFile = paths.fleetStatePath;
  const slotLogsDir = slotLogDir(tmp);

  // One-time boot migration: relocate any legacy `.red/tmp` durable artifacts to
  // the state tier before the supervisor reads/writes them (issue #1685).
  await import("../runtime/red-path-migration.js").then((m) => m.migrateLegacyDevPaths(root)).catch(() => undefined);
  await import("../runtime/fs.js").then((m) => m.ensureDir(tmp));
  await import("../runtime/fs.js").then((m) => m.ensureDir(stateAfk));
  await import("../runtime/fs.js").then((m) => m.ensureDir(slotLogsDir));
  await reapDeadSupervisorSnapshotDirs(
    join(root, ".red", "state", "castle", "supervisors"),
    isAlive,
    process.pid,
  );
  // Ensure the workers root exists so the event-driven wake's fs.watch (#934) can
  // attach from boot rather than waiting for the first worker to create it.
  await import("../runtime/fs.js").then((m) => m.ensureDir(join(tmp, "workers")));
  const envAdoptSlotPids = parseAdoptSlotPids(process.env.RED_AFK_ADOPT_SLOT_PIDS);
  const stateAdoptSlotPids =
    envAdoptSlotPids.length > 0
      ? []
      : ((await readFleetState(stateFile).catch(() => null))?.slotPids ?? []);
  const adoptSlotPids = envAdoptSlotPids.length > 0 ? envAdoptSlotPids : stateAdoptSlotPids;
  await reapStaleSupervisorState(stateAfk, isAlive);
  // One supervisor PER NAMED FLEET. The lock is the fleet's own pid file inside
  // `supervisors/<fleet>/`, so a second `alpha` supervisor is refused while
  // `beta` boots freely alongside it.
  if (existsSync(pidFile)) {
    try {
      const prev = Number(require("node:fs").readFileSync(pidFile, "utf8").trim());
      if (prev && isAlive(prev)) {
        process.stderr.write(`supervisor already running for fleet ${fleet} (pid=${prev})\n`);
        return 1;
      }
    } catch {
      // stale — overwrite
    }
  }
  writeFileSync(pidFile, String(process.pid), "utf8");
  // clear any stale stop file
  if (existsSync(stopFile)) rmSync(stopFile, { force: true });
  rmSync(paths.supervisorResizePath, { force: true });

  const values = loadConfig(paths.configPath, { warn: () => undefined });
  const config = resolveSupervisorConfig(process.env, (key) => getConfig(values, key));
  const state = initSupervisorState(config.target);
  const repo = await resolveRepoSlug(root).catch(() => "");
  const trunk = getConfig(values, "dev.trunk") || "main";
  const ghCtx = { cwd: root, repo };
  const supervisorId = `s${process.pid}`;
  // The filter/policy flags fleet.ts forwarded (--spec/--issues/--alternate/
  // --fallback-runner/--request), threaded into every slot's `run --once`.
  const slotArgs = slotFilterArgs(args);
  // Base env for fleet hooks: RED_AFK_REPO, RED_AFK_ROOT, RED_AFK_RUNNER.
  const hookEnvBase: Record<string, string> = {
    RED_AFK_ROOT: root,
    RED_AFK_WORKSPACE: root,
    RED_AFK_RUNNER: config.runner,
    ...(repo.length > 0 ? { RED_AFK_REPO: repo } : {}),
  };
  const deps = buildSupervisorDeps(root, tmp, slotLogsDir, firehoseFile, stateFile, supervisorId, fleet, config.runner, ghCtx, trunk, slotArgs, hookEnvBase, adoptSlotPids);

  const stopRequested = (): boolean => existsSync(stopFile);

  // A bare `kill <supervisor-pid>` (SIGTERM/SIGINT) must not orphan the detached
  // slot workers or leave the pid/stop control files behind (#2056). Without a
  // handler the signal skips the `finally` below, stranding both. Translate the
  // signal into the same clean shutdown the stop-file path performs: terminate
  // every live slot (SIGTERM→grace→SIGKILL→confirm via terminateAll), clean the
  // control files, then exit with the conventional 128+signal code.
  let shuttingDown = false;
  const onSignal = (signal: "SIGTERM" | "SIGINT"): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await terminateAll(state, deps);
      } catch {
        // best-effort — still clean control files and exit.
      }
      rmSync(pidFile, { force: true });
      rmSync(stopFile, { force: true });
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));

  try {
    await runSupervisor(state, deps, config, stopRequested);
  } finally {
    rmSync(pidFile, { force: true });
    rmSync(stopFile, { force: true });
  }
  return 0;
}
