import { describe, expect, it, vi } from "vitest";
import {
  runValidationCheck,
  validationRouteFor,
  type FuzzyValidationCheck,
  type StructuralValidationCheck,
} from "../src/core/validation-routing.js";

describe("validation-routing", () => {
  it("runs structural validation deterministically with zero model dispatch", async () => {
    const run = vi.fn(() => ({ status: "passed" as const, summary: "valid JSON" }));
    const dispatchValidate = vi.fn(async () => ({
      status: "failed" as const,
      summary: "model should not run",
    }));
    const resolveTier = vi.fn(() => ({ model: "claude-haiku-4-5", effort: "low" as const }));
    const check: StructuralValidationCheck = {
      mode: "structural",
      name: "parse-manifest",
      kind: "json-parse",
      run,
    };

    await expect(
      runValidationCheck(check, { runner: "claude", resolveTier, dispatchValidate }),
    ).resolves.toEqual({
      check: "parse-manifest",
      route: { execution: "deterministic", modelCalls: 0 },
      verdict: { status: "passed", summary: "valid JSON" },
    });

    expect(validationRouteFor(check)).toEqual({ execution: "deterministic", modelCalls: 0 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(resolveTier).not.toHaveBeenCalled();
    expect(dispatchValidate).not.toHaveBeenCalled();
  });

  it("routes fuzzy semantic validation through the validate tier", async () => {
    const dispatchValidate = vi.fn(async () => ({
      status: "passed" as const,
      summary: "content matches the intent",
    }));
    const resolveTier = vi.fn(() => ({ model: "claude-haiku-4-5", effort: "low" as const }));
    const check: FuzzyValidationCheck = {
      mode: "fuzzy",
      name: "brief-matches-issue",
      kind: "semantic-intent",
      prompt: "Does the implementation match the issue intent?",
    };

    await expect(
      runValidationCheck(check, { runner: "claude", resolveTier, dispatchValidate }),
    ).resolves.toEqual({
      check: "brief-matches-issue",
      route: { execution: "model", tier: "validate", modelCalls: 1 },
      verdict: { status: "passed", summary: "content matches the intent" },
    });

    expect(resolveTier).toHaveBeenCalledWith("claude", "validate");
    expect(dispatchValidate).toHaveBeenCalledWith({
      runner: "claude",
      tier: "validate",
      model: "claude-haiku-4-5",
      effort: "low",
      check,
    });
  });
});
