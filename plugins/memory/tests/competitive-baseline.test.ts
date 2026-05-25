import { describe, expect, test } from "vitest";
import {
  evaluateCompetitiveEval,
  evaluateCompetitiveBaseline,
  graphifyOutSummary,
  renderCompetitiveEvalHuman,
  renderComparisonTable,
} from "../src/competitive-baseline.js";

describe("competitive baseline harness (#73)", () => {
  test("reuses the reddb-benchmark graphify-out summary as checked-in evidence", () => {
    expect(graphifyOutSummary).toMatchObject({
      corpus: "reddb-benchmark/graphify-out",
      nodes: 551,
      edges: 1329,
      communities: 34,
      inferredEdges: 491,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
  });

  test("encodes measurable better-than claims as regression assertions", () => {
    const report = evaluateCompetitiveBaseline();

    expect(report.failedAssertions).toEqual([]);
    expect(report.assertions.map((a) => a.id)).toEqual([
      "memory-zero-ops-beats-graphify",
      "memory-zero-ops-beats-agent-memory",
      "memory-lifecycle-beats-graphify",
      "memory-lifecycle-beats-agent-memory",
      "memory-recall-latency-beats-graphify-out-path",
      "memory-recall-latency-under-agent-scale-budget",
      "memory-concedes-ner-extraction-quality",
    ]);
  });

  test("renders README-ready parity, advantage, and conceded-gap rows", () => {
    const table = renderComparisonTable(evaluateCompetitiveBaseline());

    expect(table).toContain("| Axis | `memory` | `graphify` | `agent-memory` | Framing |");
    expect(table).toContain("Advantage: embedded RedDB store, no Python or Neo4j service");
    expect(table).toContain("Parity/mixed: both graph competitors have useful breadth");
    expect(table).toContain("Conceded gap: Python ML stack is ahead for turnkey NER");
    expect(table).toContain("graphify-out fixture: 551 nodes / 1329 edges / 34 communities");
  });

  test("evaluates checked-in Memory moat fixtures without live services", async () => {
    const report = await evaluateCompetitiveEval({ now: 1_700_000_000_000 });

    expect(report.fixture.source).toBe("checked-in");
    expect(report.recall.queryCount).toBeGreaterThanOrEqual(2);
    expect(report.recall.meanRecallAtK).toBeGreaterThanOrEqual(0.75);
    expect(report.recall.meanPrecisionAtK).toBeGreaterThan(0);
    expect(report.recall.latency.p50Ms).toBeGreaterThanOrEqual(0);
    expect(report.contextPacks.packCount).toBeGreaterThanOrEqual(1);
    expect(report.contextPacks.meanReductionRatio).toBeGreaterThan(0);
    expect(report.policy.totalCandidates).toBeGreaterThanOrEqual(4);
    expect(report.policy.classificationAccuracy).toBe(1);
    expect(report.policy.lintFindings).toEqual(
      expect.arrayContaining(["imperative-memory", "likely-secret", "stale-progress-fact"]),
    );
    expect(report.foundationGate.evidenceBase).toMatchObject({
      name: "memory-moat-claims",
      source: "checked-in",
      redDbBacked: true,
    });
    expect(report.foundationGate.retrieval.hybridRecall.queryCount).toBeGreaterThanOrEqual(2);
    expect(report.foundationGate.retrieval.hybridRecall.vector.status).toMatch(
      /unavailable|available|contributed/,
    );
    expect(report.foundationGate.retrieval.asOfRecall.status).toBe("available");
    expect(report.foundationGate.readiness.contractVersion).toBe("memory.readiness.v1");
    expect(report.foundationGate.readiness.consumerTargets).toContain("eval:competitive:v2");
    expect(report.foundationGate.trustGovernance.eventLog.totalEvents).toBeGreaterThan(0);
    expect(report.foundationGate.skillEvolution.communities.assignments).toBeGreaterThan(0);
    expect(report.foundationGate.composite.axes.map((axis) => axis.id)).toEqual([
      "retrieval",
      "readiness",
      "trust-governance",
      "skill-evolution",
    ]);
    expect(report.foundationGate.agentmemoryLiveBaseline).toMatchObject({
      state: "prepared-not-implemented",
      implemented: false,
    });
    expect(report.claimGuards.unsupportedLiveCompetitorClaims).toEqual([]);

    const human = renderCompetitiveEvalHuman(report);
    expect(human).toContain("Recall quality");
    expect(human).toContain("Context-pack size");
    expect(human).toContain("Policy / extraction");
    expect(human).toContain("Foundation evidence gate");
    expect(human).toContain("Agentmemory live baseline: prepared but not implemented");
    expect(human).toContain("No live competitor claims were asserted");
  }, 20_000);
});
