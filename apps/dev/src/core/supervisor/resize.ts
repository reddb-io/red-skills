import { type DrainBudgetStatus, type ElasticResizeRequest, type ElasticShrinkMode, type SupervisorConfig } from "./config.js";
import { emitSupervisorEvent } from "./events.js";
import { reconcileDeadWorkerClaim } from "./envelopes.js";
import { spawnSlotForBudget } from "./budget.js";
import { type TickResult } from "./result.js";
import { freshSlot, type SupervisorState } from "./state.js";
import type { SupervisorDeps } from "./types.js";

export async function resolveElasticResize(
  deps: SupervisorDeps,
  config: SupervisorConfig,
): Promise<Required<ElasticResizeRequest>> {
  let request: ElasticResizeRequest | null = null;
  try {
    request = (await deps.resizeRequest?.()) ?? null;
  } catch {
    request = null;
  }
  const target =
    request && Number.isInteger(request.target) && request.target >= 0
      ? request.target
      : config.target;
  return {
    target,
    shrinkMode: request?.shrinkMode ?? config.shrinkMode,
    runner:
      typeof request?.runner === "string" && request.runner.length > 0
        ? request.runner
        : config.runner,
  };
}

export async function applyRunnerDirective(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
  runner: string,
  result: TickResult,
): Promise<boolean> {
  if (runner === config.runner) return false;
  const from = config.runner;
  await deps.configureRunner?.(runner);
  config.runner = runner;
  await emitSupervisorEvent(deps, {
    kind: "supervisor.scale",
    payload: {
      from: state.slots.length,
      to: state.slots.length,
      mode: "drain-then-retire",
      runner_from: from,
      runner_to: runner,
    },
  });
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    if (slot.retiring) continue;
    slot.retiring = true;
    const pid = slot.pid;
    if (pid !== null && deps.proc.isAlive(pid)) {
      try {
        await deps.proc.requestSlotRetire?.(i, pid);
      } catch {
        // best-effort
      }
    }
  }
  result.runnerChanged = true;
  return true;
}

export async function growFleetToTarget(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
  target: number,
  drainBudget: DrainBudgetStatus | undefined,
  result: TickResult,
): Promise<void> {
  for (const slot of state.slots) {
    slot.retiring = false;
  }
  while (state.slots.length < target) {
    const slotIndex = state.slots.length;
    const slot = freshSlot();
    state.slots.push(slot);
    const spawned = await spawnSlotForBudget(slotIndex, deps, state, drainBudget);
    if (spawned === null) continue;
    slot.pid = spawned.pid;
    slot.spawnEpoch = spawned.spawnEpoch;
    result.respawned.push(slotIndex);
  }
}

async function retireSlotAt(
  state: SupervisorState,
  index: number,
  result: TickResult,
): Promise<void> {
  state.slots.splice(index, 1);
  result.retiredSlots.push(index);
}

export async function shrinkFleetToTarget(
  state: SupervisorState,
  deps: SupervisorDeps,
  target: number,
  mode: ElasticShrinkMode,
  result: TickResult,
): Promise<void> {
  if (target >= state.slots.length) return;
  for (let i = state.slots.length - 1; i >= target; i -= 1) {
    const slot = state.slots[i]!;
    if (mode === "hard-kill") {
      const pid = slot.pid;
      const info = deps.fs.resolveIterDir(i);
      if (pid !== null && deps.proc.isAlive(pid)) {
        await deps.proc.killTree(pid);
      }
      slot.pid = null;
      slot.stalled = false;
      slot.stallSinceEpoch = 0;
      slot.reaped = false;
      try {
        const reconciled = await reconcileDeadWorkerClaim(info, deps);
        if (reconciled !== null) result.crashReconciled.push(reconciled);
      } catch {
        // best-effort
      }
      await retireSlotAt(state, i, result);
      continue;
    }

    slot.retiring = true;
    const pid = slot.pid;
    if (pid !== null && deps.proc.isAlive(pid)) {
      try {
        await deps.proc.requestSlotRetire?.(i, pid);
      } catch {
        // best-effort
      }
      continue;
    }
    await retireSlotAt(state, i, result);
  }
}

export async function retireDrainedSlots(
  state: SupervisorState,
  deps: SupervisorDeps,
  result: TickResult,
): Promise<void> {
  for (let i = state.slots.length - 1; i >= 0; i -= 1) {
    const slot = state.slots[i]!;
    if (!slot.retiring) continue;
    const pid = slot.pid;
    if (pid !== null && deps.proc.isAlive(pid)) continue;
    try {
      const reconciled = await reconcileDeadWorkerClaim(deps.fs.resolveIterDir(i), deps);
      if (reconciled !== null) result.crashReconciled.push(reconciled);
    } catch {
      // best-effort
    }
    await retireSlotAt(state, i, result);
  }
}
