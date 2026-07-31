// commands/supervise.ts — the per-project runtime (the hidden `__supervise`
// command fleet.ts spawns).
//
// It writes the supervisor pid file, polls the stop file, and drives
// runSupervisor over real SupervisorDeps.
//
// **NOTHING HERE SPAWNS A WORKER.** Since the ADR 0130 cutover (#2851) every
// Worker is born by the host `redskilled` daemon: this module states an argv, a
// workspace and its own opaque project label, and the host decides admission,
// the resource unit and the sampling floor. There is deliberately no local
// `spawn` import left — a fallback would be an unbudgeted birth no host ever
// judged, and its absence is what makes that unrepresentable rather than
// merely discouraged.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
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
  type SupervisorState,
} from "../core/supervisor.js";
import { appendRecordToonlRow } from "../core/jsonl-log.js";
import {
  afkPaths,
  resolveRepoSlug,
  collectBootPrecheckFacts,
  collectBootOptions,
  buildBootDeps,
  readFleetState,
  type RepoContext,
} from "../runtime/wire.js";
import { formatPreconditionFailure, runBoot, type BootResult, type BootstrapInput } from "../core/boot.js";
import { inspectProcessTreeNative, sampleTreeRssMbNative } from "../runtime/proc-tree.js";
import { refuseRemovedFleetFlag } from "../core/removed-fleet-flag.js";
import { SUPERVISOR_LANE_ENV } from "../core/supervisor-lane.js";
import { resolveDevScriptPath, spawnSupervisor } from "../runtime/supervisor-spawn.js";
import { resolveSupervisorEntry } from "../runtime/supervisor-entry.js";
import { compareSemver } from "../core/bundle-version.js";
import { refreshPublishedBundleVersion } from "../core/published-version.js";
import {
  createProducerReplacementWatch,
  handOverProducer,
  producerReplaceCheckMs,
  type ProducerSlotPid,
} from "../core/producer-self-replace.js";
import {
  createRedskilledBirthPort,
  redskilledUnreachableAdvice,
  type RedskilledBirthPort,
} from "../runtime/redskilled-birth.js";
import { genWorkerId } from "../core/session.js";
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
import { selectAttemptPullRequest } from "../core/branch-resume.js";
import { HOST_STATE_TRANSITION_LABELS } from "../core/state-transition.js";
import { removeDir as removeDirNative } from "../runtime/fs.js";
import { killTreeAndWait } from "../runtime/kill-tree.js";
import { buildStateChangeWake } from "../runtime/state-watch.js";
import { getConfig, loadConfig } from "../core/config.js";
import { reapDeadSupervisorSnapshotDirs, reapStaleSupervisorState } from "../runtime/supervisor-state.js";
import {
  castleStateSnapshotPath,
  createEnginePaths,
  createCastleLaneWriters,
  createFileHealLedgerStore,
  createFileIssueCuratorStore,
  createGitHubTrackerAdapter,
  PROJECT_SUPERVISOR_LANE,
  runIssueStateCurator,
  writeCastleStateSnapshot,
} from "@reddb-io/red-castle/engine";
import { createFileBootBreakerStore } from "../core/supervisor/boot-breaker.js";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "../core/toon-snapshot.js";
import { parseClaimRecords, refreshClaimHeartbeats, type ClaimHeartbeat } from "../core/claim.js";
import { resolveClaimReaperConfig } from "../core/claim-staleness.js";
import { hostFingerprintPrefix } from "../core/host-identity.js";
import { createSupervisorExitRecorder } from "../core/supervisor-exit.js";
import { readPidStartTime } from "../core/state.js";
import { encodeLines, type ToonlRecord } from "@reddb-io/toon";

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
    ...(hb.pid !== undefined ? { pid: hb.pid } : {}),
    ...(hb.pidStartTime ? { pid_start_time: hb.pidStartTime } : {}),
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
  // mkdir -p ensures a swept lane self-heals on the next heartbeat tick.
  mkdirSync(dirname(path), { recursive: true });
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
  workerId?: string,
): Record<string, string> {
  const out: Record<string, string> = { ...workerEnv, RED_AFK_SLOT: String(slot) };
  if (policy.taskTierDowngrade) out.RED_AFK_TASK_TIER_DOWNGRADE = "1";
  else delete out.RED_AFK_TASK_TIER_DOWNGRADE;
  if (retireFile !== undefined) out.RED_AFK_RETIRE_FILE = retireFile;
  else delete out.RED_AFK_RETIRE_FILE;
  // The host's handle on this Worker and the work's handle on it are ONE string
  // (#2851). The daemon is told this id at birth and the Worker adopts it as its
  // own directory name, so every surface that joins a Worker's process verdict
  // to its work — `worker_vitals`, the statusline, the MCP lane canary — joins
  // on a value both authorities agree on rather than on a mapping one of them
  // maintains privately.
  if (workerId !== undefined) out.RED_AFK_WORKER_ID = workerId;
  else delete out.RED_AFK_WORKER_ID;
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
 * `--selector` (a named fleet's work scope) / `--tags` / `--user` (territory
 * facets, folded into the selector by each slot's own flag parse) / `--request`
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
    ["--tags", "--tags"],
    ["--user", "--user"],
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
  const janitorRemovalLog = (tj?.removals ?? [])
    .map((removal) => ` | tmp-janitor remove=${removal.path} liveness=${removal.livenessVerdict}`)
    .join("");
  return (
    "boot sweeps complete: " +
    `orphans removed=${oc?.removed.length ?? 0} restored=${oc?.restored.length ?? 0} kept=${oc?.kept.length ?? 0}` +
    ` | attempt-cap reclaimed=${ac?.reclaimed.length ?? 0}` +
    // `spared` is reported beside `local` on purpose (#2866): a reclaim that
    // only ever prints its deletions cannot be audited for what it refused.
    ` | branches remote=${bc?.remoteLiveReaped.length ?? 0} local=${bc?.localLiveReaped.length ?? 0} spared=${bc?.localSpared?.length ?? 0}` +
    ` | tmp-janitor expired=${tj?.expiredLanes.length ?? 0} workers=${tj?.staleWorkers.length ?? 0} orphan-runners=${tj?.orphanTestRunners?.length ?? 0} unknown=${tj?.unknownTmpRoots.length ?? 0} protected=${(tj?.protectedLiveWorkers.length ?? 0) + (tj?.protectedLiveFeedback.length ?? 0)}` +
    janitorRemovalLog +
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
): () => Promise<void> {
  const ctx: RepoContext = { root, repo, remote: "origin" };
  const paths = afkPaths(root);
  return async (): Promise<void> => {
    const nowS = Math.floor(Date.now() / 1000);
    const facts = await collectBootPrecheckFacts(ctx, { log });
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
export function buildSupervisorDeps(
  root: string,
  tmpDir: string,
  slotLogsDir: string,
  firehosePath: string,
  statePath: string,
  supervisorId: string,
  runner: string,
  claimRefreshCadenceS: number,
  ghCtx: ghx.GhContext,
  trunk: string,
  slotArgs: readonly string[],
  adoptSlotPids: readonly HeartbeatSlotPid[] = [],
  // How this supervisor reaches the host that births its Workers (#2851).
  // Injected so a test can observe the SPEC a slot would be born from without a
  // daemon on the machine; a real supervisor passes nothing and gets the
  // session's own socket. There is no third option — with no port there is no
  // birth, which is the fail-closed rule stated as a signature.
  birth: RedskilledBirthPort = createRedskilledBirthPort({ root }),
): SupervisorDeps {
  // Slots run `run --once`, which ONLY the dev entry routes. Never infer the
  // worker entry from argv[1]: under the MCP lane this supervisor is itself the
  // castle-mcp bundle, whose entry does not route `run`, so every slot booted a
  // second resident, lost the singleton lease and died on the spot (#2677).
  const bundle = resolveDevScriptPath(process.argv[1] ?? "");
  const bundleVersion = readBuildInfo("dev").version;
  const now = () => Math.floor(Date.now() / 1000);
  // The lane lives INSIDE the project's supervisor runtime dir
  // (`supervisors/<lane>/s<pid>/`), so pid discovery only ever sees the
  // supervisors of the project it is reading.
  const supervisorWriter = createCastleLaneWriters(
    createEnginePaths(join(root, ".red")),
  ).supervisor(join(PROJECT_SUPERVISOR_LANE, supervisorId));
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
  // slot index → live orchestrator pid (SLOT_PIDS parity).
  const slotPids = new Map<number, number>(
    adoptSlotPids.map((entry) => [entry.slot, entry.pid] as const),
  );
  // issue → the claim marker this supervisor refreshes for its local holder. Cached
  // across ticks so a not-yet-due claim costs ZERO GitHub calls per heartbeat.
  const claimHeartbeatByIssue = new Map<number, ClaimHeartbeat>();
  const claimHostPrefix = hostFingerprintPrefix();
  // slot index → exit code of the most recent worker for that slot.
  const slotExitCodes = new Map<number, number>();
  // Worker env (build_passthrough_env parity): start from the supervisor's full
  // env, then STRIP every internal supervisor knob in PASSTHROUGH_DENYLIST plus
  // every per-slot `_BASE` build-isolation var, so they never leak to the worker
  // (gap 4). Operator-set RED_AFK_* vars (RED_AFK_SKIP_PERF, etc) and the rest of
  // the environment survive. RED_AFK_RUNNER is re-added explicitly below so the
  // worker's detection cascade pins the supervisor's runner.
  let activeRunner = runner;
  // Stamp the supervisor lane into the worker env so spawned workers write it to
  // their castle state snapshot (as supervisor_id). A hard teardown and the
  // statusline read it back to tell this supervisor's workers from a standalone
  // one's, without relying solely on the slot-pid map (issue #2345).
  let workerEnv = { ...buildWorkerEnv(process.env, activeRunner), [SUPERVISOR_LANE_ENV]: PROJECT_SUPERVISOR_LANE };

  // ---- the host is the launcher (#2851, ADR 0130) --------------------------
  // Every Worker below is born by the daemon: the project states an argv, a
  // workspace and its own opaque label, and the host decides admission, the
  // resource unit and the sampling floor. There is deliberately NO local spawn
  // left to fall back to — a fallback would reinstate the unbudgeted spawn the
  // daemon exists to prevent, and would do it silently.
  // The host's worker id, per slot — the handle a stop, a death and a log line
  // are all addressed by. `slotPids` keeps answering the fs/liveness closures,
  // which ask about a pid because that is what a process table is keyed on.
  const slotWorkerIds = new Map<number, string>();
  const workerSlots = new Map<string, number>();
  const bornWorkerIds = new Set<string>();

  /** The host's id for the Worker running at `pid`, when this project birthed it. */
  const workerIdForPid = (pid: number): string | undefined => {
    for (const [slot, live] of slotPids) {
      if (live === pid) return slotWorkerIds.get(slot);
    }
    return undefined;
  };

  /** Ask the host for one Worker on `slot`. Fail closed: a refusal throws. */
  const birthWorker = async (
    slot: number,
    runArgs: readonly string[],
    policy: SpawnPolicy | undefined,
    retireFile: string | undefined,
  ): Promise<{ pid: number; spawnEpoch: number }> => {
    const workerId = genWorkerId(Math.random, (id) => bornWorkerIds.has(id));
    const slotLogFile = slotLogPath(tmpDir, slot, slotLogsDir);
    if (retireFile !== undefined) rmSync(retireFile, { force: true });
    let granted;
    try {
      granted = await birth.start({
        worker_id: workerId,
        workspace_path: root,
        log_path: slotLogFile,
        command: process.execPath,
        args: [bundle, ...runArgs],
        env: buildSlotEnv(workerEnv, slot, policy, retireFile, workerId),
        project_label: "",
      });
    } catch (err) {
      logLine(redskilledUnreachableAdvice(birth.socketPath, err));
      throw err;
    }
    for (const warning of granted.warnings) logLine(`worker ${granted.workerId}: ${warning}`);
    bornWorkerIds.add(granted.workerId);
    slotWorkerIds.set(slot, granted.workerId);
    workerSlots.set(granted.workerId, slot);
    slotPids.set(slot, granted.pid);
    return { pid: granted.pid, spawnEpoch: now() };
  };

  return {
    proc: {
      spawnSlot: async (slot, policy) => {
        // Forward the Spec/Ticket filter + runner-swap policy so a supervised
        // fleet honours the same filter a single `/afk run` would (gap 5).
        const runArgs = ["run", "--once", "--runner", activeRunner, ...slotArgs];
        return birthWorker(slot, runArgs, policy, slotRetirePath(statePath, slot));
      },
      spawnReconcileWorker: async (slot, candidate) => {
        const runArgs = [
          "run", "--once", "--runner", activeRunner,
          "--reconcile-issue", String(candidate.issue),
          ...slotArgs,
        ];
        return birthWorker(slot, runArgs, undefined, slotRetirePath(statePath, slot));
      },
      slotPid: (slot) => slotPids.get(slot) ?? null,
      lastExitCode: (slot) => slotExitCodes.get(slot) ?? null,
      // Deaths come from the HOST, not from a child handle this process no
      // longer holds (#2851). The daemon appends every death to its event lane
      // with the exit status it witnessed; draining that lane is what feeds the
      // project's own circuit breaker, which is the half ADR 0130 rule 2 leaves
      // here. Best-effort: an unreadable lane costs a tick's exit codes, never
      // the tick.
      observeHostDeaths: async () => {
        let events;
        try {
          events = await birth.drainEvents();
        } catch {
          return;
        }
        for (const event of events) {
          if (event.event === "worker-birth") continue;
          const slot = workerSlots.get(event.worker_id);
          if (slot === undefined) continue;
          // A budget kill and a signal death are both non-clean; only a witnessed
          // clean exit may be read as a clean drain, so an unknown status is 1.
          slotExitCodes.set(slot, event.exit_code ?? 1);
          workerSlots.delete(event.worker_id);
          logLine(
            `host reported worker ${event.worker_id} (slot ${slot}) ${event.event}: ${event.detail ?? "no detail"}`,
          );
        }
      },
      isAlive,
      requestSlotRetire: async (slot) => {
        writeFileSync(slotRetirePath(statePath, slot), "", "utf8");
      },
      // Death is the host's too, for a Worker the host birthed: the daemon holds
      // the transient unit, so asking it to stop is what actually reaches the
      // whole tree. A pid the host never birthed — an adopted pre-cutover worker,
      // a stray — is still killed locally, because refusing to end a process
      // nobody owns would leave it running forever.
      killTree: async (pid) => {
        const owned = workerIdForPid(pid);
        if (owned !== undefined) {
          try {
            if (await birth.stop(owned, "the project's policy ended this Worker")) return true;
          } catch {
            // The host did not answer. The Worker is still running, so the local
            // kill below is the only remaining way to honour the policy.
          }
        }
        return killTreeAndWait(pid);
      },
      // Real ps-backed tree sample. A ps failure returns a CONSERVATIVE BUSY
      // snapshot (never []), so a transient ps error can never authorise a reap.
      inspectTree: (pid) => inspectProcessTreeNative(pid),
      // Per-attempt memory accounting (ADR 0128 §8): ONE process-table read
      // charges every live attempt. A failed read measures nothing rather than
      // reporting a fabricated 0, so it can never terminate an in-budget attempt.
      sampleTreeRssMb: (pids) => sampleTreeRssMbNative(pids),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    fs: {
      workerLivenessVerdict: (slot, laneIdleMs, laneHardIdleMs, issueWallClockMaxMs) =>
        workerLivenessFor(
          tmpDir,
          slotPids.get(slot) ?? null,
          laneIdleMs,
          laneHardIdleMs,
          issueWallClockMaxMs,
        ),
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
      // #2701: the open PR a capped attempt already produced, so the re-queued
      // issue names it as the pending artifact instead of leaving it unowned.
      findAttemptPullRequest: async (issue) => {
        try {
          const { execTool } = await import("../runtime/exec.js");
          const result = await execTool(
            "gh",
            ["pr", "list", "--repo", ghCtx.repo, "--state", "open", "--limit", "100", "--json", "number,headRefName,body"],
            { cwd: root },
          );
          if (result.code !== 0) return null;
          const rows = JSON.parse(result.stdout || "[]") as unknown;
          if (!Array.isArray(rows)) return null;
          const prs = rows.map((row) => {
            const r = row as { number?: unknown; headRefName?: unknown; body?: unknown };
            return {
              number: Number(r.number ?? 0),
              headRefName: String(r.headRefName ?? ""),
              ...(typeof r.body === "string" ? { body: r.body } : {}),
            };
          });
          return selectAttemptPullRequest(prs, issue)?.number ?? null;
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
    // ADR 0122 heal ledger (#2526): the death-sweep consults the same castle
    // store the boot healer writes, so worker-death heals and probe heals
    // share one per-issue budget.
    healLedger: createFileHealLedgerStore(createEnginePaths(join(root, ".red"))),
    // Crashloop circuit breaker (#2527): fingerprint every boot-sweep halt; on
    // the Nth consecutive identical signature stop feeding the respawn loop and
    // run the ADR 0122 resident healer (issue-state curator) immediately for the
    // implicated state, instead of burning respawn budget on a deterministic
    // failure. A successful boot resets the run.
    bootBreaker: {
      store: createFileBootBreakerStore(createEnginePaths(join(root, ".red"))),
      threshold: Number(process.env["RED_AFK_BOOT_BREAKER_K"]) > 0
        ? Number(process.env["RED_AFK_BOOT_BREAKER_K"])
        : undefined,
      heal: async () => {
        const paths = createEnginePaths(join(root, ".red"));
        const tracker = createGitHubTrackerAdapter({
          claimLockRoot: join(paths.tmpRoot, "claims"),
        });
        const result = await runIssueStateCurator({
          tracker,
          store: createFileIssueCuratorStore(paths),
          labels: HOST_STATE_TRANSITION_LABELS,
        });
        return `curator sweep ran: ${JSON.stringify(result).slice(0, 200)}`;
      },
    },
    // Derived human-readable messages are stored in the structured supervisor
    // lane, not dual-written to a prose supervisor log.
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
    // Wall-clock-cap hand-forward (#2701): publish the capped attempt's ref from
    // the shared repo BEFORE the issue re-queues, so the next worker's branch
    // discovery can adopt it instead of branching fresh from main. Never a
    // force: a remote ref that already carries the work is the work.
    publishAttemptBranch: async (branch) => {
      const { git } = await import("../runtime/exec.js");
      const pushed = await git(["-C", root, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
      return pushed.code === 0;
    },
    resizeRequest: async () => readResizeRequest(afkPaths(root).supervisorResizePath),
    configureRunner: (nextRunner) => {
      activeRunner = nextRunner;
      workerEnv = { ...buildWorkerEnv(process.env, activeRunner), [SUPERVISOR_LANE_ENV]: PROJECT_SUPERVISOR_LANE };
    },
    emitFleetHeartbeat: async (hb): Promise<FleetHeartbeatEmitResult> => {
      // `pid` + `pidStartTime` make the snapshot a full liveness anchor — the
      // same identity the pid file pins — so a swept or unpinned pid file can no
      // longer make a running supervisor read as absent (#2679, #2698).
      const ownStartTime = readPidStartTime(process.pid);
      const stamped = {
        ...hb,
        bundleVersion,
        pid: process.pid,
        ...(ownStartTime !== null ? { pidStartTime: ownStartTime } : {}),
      };
      let stateWritten = false;
      let firehoseWritten = false;
      let stateError: string | undefined;
      let firehoseError: string | undefined;
      // Self-heal: if the supervisor's runtime lane was removed mid-run (e.g. by
      // a janitor bug or manual rm), re-pin the pid identity so the lane is
      // protected on the next janitor sweep. The writeFleetStateAtomic mkdir
      // recreates the directory; this re-writes the pid + start files.
      try {
        const runtimeDir = dirname(statePath);
        const pidFilePath = join(runtimeDir, "afk-supervisor.pid");
        // Both files, independently: a pid file whose `.start` sidecar is gone
        // fails the identity check exactly like a missing pid file, so re-pinning
        // only the pid would leave the lane unreadable (#2698).
        if (!existsSync(pidFilePath)) {
          writeFileSync(pidFilePath, String(process.pid), "utf8");
        }
        if (ownStartTime !== null && !existsSync(`${pidFilePath}.start`)) {
          writeFileSync(`${pidFilePath}.start`, ownStartTime, "utf8");
        }
      } catch {
        // best-effort: a failed re-pin is logged implicitly via stateError below.
      }
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
      // One BATCHED claim-heartbeat pass per fleet tick — the single cadence that
      // keeps every locally-held claim fresh without one polling loop per worker
      // multiplying the shared GitHub quota.
      try {
        const active = new Map<number, ClaimHeartbeat>();
        for (const slot of stamped.slotPids.map((entry) => entry.slot)) {
          const info = resolveIterDirInfo(tmpDir, slotPids.get(slot) ?? null, stamped.epoch);
          if (info?.issue === null || info?.issue === undefined) continue;
          const worker = `${claimHostPrefix}${info.workerId}`;
          let heartbeat = claimHeartbeatByIssue.get(info.issue);
          const refreshDue = !heartbeat || stamped.epoch - heartbeat.lastHeartbeatS >= claimRefreshCadenceS;
          if (!heartbeat || heartbeat.worker !== worker || refreshDue) {
            const records = parseClaimRecords(await ghx.listClaimComments(ghCtx, info.issue));
            const latest = records
              .filter((record) => record.worker === worker)
              .sort((a, b) => b.commentId - a.commentId)[0];
            if (!latest || latest.kind !== "claim") {
              // The worker already conceded (or never claimed): refreshing would
              // resurrect a withdrawn marker.
              claimHeartbeatByIssue.delete(info.issue);
              continue;
            }
            const parsedHeartbeatS = latest.createdAt
              ? Math.floor(Date.parse(latest.createdAt) / 1000)
              : Number.NaN;
            heartbeat = {
              issue: info.issue,
              worker,
              commentId: latest.commentId,
              lastHeartbeatS: Number.isFinite(parsedHeartbeatS) ? parsedHeartbeatS : stamped.epoch,
            };
            claimHeartbeatByIssue.set(info.issue, heartbeat);
          }
          active.set(info.issue, heartbeat);
        }
        const result = await refreshClaimHeartbeats(
          { editClaim: (commentId, body) => ghx.editComment(ghCtx, commentId, body) },
          [...active.values()],
          stamped.epoch,
          claimRefreshCadenceS,
        );
        for (const issue of result.refreshed) {
          const heartbeat = claimHeartbeatByIssue.get(issue);
          if (heartbeat) claimHeartbeatByIssue.set(issue, { ...heartbeat, lastHeartbeatS: stamped.epoch });
        }
        for (const issue of [...claimHeartbeatByIssue.keys()]) {
          if (!active.has(issue)) claimHeartbeatByIssue.delete(issue);
        }
      } catch {
        // Best-effort: a missed batch is retried on the next fleet heartbeat, and
        // the staleness window tolerates several consecutive misses by design.
      }
      return {
        stateWritten,
        firehoseWritten,
        ...(stateError !== undefined ? { stateError } : {}),
        ...(firehoseError !== undefined ? { firehoseError } : {}),
      };
    },
    repairFleetHeartbeat: async (hb): Promise<FleetHeartbeatEmitResult> => {
      const stamped = { ...hb, bundleVersion, pid: process.pid };
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
 * Drive the native worker supervisor. Honours the same pid/stop-file protocol
 * fleet.ts's launch/stop already speak.
 */
export async function superviseCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const root = cwd;
  refuseRemovedFleetFlag(args);
  const paths = afkPaths(root);
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
  const priorSupervisor = await reapStaleSupervisorState(stateAfk, isAlive);
  // ONE supervisor per project. The lock is the project's own pid file inside
  // its single supervisor lane, so a second supervisor is always refused.
  if (priorSupervisor.status === "live") {
    process.stderr.write(
      `supervisor already running for this project (pid=${priorSupervisor.pid})\n`,
    );
    return 1;
  }
  const ownStartTime = readPidStartTime(process.pid);
  if (ownStartTime === null) throw new Error("cannot pin supervisor process start time");
  writeFileSync(paths.supervisorPidStartPath, ownStartTime, "utf8");
  writeFileSync(pidFile, String(process.pid), "utf8");
  const supervisorId = `s${process.pid}`;
  const exitWriter = createCastleLaneWriters(
    createEnginePaths(join(root, ".red")),
  ).supervisor(join(PROJECT_SUPERVISOR_LANE, supervisorId));
  const exitRecorder = createSupervisorExitRecorder({
    supervisorId,
    append: async (record) => {
      await exitWriter.append(record);
    },
    appendSync: (record) => {
      try {
        mkdirSync(dirname(exitWriter.path), { recursive: true });
        const row: ToonlRecord = {
          at: new Date().toISOString(),
          kind: record.kind,
          supervisor_id: supervisorId,
          payload: JSON.stringify(record.payload ?? {}),
        };
        appendFileSync(exitWriter.path, encodeLines().push(row), "utf8");
      } catch {
        // a process-exit fallback is necessarily best-effort.
      }
    },
  });
  const onProcessExit = (code: number): void => {
    exitRecorder.recordSync("process-exit", { code });
  };
  const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    exitRecorder.recordSync("exception", {
      name: error.name,
      message: error.message,
      origin,
    });
  };
  process.once("exit", onProcessExit);
  process.once("uncaughtExceptionMonitor", onUncaughtException);

  // ---- the producer re-checks its own bundle (#2925) -----------------------
  // Resolving a bundle once at launch is what stranded this process on every
  // release: `project_start` went on reporting 3.0.3 while npm served 3.0.4, and
  // every Worker born afterwards boot-halted on skew while the producer reported
  // itself healthy. The daemon already answers this for itself; the cadence and
  // the four rules are deliberately its own (`producer-self-replace.ts`).
  const runningVersion = readBuildInfo("dev").version;
  const laneLog = (line: string): void => {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // a closed stderr never costs the handover.
    }
    void exitWriter
      .append({ kind: "supervisor.message", supervisor_id: supervisorId, payload: { message: line } })
      .catch(() => undefined);
  };
  const replaceWatch = createProducerReplacementWatch({
    running: runningVersion,
    // One registry read per check, recorded so every passive surface replays it
    // instead of deriving its own answer (#2809). A published version this host
    // cannot RUN is not an adoptable answer: resolving the successor's entry here
    // is what keeps preparation ahead of anything being given up.
    probePublished: async () => {
      const observed = await refreshPublishedBundleVersion(runningVersion, process.env);
      const published = observed.version;
      if (!published || compareSemver(published, runningVersion) <= 0) return published;
      try {
        resolveSupervisorEntry({ installedVersion: runningVersion, resolvePublished: () => published });
      } catch (err) {
        laneLog(
          `producer self-replace deferred: the published bundle ${published} runs from nowhere on this host ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      }
      return published;
    },
  });
  const replaceCheckMs = producerReplaceCheckMs(process.env);
  const replaceTimer =
    replaceCheckMs > 0
      ? setInterval(() => {
          void replaceWatch
            .tick()
            .then((decision) => {
              if (decision.act === "replace") {
                laneLog(
                  `producer self-replace decided: ${runningVersion} is superseded by ${decision.to}; ` +
                    `stopping the tick loop to hand over`,
                );
              }
            })
            .catch(() => undefined);
        }, replaceCheckMs)
      : undefined;
  replaceTimer?.unref();

  const stopRequested = (): boolean => existsSync(stopFile) || replaceWatch.decided() !== null;
  let state: SupervisorState | undefined;
  let deps: SupervisorDeps | undefined;
  let shuttingDown = false;
  const onSignal = (signal: "SIGTERM" | "SIGINT" | "SIGHUP"): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await exitRecorder.record("signal", { signal });
      if (state !== undefined && deps !== undefined) {
        try {
          await terminateAll(state, deps);
        } catch {
          // best-effort — still clean control files and exit.
        }
      }
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
    })();
  };
  const onSigterm = (): void => onSignal("SIGTERM");
  const onSigint = (): void => onSignal("SIGINT");
  const onSighup = (): void => onSignal("SIGHUP");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  process.once("SIGHUP", onSighup);

  let completed = false;
  try {
    // Everything after publishing the pinned identity is inside this lifecycle
    // boundary, including configuration and dependency construction.
    if (existsSync(stopFile)) rmSync(stopFile, { force: true });
    rmSync(paths.supervisorResizePath, { force: true });

    const values = loadConfig(paths.configPath, { warn: () => undefined });
    const config = resolveSupervisorConfig(process.env, (key) => getConfig(values, key));
    state = initSupervisorState(config.target);
    const repo = await resolveRepoSlug(root).catch(() => "");
    const trunk = getConfig(values, "dev.trunk") || "main";
    const ghCtx = { cwd: root, repo };
    const slotArgs = slotFilterArgs(args);
    deps = buildSupervisorDeps(
      root,
      tmp,
      slotLogsDir,
      firehoseFile,
      stateFile,
      supervisorId,
      config.runner,
      resolveClaimReaperConfig(process.env, (key) => getConfig(values, key)).refreshCadenceS,
      ghCtx,
      trunk,
      slotArgs,
      adoptSlotPids,
    );
    await runSupervisor(state, deps, config, stopRequested);
    completed = true;
    const replacement = replaceWatch.decided();
    if (replacement === null) {
      await exitRecorder.record(existsSync(stopFile) ? "explicit-stop" : "completed");
      return 0;
    }

    // The tick loop stopped because a newer bundle is published, not because
    // anyone asked this project to stop. The live Workers are the daemon's units
    // and outlive this process, so they are handed to the successor by pid rather
    // than terminated; the control files this process owns are given up first,
    // because one producer per project is enforced by exactly that identity.
    const liveSlotPids: ProducerSlotPid[] = state.slots.flatMap((slot, index) =>
      slot.pid !== null && isAlive(slot.pid) ? [{ slot: index, pid: slot.pid }] : [],
    );
    await exitRecorder.record("self-replace", { from: runningVersion, to: replacement.to });
    const handover = await handOverProducer(
      { to: replacement.to, target: state.slots.length, adoptSlotPids: liveSlotPids },
      {
        release: () => {
          // Do NOT let the finally block remove these again: from here on they
          // belong to whoever wins the identity next.
          completed = false;
          rmSync(pidFile, { force: true });
          rmSync(paths.supervisorPidStartPath, { force: true });
          rmSync(stopFile, { force: true });
        },
        spawn: (input) =>
          spawnSupervisor({
            root,
            target: input.target,
            runner: config.runner,
            base: trunk,
            passthrough: slotArgs,
            adoptSlotPids: input.adoptSlotPids,
            // The successor is PINNED to the decided version: an entry resolved
            // afresh could land on any other one, and the skew would survive the
            // restart it exists to end.
            entry: { installedVersion: runningVersion, resolvePublished: () => input.to },
            onNotice: laneLog,
          }),
        log: laneLog,
      },
    );
    return handover.ok ? 0 : 1;
  } catch (error) {
    await exitRecorder.record("exception", {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (replaceTimer !== undefined) clearInterval(replaceTimer);
    process.removeListener("exit", onProcessExit);
    process.removeListener("uncaughtExceptionMonitor", onUncaughtException);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGHUP", onSighup);
    if (completed) {
      rmSync(pidFile, { force: true });
      rmSync(paths.supervisorPidStartPath, { force: true });
      rmSync(stopFile, { force: true });
    }
  }
  return 0;
}
