import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolveSupervisorConfig } from "../core/supervisor.js";
import { runSupervisorWatchdogLoop, runWatchdog } from "../core/watchdog.js";
import { resolveFleetFromArgs } from "../core/fleet-name.js";
import { afkPaths } from "../runtime/wire.js";
import { buildWatchdogIO } from "../runtime/watchdog-io.js";
import { isLivePid } from "../runtime/kill-tree.js";
import { readPidStartTime } from "../core/state.js";
import { isSupervisorIdentityLive, type SupervisorIdentity } from "../runtime/supervisor-state.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function recordedIdentity(pidPath: string, startPath: string): SupervisorIdentity | null {
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return null;
    return { pid: Number(raw), startTime: readFileSync(startPath, "utf8").trim() };
  } catch {
    return null;
  }
}

function recordedLivePid(pidPath: string, startPath: string): number | null {
  const identity = recordedIdentity(pidPath, startPath);
  return identity && isSupervisorIdentityLive(identity, isLivePid, readPidStartTime)
    ? identity.pid
    : null;
}

async function acquireWatchdogOwnership(paths: ReturnType<typeof afkPaths>): Promise<boolean> {
  const ownStartTime = readPidStartTime(process.pid);
  if (ownStartTime === null) return false;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(paths.supervisorWatchdogLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockPid = `${paths.supervisorWatchdogLockPath}/pid`;
      const lockStart = `${paths.supervisorWatchdogLockPath}/pid.start`;
      if (recordedLivePid(lockPid, lockStart) === null) {
        const stale = `${paths.supervisorWatchdogLockPath}.stale-${process.pid}`;
        try {
          renameSync(paths.supervisorWatchdogLockPath, stale);
          rmSync(stale, { recursive: true, force: true });
        } catch {
          // Another contender reclaimed the stale acquisition lane first.
        }
      } else {
        await sleep(25);
      }
      continue;
    }

    try {
      writeFileSync(`${paths.supervisorWatchdogLockPath}/pid.start`, ownStartTime, "utf8");
      writeFileSync(`${paths.supervisorWatchdogLockPath}/pid`, String(process.pid), "utf8");
      const existing = recordedLivePid(
        paths.supervisorWatchdogPidPath,
        paths.supervisorWatchdogPidStartPath,
      );
      if (existing !== null && existing !== process.pid) return false;
      writeFileSync(paths.supervisorWatchdogPidStartPath, ownStartTime, "utf8");
      writeFileSync(paths.supervisorWatchdogPidPath, String(process.pid), "utf8");
      return true;
    } finally {
      rmSync(paths.supervisorWatchdogLockPath, { recursive: true, force: true });
    }
  }
  return false;
}

/** Hidden, detached owner of the supervisor self-heal loop. */
export async function supervisorWatchdogCommand(
  args: string[],
  cwd = process.cwd(),
): Promise<number> {
  const fleet = resolveFleetFromArgs(args);
  const paths = afkPaths(cwd, fleet);
  const existing = recordedLivePid(
    paths.supervisorWatchdogPidPath,
    paths.supervisorWatchdogPidStartPath,
  );
  if (existing !== null && existing !== process.pid) return 0;
  if (!(await acquireWatchdogOwnership(paths))) return 1;

  const config = resolveSupervisorConfig();
  const io = buildWatchdogIO(cwd, process.stdout, fleet);
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);

  try {
    await runSupervisorWatchdogLoop({
      pollMs: config.pollIntervalS * 1000,
      shouldStop: () => stopping,
      sleep,
      onPassError: (error) => {
        io.log(
          `watchdog: pass failed; recovery remains armed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
      pass: async () => {
        if (existsSync(paths.supervisorStopPath)) {
          stopping = true;
          return;
        }
        const result = await runWatchdog(
          io,
          config.supervisorStaleS,
          config.progressStaleS,
          {
            maxRestarts: config.supervisorMaxRestarts,
            windowS: config.supervisorRestartWindowS,
          },
        );
        // A missing repo pid means the supervisor completed its explicit stop
        // and cleaned its identity. A stale recorded pid stays non-null and is
        // exactly the crash case the next pass must keep trying to recover.
        if (
          result.health === "absent" &&
          result.pid === null &&
          !(await io.isRecoveryPending?.())
        ) stopping = true;
        if (result.crashLoopSuppressed) stopping = true;
      },
    });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGHUP", stop);
    if (
      recordedLivePid(paths.supervisorWatchdogPidPath, paths.supervisorWatchdogPidStartPath) ===
      process.pid
    ) {
      rmSync(paths.supervisorWatchdogPidPath, { force: true });
      rmSync(paths.supervisorWatchdogPidStartPath, { force: true });
    }
  }
  return 0;
}
