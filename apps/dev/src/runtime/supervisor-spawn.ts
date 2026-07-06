// supervisor-spawn — the single place that spawns the native `__supervise`
// process. Shared by the fleet-launch command (fleet.ts) and the external
// watchdog's relaunch (watchdog-io.ts) so both speak the same pid/stop-file
// protocol and forward the same filter/policy args. No decision logic lives
// here — callers resolve target/runner/passthrough and inject them.

import { spawn } from "node:child_process";
import { openSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

async function waitForPidFile(pidFile: string, deadlineMs: number): Promise<number | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const pid = await readPid(pidFile);
    if (pid && isLivePid(pid)) return pid;
    await sleep(100);
  }
  return null;
}

export interface SpawnSupervisorOptions {
  root: string;
  target: number;
  runner: string;
  /** Filter/policy argv (--prd/--issues/--alternate/--fallback-runner) threaded
   * into each slot's `run --once`. */
  passthrough?: readonly string[];
  /** Optional fleet request, forwarded as RED_AFK_REQUEST + `--request`. */
  request?: string;
  /** Optional per-drain USD budget, forwarded as RED_AFK_DRAIN_MAX_COST_USD. */
  drainBudgetUsd?: number;
}

/**
 * Spawn a detached `__supervise` process for `root`, waiting up to 3s for it to
 * write its pid file. Returns the supervisor pid, or null when the pid file
 * never appeared (the caller surfaces the log tail). Mirrors fleet.ts's original
 * inline spawn so launch + watchdog-relaunch stay byte-identical.
 */
export async function spawnSupervisor(opts: SpawnSupervisorOptions): Promise<number | null> {
  const tmp = join(opts.root, ".red", "tmp");
  const pidFile = join(tmp, "afk-supervisor.pid");
  const logFile = join(tmp, "afk-supervisor.log");

  const childArgs = [...(opts.passthrough ?? [])];
  if (opts.request) childArgs.unshift("--request", opts.request);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RED_AFK_TARGET: String(opts.target),
    RED_AFK_RUNNER: opts.runner,
  };
  if (opts.request) env.RED_AFK_REQUEST = opts.request;
  if (opts.drainBudgetUsd !== undefined) env.RED_AFK_DRAIN_MAX_COST_USD = String(opts.drainBudgetUsd);

  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [process.argv[1]!, "__supervise", ...childArgs], {
    cwd: opts.root,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  return waitForPidFile(pidFile, 3_000);
}

/**
 * Stamp a placeholder #406 fleet-heartbeat state file with `epoch` so a freshly
 * relaunched supervisor is not itself read as quiescent during its boot window
 * (the watchdog's idempotency guard). The new supervisor overwrites this on its
 * first real tick. Atomic write (tmp + rename), best-effort — a failure to stamp
 * only narrows the double-fire guard, it never blocks the relaunch.
 */
export function stampFreshFleetHeartbeat(
  statePath: string,
  epoch: number,
  runner: string,
  target: number,
): void {
  const body = JSON.stringify(
    {
      ts: new Date(epoch * 1000).toISOString(),
      epoch,
      // A fresh relaunch stamp counts as progress: the new supervisor is
      // healthy until proven otherwise, so seed both epochs to `epoch`.
      last_progress_epoch: epoch,
      runner,
      ready_for_agent: 0,
      slots: { busy: 0, free: target, total: target, parked: 0 },
      spawns_this_tick: 0,
    },
    null,
    2,
  );
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, statePath);
}
