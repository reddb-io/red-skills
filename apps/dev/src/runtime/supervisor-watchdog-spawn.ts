import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { afkPaths } from "./wire.js";
import { readPidStartTime } from "../core/state.js";
import { isSupervisorIdentityLive, readSupervisorIdentity } from "./supervisor-state.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLiveWatchdogPid(pidPath: string, startPath: string): Promise<number | null> {
  const identity = await readSupervisorIdentity(pidPath, startPath);
  return identity && isSupervisorIdentityLive(identity, isLivePid, readPidStartTime)
    ? identity.pid
    : null;
}

export interface SpawnSupervisorWatchdogOptions {
  root: string;
  fleet?: string;
}

/** Arm exactly one detached watchdog for one repo-scoped fleet lane. */
export async function spawnSupervisorWatchdog(
  options: SpawnSupervisorWatchdogOptions,
): Promise<number | null> {
  const paths = afkPaths(options.root, options.fleet);
  mkdirSync(dirname(paths.supervisorWatchdogPidPath), { recursive: true });
  const existing = await readLiveWatchdogPid(
    paths.supervisorWatchdogPidPath,
    paths.supervisorWatchdogPidStartPath,
  );
  if (existing !== null) return existing;

  const child = spawn(
    process.execPath,
    [process.argv[1]!, "__watchdog", "--fleet", paths.fleet],
    {
      cwd: options.root,
      env: process.env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  child.unref();

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const pid = await readLiveWatchdogPid(
      paths.supervisorWatchdogPidPath,
      paths.supervisorWatchdogPidStartPath,
    );
    if (pid !== null) return pid;
    await sleep(100);
  }
  return null;
}
