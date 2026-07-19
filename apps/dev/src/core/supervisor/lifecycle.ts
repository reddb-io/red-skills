import type { SupervisorConfig } from "./config.js";

export interface SupervisorLiveness {
  /** The supervisor pid from afk-supervisor.pid, or null when no pid file. */
  pid: number | null;
  /** Whether that pid is alive (kill -0). Meaningless when pid is null. */
  pidAlive: boolean;
  /** Epoch seconds of the last #406 heartbeat, or null when none was observed. */
  lastHeartbeatEpoch: number | null;
  /**
   * Epoch seconds of the last NON-ABANDONED tick (#579). A tick that timed out
   * (guardedTick returned continueResult) does NOT advance this epoch. When null
   * the supervisor has not completed any tick yet — treated as healthy (can't
   * prove a wedge on a freshly-launched fleet).
   */
  lastProgressEpoch: number | null;
  /** Number of slots currently occupied by a live worker process, from the state
   * file. Used by the progress-stale check: a supervisor with no busy slots is
   * idle (not stuck), so progress staleness alone cannot prove a wedge. */
  slotsBusy: number;
}

/**
 * The watchdog's verdict on a supervisor:
 *   - "absent"    — no live supervisor (no pid / dead pid): nothing to recover;
 *                   a launch may proceed, a monitor tick stays quiet.
 *   - "healthy"   — a live PID whose heartbeat is fresh (or not yet observed, so
 *                   it cannot be PROVEN wedged): leave it alone.
 *   - "quiescent" — a live PID whose heartbeat is stale past the threshold: the
 *                   drain loop is hard-hung and must be recovered.
 */
export type SupervisorHealth = "absent" | "healthy" | "quiescent";

/**
 * classifySupervisor — the pure quiescence detector (#407, #579). Two checks:
 *
 *  1. Heartbeat stale (original #407 check): the wall-clock heartbeat epoch has
 *     not advanced in `staleS` seconds → the supervisor process itself is hard-hung
 *     (below the tick boundary, e.g. a stuck gh call that guardedTick cannot race).
 *
 *  2. Progress stale (#579): the heartbeat IS fresh but every recent tick was
 *     abandoned (timed out / threw), so no `lastProgressEpoch` has been recorded
 *     for `progressStaleS` seconds while slots are occupied. The supervisor is
 *     looping but not completing its supervisory work — treated as quiescent.
 *
 * A missing epoch (null) means the supervisor is freshly launched and has not
 * completed a tick yet — never enough to prove a wedge. Clock skew (a future-
 * stamped epoch) yields a negative age < threshold → healthy.
 */
export function classifySupervisor(
  liveness: SupervisorLiveness,
  now: number,
  staleS: number,
  progressStaleS: number,
): SupervisorHealth {
  if (liveness.pid === null || !liveness.pidAlive) return "absent";
  if (liveness.lastHeartbeatEpoch === null) return "healthy";
  // Check 1: wall-clock heartbeat stale → hard-hung process.
  if (now - liveness.lastHeartbeatEpoch >= staleS) return "quiescent";
  // Check 2: progress stale with occupied slots → loop spinning on abandoned ticks.
  if (
    liveness.lastProgressEpoch !== null &&
    now - liveness.lastProgressEpoch >= progressStaleS &&
    liveness.slotsBusy > 0
  ) {
    return "quiescent";
  }
  return "healthy";
}

// ---------- circuit breaker (pure) ----------

/**
 * The circuit-breaker decision for one slot after a worker death, mirroring the
 * fast-death-ring logic in handle_dead_slot (supervisor.sh ~1012-1031). Pure:
 * given the timestamped death events already recorded for the slot, the new
 * death epoch, and the breaker tunables, it prunes the ring to the window and
 * decides respawn vs trip-and-park.
 */
export interface CircuitDecision {
  /** Death epochs still inside the window after pruning (the new ring). */
  deaths: number[];
  /** Fast-death count after recording this death (deaths.length). */
  count: number;
  /** True when the worker died within fastDeathThresholdS of spawn. */
  fastDeath: boolean;
  /** True when count reached circuitK inside the window → slot parks. */
  trip: boolean;
}

/**
 * Record one worker death against a slot's fast-death ring and decide whether
 * the circuit trips. `priorDeaths` is the slot's ring before this death;
 * `spawnEpoch` and `deathEpoch` bound the worker's lifetime; the tunables are
 * the breaker window/threshold/K.
 *
 * Parity with handle_dead_slot:
 *   - A death is "fast" only when spawnEpoch > 0 AND lifetime < fastDeathThresholdS.
 *   - A slow death does NOT touch the ring (the bash branch is gated on the fast
 *     condition) and never trips — the slot respawns.
 *   - On a fast death the ring is the prior ring + this death, pruned to
 *     entries within circuitWindowS of deathEpoch, and the trip fires when the
 *     pruned count >= circuitK.
 */
export function recordDeath(
  priorDeaths: readonly number[],
  spawnEpoch: number,
  deathEpoch: number,
  config: Pick<SupervisorConfig, "fastDeathThresholdS" | "circuitWindowS" | "circuitK">,
): CircuitDecision {
  const lifetime = deathEpoch - spawnEpoch;
  const fastDeath = spawnEpoch > 0 && lifetime < config.fastDeathThresholdS;
  if (!fastDeath) {
    // Slow death: ring untouched, slot respawns (no prune, no trip).
    return { deaths: [...priorDeaths], count: priorDeaths.length, fastDeath: false, trip: false };
  }
  const pruned = [...priorDeaths, deathEpoch].filter(
    (t) => deathEpoch - t <= config.circuitWindowS,
  );
  const count = pruned.length;
  return { deaths: pruned, count, fastDeath: true, trip: count >= config.circuitK };
}

