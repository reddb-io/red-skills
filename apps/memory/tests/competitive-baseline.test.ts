import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  evaluateCompetitiveInteropReport,
  evaluateCompetitiveEval,
  evaluateCompetitiveBaseline,
  graphifyOutSummary,
  renderCompetitiveInteropHuman,
  renderCompetitiveInteropJson,
  renderCompetitiveEvalHuman,
  renderComparisonTable,
} from "../src/competitive-baseline.js";

function runMemoryScript(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("pnpm", args, {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("reference baseline harness (#73)", () => {
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
    expect(report.foundationGate.readiness.consumerTargets).toContain("references:eval:v2");
    expect(report.foundationGate.trustGovernance.eventLog.totalEvents).toBeGreaterThan(0);
    expect(report.foundationGate.skillEvolution.communities.assignments).toBeGreaterThan(0);
    expect(report.foundationGate.multiAgentIntegration).toMatchObject({
      supportedAgents: 7,
      readyAgents: 7,
      missingAgents: 0,
      sources: {
        routingGuide: "memory.routing_guide.v1",
        integrationStatus: "memory.agent_integration_status.v1",
      },
    });
    expect(report.foundationGate.multiAgentIntegration.mcpTools).toBeGreaterThanOrEqual(10);
    expect(report.foundationGate.multiAgentIntegration.hookReadyAgents).toBe(2);
    expect(report.foundationGate.composite.axes.map((axis) => axis.id)).toEqual([
      "retrieval",
      "readiness",
      "trust-governance",
      "skill-evolution",
      "operator-surface",
      "multi-agent-integration",
    ]);
    expect(report.foundationGate.agentmemoryLiveBaseline).toMatchObject({
      state: "adapter-ready",
      implemented: true,
    });
    expect(report.claimGuards.unsupportedLiveCompetitorClaims).toEqual([]);

    const human = renderCompetitiveEvalHuman(report);
    expect(human).toContain("Recall quality");
    expect(human).toContain("Context-pack size");
    expect(human).toContain("Policy / extraction");
    expect(human).toContain("Foundation evidence gate");
    expect(human).toContain("Agentmemory live baseline: adapter ready");
    expect(human).toContain("Neo4j Agent Memory live baseline: adapter ready");
    expect(human).toContain("No live reference claims were asserted");
  }, 30_000);

  test("reports checked-fixture Graphify and Neo4j Memory interop decisions", () => {
    const report = evaluateCompetitiveInteropReport({
      generatedAt: "2023-11-14T22:13:20.000Z",
    });

    expect(report.liveServices).toBe("not-required");
    expect(report.claimGuards.fullParityClaimed).toBe(false);
    expect(report.claimGuards.unsupportedClaims).toEqual([]);
    expect(report.artifacts.map((artifact) => artifact.competitor)).toEqual([
      "graphify-like",
      "neo4j-agent-memory-like",
    ]);

    const graphify = report.artifacts.find((artifact) => artifact.competitor === "graphify-like");
    expect(graphify).toMatchObject({
      source: "checked-in",
      counts: {
        sourceNodes: 4,
        sourceEdges: 4,
        preservedConcepts: 2,
        approximatedConcepts: 2,
        droppedConcepts: 2,
      },
    });
    expect(graphify?.decisions.map((decision) => decision.decision)).toEqual(
      expect.arrayContaining(["preserved", "approximated", "dropped"]),
    );

    const neo4j = report.artifacts.find(
      (artifact) => artifact.competitor === "neo4j-agent-memory-like",
    );
    expect(neo4j).toMatchObject({
      source: "checked-in",
      counts: {
        sourceNodes: 5,
        sourceEdges: 4,
        preservedConcepts: 3,
        approximatedConcepts: 3,
        droppedConcepts: 2,
      },
    });

    const json = JSON.parse(renderCompetitiveInteropJson(report));
    expect(json.artifacts[0]).toHaveProperty("counts");
    expect(json.artifacts[0].mapping_decisions[0]).toHaveProperty("decision");

    const human = renderCompetitiveInteropHuman(report);
    expect(human).toContain("Preserved");
    expect(human).toContain("Approximated");
    expect(human).toContain("Dropped");
    expect(human).toContain("Does not claim full Graphify or Neo4j parity");
  });

  test("competitive interop command emits JSON and human reports without live services", () => {
    const result = runMemoryScript(["--filter", "@reddb-io/benchmark-memory", "references:interop"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"schema_version": "memory.reference_interop.v1"');
    expect(result.stdout).toContain('"live_services": "not-required"');
    expect(result.stdout).toContain("# Memory reference interop report");
    expect(result.stdout).toContain("No unsupported full-parity claims were asserted.");
    // pnpm v11+ writes harmless "Ignored build scripts" warnings to stderr on first run.
    // Filter known noise; assert no actual error lines.
    const stderr = String(result.stderr ?? "");
    const meaningfulStderr = stderr
      .split("\n")
      .filter((line: string) => line.trim())
      .filter(
        (line: string) =>
          !/^\$ |^>|Ignored build scripts|approve-builds|"pnpm" field in package\.json|Already up to date|Done in /i.test(
            line,
          ),
      )
      .join("\n");
    expect(meaningfulStderr).toBe("");
  });
});
