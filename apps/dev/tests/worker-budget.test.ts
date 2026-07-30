// Per-attempt resource budgets — named terminations (ADR 0128 §8, #2707).
//
// The failure this pins: an attempt cut off for holding too much memory (or
// spending too much money) used to be indistinguishable from an attempt that
// went silent, and both re-queued as if nothing had been produced. These tests
// hold the three separations the ADR demands — a budgeted termination NAMES its
// budget, is distinct from a stall and from a clean finish, and hands its
// branch/PR forward — plus the one config invariant that keeps the feature
// inert until asked for: an unset budget is UNLIMITED, never zero.

import { describe, expect, it } from "vitest";
import {
  WORKER_BUDGET_CONFIG_KEYS,
  WORKER_BUDGET_HANDOFF_MARKER,
  WORKER_BUDGET_UNLIMITED,
  evaluateWorkerBudgets,
  planBudgetHandoff,
  resolveWorkerBudgets,
} from "../src/core/worker-budget.js";
import { CAP_HANDOFF_MARKER } from "../src/core/wall-clock-cap.js";
import { CONFIG_DEFAULTS, getConfig, loadConfig } from "../src/core/config.js";
import { resolveSupervisorConfig } from "../src/core/supervisor.js";

describe("budget resolution: unset means unlimited, never zero (#2707)", () => {
  it("the shipped defaults leave memory and cost unlimited", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", {
      ignoreActivationGate: true,
      warn: () => {},
    });
    expect(getConfig(values, "afk.attempt.budget.peak_rss_mb")).toBe(WORKER_BUDGET_UNLIMITED);
    expect(getConfig(values, "afk.attempt.budget.cost_usd")).toBe(WORKER_BUDGET_UNLIMITED);

    const budgets = resolveWorkerBudgets({ getCfg: (key) => getConfig(values, key) });
    expect(budgets.peak_rss_mb).toBeUndefined();
    expect(budgets.cost_usd).toBeUndefined();
    // Unlimited is ABSENT, not 0 — a 0 ceiling would terminate every attempt the
    // instant it was sampled.
    expect(budgets.peak_rss_mb).not.toBe(0);
    expect(evaluateWorkerBudgets({ peakRssMb: 999_999, costUsd: 999 }, budgets)).toBeNull();
  });

  it("both budget keys are documented v1 keys under plugins.dev.afk.*", async () => {
    for (const key of ["afk.attempt.budget.peak_rss_mb", "afk.attempt.budget.cost_usd"]) {
      expect(Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)).toBe(true);
    }
    const values = loadConfig("/x/.red/config.yaml", {
      ignoreActivationGate: true,
      read: () =>
        "plugins:\n  dev:\n    afk:\n      attempt:\n        budget:\n          peak_rss_mb: 4096\n          cost_usd: 12.5\n",
    });
    const budgets = resolveWorkerBudgets({ getCfg: (key) => getConfig(values, key) });
    expect(budgets.peak_rss_mb).toBe(4096);
    expect(budgets.cost_usd).toBe(12.5);
  });

  it("a garbage or non-positive value is unlimited, never an instant killer", () => {
    const budgets = resolveWorkerBudgets({
      getCfg: (key) =>
        key === WORKER_BUDGET_CONFIG_KEYS.peak_rss_mb
          ? "0"
          : key === WORKER_BUDGET_CONFIG_KEYS.cost_usd
            ? "not-a-number"
            : "",
    });
    expect(budgets.peak_rss_mb).toBeUndefined();
    expect(budgets.cost_usd).toBeUndefined();
  });

  it("env overrides the config file, and the wall-clock budget IS the per-issue ceiling", () => {
    const budgets = resolveWorkerBudgets({
      env: { RED_AFK_ATTEMPT_PEAK_RSS_MB: "2048" },
      getCfg: (key) => (key === WORKER_BUDGET_CONFIG_KEYS.peak_rss_mb ? "8192" : ""),
      wallClockS: 2700,
    });
    expect(budgets.peak_rss_mb).toBe(2048);
    expect(budgets.wall_clock_s).toBe(2700);
  });

  it("the supervisor config carries the resolved table, wall clock included", () => {
    const config = resolveSupervisorConfig(
      { RED_AFK_ATTEMPT_COST_USD: "9" },
      (key) => (key === "afk.issue_wall_clock_max_s" ? "1800" : ""),
    );
    expect(config.workerBudgets).toEqual({ wall_clock_s: 1800, cost_usd: 9 });
    expect(config.workerBudgets.peak_rss_mb).toBeUndefined();
  });
});

describe("budget evaluation names the budget that fired (#2707)", () => {
  it("reports the first budget reached, in time → memory → cost order", () => {
    const breach = evaluateWorkerBudgets(
      { wallClockS: 100, peakRssMb: 5000, costUsd: 3 },
      { peak_rss_mb: 4096, cost_usd: 1 },
    );
    expect(breach).toEqual({ budget: "peak_rss_mb", limit: 4096, observed: 5000 });
  });

  it("an unsampled signal never fires a budget", () => {
    expect(evaluateWorkerBudgets({}, { peak_rss_mb: 1, cost_usd: 1 })).toBeNull();
  });

});

describe("a budgeted termination hands its work forward (#2707)", () => {
  const branchInput = {
    issue: 2707,
    branch: "afk/w1/2707-budgets",
    branchHead: "abc1234",
    branchPublished: true,
  };

  it("names the resume ref and forbids starting over from main", () => {
    const handoff = planBudgetHandoff({
      ...branchInput,
      breach: { budget: "peak_rss_mb", limit: 4096, observed: 5120 },
    });
    expect(handoff.handsWorkForward).toBe(true);
    expect(handoff.resumeRef).toBe("afk/w1/2707-budgets");
    expect(handoff.comment).toContain(WORKER_BUDGET_HANDOFF_MARKER);
    expect(handoff.comment).toContain("peak_rss_mb");
    expect(handoff.comment).toContain("resume-from-branch: `afk/w1/2707-budgets`");
    expect(handoff.comment).toContain("do NOT start over from main");
    expect(handoff.comment).toContain("NOT stalled");
  });

  it("names an open PR as the pending artifact even with no resolvable branch head", () => {
    const handoff = planBudgetHandoff({
      issue: 2707,
      pullRequest: 4242,
      breach: { budget: "cost_usd", limit: 5, observed: 7.5 },
    });
    expect(handoff.pendingPullRequest).toBe(4242);
    expect(handoff.resumeRef).toBeUndefined();
    expect(handoff.handsWorkForward).toBe(true);
    expect(handoff.comment).toContain("PR #4242");
  });

  it("an attempt that committed nothing hands nothing forward", () => {
    const handoff = planBudgetHandoff({
      issue: 2707,
      breach: { budget: "peak_rss_mb", limit: 4096, observed: 4096 },
    });
    expect(handoff.handsWorkForward).toBe(false);
    expect(handoff.comment).toContain("nothing is handed forward");
  });

  it("the wall-clock budget keeps the shipped #2701 wording", () => {
    const handoff = planBudgetHandoff({
      ...branchInput,
      breach: { budget: "wall_clock_s", limit: 2700, observed: 2800 },
    });
    expect(handoff.comment).toContain(CAP_HANDOFF_MARKER);
    expect(handoff.comment).toContain("cap 2700s");
    expect(handoff.resumeRef).toBe("afk/w1/2707-budgets");
  });
});
