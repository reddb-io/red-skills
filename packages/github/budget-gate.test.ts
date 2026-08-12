import { describe, expect, it } from "vitest";

import {
  DEFAULT_GITHUB_BUDGET_GATE,
  GITHUB_BUDGET_GATE_ENV,
  githubBudgetGate,
  githubBudgetGateEnabled,
  githubBudgetGateFromEnv,
} from "./budget-gate.js";

describe("the budget gate's default", () => {
  it("is off, because the quota belongs to the operator", () => {
    expect(DEFAULT_GITHUB_BUDGET_GATE).toBe("off");
    expect(githubBudgetGateEnabled(undefined)).toBe(false);
    expect(githubBudgetGateFromEnv({})).toBe("off");
  });
});

describe("reading a declared mode", () => {
  it("turns the spellings an operator actually writes on", () => {
    for (const declared of ["on", "ON", " enabled ", "true", true]) {
      expect(githubBudgetGate(declared)).toBe("on");
    }
    expect(githubBudgetGateEnabled(githubBudgetGateFromEnv({ [GITHUB_BUDGET_GATE_ENV]: "on" }))).toBe(true);
  });

  it("reads anything else as off rather than as an error", () => {
    for (const declared of ["off", "no", "", "  ", "yes-please", 1, null, undefined, {}]) {
      expect(githubBudgetGate(declared)).toBe("off");
    }
  });
});
