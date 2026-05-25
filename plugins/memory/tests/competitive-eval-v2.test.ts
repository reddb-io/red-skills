import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  evaluateCompetitiveEvalV2,
  renderCompetitiveEvalV2Human,
  renderCompetitiveEvalV2Json,
} from "../src/competitive-baseline.js";
import { competitiveEvalFixture, type CompetitiveEvalFixture } from "../src/competitive-fixtures.js";

function runCompetitiveEvalV2(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", "src/competitive-baseline.ts", ...args], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("competitive eval v2 scaffold (#155)", () => {
  test("reports operational-memory composite scores with stable JSON and human summaries", async () => {
    const report = await evaluateCompetitiveEvalV2({
      now: 1_700_000_000_000,
      generatedAt: "2023-11-14T22:13:20.000Z",
    });

    expect(report.schemaVersion).toBe("memory.competitive_eval.v2");
    expect(report.fixture.source).toBe("checked-in");
    expect(report.liveServices).toBe("not-required");
    expect(report.dimensions.map((dimension) => dimension.id)).toEqual([
      "retrieval",
      "readiness",
      "trust-governance",
      "skill-evolution",
    ]);
    expect(report.composite).toMatchObject({
      score: 4,
      maxScore: 4,
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
      "composite",
      "dimensions",
      "claim_guards",
    ]);
    expect(body.dimensions.map((dimension: { id: string }) => dimension.id)).toEqual([
      "retrieval",
      "readiness",
      "trust-governance",
      "skill-evolution",
    ]);

    const human = renderCompetitiveEvalV2Human(report);
    expect(human).toContain("# Memory competitive eval v2");
    expect(human).toContain("Composite: 4/4 normalized=1 status=pass");
    expect(human).toContain("retrieval: 1/1 pass");
    expect(human).toContain("Claim guards: pass");
  });

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
  });

  test("CLI can run the v2 harness and emit JSON plus a human summary", () => {
    const result = runCompetitiveEvalV2(["--v2", "--json", "--human"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"schema_version": "memory.competitive_eval.v2"');
    expect(result.stdout).toContain("# Memory competitive eval v2");
    expect(result.stderr).toBe("");
  });
});
