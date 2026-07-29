import { recordWake, waitForNextWake } from "../event-wake.js";
import { BootHaltError } from "../boot.js";
import { bootDeathSignature, recordBootDeath } from "./boot-breaker.js";
import {
  validateStallThresholds,
  validateSupervisorProgressThreshold,
  validateSupervisorStaleThreshold,
  type SupervisorConfig,
} from "./config.js";
import { emitSupervisorEvent } from "./events.js";
import { emitFleetHeartbeat, superviseHeartbeatStateWrite, trunkFreshnessEventPayload } from "./heartbeat.js";
import { logDrainBudgetTransition, readDrainBudget, spawnSlotForBudget } from "./budget.js";
import { superviseTick } from "./tick.js";
import { guardedTick } from "./guarded-tick.js";
import type { SupervisorState } from "./state.js";
import type { HeartbeatSlotPid, SupervisorDeps } from "./types.js";

/**
 * Record one boot-sweep halt against the crashloop circuit breaker (#2527).
 * Below the threshold this only persists the ledger — the watchdog keeps its
 * normal respawn behaviour. On the death that reaches N consecutive identical
 * signatures: the healer runs immediately for the implicated state, a loud
 * alert is logged, and a `supervisor.breaker` event is emitted; the persisted
 * open ledger then makes the watchdog refuse to respawn into the same failing
 * configuration. Best-effort throughout — breaker bookkeeping must never mask
 * the original halt.
 */
async function recordBootBreakerDeath(deps: SupervisorDeps, err: BootHaltError): Promise<void> {
  const breaker = deps.bootBreaker;
  if (!breaker) return;
  try {
    const signature = bootDeathSignature(err);
    const prior = await breaker.store.read();
    const decision = recordBootDeath(prior, signature, deps.now(), breaker.threshold);
    await breaker.store.write(decision.ledger);
    if (!decision.tripped) return;
    let healOutcome = "no healer wired";
    if (breaker.heal) {
      try {
        healOutcome = await breaker.heal(err);
      } catch (healErr) {
        healOutcome = `healer failed: ${healErr instanceof Error ? healErr.message : String(healErr)}`;
      }
    }
    deps.log?.(
      `⛔ boot breaker TRIPPED: ${decision.ledger.count} consecutive identical boot deaths ` +
        `(signature=${signature}) — respawn suppressed, healer invoked (${healOutcome}). ` +
        `Fix the implicated state, then relaunch the fleet to reset the breaker.`,
    );
    await emitSupervisorEvent(deps, {
      kind: "supervisor.breaker",
      payload: {
        status: "tripped",
        signature,
        count: decision.ledger.count,
        heal_outcome: healOutcome,
      },
    });
  } catch (breakerErr) {
    deps.log?.(
      `boot breaker bookkeeping failed: ${breakerErr instanceof Error ? breakerErr.message : String(breakerErr)}`,
    );
  }
}

export interface SupervisorAdoptionResult {
  adopted: HeartbeatSlotPid[];
  dead: HeartbeatSlotPid[];
}

export async function adoptPersistedSlotPids(
  state: SupervisorState,
  deps: SupervisorDeps,
): Promise<SupervisorAdoptionResult> {
  const result: SupervisorAdoptionResult = { adopted: [], dead: [] };
  if (!deps.proc.slotPid) return result;

  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    if (slot.pid !== null) continue;
    const pid = deps.proc.slotPid(i);
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) continue;
    if (deps.proc.isAlive(pid)) {
      slot.pid = pid;
      slot.spawnEpoch = 0;
      slot.stalled = false;
      slot.stallSinceEpoch = 0;
      slot.reaped = false;
      result.adopted.push({ slot: i, pid });
    } else {
      result.dead.push({ slot: i, pid });
    }
  }

  if (result.adopted.length > 0 || result.dead.length > 0) {
    deps.log?.(
      `takeover adoption: adopted=${result.adopted.length} dead=${result.dead.length} target=${state.slots.length}`,
    );
    await emitSupervisorEvent(deps, {
      kind: "supervisor.message",
      payload: {
        message: "takeover adoption",
        adopted: result.adopted.length,
        dead: result.dead.length,
        target: state.slots.length,
      },
    });
  }

  return result;
}

/**
 * The supervisor's startup + health-check loop, composing the steps above. This
 * is the testable shape of supervisor.sh's main body (~1109-1141): validate
 * thresholds, spawn the initial fleet to target, then tick until the stop-file
 * appears. Between ticks it sleeps the poll cadence (config.pollIntervalS, via
 * the injected deps.proc.sleep) so the loop never busy-spins.
 */
