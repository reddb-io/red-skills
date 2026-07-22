import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolveSupervisorConfig } from "../core/supervisor.js";
import { runSupervisorWatchdogLoop, runWatchdog } from "../core/watchdog.js";
import { resolveFleetFromArgs } from "../core/fleet-name.js";
import { afkPaths } from "../runtime/wire.js";
import { buildWatchdogIO } from "../runtime/watchdog-io.js";
import { isLivePid } from "../runtime/kill-tree.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function recordedLivePid(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return null;
    const pid = Number(raw);
    return isLivePid(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Hidden, detached owner of the supervisor self-heal loop. */
export async function supervisorWatchdogCommand(
  args: string[],
  cwd = process.cwd(),
): Promise<number> {
  const fleet = resolveFleetFromArgs(args);
  const paths = afkPaths(cwd, fleet);
  const existing = recordedLivePid(paths.supervisorWatchdogPidPath);
  if (existing !== null && existing !== process.pid) return 0;
  writeFileSync(paths.supervisorWatchdogPidPath, String(process.pid), "utf8");

  const config = resolveSupervisorConfig();
  const io = buildWatchdogIO(cwd);
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
        if (result.health === "absent" && result.pid === null) stopping = true;
        if (result.crashLoopSuppressed) stopping = true;
      },
    });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGHUP", stop);
    if (recordedLivePid(paths.supervisorWatchdogPidPath) === process.pid) {
      rmSync(paths.supervisorWatchdogPidPath, { force: true });
    }
  }
  return 0;
}
