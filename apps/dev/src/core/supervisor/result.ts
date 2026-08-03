import type { DrainBudgetStatus } from "./config.js";
import type { TrunkFreshnessOutcome } from "./types.js";

export interface TickResult {
  respawned: number[];
  /** Slots whose worker died and were handled (respawn or park). */
  deaths: number[];
  /** Slots parked by a circuit-breaker trip this tick. */
  parked: number[];
  /** Slots that entered idle-park this tick (clean drain, empty queue). */
  idleParked: number[];
  /** Slots whose cooldown expired and a half-open probe was spawned this tick. */
  halfOpened: number[];
  reaped: number[];
  /** Issues re-queued this tick because their claiming worker died mid-attempt
   * and stranded them in `running` (#815, ADR 0071 Pattern 5). One entry per
   * issue the running supervisor reconciled off the dead-slot respawn path. */
  crashReconciled: number[];
  /** Slots into which a reconcile worker was dispatched this tick. */
  reconciledSlots: number[];
  /** Latest continuous trunk freshness tick outcome, when the seam is wired. */
  trunkFreshness?: TrunkFreshnessOutcome;
  /** Slots removed from the runtime fleet by elastic shrink this tick. */
  retiredSlots: number[];
  /** True when a live directive changed the fleet runner this tick. */
  runnerChanged: boolean;
  /** True when the stop-file was honoured and the supervisor stopped claiming. */
  stopped: boolean;
  /** Ready-queue depth sampled at the start of this tick (0 on an abandoned
   * tick or when readyQueueDepth is unavailable). Used by emitFleetHeartbeat
   * so the queue is fetched exactly once per tick. */
  queueDepth: number;
  drainBudget?: DrainBudgetStatus;
  /**
   * True when the tick was abandoned — guardedTick timed out or threw. An
   * abandoned tick does NOT advance lastProgressEpoch in the heartbeat; only
   * ticks that complete normally are counted as "forward progress" (#579).
   */
  abandoned: boolean;
}
