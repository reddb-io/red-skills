// supervisor-spawn — the single place that spawns the native `__supervise`
// process. Shared by the fleet-launch command (fleet.ts) and the external
// watchdog's relaunch (watchdog-io.ts) so both speak the same pid/stop-file
// protocol and forward the same filter/policy args. No decision logic lives
// here — callers resolve target/runner/passthrough and inject them.

import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodeDevSnapshotToon } from "../core/toon-snapshot.js";
import type { ElasticShrinkMode, HeartbeatSlotPid } from "../core/supervisor.js";
import { afkPaths } from "./wire.js";
import { FLEET_NAME_ENV } from "../core/fleet-name.js";
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

async function waitForPinnedPid(
  pidFile: string,
  pidStartFile: string,
  deadlineMs: number,
): Promise<number | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const identity = await readSupervisorIdentity(pidFile, pidStartFile);
    if (identity && isSupervisorIdentityLive(identity, isLivePid, readPidStartTime)) {
      return identity.pid;
    }
    await sleep(100);
  }
  return null;
}

export interface SpawnSupervisorOptions {
  root: string;
  target: number;
  runner: string;
  /** Filter/policy argv (--spec/--issues/--alternate/--fallback-runner) threaded
   * into each slot's `run --once`. */
  passthrough?: readonly string[];
  /** Optional fleet request, forwarded as RED_AFK_REQUEST + `--request`. */
  request?: string;
  /** Optional per-drain USD budget, forwarded as RED_AFK_DRAIN_MAX_COST_USD. */
  drainBudgetUsd?: number;
  /** Initial shrink mode for runtime target decreases. */
  shrinkMode?: ElasticShrinkMode;
  /** Prior supervisor slot -> worker pid map for takeover/adoption. */
  adoptSlotPids?: readonly HeartbeatSlotPid[];
  /** Named fleet this supervisor owns (defaults to the `default` lane). */
  fleet?: string;
}

/**
 * Spawn a detached `__supervise` process for `root`, waiting up to 3s for it to
 * write its pid file. Returns the supervisor pid, or null when the pid file
 * never appeared (the caller surfaces the log tail). Mirrors fleet.ts's original
 * inline spawn so launch + watchdog-relaunch stay byte-identical.
 */
export async function spawnSupervisor(opts: SpawnSupervisorOptions): Promise<number | null> {
  const paths = afkPaths(opts.root, opts.fleet);
  mkdirSync(dirname(paths.supervisorPidPath), { recursive: true });
  const pidFile = paths.supervisorPidPath;

  const childArgs = [...(opts.passthrough ?? [])];
  if (opts.request) childArgs.unshift("--request", opts.request);
  // Name the fleet on BOTH channels: the flag is what the supervisor parses, the
  // env survives a re-exec that drops argv.
  childArgs.unshift("--fleet", paths.fleet);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RED_AFK_TARGET: String(opts.target),
    RED_AFK_RUNNER: opts.runner,
    [FLEET_NAME_ENV]: paths.fleet,
  };
  if (opts.request) env.RED_AFK_REQUEST = opts.request;
  if (opts.drainBudgetUsd !== undefined) env.RED_AFK_DRAIN_MAX_COST_USD = String(opts.drainBudgetUsd);
  if (opts.shrinkMode !== undefined) env.RED_AFK_SHRINK_MODE = opts.shrinkMode;
  if (opts.adoptSlotPids && opts.adoptSlotPids.length > 0) {
    env.RED_AFK_ADOPT_SLOT_PIDS = JSON.stringify(opts.adoptSlotPids);
  }

  const child = spawn(process.execPath, [process.argv[1]!, "__supervise", ...childArgs], {
    cwd: opts.root,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  return waitForPinnedPid(pidFile, paths.supervisorPidStartPath, 3_000);
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
  // TOON, never raw JSON — this is the fleet supervisor state snapshot surface
  // (ADR 0097); `readFleetState` sniffs so a stamp from an older bundle still reads.
  const body = encodeDevSnapshotToon({
    ts: new Date(epoch * 1000).toISOString(),
    epoch,
    // A fresh relaunch stamp counts as progress: the new supervisor is
    // healthy until proven otherwise, so seed both epochs to `epoch`.
    last_progress_epoch: epoch,
    target,
    runner,
    shrink_mode: "drain-then-retire",
    ready_for_agent: 0,
    slots: { busy: 0, free: target, total: target, parked: 0 },
    slot_pids: [],
    spawns_this_tick: 0,
  });
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, statePath);
}
