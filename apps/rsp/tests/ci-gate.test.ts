import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

async function workflow(name: string): Promise<string> {
  return readFile(join(repoRoot, ".github", "workflows", name), "utf8");
}

function jobBody(source: string, name: string): string {
  const marker = `\n  ${name}:`;
  const start = source.indexOf(marker);
  expect(start, `missing workflow job: ${name}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("RSP CI posture", () => {
  it("does not make RSP build, unit, or integration checks merge requirements", async () => {
    const source = await workflow("red-workspace-ci.yml");
    expect(source).not.toMatch(/^  rsp:/m);
    expect(source).not.toContain("run: pnpm -C apps/rsp test");
    expect(source).not.toContain("run: pnpm -C apps/rsp test:integration");

    const aggregate = jobBody(source, "test");
    expect(aggregate).not.toMatch(/needs:\s*\[[^\]]*rsp[^\]]*\]/);
    expect(aggregate).not.toContain("rsp=${{ needs.rsp.result }}");
  });

  it("keeps unhandled integration errors fatal at the Vitest boundary", async () => {
    const config = await readFile(join(repoRoot, "apps", "rsp", "vitest.integration.config.ts"), "utf8");
    expect(config).toContain("dangerouslyIgnoreUnhandledErrors: false");
  });

  it("keeps the deterministic two-axis check manual-only", async () => {
    const source = await workflow("red-rsp-benchmark-ci.yml");
    const trigger = source.slice(0, source.indexOf("\njobs:"));

    expect(trigger).toContain("workflow_dispatch:");
    expect(trigger).not.toContain("pull_request:");
    expect(trigger).not.toContain("push:");
    expect(source).toContain("run: pnpm -C apps/rsp bench:two-axis:check");
    expect(source).toContain(
      "run: git diff --exit-code -- apps/rsp/bench/results/rsp-two-axis.toon apps/rsp/bench/results/rsp-two-axis.md",
    );
  });
});
