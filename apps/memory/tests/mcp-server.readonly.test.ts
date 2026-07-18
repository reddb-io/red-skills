import { afterEach, describe, expect, test } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  cleanupMcpServerTest,
  connect,
  pluginRoot,
  seedConfiguredStore,
  seedConflictStore,
  seedStore,
  TIMEOUT,
  type ToolResult,
} from "./mcp-server-test-helpers.js";

afterEach(cleanupMcpServerTest);

describe("MCP server over stdio", () => {
  test(
    "memory_communities exposes read-only community analytics",
    async () => {
      const client = await connect(await seedStore());
      const before = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;

      const result = (await client.callTool({
        name: "memory_communities",
        arguments: {},
      })) as ToolResult;

      const analytics = decode(result.content[0]?.text ?? "{}") as {
        schema_version: string;
        graph_hash: string;
        communities: Array<{ count: number; labels: string[]; titles: string[] }>;
        assignments: Array<{ label: string; title: string; community_id: string }>;
      };
      expect(analytics.schema_version).toBe("memory.communities.v1");
      expect(analytics.graph_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(analytics.assignments.map((item) => item.label).sort()).toEqual([
        "auth-service",
        "cache-ttl",
        "jwt-rotation",
      ]);
      expect(analytics.communities.reduce((sum, item) => sum + item.count, 0)).toBe(3);
      expect(analytics.communities.some((item) => item.titles.includes("jwt rotation"))).toBe(
        true,
      );
      expect(result.structuredContent).toMatchObject({
        operation_id: "memory.communities",
        schema_version: "memory.communities.v1",
        assignments: 3,
        nodes: 3,
        edges: 2,
      });

      const digestResult = (await client.callTool({
        name: "memory_community_digest",
        arguments: {},
      })) as ToolResult;
      const digest = decode(digestResult.content[0]?.text ?? "{}") as {
        schema_version: string;
        provider: { status: string; error?: string };
        digests: Array<{ narrative_summary: string | null }>;
      };
      expect(digest.schema_version).toBe("memory.community-digest.v1");
      expect(digest.provider).toMatchObject({
        status: "unavailable",
        error: "no AI provider configured",
      });
      expect(digest.digests.length).toBeGreaterThan(0);
      expect(digest.digests.every((item) => item.narrative_summary === null)).toBe(true);
      expect(digestResult.structuredContent).toMatchObject({
        operation_id: "memory.community-digest",
        schema_version: "memory.community-digest.v1",
        provider_status: "unavailable",
        provider_error: "no AI provider configured",
        narrative_summaries: 0,
      });

      const globalSearchResult = (await client.callTool({
        name: "memory_global_search",
        arguments: { query: "jwt cache" },
      })) as ToolResult;
      const globalSearch = decode(globalSearchResult.content[0]?.text ?? "{}") as {
        schema_version: string;
        surface: string;
        generated_from: { operation_id: string };
        evidence: unknown[];
      };
      expect(globalSearch.schema_version).toBe("memory.global-search.v1");
      expect(globalSearch.surface).toBe("memory.global-search");
      expect(globalSearch.generated_from.operation_id).toBe("memory.community-digest");
      expect(globalSearch.evidence.length).toBeGreaterThan(0);
      expect(globalSearchResult.structuredContent).toMatchObject({
        operation_id: "memory.global-search",
        schema_version: "memory.global-search.v1",
        surface: "memory.global-search",
        source_operation: "memory.community-digest",
      });

      const viewerResult = (await client.callTool({
        name: "memory_communities_viewer",
        arguments: {},
      })) as ToolResult;
      const viewer = decode(viewerResult.content[0]?.text ?? "{}") as {
        contract: { version: string; consumes: string };
        report: { schema_version: string; assignments: unknown[] };
        html: string;
      };
      expect(viewer.contract).toMatchObject({
        version: "memory.communities.viewer.v1",
        consumes: "memory.communities.v1",
      });
      expect(viewer.report.schema_version).toBe("memory.communities.v1");
      expect(viewer.report.assignments).toHaveLength(3);
      expect(viewer.html).toContain("Graph Communities");
      expect(viewer.html).toContain('id="communities-data"');
      expect(viewerResult.structuredContent).toMatchObject({
        operation_id: "memory.communities-viewer",
        contract: "memory.communities.viewer.v1",
        consumes: "memory.communities.v1",
        assignments: 3,
      });

      const after = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;
      expect(after.structuredContent).toEqual(before.structuredContent);
    },
    TIMEOUT,
  );


  test(
    "memory_hook_coverage exposes read-only runner manifest and config coverage",
    async () => {
      const seeded = await seedConfiguredStore();
      const client = await connect(seeded.uri, {
        MEMORY_ROOT: seeded.root,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CODEX_PLUGIN_ROOT: pluginRoot,
      });

      const result = (await client.callTool({
        name: "memory_hook_coverage",
        arguments: {},
      })) as ToolResult;

      const coverage = decode(result.content[0]?.text ?? "{}") as {
        schema_version: string;
        mode: string;
        hooks_enabled: string[];
        runners: Array<{ runner: string; coverage: { enabled: number }; gaps: string[] }>;
      };
      expect(coverage.schema_version).toBe("memory.hook_coverage.v1");
      expect(coverage.mode).toBe("graph");
      expect(coverage.hooks_enabled).toEqual([
        "sessionStart",
        "postToolUse",
        "stop",
        "preCompact",
      ]);
      expect(coverage.runners.find((runner) => runner.runner === "claude")?.coverage.enabled).toBe(4);
      expect(coverage.runners.find((runner) => runner.runner === "codex")?.coverage.enabled).toBe(3);
      expect(coverage.runners.find((runner) => runner.runner === "codex")?.gaps).toContain(
        "codex has no PreCompact equivalent; flush relies on Stop plus SessionStart",
      );
      expect(result.structuredContent).toMatchObject({
        operation_id: "memory.hook-coverage",
        schema_version: "memory.hook_coverage.v1",
        mode: "graph",
        config_found: true,
        enabled_events: 7,
        read_only: true,
      });

      const viewerResult = (await client.callTool({
        name: "memory_hook_coverage_viewer",
        arguments: {},
      })) as ToolResult;
      const viewer = decode(viewerResult.content[0]?.text ?? "{}") as {
        contract: { version: string };
        report: { mode: string; summary: { effective_events: number } };
        html: string;
      };
      expect(viewer.contract.version).toBe("memory.hook_coverage.viewer.v1");
      expect(viewer.report.mode).toBe("graph");
      expect(viewer.report.summary.effective_events).toBe(8);
      expect(viewer.html).toContain("Hook Coverage");
      expect(viewerResult.structuredContent).toMatchObject({
        operation_id: "memory.hook-coverage-viewer",
        contract: "memory.hook_coverage.viewer.v1",
        mode: "graph",
        effective_events: 8,
      });
    },
    TIMEOUT,
  );


  test(
    "memory_recall returns ranked nodes + neighborhood context",
    async () => {
      const client = await connect(await seedStore());
      const result = (await client.callTool({
        name: "memory_recall",
        arguments: { query: "rotate 90 days", depth: 1 },
      })) as ToolResult;

      const md = result.content[0]?.text ?? "";
      expect(() => decode(md)).not.toThrow();
      expect(md).toContain("jwt-rotation");

      const nodes = result.structuredContent?.nodes as { label: string; score: number }[];
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes[0].label).toBe("jwt-rotation");
      // auth-service surfaces as a one-hop neighbor of the jwt seed.
      expect(nodes.some((n) => n.label === "auth-service")).toBe(true);
      expect(result.structuredContent?.diagnostics).toMatchObject({
        vector: { status: "unavailable" },
      });
    },
    TIMEOUT,
  );


  test(
    "memory_map_context returns a compact graph slice for code-agent routing",
    async () => {
      const client = await connect(await seedStore());
      const result = (await client.callTool({
        name: "memory_map_context",
        arguments: { query: "jwt rotation references", depth: 1, context: "reference" },
      })) as ToolResult;

      const slice = decode(result.content[0]?.text ?? "{}") as {
        schema_version: string;
        context_md: string;
        nodes: Array<{ label: string; source: string | null }>;
        edges: Array<{ label: string; weight: number; salience: number }>;
        diagnostics: { selected_nodes: number; selected_edges: number };
      };
      expect(slice.schema_version).toBe("memory.map_context.v1");
      expect(slice.context_md).toContain("NODE");
      expect(slice.context_md).toContain("EDGE");
      expect(slice.nodes.some((node) => node.label === "jwt-rotation")).toBe(true);
      expect(slice.edges.some((edge) => edge.weight === 2 && edge.salience === 2)).toBe(true);
      expect(result.structuredContent).toMatchObject({
        operation_id: "memory.map-context",
        schema_version: "memory.map_context.v1",
        query: "jwt rotation references",
        mode: "bfs",
        depth: 1,
        nodes: slice.diagnostics.selected_nodes,
        edges: slice.diagnostics.selected_edges,
      });
    },
    TIMEOUT,
  );


  test(
    "traverse and path return correct results over the seed graph",
    async () => {
      const client = await connect(await seedStore());

      const traverseRes = (await client.callTool({
        name: "memory_traverse",
        arguments: { start: "auth-service", depth: 3, direction: "outgoing" },
      })) as ToolResult;
      const walked = decode(traverseRes.content[0]?.text ?? "{}") as {
        rows: Array<{ label: string }>;
      };
      expect(walked.rows.map((n) => n.label)).toEqual([
        "auth-service",
        "jwt-rotation",
        "cache-ttl",
      ]);

      const pathRes = (await client.callTool({
        name: "memory_path",
        arguments: { from: "auth-service", to: "cache-ttl" },
      })) as ToolResult;
      const path = decode(pathRes.content[0]?.text ?? "{}") as {
        result: {
          reachable: boolean;
          hopCount: number;
        };
      };
      expect(path.result.reachable).toBe(true);
      expect(path.result.hopCount).toBe(2);
    },
    TIMEOUT,
  );


  test(
    "memory_conflicts and memory_timeline expose read-only supersession audit views",
    async () => {
      const client = await connect(await seedConflictStore());

      const conflictsRes = (await client.callTool({
        name: "memory_conflicts",
        arguments: {},
      })) as ToolResult;
      const conflicts = decode(conflictsRes.content[0]?.text ?? "{}") as {
        conflicts: Array<{
          from: { label: string };
          to: { label: string };
        }>;
      };
      expect(conflicts.conflicts).toHaveLength(1);
      expect(conflicts.conflicts[0].from.label).toBe("deploy-friday");
      expect(conflicts.conflicts[0].to.label).toBe("deploy-tuesday");
      expect(conflictsRes.structuredContent?.count).toBe(1);

      const timelineRes = (await client.callTool({
        name: "memory_timeline",
        arguments: { topic: "deploy" },
      })) as ToolResult;
      const timeline = decode(timelineRes.content[0]?.text ?? "{}") as {
        entries: Array<{ label: string; status: string }>;
        auditLinks: Array<{ label: string }>;
      };
      expect(timeline.entries.some((entry) => entry.label === "deploy-friday")).toBe(true);
      expect(timeline.auditLinks.some((edge) => edge.label === "CONTRADICTS")).toBe(true);
      expect(timelineRes.structuredContent?.audit_links).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );


  test(
    "memory_ask reports citations and cost metadata",
    async () => {
      const client = await connect(await seedStore());
      const result = (await client.callTool({
        name: "memory_ask",
        arguments: { question: "how often do jwt tokens rotate?" },
      })) as ToolResult;

      const answer = decode(result.content[0]?.text ?? "{}") as {
        status: string;
        citations: unknown[];
        evidence: { active: unknown[] };
        gap_analysis: { status: string };
        cost: unknown;
      };
      expect(answer.status).toBe("provider-unavailable");
      expect(Array.isArray(answer.citations)).toBe(true);
      expect(answer.evidence.active.length).toBeGreaterThan(0);
      expect(answer.gap_analysis.status).toBeTruthy();
      expect(answer).toHaveProperty("cost");
      expect(result.structuredContent).toHaveProperty("status");
      expect(result.structuredContent).toHaveProperty("citations");
      expect(result.structuredContent).toHaveProperty("active_evidence");
      expect(result.structuredContent).toHaveProperty("ambiguous_evidence");
      expect(result.structuredContent).toHaveProperty("gap_status");
      expect(result.structuredContent).toHaveProperty("gaps");
      expect(result.structuredContent).toHaveProperty("cost_usd");
    },
    TIMEOUT,
  );

});
