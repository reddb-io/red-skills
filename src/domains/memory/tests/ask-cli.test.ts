import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
  });
}

async function initRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-ask-cli-"));
  roots.push(root);
  const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
  expect(init.status).toBe(0);
  return root;
}

describe("memory ask CLI", () => {
  test(
    "returns no-provider status with recalled evidence provenance",
    async () => {
      const root = await initRoot();
      const stored = runMemory([
        "store",
        "JWT tokens rotate every 90 days in staging.",
        "--root",
        root,
      ]);
      expect(stored.status).toBe(0);

      const result = runMemory(["ask", "how often do jwt tokens rotate?", "--root", root, "--json"]);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        available: boolean;
        answer: string;
        citations: unknown[];
        evidence: { active: Array<{ rid: number; source: string; confidence: string }> };
        gap_analysis: { status: string; gaps: string[]; next_actions: string[] };
        cost: unknown;
      };

      expect(body.status).toBe("provider-unavailable");
      expect(body.available).toBe(false);
      expect(body.answer).toContain("Evidence-only fallback: LLM provider unavailable");
      expect(body.answer).toContain("[1]");
      expect(body.answer).toContain("JWT tokens rotate every 90 days in staging.");
      expect(body.answer).toContain("Gap analysis:");
      expect(body.citations).toHaveLength(1);
      expect(body.evidence.active[0]).toMatchObject({
        source: "manual",
        confidence: "AMBIGUOUS",
      });
      expect(body.gap_analysis.status).toBe("partial");
      expect(body.gap_analysis.gaps).toContain("No EXTRACTED evidence supports the answer.");
      expect(body.cost).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "returns insufficient evidence for unsupported questions",
    async () => {
      const root = await initRoot();
      const stored = runMemory([
        "store",
        "JWT tokens rotate every 90 days in staging.",
        "--root",
        root,
      ]);
      expect(stored.status).toBe(0);

      const result = runMemory(["ask", "what is the database password?", "--root", root, "--json"]);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        answer: string;
        citations: unknown[];
        evidence: { active: unknown[]; superseded: unknown[]; contradictory: unknown[] };
        gap_analysis: { status: string; summary: string; next_actions: string[] };
        cost: unknown;
      };

      expect(body.status).toBe("insufficient-evidence");
      expect(body.answer).toContain("Insufficient evidence");
      expect(body.citations).toEqual([]);
      expect(body.evidence.active).toEqual([]);
      expect(body.evidence.superseded).toEqual([]);
      expect(body.evidence.contradictory).toEqual([]);
      expect(body.gap_analysis).toMatchObject({
        status: "unsupported",
        summary: "Memory has no recalled evidence for this question.",
      });
      expect(body.cost).toBeNull();
    },
    TIMEOUT,
  );
});
