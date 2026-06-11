import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { evaluateCompetitiveEvalV2 } from "../src/competitive-baseline.js";
import { competitiveEvalFixture } from "../src/competitive-fixtures.js";

// The README stayed at the plugin definition root (plugins/memory/README.md)
// after the impl moved to apps/memory (ADR 0060). Resolve it relative to this
// test file: tests/ -> memory -> apps -> repo root.
const HERE = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, "..", "..", "..", "plugins", "memory", "README.md");

describe("public Memory documentation claims", () => {
  test("quickstart documents useful source-only plugin behavior", async () => {
    const readme = await readFile(README, "utf8");

    expect(readme).toContain("## Golden path: governed operational memory");
    expect(readme).toContain("## What this plugin is");
    expect(readme).toContain("## Which mode should I use?");
    expect(readme).toContain("## Common workflows");
    expect(readme).toContain("## Read surfaces and operator diagnostics");
    expect(readme).toContain("Initialize | `memory init` / `$init`");
    expect(readme).toContain("Lowest-risk searchable notes in any repo");
    expect(readme).toContain("Get context before acting");
    expect(readme).toContain("`memory recall \"topic\"`");
    expect(readme).toContain("pnpm --dir apps/memory install");
    expect(readme).toContain("pnpm --dir apps/memory build");
    expect(readme).toContain("memory init --mode markdown-only --yes");
    expect(readme).toContain("memory init --mode graph --hooks --skill-telemetry --yes");
    expect(readme).toContain('memory recall "cache TTL"');
  });

  test("README public claims are backed by executable reference eval evidence", async () => {
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
