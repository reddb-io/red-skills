import { describe, expect, test } from "vitest";
import {
  evaluateCompetitiveBaseline,
  graphifyOutSummary,
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
});
