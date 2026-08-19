import { describe, expect, it } from "vitest";
import { OUTCOME_EVENT_SCHEMA_VERSION, type OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import {
  recommendModelTier,
  replayModelTierBandit,
  type ModelTierBanditDocument,
  type ModelTierBanditTier,
} from "./model-tier-bandit.js";

const event = (
  id: string,
  taskClass: string,
  tier: ModelTierBanditTier,
  outcome: OutcomeEvent["outcome"],
): OutcomeEvent => ({
  schemaVersion: OUTCOME_EVENT_SCHEMA_VERSION,
  id,
  emitter: "afk-test",
  occurredAt: `2026-07-07T00:00:${id.padStart(2, "0")}.000Z`,
  taskClass,
  chosenOption: { kind: tier },
  outcome,
  cost: { signal: "unknown" },
});

describe("model-tier Thompson bandit", () => {
  it("replays outcome events into explainable posteriors and escalates after consecutive failures", () => {
    const document = replayModelTierBandit([
      event("1", "bugfix", "simple", "success"),
      event("2", "bugfix", "simple", "success"),
      event("3", "bugfix", "simple", "success"),
      event("4", "bugfix", "simple", "success"),
      event("5", "bugfix", "simple", "success"),
      event("6", "bugfix", "complex", "success"),
      event("7", "bugfix", "simple", "failure"),
      event("8", "bugfix", "simple", "failure"),
    ]);

    expect(document.schemaVersion).toBe(1);
    expect(document.buckets.bugfix?.arms.simple.posterior).toEqual({
      alpha: 5.25,
      beta: 3.75,
    });
    expect(document.buckets.bugfix?.arms.complex.posterior).toEqual({
      alpha: 1.65,
      beta: 1.35,
    });

    const advice = recommendModelTier(document, "bugfix", { samplePosterior: (stats) => stats.mean });

    expect(advice.recommendedTier).toBe("complex");
    expect(advice.confidence).toBeGreaterThan(0);
    expect(advice.explanation).toContain("posterior");
    expect(advice.breaker).toEqual({
      fromTier: "simple",
      toTier: "complex",
      consecutiveFailures: 2,
    });
    expect(advice.posterior.find((arm) => arm.tier === "simple")).toMatchObject({
      alpha: 5.25,
      beta: 3.75,
      observations: 7,
      consecutiveFailures: 2,
    });
  });

  it("round-trips as a small persisted document", () => {
    const document: ModelTierBanditDocument = replayModelTierBandit([
      event("1", "docs", "validate", "success"),
    ]);

    expect(JSON.stringify(document).length).toBeLessThan(1500);
    expect(document.buckets.docs?.arms.validate.posterior.alpha).toBe(2);
  });
});
