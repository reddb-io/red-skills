// watchdog-io — REAL process / fs IO backing the external supervisor watchdog
// (core/watchdog.ts). Built once per surface (fleet pre-check / monitor tick),
// bound to a repo root. Every closure is best-effort, mirroring the supervisor's
// own injected IO: a failed kill / stat / spawn degrades to the safe value and
// never throws out of the closure.

import { constants } from "node:fs";
import { access, readFile, readdir, rm } from "node:fs/promises";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { SupervisorLiveness } from "../core/supervisor.js";
import type { WatchdogIO } from "../core/watchdog.js";
import { afkPaths, readFleetState } from "./wire.js";
import { listStaleClaimDirs, removeDir } from "./fs.js";
import { detectRunner } from "../core/runner-detection.js";
import { callerProcessTreeNative } from "./caller-process.js";
import { spawnSupervisor, stampFreshFleetHeartbeat } from "./supervisor-spawn.js";
// The wait-and-escalate killer (SIGTERM → grace → SIGKILL → confirm) is shared
// with the fleet reaper and `fleet stop` (#580). It matters for recovery
// correctness here too: the supervisor's own `finally` removes the pid/stop
// files on exit, so the relaunch must not write a fresh pid file until the dying
// process has finished cleaning up — otherwise it would clobber the new one.
import { isLivePid, killTreeAndWait } from "./kill-tree.js";

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
 * monitor tick / launch surfaces the recovery loudly) AND appended to
 * afk-supervisor.log so the recovery is durable in the same place the fleet's
 * own heartbeat lives. The last fleet-state read by `liveness()` is cached so a
 * relaunch restores the prior target/runner instead of guessing.
 */
export function buildWatchdogIO(
  root: string,
  stdout: NodeJS.WritableStream = process.stdout,
): WatchdogIO {
  const paths = afkPaths(root);
  const pidFile = join(paths.tmpDir, "afk-supervisor.pid");
  const stopFile = join(paths.tmpDir, "afk-supervisor.stop");
  const logFile = join(paths.tmpDir, "afk-supervisor.log");

  // Carried from liveness() → relaunch() so a recovered fleet keeps its target
  // and runner. Falls back to a 2-slot, freshly-detected-runner fleet when the
  // wedged supervisor left no usable heartbeat.
  let lastTarget = 2;
  let lastRunner = "";

  return {
    now: () => Math.floor(Date.now() / 1000),

    liveness: async (): Promise<SupervisorLiveness> => {
      const pid = await readPid(pidFile);
      const fleet = await readFleetState(paths.fleetStatePath);
      if (fleet) {
        if (fleet.slotsTotal > 0) lastTarget = fleet.slotsTotal;
        if (fleet.runner) lastRunner = fleet.runner;
      }
      return {
        pid,
        pidAlive: pid !== null && isLivePid(pid),
        lastHeartbeatEpoch: fleet ? fleet.epoch : null,
        lastProgressEpoch: fleet?.lastProgressEpoch ?? null,
        slotsBusy: fleet?.slotsBusy ?? 0,
      };
    },

    killTree: async (pid) => {
      await killTreeAndWait(pid);
    },

    killWorkers: async () => {
      // Workers are spawned detached (nohup'd) so they are NOT children of the
      // supervisor — killTree misses them. Enumerate every worker dir and kill
      // any still-alive PID recorded in worker.pid. Best-effort per worker: a
      // failed read or kill on one worker must not block the rest.
      let workerDirs: string[];
      try {
        workerDirs = await readdir(paths.workersRoot);
      } catch {
        return;
      }
      for (const workerDir of workerDirs) {
        const pidPath = join(paths.workersRoot, workerDir, "worker.pid");
        try {
          const raw = (await readFile(pidPath, "utf8")).trim();
          if (!/^[1-9][0-9]*$/.test(raw)) continue;
          const workerPid = Number(raw);
          if (isLivePid(workerPid)) {
            await killTreeAndWait(workerPid);
          }
        } catch {
          // best-effort: missing/bad pid file is not an error.
        }
      }
    },

    clearControlFiles: async () => {
      await rm(pidFile, { force: true });
      await rm(stopFile, { force: true });
    },

    // Reconcile stranded claims: drop every claim-lock dir whose owning worker
    // pid is dead, so no issue stays claimed (and unre-grabbable) across the
    // restart. listStaleClaimDirs already gates on liveness, so a claim a still-
    // live orphaned worker holds is left untouched. The relaunched fleet's
    // worker boot finishes the gh label rotation (the trip-sweep / orphan path).
    reconcile: async () => {
      const stale = await listStaleClaimDirs(paths.tmpDir).catch(() => []);
      for (const dir of stale) {
        await removeDir(dir.path).catch(() => {});
      }
    },

    relaunch: async () => {
      const runner =
        lastRunner ||
        detectRunner({
          processTree: callerProcessTreeNative(),
          scriptPath: process.argv[1],
        }).runner;
      await spawnSupervisor({ root, target: lastTarget, runner });
      // Stamp a fresh heartbeat so the very next watchdog pass (a monitor cron
      // tick firing every poll) sees the new supervisor as healthy and does not
      // double-fire while it boots.
      try {
        stampFreshFleetHeartbeat(paths.fleetStatePath, Math.floor(Date.now() / 1000), runner, lastTarget);
      } catch {
        // best-effort
      }
    },

    log: (line) => {
      try {
        stdout.write(`${line}\n`);
      } catch {
        // best-effort
      }
      try {
        const fd = openSync(logFile, "a");
        try {
          writeSync(fd, `[${new Date().toISOString()}] ${line}\n`);
        } finally {
          closeSync(fd);
        }
      } catch {
        // best-effort: a log-write failure must never affect recovery.
      }
    },
  };
}
