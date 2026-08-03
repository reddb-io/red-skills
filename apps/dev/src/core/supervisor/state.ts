import { freshWakeStats, type WakeStats } from "../event-wake.js";
import type { DrainBudgetTier } from "./config.js";
import type { TrunkFreshnessOutcome } from "./types.js";

export interface ReapContestState {
  issue: number;
  branch: string;
  headAtReap: string | undefined;
  openedEpoch: number;
  deadlineEpoch: number;
}

/** The supervisor's per-slot bookkeeping, mirroring the SLOT_* arrays. A fresh
 * slot is `freshSlot()`. The tick mutates these in place (the bash arrays are
 * global mutable state); tests inspect them after each tick. */
export interface SlotState {
  pid: number | null;
  spawnEpoch: number;
  /** Fast-death ring, pruned to the window (SLOT_FAST_DEATHS). */
  deaths: number[];
  parked: boolean;
  /** Fatal, non-retryable reason that parked this slot outside the circuit. */
  fatalReason: "host-config" | null;
  tripEpoch: number;
  /** SLOT_SWEPT — the trip sweep fired once. */
  swept: boolean;
  stalled: boolean;
  /** Epoch the stall window opened (anchored to last lane activity). */
  stallSinceEpoch: number;
  /** SLOT_REAPED — the hard reap fired once. */
  reaped: boolean;
  /** True while a spawnSlot call is in-flight for this slot. Prevents a
   * duplicate spawn on the same slot if an enclosing tick is abandoned by
   * the guardedTick ceiling before the spawn resolves. */
  spawning: boolean;
  /** True when the slot idle-parked after a clean drain (exit 0) with an
   * empty ready queue. Distinct from a breaker-trip park: no sweep is run
   * and the slot un-parks automatically when the queue refills. */
  idleParked: boolean;
  /** Current half-open backoff step (0 = first probe). Increments on each
   * probe fast-death; reset to 0 when the circuit closes (probe success). */
  backoffStep: number;
  /** True when the slot is in half-open state: parked=true AND a probe worker
   * has been spawned. The probe's death resolves to either closed (success)
   * or re-parked-open (fast-death failure). */
  halfOpen: boolean;
  /** Pending post-reap retry contest. While present, the issue carries
   * `running` + `contested`; a late commit on `branch` reclaims the issue,
   * otherwise the normal clean retry label flip runs when `deadlineEpoch` passes. */
  contest: ReapContestState | null;
  /** Slot is above the current target and should not claim another issue. */
  retiring: boolean;
  /**
   * Highest resident-set size, in MB, the RESIDENT has observed across this
   * slot's worker tree during the current attempt (ADR 0128 §8). Sampled by the
   * supervise tick and reset on respawn, so it always describes the attempt the
   * slot is running now. 0 means "never sampled" — the record omits the field
   * rather than claiming a measured zero.
   */
  peakRssMb: number;
  /** The pid {@link SlotState.peakRssMb} was sampled against. A different live
   * pid means the slot was respawned onto a NEW attempt, so the peak resets
   * rather than carrying a dead attempt's memory into a live one. */
  peakRssPid: number | null;
}

export function freshSlot(): SlotState {
  return {
    pid: null,
    spawnEpoch: 0,
    deaths: [],
    parked: false,
    fatalReason: null,
    tripEpoch: 0,
    swept: false,
    stalled: false,
    stallSinceEpoch: 0,
    reaped: false,
    spawning: false,
    idleParked: false,
    backoffStep: 0,
    halfOpen: false,
    contest: null,
    retiring: false,
    peakRssMb: 0,
    peakRssPid: null,
  };
}

/** The whole supervisor runtime: one SlotState per target slot. */
export interface SupervisorState {
  slots: SlotState[];
  /**
   * Epoch seconds of the last non-abandoned pass (#579). 0 = no successful pass
   * has been observed yet. Carried into every FleetHeartbeat so stalled progress
   * remains visible.
   */
  lastProgressEpoch: number;
  /** Epoch seconds of the last attempted supervisor trunk-mirror refresh. */
  lastTrunkFreshnessEpoch: number;
  /** Last recorded trunk freshness outcome for heartbeat/status surfacing. */
  lastTrunkFreshness?: TrunkFreshnessOutcome;
  /**
   * Cumulative wake accounting (#934): how many health-check loop iterations woke
   * on a worker state-change event vs the safety-net timer. Lets the supervisor
   * log — and a test assert — the measurable reduction in idle (timer) wake-ups
   * the event lane delivered.
   */
  wakeStats: WakeStats;
  /** Once HARD_STOP is reached, no new workers are spawned for this supervisor. */
  drainBudgetHardStopped: boolean;
  /** Last budget tier logged, to avoid repeating unchanged OK/WARNING/CRITICAL. */
  lastDrainBudgetTier?: DrainBudgetTier;
  /** Epoch seconds of the last successful supervisor state heartbeat write. */
  lastHeartbeatStateWriteEpoch: number;
  /** Consecutive ticks whose state heartbeat write did not land. */
  heartbeatStateWriteMisses: number;
  /** Rolling death/respawn event epochs for the fleet heartbeat churn stat. */
  churnDeathEpochs: number[];
  churnRespawnEpochs: number[];
}

/** Build the initial runtime for `target` slots. */
export function initSupervisorState(target: number): SupervisorState {
  return {
    slots: Array.from({ length: target }, () => freshSlot()),
    lastProgressEpoch: 0,
    lastTrunkFreshnessEpoch: 0,
    wakeStats: freshWakeStats(),
    drainBudgetHardStopped: false,
    lastHeartbeatStateWriteEpoch: 0,
    heartbeatStateWriteMisses: 0,
    churnDeathEpochs: [],
    churnRespawnEpochs: [],
  };
}
