import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  evaluateCompetitiveEvalV2,
  renderCompetitiveEvalV2Human,
  renderCompetitiveEvalV2Json,
} from "../src/competitive-baseline.js";
import { buildCompetitiveEvalViewerArtifact } from "../src/competitive-eval-viewer.js";
import { competitiveEvalFixture, type CompetitiveEvalFixture } from "../src/competitive-fixtures.js";

function runCompetitiveEvalV2(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", "src/competitive-baseline.ts", ...args], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

describe("competitive eval v2 scaffold (#155)", () => {
  test("reports operational-memory composite scores with stable JSON and human summaries", async () => {
    const report = await evaluateCompetitiveEvalV2({
      now: 1_700_000_000_000,
      generatedAt: "2023-11-14T22:13:20.000Z",
    });

    expect(report.schemaVersion).toBe("memory.reference_eval.v2");
    expect(report.fixture.source).toBe("checked-in");
    expect(report.liveServices).toBe("not-required");
    expect(report.dimensions.map((dimension) => dimension.id)).toEqual([
      "retrieval",
      "readiness",
      "trust-governance",
      "governed-write",
      "skill-evolution",
      "operator-surface",
      "multi-agent-integration",
      "intelligence",
    ]);
    expect(report.composite).toMatchObject({
      score: 8,
      maxScore: 8,
      normalizedScore: 1,
      status: "pass",
    });
    expect(report.claimGuards.status).toBe("pass");
    expect(report.claimGuards.unsupportedPublicClaims).toEqual([]);

    const body = JSON.parse(renderCompetitiveEvalV2Json(report));
    expect(Object.keys(body)).toEqual([
      "schema_version",
      "generated_at",
      "fixture",
      "live_services",
      "live_baselines",
      "composite",
      "dimensions",
      "claim_guards",
    ]);
    expect(body.live_baselines).toEqual([]);
    expect(body.dimensions.map((dimension: { id: string }) => dimension.id)).toEqual([
      "retrieval",
      "readiness",
      "trust-governance",
      "governed-write",
      "skill-evolution",
      "operator-surface",
      "multi-agent-integration",
      "intelligence",
    ]);

    const human = renderCompetitiveEvalV2Human(report);
    expect(human).toContain("# Memory reference eval v2");
    expect(human).toContain("Composite: 8/8 normalized=1 status=pass");
    expect(human).toContain("intelligence: 1/1 pass");
    expect(human).toContain("governed-write: 1/1 pass");
    expect(human).toContain("retrieval: 1/1 pass");
    expect(human).toContain("operator-surface: 1/1 pass");
    expect(human).toContain("multi-agent-integration: 1/1 pass");
    expect(human).toContain("Live baselines: not requested.");
    expect(human).toContain("Claim guards: pass");
  }, 30_000);

  test("fails public documentation claims that are not backed by executable evidence", async () => {
    const fixture: CompetitiveEvalFixture = {
      ...competitiveEvalFixture,
      publicClaims: [
        {
          id: "unsupported-agent-memory-latency-win",
          text: "Memory beats agent-memory recall latency.",
          requiredEvidence: ["live-baseline:agent-memory:recall-latency"],
        },
      ],
    };

    const report = await evaluateCompetitiveEvalV2({
      fixture,
      now: 1_700_000_000_000,
      generatedAt: "2023-11-14T22:13:20.000Z",
    });

    expect(report.claimGuards.status).toBe("fail");
    expect(report.claimGuards.unsupportedPublicClaims).toEqual([
      "unsupported-agent-memory-latency-win",
    ]);
    expect(report.composite.status).toBe("fail");
    expect(renderCompetitiveEvalV2Human(report)).toContain(
      "Unsupported public claims: unsupported-agent-memory-latency-win",
    );
  }, 30_000);

  test("includes measured Agentmemory live baselines in JSON, human summaries, and claim evidence", async () => {
    const fixture: CompetitiveEvalFixture = {
      ...competitiveEvalFixture,
      publicClaims: [
        {
          id: "agentmemory-recall-measured",
          text: "Agentmemory recall was measured through the live adapter.",
          requiredEvidence: ["live-baseline:agentmemory:agentmemory-cli-recall"],
        },
      ],
    };

    const report = await evaluateCompetitiveEvalV2({
      fixture,
      now: 1_700_000_000_000,
      generatedAt: "2023-11-14T22:13:20.000Z",
      liveBaselines: [
        {
          competitor: "agentmemory",
          adapter: "agentmemory-cli",
          state: "measured",
          source: "live-cli",
          configured: true,
          capabilityId: "agentmemory.cli.recall",
          command: ["agentmemory", "baseline", "--json"],
          metrics: { recall_at_5: 0.952, p50_ms: 18 },
          evidence: ["agentmemory:smart-search"],
          summary: "R@5 0.952, p50 18ms",
        },
      ],
    });

    expect(report.liveServices).toBe("opt-in");
    expect(report.liveBaselines).toHaveLength(1);
    expect(report.claimGuards.status).toBe("pass");
    expect(report.claimGuards.unsupportedPublicClaims).toEqual([]);

    const body = JSON.parse(renderCompetitiveEvalV2Json(report));
    expect(body.live_baselines).toEqual([
      {
        competitor: "agentmemory",
        adapter: "agentmemory-cli",
        state: "measured",
        source: "live-cli",
        configured: true,
        capability_id: "agentmemory.cli.recall",
        command: ["agentmemory", "baseline", "--json"],
        metrics: { recall_at_5: 0.952, p50_ms: 18 },
        evidence: ["agentmemory:smart-search"],
        summary: "R@5 0.952, p50 18ms",
      },
    ]);

    const human = renderCompetitiveEvalV2Human(report);
    expect(human).toContain("Agentmemory live baseline: measured - R@5 0.952, p50 18ms");
    expect(human).toContain("recall_at_5=0.952");
  }, 30_000);

  test("includes measured Neo4j Agent Memory live baselines in claim evidence", async () => {
    const fixture: CompetitiveEvalFixture = {
      ...competitiveEvalFixture,
      publicClaims: [
        {
          id: "neo4j-agent-memory-recall-latency-measured",
          text: "Neo4j Agent Memory recall latency was measured through the live adapter.",
          requiredEvidence: ["live-baseline:agent-memory:recall-latency"],
        },
      ],
    };

    const report = await evaluateCompetitiveEvalV2({
      fixture,
      now: 1_700_000_000_000,
      generatedAt: "2023-11-14T22:13:20.000Z",
      liveBaselines: [
        {
          competitor: "agent-memory",
          adapter: "neo4j-agent-memory-cli",
          state: "measured",
          source: "live-cli",
          configured: true,
          capabilityId: "recall latency",
          command: ["node", "scripts/neo4j-agent-memory-baseline.mjs"],
          metrics: { p50_ms: 42, recall_at_5: 0.88 },
          evidence: ["neo4j-agent-memory:recall"],
          summary: "Neo4j Agent Memory p50 42ms",
        },
      ],
    });

    expect(report.liveServices).toBe("opt-in");
    expect(report.claimGuards.status).toBe("pass");
    expect(report.claimGuards.unsupportedPublicClaims).toEqual([]);
    expect(report.claimGuards.unmeasuredLiveBaselines).toEqual([]);

    const body = JSON.parse(renderCompetitiveEvalV2Json(report));
    expect(body.live_baselines).toEqual([
      {
        competitor: "agent-memory",
        adapter: "neo4j-agent-memory-cli",
        state: "measured",
        source: "live-cli",
        configured: true,
        capability_id: "recall latency",
        command: ["node", "scripts/neo4j-agent-memory-baseline.mjs"],
        metrics: { p50_ms: 42, recall_at_5: 0.88 },
        evidence: ["neo4j-agent-memory:recall"],
        summary: "Neo4j Agent Memory p50 42ms",
      },
    ]);

    const human = renderCompetitiveEvalV2Human(report);
    expect(human).toContain("Neo4j Agent Memory live baseline: measured - Neo4j Agent Memory p50 42ms");
    expect(human).toContain("p50_ms=42");
  }, 30_000);

  test("CLI can run the v2 harness and emit JSON plus a human summary", () => {
    const result = runCompetitiveEvalV2(["--v2", "--json", "--human"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"schema_version": "memory.reference_eval.v2"');
    expect(result.stdout).toContain("# Memory reference eval v2");
    expect(result.stderr).toBe("");
  }, 30_000);

  test("CLI can opt in to a live Agentmemory baseline without requiring it by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-agentmemory-baseline-"));
    const fakeAgentmemory = join(dir, "agentmemory-baseline.mjs");
    await writeFile(
      fakeAgentmemory,
      `console.log(JSON.stringify({ summary: "fake Agentmemory R@5 0.9", metrics: { recall_at_5: 0.9, p50_ms: 12 }, evidence: ["agentmemory:fake"] }));\n`,
      "utf8",
    );

    const result = runCompetitiveEvalV2(["--v2", "--json", "--human", "--live-agentmemory"], {
      MEMORY_AGENTMEMORY_BASELINE_CMD: JSON.stringify([process.execPath, fakeAgentmemory]),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"live_services": "opt-in"');
    expect(result.stdout).toContain('"competitor": "agentmemory"');
    expect(result.stdout).toContain("Agentmemory live baseline: measured - fake Agentmemory R@5 0.9");
  }, 30_000);

  test("CLI can opt in to a live Neo4j Agent Memory baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-neo4j-agent-memory-baseline-"));
    const fakeAgentMemory = join(dir, "neo4j-agent-memory-baseline.mjs");
    await writeFile(
      fakeAgentMemory,
      `console.log(JSON.stringify({ summary: "fake Neo4j Agent Memory p50 33ms", metrics: { p50_ms: 33, recall_at_5: 0.86 }, evidence: ["neo4j-agent-memory:fake"] }));\n`,
      "utf8",
    );

    const result = runCompetitiveEvalV2(["--v2", "--json", "--human", "--live-agent-memory"], {
      MEMORY_NEO4J_AGENT_MEMORY_BASELINE_CMD: JSON.stringify([process.execPath, fakeAgentMemory]),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"live_services": "opt-in"');
    expect(result.stdout).toContain('"competitor": "agent-memory"');
    expect(result.stdout).toContain(
      "Neo4j Agent Memory live baseline: measured - fake Neo4j Agent Memory p50 33ms",
    );
  }, 30_000);

  test("competitive eval viewer artifact renders self-contained HTML with embedded JSON", async () => {
    const report = await evaluateCompetitiveEvalV2({
      now: 1_700_000_000_000,
      generatedAt: "2023-11-14T22:13:20.000Z",
    });
    const artifact = buildCompetitiveEvalViewerArtifact(report);

    expect(artifact.contract).toEqual({
      name: "memory.reference_eval.viewer",
      version: "memory.reference_eval.viewer.v1",
      consumes: "memory.reference_eval.v2",
    });
    expect(artifact.report).toBe(report);
    expect(artifact.html).toContain("<title>Memory Reference Eval</title>");
    expect(artifact.html).toContain('id="memory-reference-eval-data"');
    expect(artifact.html).toContain("memory.reference_eval.v2");
    expect(artifact.html).toContain("multi-agent-integration");
  }, 30_000);
});