export async function runSupervisor(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
  stopRequested: () => boolean,
): Promise<void> {
  validateStallThresholds(config);
  // The external watchdog (#407) reads this heartbeat to recover a hard-hung
  // loop; refuse to boot with a threshold that could misread a slow-but-live
  // tick as quiescent.
  validateSupervisorStaleThreshold(config);
  // The progress-stale check (#579) must fire strictly after the heartbeat-stale
  // check, so its threshold must be greater.
  validateSupervisorProgressThreshold(config);

  // Fleet supervisor owns the boot (#623): run the shared sweeps ONCE, pre-spawn,
  // so every worker the fleet spawns boots bootstrap+claim only and never races
  // peers over `.red/tmp` state. This is the ONLY call site — a respawn after a
  // worker exit happens inside the tick loop below and never re-enters here, so
  // the sweeps run exactly once per supervisor lifetime. Best-effort boot
  // failures are logged, but a typed halt intentionally stops before spawn.
  if (deps.bootSweeps) {
    try {
      await deps.bootSweeps();
      await emitSupervisorEvent(deps, {
        kind: "supervisor.boot-sweep",
        payload: { status: "passed" },
      });
      // A successful boot closes the crashloop breaker (#2527): the failing
      // configuration is provably gone, so the consecutive-signature run resets.
      try {
        await deps.bootBreaker?.store.write(null);
      } catch {
        // best-effort: a failed reset only risks a stale-open breaker, which the
        // next trip evaluation overwrites.
      }
    } catch (err) {
      if (err instanceof BootHaltError) {
        deps.log?.(`boot sweeps halted: ${err.message}`);
        await emitSupervisorEvent(deps, {
          kind: "supervisor.boot-sweep",
          payload: { status: "halted", reason: err.message },
        });
        await recordBootBreakerDeath(deps, err);
        return;
      }
      deps.log?.(
        `boot sweeps failed: ${err instanceof Error ? err.message : String(err)} — spawning workers anyway`,
      );
      await emitSupervisorEvent(deps, {
        kind: "supervisor.boot-sweep",
        payload: {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }


  // Adopt live detached workers from the previous supervisor's persisted
  // slot->pid snapshot before spawning the initial fleet. Dead pids are left as
  // empty slots, so the spawn loop fills only the remainder.
  await adoptPersistedSlotPids(state, deps);

  // Spawn the initial fleet to target.
  const initialBudget = readDrainBudget(state, deps, config);
  logDrainBudgetTransition(state, deps, initialBudget, 0);
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    if (slot.pid !== null && deps.proc.isAlive(slot.pid)) continue;
    const spawned = await spawnSlotForBudget(i, deps, state, initialBudget);
    if (spawned === null) continue;
    slot.pid = spawned.pid;
    slot.spawnEpoch = spawned.spawnEpoch;
  }

  // Health-check loop until the stop-file, sleeping the poll cadence each pass.
  // Every tick is bounded by `guardedTick`: a hung tick (gh/ps/git await with no
  // timeout) is abandoned after tickTimeoutS and the loop continues — the
  // supervisor can no longer go alive-but-quiescent. Each pass logs a heartbeat
  // so the fleet's liveness is observable.
  for (;;) {
    const result = await guardedTick(
      () => superviseTick(state, deps, config, stopRequested),
      config.tickTimeoutS * 1000,
      deps.proc.sleep,
      deps.log,
    );
    // Advance the progress epoch only when the tick was NOT abandoned. An
    // abandoned tick (timeout / throw) is loop-liveness, not work-progress.
    if (!result.abandoned) {
      state.lastProgressEpoch = deps.now();
    }
    const { heartbeat, write } = await emitFleetHeartbeat(state, deps, result, config);
    await superviseHeartbeatStateWrite(state, deps, heartbeat, write);
    deps.log?.(
      `tick: slots=${state.slots.length} respawned=${result.respawned.length} ` +
        `deaths=${result.deaths.length} parked=${result.parked.length} idle-parked=${result.idleParked.length} ` +
        `half-opened=${result.halfOpened.length} reaped=${result.reaped.length} ` +
        `unblocked=${result.unblocked.length} ` +
        `crash-reconciled=${result.crashReconciled.length} ` +
        `trunk=${heartbeat.trunkFreshness?.status ?? "unwired"} ` +
        `ready=${heartbeat.readyForAgent} busy=${heartbeat.slotsBusy} free=${heartbeat.slotsFree}`,
    );
    await emitSupervisorEvent(deps, {
      kind: "supervisor.tick",
      payload: {
        slots: state.slots.length,
        respawned: result.respawned.length,
        deaths: result.deaths.length,
        parked: result.parked.length,
        idle_parked: result.idleParked.length,
        half_opened: result.halfOpened.length,
        reaped: result.reaped.length,
        unblocked: result.unblocked.length,
        crash_reconciled: result.crashReconciled.length,
        ready_for_agent: heartbeat.readyForAgent,
        slots_busy: heartbeat.slotsBusy,
        slots_free: heartbeat.slotsFree,
        ...trunkFreshnessEventPayload(heartbeat.trunkFreshness),
      },
    });
    if (result.stopped) {
      return;
    }
    // Event-driven wake (#934): race the safety-net poll timer against the next
    // worker-state-change event. Whichever fires first ends the wait, so a state
    // change is reacted to immediately instead of waiting out the full interval,
    // while the timer still guarantees a wake within `pollIntervalS` even if every
    // event is missed. With no `deps.wake` wired this is exactly the old
    // `sleep(pollIntervalS)` and always returns "timer" (no regression).
    const fallbackS = deps.wake ? config.eventFallbackS : config.pollIntervalS;
    const reason = await waitForNextWake({
      fallbackMs: fallbackS * 1000,
      sleep: deps.proc.sleep,
      wake: deps.wake,
    });
    recordWake(state.wakeStats, reason);
    await emitSupervisorEvent(deps, {
      kind: "supervisor.wake",
      payload: {
        source: reason,
        event_wakes: state.wakeStats.event,
        timer_wakes: state.wakeStats.timer,
        total_wakes: state.wakeStats.total,
      },
    });
    if (reason === "event") {
      deps.log?.(
        `wake: event-driven (idle wakes reduced — ${state.wakeStats.event}/${state.wakeStats.total} wakes event-driven)`,
      );
    }
  }
}
