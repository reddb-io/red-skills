import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildMemoryAgentIntegrationStatus } from "../src/agent-integration-status.js";
import { buildMemoryAgentIntegrationStatusViewerArtifact } from "../src/agent-integration-status-viewer.js";
import { initGraph } from "../src/init.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-agent-integration-status-"));
  roots.push(root);
  return root;
}

describe("Memory agent integration status", () => {
  test("audits routing snippets and hook coverage without mutating", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    await writeFile(
      join(root, "AGENTS.md"),
      "## Memory Routing\n\nUse `memory-mcp` and `memory_context_pack` before large work.\n",
      "utf8",
    );

    const report = await buildMemoryAgentIntegrationStatus(root, {
      agent: "codex",
      now: 1_700_000_000_000,
    });

    expect(report).toMatchObject({
      schema_version: "memory.agent_integration_status.v1",
      read_only: true,
      mode: "graph",
      summary: { agents: 1, ready: 1, partial: 0, missing: 0 },
      sources: {
        routing_guide: "memory.routing_guide.v1",
        hook_coverage: "memory.hook_coverage.v1",
      },
    });
    expect(report.agents[0]).toMatchObject({
      agent: "codex",
      state: "ready",
      target_files: [
        {
          path: "AGENTS.md",
          exists: true,
          contains_memory_routing: true,
        },
      ],
      hook_coverage: {
        supported: true,
        effective_events: expect.any(Number),
      },
    });

    const artifact = buildMemoryAgentIntegrationStatusViewerArtifact(report);
    expect(artifact.contract).toEqual({
      version: "memory.agent_integration_status.viewer.v1",
      consumes: "memory.agent_integration_status.v1",
    });
    expect(artifact.html).toContain("Memory Agent Integration Status");
    expect(artifact.html).toContain('id="memory-agent-integration-status-data"');
  });

  test("reports missing MCP-first agent rule files", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".cursor"), { recursive: true });

    const report = await buildMemoryAgentIntegrationStatus(root, { agent: "cursor" });

    expect(report.summary).toMatchObject({ agents: 1, ready: 0, missing: 1 });
    expect(report.agents[0]).toMatchObject({
      agent: "cursor",
      state: "missing",
      target_files: [
        {
          path: ".cursor/rules/memory.md",
          exists: false,
          contains_memory_routing: false,
        },
      ],
    });
    expect(report.recommended_next_actions[0]).toContain("memory routing-guide --agent cursor");
  });

  test("CLI writes the integration status viewer", async () => {
    const root = await tempRoot();
    const out = join(root, "integration.html");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "integration-status-viewer", "--root", root, "--out", out],
      {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("memory: agent integration status viewer written");
    const html = await readFile(out, "utf8");
    expect(html).toContain("Memory Agent Integration Status");
  });
});
