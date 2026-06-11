import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildHookCoverageReport } from "../src/hook-coverage.js";
import { buildHookCoverageViewerArtifact } from "../src/hook-coverage-viewer.js";
import { initGraph, initMarkdownOnly } from "../src/init.js";

const TIMEOUT = 30_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempRoot(prefix = "memory-hook-coverage-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("hook coverage", () => {
  test("reports runner hook wiring and effective Codex PreCompact fallback coverage", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });

    const report = await buildHookCoverageReport(root);

    expect(report).toMatchObject({
      schema_version: "memory.hook_coverage.v1",
      read_only: true,
      config_found: true,
      mode: "graph",
      hooks_enabled: ["sessionStart", "postToolUse", "stop", "preCompact"],
      summary: {
        runner_count: 2,
        total_events: 8,
        wired_events: 7,
        enabled_events: 7,
        effective_events: 8,
        actionable_gaps: 0,
      },
    });
    expect(report.runners.find((runner) => runner.runner === "claude")).toMatchObject({
      manifest_found: true,
      coverage: { wired: 4, enabled: 4, total: 4 },
    });
    expect(report.runners.find((runner) => runner.runner === "codex")).toMatchObject({
      manifest_found: true,
      coverage: { wired: 3, enabled: 3, effective: 4, total: 4 },
    });
    expect(
      report.runners
        .find((runner) => runner.runner === "codex")
        ?.events.find((event) => event.event === "PreCompact"),
    ).toMatchObject({
      supported: false,
      wired: false,
      enabled: false,
      effectively_covered: true,
      notes: expect.arrayContaining([
        "runner has no PreCompact hook surface",
        "effectively covered by Stop flush plus SessionStart recall",
      ]),
    });
    expect(report.gaps).toContain(
      "codex has no PreCompact equivalent; flush relies on Stop plus SessionStart",
    );
    expect(report.actionable_gaps).toEqual([]);
    expect(report.recommended_next_actions).toEqual(["hook coverage is ready; no action required"]);
  });

  test("explains that markdown-only mode disables hooks", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);

    const report = await buildHookCoverageReport(root);

    expect(report.mode).toBe("markdown-only");
    expect(report.summary.enabled_events).toBe(0);
    expect(report.gaps).toContain("markdown-only mode disables auto-firing hooks");
    expect(report.recommended_next_actions).toContain(
      "switch to graph mode before enabling auto-firing hooks",
    );
  });

  test("builds a self-contained hook coverage viewer artifact", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });

    const artifact = buildHookCoverageViewerArtifact(await buildHookCoverageReport(root));

    expect(artifact.contract).toEqual({
      name: "memory.hook_coverage.viewer",
      version: "memory.hook_coverage.viewer.v1",
      consumes: "memory.hook_coverage.v1",
    });
    expect(artifact.html).toContain("Hook Coverage");
    expect(artifact.html).toContain("claude");
    expect(artifact.html).toContain("codex");
    expect(artifact.html).toContain("PreCompact");
    expect(artifact.html).toContain('id="hook-coverage-data"');
    expect(artifact.html).not.toContain("<script src=");
  });

  test(
    "CLI prints JSON hook coverage without mutating the project",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });

      const result = runMemory(["hooks", "coverage", "--root", root, "--json"]);
      expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      schema_version: string;
      summary: { enabled_events: number; effective_events: number; actionable_gaps: number };
      actionable_gaps: string[];
      runners: Array<{ runner: string; events: Array<{ event: string; enabled: boolean; effectively_covered: boolean }> }>;
    };
    expect(body.schema_version).toBe("memory.hook_coverage.v1");
    expect(body.summary.enabled_events).toBe(7);
    expect(body.summary.effective_events).toBe(8);
    expect(body.summary.actionable_gaps).toBe(0);
    expect(body.actionable_gaps).toEqual([]);
    expect(body.runners.find((runner) => runner.runner === "codex")?.events).toContainEqual(
        expect.objectContaining({ event: "PreCompact", enabled: false, effectively_covered: true }),
      );
    },
    TIMEOUT,
  );

  test(
    "CLI writes hook coverage viewer HTML without mutating Memory",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });
      const out = join(root, "hook-coverage.html");

      const result = runMemory(["hooks", "coverage-viewer", "--root", root, "--out", out]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: hook coverage viewer written");
      expect(result.stdout).toContain("contract: memory.hook_coverage.v1");
      await expect(readFile(out, "utf8")).resolves.toContain("Hook Coverage");
    },
    TIMEOUT,
  );
});
