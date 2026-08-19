import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { evaluateCompetitiveEvalV2 } from "../src/competitive-baseline.js";
import { competitiveEvalFixture } from "../src/competitive-fixtures.js";

// The README stayed at the plugin definition root (plugins/memory/README.md)
// after the impl moved to apps/plugin-memory (ADR 0060). Resolve it relative to this
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
    expect(readme).toContain("pnpm --dir apps/plugin-memory install");
    expect(readme).toContain("pnpm --dir apps/plugin-memory build");
    expect(readme).toContain("memory init --mode markdown-only --yes");
    expect(readme).toContain("memory init --mode graph --hooks --skill-telemetry --yes");
    expect(readme).toContain('memory recall "cache TTL"');
  });

  test("README documents the 60-second governed cross-agent Memory story", async () => {
    const readme = await readFile(README, "utf8");

    expect(readme).toContain("## 60-second governed cross-agent flow");
    expect(readme).toContain("Mistakes avoided");
    expect(readme).toContain("token savings");
    expect(readme).toContain("memory store-evidence");
    expect(readme).toContain("memory_store_evidence");
    expect(readme).toContain("--observer claude-smoke-runner");
    expect(readme).toContain("--observer codex-smoke-runner");
    expect(readme).toContain("issue-871-cross-agent-memory-smoke.md:17");
    expect(readme).toContain("provenance");
    expect(readme).toContain("`governed-cross-agent-smoke`");
    expect(readme).toContain("`foundation:governed-write-cli`");
    expect(readme).toContain("`foundation:cross-agent-governed-recall`");
    expect(readme).toContain("`foundation:mistake-avoided-bench`");
    expect(readme).not.toContain("Use `memory_store` for governed writes");
    expect(readme).not.toContain("Use `memory store` for governed writes");
    expect(readme).not.toContain("memory learn will");
    expect(readme).not.toContain("memory refine will");
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
