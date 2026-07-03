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
  /**
   * Point-in-time signals for the DEAD-supervisor respawn decision (#1097),
   * gathered only when the supervisor is found dead (pid file present but its pid
   * no longer alive). Best-effort: a gh failure degrades `readyForAgent` to the
   * last heartbeat's value, a missing worker dir counts as zero live workers.
   * Absent → the dead-supervisor safety net never fires (back-compat; a test IO
   * that omits it keeps the pre-#1097 behaviour).
   */
  deadSupervisorSignals?(): Promise<DeadSupervisorSignals>;
  /** Read the persisted dead-supervisor restart ledger (epoch seconds). Best-effort:
   * a missing/corrupt ledger reads as an empty list. */
  readRestartLedger?(): Promise<number[]>;
  /** Persist the pruned dead-supervisor restart ledger after a respawn. Best-effort. */
  writeRestartLedger?(epochs: number[]): Promise<void>;
  /** Loud, structured progress line (best-effort). */
  log(line: string): void;
}

/**
 * The signals the dead-supervisor safety net (#1097) reads when a supervisor is
 * found dead. All are point-in-time and best-effort; the pure decider
 * {@link decideDeadSupervisorRespawn} turns them into a respawn / skip / crash-loop
 * verdict.
 */
export interface DeadSupervisorSignals {
  /** Current claimable `ready-for-agent` queue depth. */
  readyForAgent: number;
  /** Desired worker count (fleet target). */
  target: number;
  /** Live worker processes that survived the supervisor's death — detached workers
   * outlive their supervisor, so "below target" is measured against the real live
   * count, not the stale heartbeat's slot bookkeeping. */
  liveWorkers: number;
  /** True when a graceful `fleet stop` was requested (stop file present) — the
   * safety net never resurrects a supervisor the operator asked to stop. */
  stopRequested: boolean;
}

/** Pure input to {@link decideDeadSupervisorRespawn}. */
export interface DeadSupervisorRespawnInput {
  readyForAgent: number;
  liveWorkers: number;
  target: number;
  /** Restart epochs recorded by prior respawns (the crash-loop ledger). */
  priorRestarts: readonly number[];
  now: number;
  /** Sliding window for the crash-loop bound (seconds). */
  windowS: number;
  /** Max respawns allowed inside the window before the net suppresses instead. */
  maxRestarts: number;
}

export type DeadSupervisorAction = "respawn" | "skip" | "crash-loop-suppressed";

export interface DeadSupervisorDecision {
  action: DeadSupervisorAction;
  /** The ledger to persist. On "respawn" it is the pruned prior restarts plus
   * `now`; otherwise the pruned prior restarts unchanged. */
  restarts: number[];
  /** Restart count inside the window — after adding this respawn on "respawn",
   * or the current count on "crash-loop-suppressed"/"skip". Drives the alert line. */
  countInWindow: number;
}

/**
 * decideDeadSupervisorRespawn — the pure dead-supervisor safety-net decision
 * (#1097). Called only once the supervisor is already known dead-with-a-recorded-pid
 * and not stop-requested (those cheaper guards live in {@link runWatchdog} so this
 * stays a pure function of the observable fleet state). Order:
 *
 *   1. Prune the restart ledger to the crash-loop window.
 *   2. `skip` when nothing is stranded (`readyForAgent <= 0`) or the fleet is not
 *      actually short-handed (`liveWorkers >= target`). A supervisor that died
 *      after cleanly draining its queue is NOT a fault condition.
 *   3. `crash-loop-suppressed` when the pruned restart count already reached
 *      `maxRestarts` — respawning again would just hide a repeating crash.
 *   4. `respawn` otherwise, appending `now` to the ledger.
 *
 * Clock skew (a future-stamped restart) only makes the window wider, never
 * narrower, so the bound can never be under-counted by a skewed clock.
 */
export function decideDeadSupervisorRespawn(
  input: DeadSupervisorRespawnInput,
): DeadSupervisorDecision {
  const pruned = input.priorRestarts.filter((t) => input.now - t <= input.windowS);
  if (input.readyForAgent <= 0 || input.liveWorkers >= input.target) {
    return { action: "skip", restarts: [...pruned], countInWindow: pruned.length };
  }
  if (pruned.length >= input.maxRestarts) {
    return { action: "crash-loop-suppressed", restarts: [...pruned], countInWindow: pruned.length };
  }
  const restarts = [...pruned, input.now];
  return { action: "respawn", restarts, countInWindow: restarts.length };
}

