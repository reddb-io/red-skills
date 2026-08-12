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

describe("RSP required CI gates (#3625)", () => {
  it("builds and exercises the distributable before required unit and integration checks", async () => {
    const source = await workflow("red-workspace-ci.yml");
    const rsp = jobBody(source, "rsp");

    expect(rsp).toContain("needs: scope");
    expect(rsp).toContain("contains(fromJSON(needs.scope.outputs.test_packages), 'apps/rsp')");
    expect(rsp).not.toMatch(/^ {4}if:/m);

    const build = rsp.indexOf("run: pnpm -C apps/rsp build");
    const exercise = rsp.indexOf("run: node dist/rsp.bundle.min.mjs --help");
    const unit = rsp.indexOf("run: pnpm -C apps/rsp test");
    const integration = rsp.indexOf("run: pnpm -C apps/rsp test:integration");

    expect(build, "missing distributable build").toBeGreaterThanOrEqual(0);
    expect(exercise, "missing distributable smoke exercise").toBeGreaterThan(build);
    expect(unit, "missing unit/fidelity gate").toBeGreaterThan(exercise);
    expect(integration, "missing integration gate").toBeGreaterThan(unit);
    expect(rsp).toContain("NODE_OPTIONS: --unhandled-rejections=strict");

    const aggregate = jobBody(source, "test");
    expect(aggregate).toMatch(/needs:\s*\[[^\]]*rsp[^\]]*\]/);
    expect(aggregate).toContain("rsp=${{ needs.rsp.result }}");
  });

  it("keeps unhandled integration errors fatal at the Vitest boundary", async () => {
    const config = await readFile(join(repoRoot, "apps", "rsp", "vitest.integration.config.ts"), "utf8");
    expect(config).toContain("dangerouslyIgnoreUnhandledErrors: false");
  });

  it("runs the deterministic two-axis check only for the RSP surface", async () => {
    const source = await workflow("red-rsp-benchmark-ci.yml");
    const trigger = source.slice(0, source.indexOf("\njobs:"));

    expect(trigger).toContain("- apps/rsp/**");
    expect(trigger).toContain("- .github/workflows/red-rsp-benchmark-ci.yml");
    expect(trigger).not.toContain("- apps/**");
    expect(trigger).not.toContain("- packages/**");
    expect(trigger).not.toContain("- pnpm-lock.yaml");
    expect(source).toContain("run: pnpm -C apps/rsp bench:two-axis:check");
    expect(source).toContain(
      "run: git diff --exit-code -- apps/rsp/bench/results/rsp-two-axis.toon apps/rsp/bench/results/rsp-two-axis.md",
    );
  });
});
