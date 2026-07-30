// worker-accounting — the supervisor's per-worker resource accounting.
//
// The record this used to write is gone, and so is the noun it was keyed to
// (issue #2850, Spec #2772, ADR 0130): a Worker already IS one Worker × one
// Ticket × one try, so the accounting is worker-keyed and its numbers are
// consumed where they are measured. Sampling itself was never the leftover —
// the ATTEMPT-KEYED IDENTITY around it was. What survives is the sampling and
// the budget decision:
//
//  1. ONE SAMPLE PER TICK FOR EVERY SLOT. Memory is read through a single
//     `sampleTreeRssMb(pids)` call, so accounting cost does not scale with the
//     number of workers and a wide project never pays a process-table read per
//     slot.
//  2. THE PEAK BELONGS TO THE WORKER, NOT THE SLOT. A slot respawned onto a new
//     worker resets its peak, so a dead worker's memory is never charged to a
//     live one.
//
// The WALL-CLOCK budget is deliberately NOT enforced here: the per-issue ceiling
// (#2701, LivenessEvaluator → pollStallDetector) already owns that kill and runs
// it through the busy-vs-stuck gate. This module only decides the budgets
// nothing else watches — memory and cost — and NAMES whichever one fired.

import {
  evaluateWorkerBudgets,
  type WorkerBudgetBreach,
  type WorkerBudgets,
  type WorkerUsage,
} from "../worker-budget.js";
import type { SlotState, SupervisorState } from "./state.js";
import type { IterDirInfo, SupervisorDeps } from "./types.js";

/**
 * Refresh every live slot's peak RSS from ONE project-wide sample. A slot whose
 * pid changed since the last sample starts a fresh peak — that is a new worker.
 * Best-effort: a sampler throw leaves the peaks untouched.
 */
export function sampleWorkerPeakRss(state: SupervisorState, deps: SupervisorDeps): void {
  if (!deps.proc.sampleTreeRssMb) return;
  const pids = state.slots
    .map((slot) => slot.pid)
    .filter((pid): pid is number => pid !== null && pid > 1);
  if (pids.length === 0) return;

  let sample: ReadonlyMap<number, number>;
  try {
    sample = deps.proc.sampleTreeRssMb(pids);
  } catch {
    return;
  }
  for (const slot of state.slots) {
    const pid = slot.pid;
    if (pid === null) continue;
    const rssMb = sample.get(pid);
    if (rssMb === undefined || !Number.isFinite(rssMb) || rssMb <= 0) continue;
    if (slot.peakRssPid !== pid) {
      slot.peakRssPid = pid;
      slot.peakRssMb = 0;
    }
    if (rssMb > slot.peakRssMb) slot.peakRssMb = rssMb;
  }
}

/**
 * What the slot's current worker has consumed so far. An unsampled signal is
 * omitted, never reported as 0 — "not measured" is a different claim from
 * "measured zero", and no reader may conflate them.
 */
export function workerUsage(slot: SlotState, info: IterDirInfo | null): WorkerUsage {
  return {
    ...(info !== null && info.durationS > 0 ? { wallClockS: info.durationS } : {}),
    ...(slot.peakRssMb > 0 ? { peakRssMb: slot.peakRssMb } : {}),
    ...(info?.costUsd !== undefined && info.costUsd > 0 ? { costUsd: info.costUsd } : {}),
  };
}

/**
 * The resource budget this worker has reached, or null. Wall clock is excluded
 * on purpose — the per-issue ceiling owns that decision and runs it through the
 * busy-vs-stuck gate, so evaluating it here would turn a gated cut-off into an
 * ungated one.
 */
export function resourceBudgetBreach(
  usage: WorkerUsage,
  budgets: WorkerBudgets,
): WorkerBudgetBreach | null {
  const { wall_clock_s: _wallClock, ...resourceBudgets } = budgets;
  return evaluateWorkerBudgets(usage, resourceBudgets);
}

/** True when at least one resource budget (memory or cost) is configured. An
 * all-unlimited table means the tick skips the extra state read entirely. */
export function hasResourceBudget(budgets: WorkerBudgets): boolean {
  return budgets.peak_rss_mb !== undefined || budgets.cost_usd !== undefined;
}
