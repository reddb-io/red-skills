import { describe, expect, it } from "vitest";
import { aggregateReseedMeasurements, reseedMeasurementFact } from "../src/core/process-issue/reseed-measurement.js";
import { harness, processIssue } from "./process-issue.test-helpers.js";

describe("Re-seed measurement fact (#3843)", () => {
  it("records two rounds in the landed Worker's state and Envelope", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, false, true],
      reseedGateBudget: 3,
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.statePatches).toContainEqual({
      "current.reseed": {
        version: 1,
        rounds: 2,
        by_cause: { gate: 2, tier: 0, review: 0 },
      },
    });
    const envelope = trace.envelopeBodies.at(-1) ?? "";
    expect(envelope).toContain('<details data-section="reseed">');
    expect(envelope).toContain("rounds: 2");
    expect(envelope).toContain("gate: 2");
  });

  it("aggregates Worker fixtures by cause", () => {
    const aggregate = aggregateReseedMeasurements([
      reseedMeasurementFact({ gate: 2 }),
      reseedMeasurementFact({ tier: 1, review: 1 }),
      reseedMeasurementFact({ gate: 1, review: 1 }),
    ]);

    expect(aggregate).toEqual({
      workers: 3,
      rounds: 6,
      by_cause: { gate: 3, tier: 1, review: 2 },
    });
  });
});