export interface WatchdogResult {
  health: SupervisorHealth;
  /** True only when this pass tore down + relaunched a quiescent supervisor. */
  recovered: boolean;
  /** The wedged supervisor pid that was recovered, when recovered. */
  pid: number | null;
  /** Heartbeat age in seconds at detection, when a heartbeat was observed. */
  staleForS: number | null;
  /** True only when this pass respawned a DEAD supervisor stranding a non-empty
   * queue (#1097). Distinct from `recovered`, which is the quiescent (#407) path. */
  respawnedDeadSupervisor: boolean;
  /** True when a dead supervisor met the respawn condition but the crash-loop
   * bound was already reached, so the net logged the loop instead of respawning. */
  crashLoopSuppressed: boolean;
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
 * the new supervisor boots.
 *
 * Two independent recovery conditions:
 *   - QUIESCENT (#407): a live PID whose heartbeat/progress is stale → tear down
 *     and relaunch (the original path, unchanged).
 *   - DEAD-with-stranded-work (#1097): the pid file points to a no-longer-alive
 *     process (a silent mid-drain crash, NOT a graceful `fleet stop` — that removes
 *     the pid file) while `ready-for-agent` work is stranded and live workers are
 *     below target → respawn the fleet, bounded by the crash-loop guard so a
 *     repeating crash surfaces instead of respawning forever.
 *
 * A healthy supervisor, or a dead one whose queue is empty / whose workers are at
 * target, is left untouched — the launch pre-check handles the "refuse to stack on
 * a healthy fleet" case itself by inspecting the returned `health`.
 */
export async function runWatchdog(
  io: WatchdogIO,
  staleS: number,
  progressStaleS: number,
  restartBound: { maxRestarts: number; windowS: number } = { maxRestarts: 5, windowS: 300 },
): Promise<WatchdogResult> {
  const now = io.now();
  const liveness = await io.liveness();
  const health = classifySupervisor(liveness, now, staleS, progressStaleS);
  const staleForS = liveness.lastHeartbeatEpoch !== null ? now - liveness.lastHeartbeatEpoch : null;

  const base: WatchdogResult = {
    health,
    recovered: false,
    pid: liveness.pid,
    staleForS,
    respawnedDeadSupervisor: false,
    crashLoopSuppressed: false,
  };

  if (health === "healthy") return base;

  if (health === "absent") {
    // A null pid means the pid file is gone — a graceful `fleet stop` (or a fleet
    // that never launched). NEVER resurrect that; the safety net only fires for a
    // crashed supervisor that left its pid file behind pointing at a dead pid.
    if (liveness.pid === null) return base;
    return await recoverDeadSupervisor(io, liveness.pid, now, restartBound, base);
  }

  // health === "quiescent"
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
  return { ...base, recovered: true };
}

/**
 * recoverDeadSupervisor — the DEAD-supervisor safety net (#1097). Called only when
 * the supervisor is classified absent WITH a recorded (dead) pid: a silent
 * mid-drain crash. Gathers the observable fleet state, runs the pure
 * {@link decideDeadSupervisorRespawn} decision, and — on "respawn" — records the
 * restart, clears the stale control files, reconciles stranded claims, and
 * relaunches. Unlike the quiescent path it does NOT kill workers: detached workers
 * that outlived the crash are still legitimately draining their claims, so killing
 * them would throw away in-flight work. Every step is best-effort.
 *
 * The respawn is idempotent across monitor ticks: relaunch stamps a fresh
 * heartbeat + pid, so the next pass sees "healthy" and does not double-fire.
 */
async function recoverDeadSupervisor(
  io: WatchdogIO,
  pid: number,
  now: number,
  bound: { maxRestarts: number; windowS: number },
  base: WatchdogResult,
): Promise<WatchdogResult> {
  // No signal source wired (a pre-#1097 test IO) → the net is inert (back-compat).
  if (!io.deadSupervisorSignals) return base;

  let signals: DeadSupervisorSignals;
  try {
    signals = await io.deadSupervisorSignals();
  } catch {
    // Can't assess the fleet → do nothing rather than respawn blind.
    return base;
  }
  // The operator asked to stop — never resurrect a supervisor mid-shutdown.
  if (signals.stopRequested) return base;

  let ledger: number[] = [];
  try {
    ledger = (await io.readRestartLedger?.()) ?? [];
  } catch {
    ledger = [];
  }

  const decision = decideDeadSupervisorRespawn({
    readyForAgent: signals.readyForAgent,
    liveWorkers: signals.liveWorkers,
    target: signals.target,
    priorRestarts: ledger,
    now,
    windowS: bound.windowS,
    maxRestarts: bound.maxRestarts,
  });

  if (decision.action === "skip") return base;

  if (decision.action === "crash-loop-suppressed") {
    io.log(
      `⛔ watchdog: supervisor pid=${pid} DIED with ${signals.readyForAgent} ready-for-agent ` +
        `issue(s) stranded and ${signals.liveWorkers}/${signals.target} live worker(s), but ` +
        `${decision.countInWindow} restart(s) within ${bound.windowS}s hit the max-restarts cap ` +
        `(${bound.maxRestarts}) — NOT respawning. Investigate the crash loop; delete ` +
        `.red/tmp/afk-supervisor.restarts.json to reset the bound.`,
    );
    return { ...base, crashLoopSuppressed: true };
  }

  io.log(
    `⚠️  watchdog: supervisor pid=${pid} DIED with ${signals.readyForAgent} ready-for-agent ` +
      `issue(s) stranded and only ${signals.liveWorkers}/${signals.target} live worker(s) — ` +
      `respawning the fleet (restart ${decision.countInWindow}/${bound.maxRestarts} within ${bound.windowS}s).`,
  );

  try {
    await io.writeRestartLedger?.(decision.restarts);
  } catch {
    // best-effort: a failed ledger write only weakens the crash-loop bound.
  }
  try {
    await io.clearControlFiles();
  } catch {
    // best-effort: the stale pid file may already be gone.
  }
  try {
    await io.reconcile();
  } catch {
    // best-effort: the relaunched workers' boot sweep also reconciles.
  }
  try {
    await io.relaunch();
  } catch (err) {
    io.log(`watchdog: relaunch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  io.log(`watchdog: dead supervisor respawned — fresh fleet relaunched (target ${signals.target}).`);
  return { ...base, respawnedDeadSupervisor: true };
}
