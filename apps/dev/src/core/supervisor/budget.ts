import { encode as encodeToon } from "@reddb-io/toon";
import { evaluateDrainBudget, type DrainBudgetStatus, type SupervisorConfig } from "./config.js";
import type { TickResult } from "./result.js";
import type { SupervisorState } from "./state.js";
import type { SpawnPolicy, SupervisorDeps } from "./types.js";

export function readDrainBudget(state: SupervisorState, deps: SupervisorDeps, config: SupervisorConfig): DrainBudgetStatus | undefined {
  if (config.drainBudgetUsd === undefined) return undefined;
  let spent = 0;
  try {
    spent = deps.fs.fleetCostUsd?.() ?? 0;
  } catch {
    spent = 0;
  }
  const budget = evaluateDrainBudget(spent, config.drainBudgetUsd);
  if (budget?.tier === "HARD_STOP") state.drainBudgetHardStopped = true;
  return budget;
}

export function logDrainBudgetTransition(
  state: SupervisorState,
  deps: SupervisorDeps,
  budget: DrainBudgetStatus | undefined,
  queueDepth: number,
): void {
  if (!budget || state.lastDrainBudgetTier === budget.tier) return;
  state.lastDrainBudgetTier = budget.tier;
  deps.log?.(
    encodeToon({
      schema_version: "red.afk.drain_budget.v1",
      tier: budget.tier,
      spent_usd: Number(budget.spentUsd.toFixed(4)),
      limit_usd: Number(budget.limitUsd.toFixed(4)),
      percent: Number((budget.percent * 100).toFixed(2)),
      ready_for_agent: queueDepth,
      action:
        budget.tier === "HARD_STOP"
          ? "hard_stop_no_new_spawns_inflight_finish"
          : budget.tier === "CRITICAL"
            ? "new_spawns_downgrade_one_model_tier"
            : "observe",
    }),
  );
}

export function spawnPolicyForBudget(
  state: SupervisorState,
  budget: DrainBudgetStatus | undefined,
): SpawnPolicy | "hard-stop" | undefined {
  if (state.drainBudgetHardStopped || budget?.tier === "HARD_STOP") return "hard-stop";
  if (budget?.tier === "CRITICAL") return { taskTierDowngrade: true };
  return undefined;
}

export async function spawnSlotForBudget(
  slot: number,
  deps: SupervisorDeps,
  state: SupervisorState,
  budget: DrainBudgetStatus | undefined,
): Promise<{ pid: number; spawnEpoch: number } | null> {
  const policy = spawnPolicyForBudget(state, budget);
  if (policy === "hard-stop") return null;
  return policy ? deps.proc.spawnSlot(slot, policy) : deps.proc.spawnSlot(slot);
}
