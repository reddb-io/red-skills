import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afkPaths } from "./wire.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLivePid(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return null;
    const pid = Number(raw);
    return isLivePid(pid) ? pid : null;
  } catch {
    return null;
  }
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
  const existing = await readLivePid(paths.supervisorWatchdogPidPath);
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
    const pid = await readLivePid(paths.supervisorWatchdogPidPath);
    if (pid !== null) return pid;
    await sleep(100);
  }
  return null;
}
