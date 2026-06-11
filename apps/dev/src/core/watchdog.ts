// watchdog — the EXTERNAL recovery layer for a hard-hung fleet supervisor
// (#407). The HITL decision (2026-06-08) was: a live-but-quiescent supervisor
// (alive PID, drain loop wedged, #406 heartbeat gone stale) cannot re-arm
// itself, so recovery is driven by an ALREADY-ALIVE surface — the fleet-launch
// pre-check (fleet.ts) and the auto-monitor tick (monitor.ts) — never a new
// standalone daemon.
//
// This module is PURE SEQUENCING over injected IO, mirroring supervisor.ts:
// every side effect (reading the pid/heartbeat, killing a tree, clearing the
// control files, reconciling stranded claims, relaunching `__supervise`) is
// injected through `WatchdogIO`. The decision itself — quiescent vs healthy vs
// absent — is `classifySupervisor` in supervisor.ts and is never re-implemented
// here. No real process / fs / gh call lives in this file.

import { classifySupervisor, type SupervisorHealth, type SupervisorLiveness } from "./supervisor.js";

/**
 * Injected IO for one watchdog pass. Each closure is best-effort — the same
 * `|| true` discipline the supervisor's gh/fs closures already follow — so a
 * failed kill / reconcile never throws out of the recovery sequence and the
 * relaunch still fires.
 */
export interface WatchdogIO {
  /** Current epoch seconds (date +%s), injected for determinism. */
  now(): number;
  /** Read the supervisor's pid + liveness + last #406 heartbeat epoch. */
  liveness(): Promise<SupervisorLiveness>;
  /** kill_tree the wedged supervisor pid + its descendants. */
  killTree(pid: number): Promise<void>;
  /**
   * Kill all still-alive worker processes that survived the supervisor's death
   * (#579). Workers are spawned `detached: true` (nohup'd) so they are NOT
   * children of the supervisor and killTree misses them. Best-effort: a failed
   * kill on one worker must not block the rest of the recovery sequence.
   */
  killWorkers(): Promise<void>;
  /** Remove the supervisor pid + stop control files so a relaunch is unblocked. */
  clearControlFiles(): Promise<void>;
  /** Reconcile claims/labels the wedged supervisor left so no issue is stranded
   * in `running` across the restart (reuse the trip-sweep / reap cleanup). */
  reconcile(): Promise<void>;
  /** Spawn a fresh `__supervise` and stamp a fresh heartbeat so the next tick is
   * not itself misread as quiescent during the boot window. */
  relaunch(): Promise<void>;
  /** Loud, structured progress line (best-effort). */
  log(line: string): void;
}

export interface WatchdogResult {
  health: SupervisorHealth;
  /** True only when this pass tore down + relaunched a quiescent supervisor. */
  recovered: boolean;
  /** The wedged supervisor pid that was recovered, when recovered. */
  pid: number | null;
  /** Heartbeat age in seconds at detection, when a heartbeat was observed. */
  staleForS: number | null;
}

/**
 * Tear down a supervisor proven quiescent: kill its tree, kill its detached
 * workers (#579), clear the control files, then reconcile any claims/labels it
 * stranded. Order matters — workers are killed while the supervisor is already
 * dead so their claim-locks reflect reality by the time reconcile runs; the
 * pid/stop files are cleared BEFORE the relaunch so the fresh supervisor's
 * single-supervisor lock is not tripped by the leftover pid file; and reconcile
 * runs after the kill so a still-live worker is judged dead-or-alive against
 * reality, not a phantom. Best-effort throughout: every step is wrapped so one
 * failure never aborts the rest of the recovery.
 */
export async function teardownWedgedSupervisor(io: WatchdogIO, pid: number | null): Promise<void> {
  if (pid !== null) {
    try {
      await io.killTree(pid);
    } catch {
      // best-effort: the pid may already be gone.
    }
  }
  try {
    await io.killWorkers();
  } catch {
    // best-effort: a failed worker kill must not block the rest of recovery.
  }
  try {
    await io.clearControlFiles();
  } catch {
    // best-effort
  }
  try {
    await io.reconcile();
  } catch {
    // best-effort: reconcile is also finished by the relaunched workers' boot.
  }
}

/**
 * Run one watchdog pass: classify the supervisor, and if quiescent, tear it down
 * and relaunch. Idempotent across repeated invocations of an already-alive
 * surface (a monitor cron tick firing every poll): the relaunch stamps a fresh
 * heartbeat, so the very next pass sees "healthy" and does not double-fire while
 * the new supervisor boots. A supervisor that is absent or healthy is left
 * untouched — the launch pre-check handles the "refuse to stack on a healthy
 * fleet" case itself by inspecting the returned `health`.
 */
export async function runWatchdog(
  io: WatchdogIO,
  staleS: number,
  progressStaleS: number,
): Promise<WatchdogResult> {
  const now = io.now();
  const liveness = await io.liveness();
  const health = classifySupervisor(liveness, now, staleS, progressStaleS);
  const staleForS = liveness.lastHeartbeatEpoch !== null ? now - liveness.lastHeartbeatEpoch : null;

  if (health !== "quiescent") {
    return { health, recovered: false, pid: liveness.pid, staleForS };
  }

  const progressStaleForS =
    liveness.lastProgressEpoch !== null ? now - liveness.lastProgressEpoch : null;
  const isProgressQuiescent =
    staleForS !== null && staleForS < staleS && progressStaleForS !== null;
  const reason = isProgressQuiescent
    ? `no completed tick for ${progressStaleForS}s ≥ ${progressStaleS}s with ${liveness.slotsBusy} busy slot(s) — loop spinning on abandoned ticks`
    : `heartbeat stale ${staleForS ?? "?"}s ≥ ${staleS}s threshold`;
  io.log(
    `⚠️  watchdog: supervisor pid=${liveness.pid ?? "?"} is QUIESCENT — ${reason}. Recovering.`,
  );
  await teardownWedgedSupervisor(io, liveness.pid);
  try {
    await io.relaunch();
  } catch (err) {
    io.log(`watchdog: relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  io.log(`watchdog: wedged supervisor recovered — fresh fleet relaunched.`);
  return { health, recovered: true, pid: liveness.pid, staleForS };
}
