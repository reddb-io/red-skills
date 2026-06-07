import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildMemoryRoutingGuide } from "../src/routing-guide.js";
import { buildMemoryRoutingGuideViewerArtifact } from "../src/routing-guide-viewer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("Memory routing guide", () => {
  test("builds an agent-rule snippet for Codex", () => {
    const guide = buildMemoryRoutingGuide({ agent: "codex" });

    expect(guide).toMatchObject({
      schemaVersion: "memory.routing_guide.v1",
      agent: "codex",
      supportedAgents: expect.arrayContaining(["cursor", "gemini", "aider", "opencode"]),
      integration: {
        displayName: "Codex CLI",
        transports: expect.arrayContaining(["mcp", "hooks", "http"]),
      },
      targetFiles: ["AGENTS.md"],
    });
    expect(guide.mcpTools).toEqual(expect.arrayContaining(["memory_context_pack"]));
    expect(guide.mcpTools).toEqual(expect.arrayContaining(["memory_doc_read"]));
    expect(guide.mcpTools).toEqual(expect.arrayContaining(["memory_pre_pr_review"]));
    expect(guide.mcpTools).toEqual(expect.arrayContaining(["memory_onboarding_map"]));
    expect(guide.mapContext).toMatchObject({
      kind: "agent_context",
      relationFilters: expect.arrayContaining([
        "call",
        "import",
        "type",
        "validation",
        "decision",
        "work",
        "reference",
      ]),
    });
    expect(guide.mapContext.description).toContain("before broad grep");
    expect(guide.mapContext.description).toContain("not a generated answer");
    expect(guide.mapContext.examples.map((example) => example.relationFilters.join(","))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("call"),
        expect.stringContaining("validation"),
        expect.stringContaining("decision"),
        expect.stringContaining("work"),
        expect.stringContaining("reference"),
      ]),
    );
    expect(guide.rules.map((rule) => rule.call)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("memory_claim_check"),
        expect.stringContaining("memory_structural_impact"),
        expect.stringContaining("memory_map_context"),
        expect.stringContaining("route Personal facts and human-facing context to Brain"),
      ]),
    );
    expect(guide.safetyNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Map context is agent context"),
        expect.stringContaining("Personal facts, human-facing context"),
        expect.stringContaining("belong in Brain, not Memory"),
      ]),
    );
    expect(guide.installSnippet).toContain("## Memory Routing");
    expect(guide.installSnippet).toContain("MCP server command");
    expect(guide.installSnippet).toContain("Map context before broad source reads");
    expect(guide.installSnippet).toContain("Relation filters to apply");
    expect(guide.installSnippet).toContain("Target file: AGENTS.md");
    expect(guide.installSnippet).toContain("route Personal facts and human-facing context to Brain");
  });

  test("builds multi-agent integration metadata for MCP-first agents", () => {
    const guide = buildMemoryRoutingGuide({ agent: "cursor" });

    expect(guide).toMatchObject({
      agent: "cursor",
      targetFiles: [".cursor/rules/memory.md"],
      integration: {
        displayName: "Cursor",
        transports: ["agent-rules", "mcp", "http"],
      },
    });
    expect(guide.integration.configSnippets.map((snippet) => snippet.label)).toEqual(
      expect.arrayContaining(["MCP stdio server", "Loopback HTTP API"]),
    );
    expect(guide.integration.configSnippets[0]?.body).toContain("memory-mcp");
    expect(guide.integration.connectCommands).toEqual(
      expect.arrayContaining(["memory-mcp", "memory serve"]),
    );
  });

  test("builds a self-contained routing guide viewer", () => {
    const guide = buildMemoryRoutingGuide({ agent: "cursor" });
    const artifact = buildMemoryRoutingGuideViewerArtifact(guide);

    expect(artifact).toMatchObject({
      name: "memory.routing_guide.viewer",
      contract: {
        version: "memory.routing_guide.viewer.v1",
        consumes: "memory.routing_guide.v1",
      },
      guide: {
        agent: "cursor",
      },
    });
    expect(artifact.html).toContain("Memory Routing Guide");
    expect(artifact.html).toContain("Cursor");
    expect(artifact.html).toContain('id="memory-routing-guide-data"');
    expect(artifact.html).toContain("memory_context_pack");
    expect(artifact.html).toContain("Map Context");
    expect(artifact.html).toContain("agent_context");
    expect(artifact.html).toContain("call, import, type, validation");
  });

  test("CLI emits JSON, installable text, and viewer HTML without requiring a store", async () => {
    const json = runMemory(["routing-guide", "--agent", "gemini", "--json"]);
    expect(json.status, json.stderr).toBe(0);
    const body = JSON.parse(json.stdout) as {
      schemaVersion: string;
      targetFiles: string[];
      supportedAgents: string[];
      integration: { transports: string[]; configSnippets: Array<{ body: string }> };
      mapContext: { kind: string; relationFilters: string[]; description: string };
      installSnippet: string;
    };
    expect(body.schemaVersion).toBe("memory.routing_guide.v1");
    expect(body.targetFiles).toEqual(["GEMINI.md"]);
    expect(body.supportedAgents).toContain("cursor");
    expect(body.integration.transports).toContain("mcp");
    expect(body.integration.configSnippets[0]?.body).toContain("memory-mcp");
    expect(body.mapContext.kind).toBe("agent_context");
    expect(body.mapContext.relationFilters).toEqual(
      expect.arrayContaining([
        "call",
        "import",
        "type",
        "validation",
        "decision",
        "work",
        "reference",
      ]),
    );
    expect(body.mapContext.description).toContain("not a generated answer");
    expect(body.installSnippet).toContain("memory_map_context");
    expect(body.installSnippet).toContain("memory_pre_pr_review");

    const text = runMemory(["routing-guide", "--agent", "codex"]);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("memory: routing guide");
    expect(text.stdout).toContain("before broad grep");
    expect(text.stdout).toContain("filters=work, validation, decision, reference");
    expect(text.stdout).toContain("Target file: AGENTS.md");
    expect(text.stdout).toContain("memory_map_context");

    const root = await mkdtemp(join(tmpdir(), "memory-routing-guide-"));
    roots.push(root);
    const out = join(root, "routing.html");
    const viewer = runMemory(["routing-guide-viewer", "--agent", "opencode", "--out", out]);
    expect(viewer.status, viewer.stderr).toBe(0);
    expect(viewer.stdout).toContain("memory: routing guide viewer written");
    const html = await readFile(out, "utf8");
    expect(html).toContain("Memory Routing Guide");
    expect(html).toContain("opencode");
    expect(html).toContain("memory-routing-guide-data");
  });
});
