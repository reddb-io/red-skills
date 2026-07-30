import {
  computeHalfOpenBackoff,
} from "../slot-circuit.js";
import { recordDeath } from "./lifecycle.js";
import { reconcileDeadWorkerClaim } from "./envelopes.js";
import { sweepParkedSlot } from "./reaper.js";
import type { SupervisorConfig } from "./config.js";
import type { TickResult } from "./result.js";
import type { SlotState, SupervisorState } from "./state.js";
import type { ReconcileCandidate, SpawnPolicy, SupervisorDeps } from "./types.js";
import { HOST_CONFIG_EXIT_CODE } from "../worker-outcome.js";

export async function handleDeadSlot(
  slot: number,
  state: SlotState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
  queueDepth = 0,
  spawnPolicy?: SpawnPolicy | "hard-stop",
): Promise<{ parked: boolean }> {
  // Named for what it does since the ADR 0130 cutover (#2851): this ASKS the
  // host for a Worker, it does not create one. A closure called `spawn` in a
  // module that no longer spawns is how the removed vocabulary walks back in.
  const askHostForWorker = async (): Promise<{ pid: number; spawnEpoch: number } | null> => {
    if (spawnPolicy === "hard-stop") return null;
    return spawnPolicy ? deps.proc.spawnSlot(slot, spawnPolicy) : deps.proc.spawnSlot(slot);
  };
  const exitCode = deps.proc.lastExitCode?.(slot) ?? null;

  // EX_CONFIG is a permanent host defect, not a fast runner death. Park the
  // slot indefinitely without adding to the circuit ring, sweeping work, or
  // spawning a cooldown probe that can only fail the same way.
  if (exitCode === HOST_CONFIG_EXIT_CODE) {
    state.pid = null;
    state.parked = true;
    state.fatalReason = "host-config";
    state.halfOpen = false;
    state.tripEpoch = 0;
    deps.log?.(
      `fatal host configuration: slot ${slot} parked without retry; fix the required shell/workspace and restart the fleet`,
    );
    return { parked: true };
  }

  // Half-open probe death: resolve the circuit transition before the normal path.
  if (state.parked && state.halfOpen) {
    const now = deps.now();
    const lifetime = state.spawnEpoch > 0 ? now - state.spawnEpoch : 0;
    const fastDeath = state.spawnEpoch > 0 && lifetime < config.fastDeathThresholdS;
    state.halfOpen = false;
    state.pid = null;
    if (fastDeath) {
      // Probe fast-died: re-park with next backoff step, sweep already ran on
      // the original trip so we do NOT re-sweep.
      state.backoffStep++;
      state.tripEpoch = now;
      deps.log?.(
        `circuit re-parked: slot ${slot} probe fast-death (${lifetime}s), ` +
          `next backoff=${computeHalfOpenBackoff(state.backoffStep, config)}s step=${state.backoffStep}`,
      );
      return { parked: true };
    }
    // Probe survived long enough: close the circuit and reset backoff.
    state.parked = false;
    state.backoffStep = 0;
    state.tripEpoch = 0;
    state.swept = false; // allow sweep on a future trip
    state.deaths = []; // reset the fast-death ring
    deps.log?.(`circuit closed: slot ${slot} probe succeeded (${lifetime}s), backoff reset`);
    // Respawn immediately so the closed slot has a live worker.
    state.spawning = true;
    try {
      const spawned = await askHostForWorker();
      if (spawned === null) return { parked: true };
      state.pid = spawned.pid;
      state.spawnEpoch = spawned.spawnEpoch;
    } finally {
      state.spawning = false;
    }
    state.stalled = false;
    state.stallSinceEpoch = 0;
    state.reaped = false;
    return { parked: false };
  }

  const cleanExit = exitCode === 0;

  if (cleanExit && queueDepth === 0) {
    // Clean drain with empty queue → idle-park (no sweep, no discard envelope).
    state.pid = null;
    state.idleParked = true;
    return { parked: true };
  }

  // A fast worker death while work remains is a boot-death signal regardless
  // of its exit code. Session errors can return cleanly, so excluding exit 0
  // makes deterministic boot crashloops invisible to the slot circuit.
  const now = deps.now();
  const decision = recordDeath(state.deaths, state.spawnEpoch, now, config);
  state.deaths = decision.deaths;

  if (decision.trip) {
    state.parked = true;
    state.tripEpoch = now;
    await sweepParkedSlot(slot, state, deps, config);
    state.pid = null;
    return { parked: true };
  }

  state.spawning = true;
  try {
    const spawned = await askHostForWorker();
    if (spawned === null) {
      state.pid = null;
      return { parked: true };
    }
    state.pid = spawned.pid;
    state.spawnEpoch = spawned.spawnEpoch;
  } finally {
    state.spawning = false;
  }
  // A respawn opens a fresh worker lifetime; clear any stale stall flags.
  state.stalled = false;
  state.stallSinceEpoch = 0;
  state.reaped = false;
  return { parked: false };
}

/**
 * dispatchReconcileIfPossible — attempt to dispatch ONE reconcile worker into
 * the first free slot (ADR 0055, #562). Called at the end of every superviseTick,
 * after normal lifecycle handling (respawn / stall / reap). Returns the slot
 * index of the dispatched worker, or null when no dispatch occurred.
 *
 * A "free slot" is one that is not parked and has no live pid — typically freed
 * by the stall-reaper within the same tick. The heavy validate+land runs in the
 * worker process (its own timeout), off the tick's critical path.
 *
 * Both `deps.proc.spawnReconcileWorker` and `deps.gh.findReconcileCandidate` are
 * optional — when either is absent this is a no-op, preserving backward
 * compatibility with existing SupervisorDeps implementations (tests, boot-only).
 */
export async function dispatchReconcileIfPossible(
  state: SupervisorState,
  deps: SupervisorDeps,
): Promise<number | null> {
  if (!deps.proc.spawnReconcileWorker || !deps.gh.findReconcileCandidate) return null;

  // Find the first free slot: not parked and no live pid.
  const freeIdx = state.slots.findIndex((s) => !s.parked && s.pid === null);
  if (freeIdx < 0) return null;

  // Cheap detection: one gh label query + remote branch list via the injected closure.
  let candidate: ReconcileCandidate | null = null;
  try {
    candidate = await deps.gh.findReconcileCandidate();
  } catch {
    return null;
  }
  if (candidate === null) return null;

  // Dispatch the reconcile worker into the free slot.
  const spawned = await deps.proc.spawnReconcileWorker(freeIdx, candidate);
  const slot = state.slots[freeIdx]!;
  slot.pid = spawned.pid;
  slot.spawnEpoch = spawned.spawnEpoch;
  // Clear stale stall/reap flags — this is a fresh worker start.
  slot.stalled = false;
  slot.stallSinceEpoch = 0;
  slot.reaped = false;
  return freeIdx;
}

export async function terminateAll(state: SupervisorState, deps: SupervisorDeps): Promise<void> {
  for (const slot of state.slots) {
    const pid = slot.pid;
    if (pid !== null && deps.proc.isAlive(pid)) {
      await deps.proc.killTree(pid);
    }
  }
}
