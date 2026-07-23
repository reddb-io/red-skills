// watchdog-io — REAL process / fs IO backing the external supervisor watchdog
// (core/watchdog.ts). Built for the persistent repo-scoped watchdog and reused
// by the fleet pre-check / opt-in monitor recovery surfaces,
// bound to a repo root. Every closure is best-effort, mirroring the supervisor's
// own injected IO: a failed kill / stat / spawn degrades to the safe value and
// never throws out of the closure.

import { constants } from "node:fs";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupervisorLiveness } from "../core/supervisor.js";
import type { HeartbeatSlotPid } from "../core/supervisor.js";
import type { DeadSupervisorSignals, WatchdogIO } from "../core/watchdog.js";
import { createFileBootBreakerStore } from "../core/supervisor/boot-breaker.js";
import { afkPaths, readFleetState, resolveRepoSlug } from "./wire.js";
import { listStaleClaimDirs, removeDir } from "./fs.js";
import { countReadyForAgent } from "./gh.js";
import { editLabels, viewLabels } from "./gh.js";
import { LABEL_HUMAN, LABEL_READY, LABEL_RUNNING } from "../core/triage-labels.js";
import { detectRunner } from "../core/runner-detection.js";
import { callerProcessTreeNative } from "./caller-process.js";
import { spawnSupervisor, stampFreshFleetHeartbeat } from "./supervisor-spawn.js";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "../core/toon-snapshot.js";
import { appendRecordToonl } from "../core/jsonl-log.js";
import {
  castleStateSnapshotPath,
  createEnginePaths,
  readCastleStateSnapshot,
} from "@reddb-io/red-castle/engine";
// The wait-and-escalate killer (SIGTERM → grace → SIGKILL → confirm) is shared
// with the fleet reaper and `fleet stop` (#580). It matters for recovery
// correctness here too: the supervisor's own `finally` removes the pid/stop
// files on exit, so the relaunch must not write a fresh pid file until the dying
// process has finished cleaning up — otherwise it would clobber the new one.
import { isLivePid, killTreeAndWait } from "./kill-tree.js";
import { isSupervisorIdentityLive, readSupervisorIdentity } from "./supervisor-state.js";
import { readPidStartTime } from "../core/state.js";

