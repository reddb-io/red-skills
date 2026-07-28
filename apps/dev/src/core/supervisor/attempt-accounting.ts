// attempt-accounting — the resident's per-attempt resource accounting (ADR 0128
// §8, Spec #2700 slice 5).
//
// The resident samples what an attempt consumes while it runs and writes the
// numbers into the attempt record when it closes — completed or terminated
// alike. Three properties this module exists to hold:
//
//  1. ONE SAMPLE PER TICK FOR THE WHOLE FLEET. Memory is read through a single
//     `sampleTreeRssMb(pids)` call, so accounting cost does not scale with fleet
//     width and a wide fleet never pays a process-table read per slot.
//  2. THE PEAK BELONGS TO THE ATTEMPT, NOT THE SLOT. A slot respawned onto a new
//     attempt resets its peak, so a dead attempt's memory is never charged to a
//     live one.
//  3. THE RECORD IS DIAGNOSTIC — IT NEVER BREAKS EXECUTION. Every write is
//     best-effort and swallowed; a broken lane costs observability, not work.
//
// The WALL-CLOCK budget is deliberately NOT enforced here: the per-issue ceiling
// (#2701, LivenessEvaluator → pollStallDetector) already owns that kill and runs
// it through the busy-vs-stuck gate. This module only enforces the budgets
// nothing else watches — memory and cost — and NAMES whichever budget fired when
// the record is written.

import {
  attemptResources,
  evaluateAttemptBudgets,
  type AttemptBudgetBreach,
  type AttemptBudgets,
  type AttemptUsage,
} from "../attempt-budget.js";
import type { SlotState, SupervisorState } from "./state.js";
import type { AttemptCloseRecord, IterDirInfo, SupervisorDeps } from "./types.js";

/**
 * Refresh every live slot's peak RSS from ONE fleet-wide sample. A slot whose
 * pid changed since the last sample starts a fresh peak — that is a new attempt.
 * Best-effort: a sampler throw leaves the peaks untouched.
 */
export function sampleFleetPeakRss(state: SupervisorState, deps: SupervisorDeps): void {
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
 * What the slot's current attempt has consumed so far. An unsampled signal is
 * omitted, never reported as 0 — "not measured" is a different claim from
 * "measured zero", and the record must not conflate them.
 */
export function attemptUsage(slot: SlotState, info: IterDirInfo | null): AttemptUsage {
  return {
    ...(info !== null && info.durationS > 0 ? { wallClockS: info.durationS } : {}),
    ...(slot.peakRssMb > 0 ? { peakRssMb: slot.peakRssMb } : {}),
    ...(info?.costUsd !== undefined && info.costUsd > 0 ? { costUsd: info.costUsd } : {}),
  };
}

/**
 * The resource budget this attempt has reached, or null. Wall clock is excluded
 * on purpose — the per-issue ceiling owns that decision and runs it through the
 * busy-vs-stuck gate, so evaluating it here would turn a gated cut-off into an
 * ungated one.
 */
export function resourceBudgetBreach(
  usage: AttemptUsage,
  budgets: AttemptBudgets,
): AttemptBudgetBreach | null {
  const { wall_clock_s: _wallClock, ...resourceBudgets } = budgets;
  return evaluateAttemptBudgets(usage, resourceBudgets);
}

/** True when at least one resource budget (memory or cost) is configured. An
 * all-unlimited table means the tick skips the extra state read entirely. */
export function hasResourceBudget(budgets: AttemptBudgets): boolean {
  return budgets.peak_rss_mb !== undefined || budgets.cost_usd !== undefined;
}

export interface AttemptCloseInput {
  info: IterDirInfo;
  usage: AttemptUsage;
  outcome: AttemptCloseRecord["outcome"];
  pr?: number;
  note?: string;
}

/**
 * Write one attempt's terminal record through the resident's writer. Charged to
 * this supervisor's fleet and cgroup scope (#2697), so "which fleet caused this
 * pressure" is answerable from the record rather than from `ps`. Best-effort by
 * contract — every failure is swallowed.
 */
export async function recordAttemptClose(
  deps: SupervisorDeps,
  input: AttemptCloseInput,
): Promise<void> {
  if (!deps.recordAttemptClose) return;
  if (input.info.issue === null) return;
  try {
    await deps.recordAttemptClose({
      workerId: input.info.workerId,
      issue: input.info.issue,
      try: input.info.attempt,
      outcome: input.outcome,
      resources: attemptResources(input.usage, deps.fleetAttribution ?? {}),
      ...(input.info.branch !== undefined ? { branch: input.info.branch } : {}),
      ...(input.pr !== undefined ? { pr: input.pr } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
  } catch {
    // The record is diagnostic; it must never break execution (ADR 0128).
  }
}
