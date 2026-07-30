import {
  computeHalfOpenBackoff,
  isHalfOpenDue,
} from "../slot-circuit.js";
import { emitSupervisorEvent } from "./events.js";
import { reconcileDeadWorkerClaim } from "./envelopes.js";
import { workerUsage } from "./worker-accounting.js";
import {
  logDrainBudgetTransition,
  readDrainBudget,
  spawnPolicyForBudget,
  spawnSlotForBudget,
} from "./budget.js";
import {
  applyRunnerDirective,
  growFleetToTarget,
  resolveElasticResize,
  retireDrainedSlots,
  shrinkFleetToTarget,
} from "./resize.js";
import { pollStallDetector, resolveReapContest } from "./reaper.js";
import { dispatchReconcileIfPossible, handleDeadSlot } from "./slot-actions.js";
import type { SupervisorConfig } from "./config.js";
import type { TickResult } from "./result.js";
import type { SupervisorState } from "./state.js";
import type { SupervisorDeps, TrunkFreshnessOutcome } from "./types.js";

async function refreshTrunkMirrorIfDue(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: Pick<SupervisorConfig, "trunkFreshnessIntervalS">,
): Promise<TrunkFreshnessOutcome | undefined> {
  if (!deps.refreshTrunkMirror) return undefined;

  const now = deps.now();
  const intervalS = Math.max(1, config.trunkFreshnessIntervalS);
  if (state.lastTrunkFreshnessEpoch > 0 && now - state.lastTrunkFreshnessEpoch < intervalS) {
    const throttled: TrunkFreshnessOutcome = {
      status: "throttled",
      refreshedAtEpoch: state.lastTrunkFreshnessEpoch,
      nextDueEpoch: state.lastTrunkFreshnessEpoch + intervalS,
      intervalS,
    };
    state.lastTrunkFreshness = throttled;
    return throttled;
  }

  state.lastTrunkFreshnessEpoch = now;
  let outcome: TrunkFreshnessOutcome;
  try {
    const refreshed = await deps.refreshTrunkMirror();
    outcome = {
      ...refreshed,
      refreshedAtEpoch: now,
      intervalS,
    };
  } catch (err) {
    outcome = {
      status: "failed",
      refreshedAtEpoch: now,
      intervalS,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (outcome.status === "failed") {
    deps.log?.(`trunk mirror refresh failed: ${outcome.message ?? "unknown git error"}`);
  }
  state.lastTrunkFreshness = outcome;
  return outcome;
}

export async function superviseTick(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
  stopRequested: () => boolean,
): Promise<TickResult> {
  const result: TickResult = {
    respawned: [],
    deaths: [],
    parked: [],
    idleParked: [],
    halfOpened: [],
    reaped: [],
    crashReconciled: [],
    reconciledSlots: [],
    unblocked: [],
    retiredSlots: [],
    runnerChanged: false,
    stopped: false,
    queueDepth: 0,
    abandoned: false,
  };

  if (stopRequested()) {
    result.stopped = true;
    return result;
  }

  // Take in the host's deaths BEFORE anything reads a slot's exit code (#2851).
  // Since ADR 0130 the daemon owns death, so a Worker's exit status arrives on
  // the host event lane rather than on a child handle; draining it first is what
  // lets the dead-slot scan below read the daemon's own number instead of
  // guessing from a pid that stopped answering.
  try {
    await deps.proc.observeHostDeaths?.();
  } catch {
    // Best-effort: an unreadable lane costs this tick its exit codes, and the
    // liveness scan still reports every death conservatively as non-clean.
  }

  result.trunkFreshness = await refreshTrunkMirrorIfDue(state, deps, config);

  // Sample queue depth once per tick for idle-park / un-park decisions and the
  // fleet heartbeat. Best-effort: 0 on any failure or missing implementation.
  let queueDepth = 0;
  try {
    queueDepth = (await deps.gh.readyQueueDepth?.()) ?? 0;
  } catch {
    queueDepth = 0;
  }
  result.queueDepth = queueDepth;
  const drainBudget = readDrainBudget(state, deps, config);
  result.drainBudget = drainBudget;
  logDrainBudgetTransition(state, deps, drainBudget, queueDepth);
  const spawnPolicy = spawnPolicyForBudget(state, drainBudget);

  const resize = await resolveElasticResize(deps, config);
  const runnerChanged = await applyRunnerDirective(state, deps, config, resize.runner, result);
  config.target = resize.target;
  config.shrinkMode = resize.shrinkMode;
  const slotsBeforeResize = state.slots.length;
  if (resize.target !== slotsBeforeResize) {
    await emitSupervisorEvent(deps, {
      kind: "supervisor.scale",
      payload: {
        from: slotsBeforeResize,
        to: resize.target,
        mode: resize.shrinkMode,
      },
    });
  }
  if (resize.target > state.slots.length && !runnerChanged) {
    for (const slot of state.slots) slot.retiring = false;
  }
  if (resize.target > state.slots.length && spawnPolicy !== "hard-stop") {
    await growFleetToTarget(state, deps, config, resize.target, drainBudget, result);
  } else if (resize.target < state.slots.length) {
    await shrinkFleetToTarget(state, deps, resize.target, resize.shrinkMode, result);
  }
  await retireDrainedSlots(state, deps, result);

  for (let i = 0; i < state.slots.length; i += 1) {
    await resolveReapContest(i, state.slots[i]!, deps, config);
  }

  // Un-park idle-parked slots when the queue has work to do.
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    if (!slot.idleParked || queueDepth === 0) continue;
    if (spawnPolicy === "hard-stop") continue;
    slot.idleParked = false;
    slot.spawning = true;
    try {
      const spawned = await spawnSlotForBudget(i, deps, state, drainBudget);
      if (spawned === null) continue;
      slot.pid = spawned.pid;
      slot.spawnEpoch = spawned.spawnEpoch;
      slot.stalled = false;
      slot.stallSinceEpoch = 0;
      slot.reaped = false;
    } finally {
      slot.spawning = false;
    }
    result.respawned.push(i);
  }

  // Schedule half-open probes for circuit-tripped slots whose cooldown has expired.
  // A parked slot without a probe (halfOpen=false) transitions to half-open when
  // now - tripEpoch >= backoff(step). The probe is a normal worker spawn; its death
  // is handled by handleDeadSlot which detects the halfOpen flag.
  {
    const now = deps.now();
    for (let i = 0; i < state.slots.length; i += 1) {
      const slot = state.slots[i]!;
      if (!slot.parked || slot.halfOpen || slot.spawning || slot.fatalReason === "host-config") continue;
      if (spawnPolicy === "hard-stop") continue;
      if (!isHalfOpenDue(slot.tripEpoch, slot.backoffStep, now, config)) continue;
      deps.log?.(
        `circuit half-open: slot ${i} cooldown expired, spawning probe ` +
          `(backoff=${computeHalfOpenBackoff(slot.backoffStep, config)}s step=${slot.backoffStep})`,
      );
      slot.halfOpen = true;
      slot.spawning = true;
      try {
        const spawned = await spawnSlotForBudget(i, deps, state, drainBudget);
        if (spawned === null) continue;
        slot.pid = spawned.pid;
        slot.spawnEpoch = spawned.spawnEpoch;
        slot.stalled = false;
        slot.stallSinceEpoch = 0;
        slot.reaped = false;
      } finally {
        slot.spawning = false;
      }
      result.halfOpened.push(i);
    }
  }

  // Respawn / park dead non-parked, non-idle-parked, non-spawning slots.
  // `slot.spawning` guards against a duplicate spawn when the enclosing tick
  // was abandoned mid-spawnSlot by the guardedTick ceiling.
  // Also processes half-open probe deaths (parked=true, halfOpen=true).
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    // Skip: open (parked but not probing), idleParked, or spawning in-flight.
    if ((slot.parked && !slot.halfOpen) || slot.idleParked || slot.spawning) continue;
    const pid = slot.pid;
    if (pid === null || !deps.proc.isAlive(pid)) {
      if (pid !== null) {
        deps.log?.(`dead slot reconciled: slot ${i} pid=${pid}`);
        await emitSupervisorEvent(deps, {
          kind: "supervisor.dead-slot-reconcile",
          payload: { slot: i, pid },
        });
      }
      // Capture the dead worker's iter dir BEFORE handleDeadSlot respawns the
      // slot — a respawn rebinds resolveIterDir(i) to the NEW worker's dir, so
      // the stranded claim must be snapshotted here, while it still resolves.
      const deadInfo = deps.fs.resolveIterDir(i);
      // Snapshot the resource usage the resident measured for the dying attempt
      // BEFORE the slot is recycled (ADR 0128 §8) — the peak resets the moment
      // the slot is respawned onto a new attempt.
      const deadUsage = workerUsage(slot, deadInfo);
      result.deaths.push(i);
      if (spawnPolicy === "hard-stop") {
        slot.pid = null;
        slot.stalled = false;
        slot.stallSinceEpoch = 0;
        slot.reaped = false;
        try {
          const reconciled = await reconcileDeadWorkerClaim(deadInfo, deps, deadUsage);
          if (reconciled !== null) result.crashReconciled.push(reconciled);
        } catch {
          // best-effort, same as the respawn path.
        }
        continue;
      }
      const { parked } = await handleDeadSlot(i, slot, deps, config, queueDepth, spawnPolicy);
      if (parked) {
        // A circuit-trip park already swept this slot's claimed issues
        // (sweepParkedSlot); an idle-park drained cleanly with no live claim.
        // Neither needs the crash reconcile.
        if (slot.idleParked) result.idleParked.push(i);
        else result.parked.push(i);
      } else {
        result.respawned.push(i);
        // #815: the respawn reused the slot for a NEW issue, so a worker that
        // died mid-attempt (agent finished, no terminal envelope) would leave
        // its old claim stranded in `running` forever — invisible to the drain
        // until a fleet reboot runs the boot sweep. Reconcile it here on the
        // live loop instead. Best-effort: a failure leaves it for the boot sweep.
        try {
          const reconciled = await reconcileDeadWorkerClaim(deadInfo, deps, deadUsage);
          if (reconciled !== null) result.crashReconciled.push(reconciled);
        } catch {
          // never let a reconcile failure abort the tick.
        }
      }
    }
  }

  // Passive stall detector + gated hard reaper.
  const reaped = await pollStallDetector(state, deps, config);
  result.reaped = reaped;

  // Reconcile dispatch: use any free slot (e.g. just stall-reaped) for a parked
  // candidate. Best-effort; a failure or absent candidate is silently skipped.
  if (spawnPolicy !== "hard-stop") {
    const reconciledSlot = await dispatchReconcileIfPossible(state, deps);
    if (reconciledSlot !== null) result.reconciledSlots.push(reconciledSlot);
  }

  // Periodic dependency Unblock Sweep (#844). The boot-time sweep and the
  // event-driven close-cascade are both best-effort; when a cascade misses an
  // unblock AND the remaining queue is all dependency-blocked, the fleet idles
  // (ready:0) → spawns no worker → the boot sweep never re-runs → the dependent
  // is stranded forever. Running the idempotent sweep here self-heals that within
  // one interval with NO worker spawn. Throttled to unblockSweepIntervalS so a
  // drained tracker costs ~no extra gh calls (the sweep itself is a single `gh
  // issue list` that short-circuits when there are no blocked:dependency issues).
  if (deps.unblockSweep) {
    const now = deps.now();
    const due =
      state.lastUnblockSweepEpoch === 0 ||
      now - state.lastUnblockSweepEpoch >= config.unblockSweepIntervalS;
    if (due) {
      // Stamp BEFORE awaiting so a slow/hung sweep can't be re-fired by the next
      // tick; the guardedTick ceiling still abandons a wedged tick independently.
      state.lastUnblockSweepEpoch = now;
      try {
        result.unblocked = await deps.unblockSweep();
      } catch {
        // Best-effort: a failed sweep is retried on the next due tick.
      }
    }
  }

  return result;
}