async function readPid(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a WatchdogIO bound to `root`. `log` lines are written to `stdout` (so a
 * monitor tick / launch surfaces the recovery loudly) AND appended to the
 * structured supervisor firehose so recovery events share the fleet heartbeat
 * lane. The last fleet-state read by `liveness()` is cached so a relaunch
 * restores the prior target/runner instead of guessing.
 */
export function buildWatchdogIO(
  root: string,
  stdout: NodeJS.WritableStream = process.stdout,
  fleet?: string,
): WatchdogIO {
  const paths = afkPaths(root, fleet);
  const pidFile = paths.supervisorPidPath;
  const pidStartFile = paths.supervisorPidStartPath;
  const stopFile = paths.supervisorStopPath;
  const logFile = paths.supervisorLogPath;
  const restartLedgerFile = paths.supervisorRestartsPath;
  const enginePaths = createEnginePaths(join(root, ".red"));

  // Carried from liveness() → relaunch() so a recovered fleet keeps its target
  // and runner. Falls back to a 2-slot, freshly-detected-runner fleet when the
  // wedged supervisor left no usable heartbeat.
  let lastTarget = 2;
  let lastRunner = "";
  let lastSlotPids: HeartbeatSlotPid[] = [];

  // Count worker processes that survived the supervisor's death. Workers are
  // spawned detached, so they outlive the supervisor; the dead-supervisor net
  // measures "below target" against this live count, not the stale heartbeat.
  const liveWorkerCount = async (): Promise<number> => {
    let workerDirs: string[];
    try {
      workerDirs = await readdir(paths.workersRoot);
    } catch {
      return 0;
    }
    let live = 0;
    for (const workerDir of workerDirs) {
      const pidPath = join(paths.workersRoot, workerDir, "worker.pid");
      try {
        const raw = (await readFile(pidPath, "utf8")).trim();
        if (!/^[1-9][0-9]*$/.test(raw)) continue;
        if (isLivePid(Number(raw))) live += 1;
      } catch {
        // best-effort: a missing/bad pid file counts as no live worker.
      }
    }
    return live;
  };

  return {
    now: () => Math.floor(Date.now() / 1000),

    liveness: async (): Promise<SupervisorLiveness> => {
      const pid = await readPid(pidFile);
      const startTime = await readFile(pidStartFile, "utf8").then((value) => value.trim()).catch(() => "");
      const fleet = await readFleetState(paths.fleetStatePath);
      if (fleet) {
        if (fleet.slotsTotal > 0) lastTarget = fleet.slotsTotal;
        if (fleet.runner) lastRunner = fleet.runner;
        lastSlotPids = fleet.slotPids ?? [];
      }
      return {
        pid,
        pidAlive:
          pid !== null &&
          isSupervisorIdentityLive({ pid, startTime }, isLivePid, readPidStartTime),
        lastHeartbeatEpoch: fleet ? fleet.epoch : null,
        lastProgressEpoch: fleet?.lastProgressEpoch ?? null,
        slotsBusy: fleet?.slotsBusy ?? 0,
      };
    },

    killTree: async (pid) => {
      await killTreeAndWait(pid);
    },

    killWorkers: async (): Promise<{ killed: number; survivors: number[] }> => {
      // Workers are spawned detached (nohup'd) so they are NOT children of the
      // supervisor — killTree misses them. A hard teardown may kill only workers
      // whose castle snapshot attributes them to this named fleet; another
      // fleet's workers and unstamped standalone workers are never collateral.
      let workerDirs: string[];
      try {
        workerDirs = await readdir(paths.workersRoot);
      } catch {
        return { killed: 0, survivors: [] };
      }
      let killed = 0;
      const survivors: number[] = [];
      for (const workerDir of workerDirs) {
        const pidPath = join(paths.workersRoot, workerDir, "worker.pid");
        try {
          const snapshot = await readCastleStateSnapshot(
            castleStateSnapshotPath(enginePaths, "worker", workerDir),
          );
          if (snapshot?.supervisor_id !== paths.fleet) continue;
          const raw = (await readFile(pidPath, "utf8")).trim();
          if (!/^[1-9][0-9]*$/.test(raw)) continue;
          const workerPid = Number(raw);
          if (isLivePid(workerPid)) {
            if (await killTreeAndWait(workerPid)) {
              killed += 1;
            } else {
              survivors.push(workerPid);
            }
          }
        } catch {
          // best-effort: missing/bad pid file is not an error.
        }
      }
      return { killed, survivors };
    },

    clearControlFiles: async () => {
      await rm(pidFile, { force: true });
      await rm(pidStartFile, { force: true });
      await rm(stopFile, { force: true });
    },

    // Reconcile GitHub before deleting local claim evidence. A failed remote
    // read/edit leaves the directory intact for the replacement supervisor's
    // boot sweep; only a completed remote decision consumes the issue number.
    reconcile: async () => {
      const stale = await listStaleClaimDirs(paths.tmpDir).catch(() => []);
      const repo = await resolveRepoSlug(root);
      const gh = { cwd: root, repo };
      for (const claim of stale) {
        if (claim.issue === undefined) continue;
        try {
          const labels = await viewLabels(gh, claim.issue);
          const parked = labels.includes(LABEL_HUMAN) || labels.some((label) => label.startsWith("blocked:"));
          if (labels.includes(LABEL_RUNNING) && !parked) {
            const edited = await editLabels(gh, claim.issue, [LABEL_RUNNING], [LABEL_READY]);
            if (!edited) continue;
          }
          await removeDir(claim.path);
        } catch {
          // Preserve the claim for boot when GitHub reconciliation is uncertain.
        }
      }
    },

    isRecoveryPending: async () => fileExists(paths.supervisorRecoveryPath),

    setRecoveryPending: async (pending) => {
      if (pending) {
        await writeFile(paths.supervisorRecoveryPath, "quiescent-relaunch\n", "utf8");
      } else {
        await rm(paths.supervisorRecoveryPath, { force: true });
      }
    },

    relaunch: async () => {
      const runner =
        lastRunner ||
        detectRunner({
          processTree: callerProcessTreeNative(),
          scriptPath: process.argv[1],
        }).runner;
      const spawnedPid = await spawnSupervisor({
        root,
        target: lastTarget,
        runner,
        adoptSlotPids: lastSlotPids,
        fleet: paths.fleet,
      });
      if (spawnedPid === null) return false;
      const identity = await readSupervisorIdentity(pidFile, pidStartFile);
      if (
        identity === null ||
        identity.pid !== spawnedPid ||
        !isSupervisorIdentityLive(identity, isLivePid, readPidStartTime)
      ) {
        return false;
      }
      // Stamp a fresh heartbeat so the very next watchdog pass (a monitor cron
      // tick firing every poll) sees the new supervisor as healthy and does not
      // double-fire while it boots.
      try {
        stampFreshFleetHeartbeat(paths.fleetStatePath, Math.floor(Date.now() / 1000), runner, lastTarget);
      } catch {
        // best-effort
      }
      return true;
    },

    deadSupervisorSignals: async (): Promise<DeadSupervisorSignals> => {
      const fleet = await readFleetState(paths.fleetStatePath);
      const target = fleet && fleet.slotsTotal > 0 ? fleet.slotsTotal : lastTarget;
      // Prefer a LIVE queue count — a supervisor that died before its last
      // heartbeat could have new stranded work the stale state never recorded.
      // Fall back to the last heartbeat's readyForAgent when gh is unreachable.
      let readyForAgent = fleet?.readyForAgent ?? 0;
      try {
        const repo = await resolveRepoSlug(root).catch(() => "");
        readyForAgent = await countReadyForAgent({ repo, cwd: root });
      } catch {
        // best-effort: keep the last-heartbeat fallback.
      }
      const liveWorkers = await liveWorkerCount();
      const stopRequested = await fileExists(stopFile);
      return { readyForAgent, target, liveWorkers, stopRequested };
    },

    readBootBreaker: async () => {
      try {
        return await createFileBootBreakerStore(createEnginePaths(join(root, ".red"))).read();
      } catch {
        return null;
      }
    },

    readRestartLedger: async (): Promise<number[]> => {
      try {
        const raw = await readFile(restartLedgerFile, "utf8");
        // Sniff JSON-then-TOON so a ledger written by an older bundle still reads.
        const parsed = decodeDevSnapshotSniff(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
      } catch {
        return [];
      }
    },

    writeRestartLedger: async (epochs: number[]): Promise<void> => {
      try {
        // TOON, never raw JSON — the supervisor restart-ledger snapshot (ADR 0097).
        await writeFile(restartLedgerFile, encodeDevSnapshotToon(epochs), "utf8");
      } catch {
        // best-effort: a failed ledger write only weakens the crash-loop bound.
      }
    },

    log: (line) => {
      try {
        stdout.write(`${line}\n`);
      } catch {
        // best-effort
      }
      void appendRecordToonl(logFile, "watchdog", line, {
        ts: new Date().toISOString(),
        fields: { worker: "fleet" },
      }).catch(() => undefined);
    },
  };
}
