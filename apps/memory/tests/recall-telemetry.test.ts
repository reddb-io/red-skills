import { describe, expect, test } from "vitest";
import type { ContextPack } from "../src/context-pack.js";
import {
  recallObservationToMemoryEvent,
  type RecallObservationInput,
} from "../src/memory-events.js";
import {
  deriveRecallTelemetry,
  recallObservationFromContextPack,
  renderRecallTelemetryReport,
} from "../src/recall-telemetry.js";

function observation(overrides: Partial<RecallObservationInput> = {}): RecallObservationInput {
  return {
    surface: "context-pack",
    query: "jwt rotation",
    candidateCount: 5,
    returnedCount: 4,
    hitCount: 4,
    goldInPackProxy: true,
    tokensBaseline: 1000,
    tokensCompressed: 600,
    ...overrides,
  };
}

describe("recall telemetry", () => {
  test("derives hit-rate, gold-in-pack proxy, and tokens-saved from observation events", () => {
    const events = [
      recallObservationToMemoryEvent(observation({ eventId: "r1" })),
      recallObservationToMemoryEvent(
        observation({ eventId: "r2", hitCount: 0, goldInPackProxy: false, tokensCompressed: 1000 }),
      ),
      recallObservationToMemoryEvent(
        observation({ eventId: "r3", surface: "handoff", tokensBaseline: 800, tokensCompressed: 500 }),
      ),
    ];

    const report = deriveRecallTelemetry(events);

    expect(report.schema_version).toBe("memory.recall-telemetry.v1");
    expect(report.source).toBe("real-runs");
    expect(report.observation_count).toBe(3);
    expect(report.recall_total).toBe(3);
    expect(report.recall_hits).toBe(2);
    expect(report.recall_hit_rate).toBeCloseTo(2 / 3, 5);
    expect(report.gold_in_pack_count).toBe(2);
    expect(report.gold_in_pack_rate).toBeCloseTo(2 / 3, 5);
    // saved = (1000-600) + (1000-1000) + (800-500) = 700
    expect(report.tokens_saved_total).toBe(700);
    expect(report.surfaces).toEqual(["context-pack", "handoff"]);
  });

  test("empty stream yields zeroed metrics without dividing by zero", () => {
    const report = deriveRecallTelemetry([]);
    expect(report.observation_count).toBe(0);
    expect(report.recall_hit_rate).toBe(0);
    expect(report.gold_in_pack_rate).toBe(0);
    expect(report.savings_ratio).toBe(0);
  });

  test("derives an observation from a context pack", () => {
    const pack = {
      goal: "ship cache prefix",
      status: "ok",
      budgetChars: 4000,
      usedChars: 1200,
      markdown: "...",
      coreContext: [{}],
      entries: [{}, {}, {}],
      skillRecommendations: { recommendations: [] },
      warnings: [],
      omittedEntries: 2,
    } as unknown as ContextPack;

    const obs = recallObservationFromContextPack(pack, { surface: "context-pack" });
    expect(obs.returnedCount).toBe(3);
    expect(obs.candidateCount).toBe(5);
    expect(obs.hitCount).toBe(3);
    expect(obs.goldInPackProxy).toBe(true);
    expect(obs.tokensCompressed).toBe(300); // 1200 chars / 4
    expect(obs.tokensBaseline).toBeGreaterThan(obs.tokensCompressed);
  });

  test("report markdown is explicitly distinct from the synthetic benchmark", () => {
    const md = renderRecallTelemetryReport(deriveRecallTelemetry([]));
    expect(md).toContain("# Recall telemetry (real agent runs)");
    expect(md).toContain("Distinct from the synthetic retrieval benchmark");
    expect(md).toContain("tokens saved");
  });
});
