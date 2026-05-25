import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { evaluateCompetitiveEvalV2 } from "../src/competitive-baseline.js";
import { competitiveEvalFixture } from "../src/competitive-fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, "..", "README.md");

describe("public Memory documentation claims", () => {
  test("quickstart documents useful source-only plugin behavior", async () => {
    const readme = await readFile(README, "utf8");

    expect(readme).toContain("## Quickstart: source-only operational memory");
    expect(readme).toContain("pnpm --dir plugins/memory install");
    expect(readme).toContain("pnpm --dir plugins/memory build");
    expect(readme).toContain("node plugins/memory/dist/cli.js init --mode markdown-only");
    expect(readme).toContain("node plugins/memory/dist/cli.js init --mode graph --hooks --skill-telemetry");
    expect(readme).toContain("node plugins/memory/dist/cli.js recall");
  });

  test("README public claims are backed by executable competitive eval evidence", async () => {
    const readme = await readFile(README, "utf8");
    const report = await evaluateCompetitiveEvalV2({
      now: 1_700_000_000_000,
      generatedAt: "2023-11-14T22:13:20.000Z",
    });

    expect(report.claimGuards.status).toBe("pass");
    expect(report.claimGuards.unsupportedPublicClaims).toEqual([]);

    for (const claim of competitiveEvalFixture.publicClaims ?? []) {
      expect(readme).toContain(`\`${claim.id}\``);
      for (const evidence of claim.requiredEvidence) {
        expect(readme).toContain(`\`${evidence}\``);
      }
    }
  }, 30_000);
});
