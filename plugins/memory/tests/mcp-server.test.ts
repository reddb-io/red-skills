import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import {
  getReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
} from "../src/operations.js";

// Spawning tsx + booting RedDB twice (seed, then server) is slow; be generous.
const TIMEOUT = 40_000;

const pkgRoot = resolve(__dirname, "..");
const tsx = join(pkgRoot, "node_modules", ".bin", "tsx");
const serverEntry = join(pkgRoot, "src", "mcp-server.ts");

const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Seed a graph in a fresh store, close it, and return its file:// URI so the
 *  server can reopen the same store (file:// is single-writer). */
async function seedStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-mcp-"));
  roots.push(dir);
  const uri = `file://${join(dir, "graph.rdb")}`;
  const store = await MemoryStore.open({ uri, project: "test" });
  try {
    const auth = await store.upsertNode({
      label: "auth-service",
      node_type: "concept",
      properties: { title: "auth service", content: "the auth service issues jwt tokens" },
    });
    const jwt = await store.upsertNode({
      label: "jwt-rotation",
      node_type: "concept",
      properties: { title: "jwt rotation", content: "jwt tokens rotate every 90 days" },
    });
    const cache = await store.upsertNode({
      label: "cache-ttl",
      node_type: "concept",
      properties: { title: "cache ttl", content: "redis cache ttl is 300 seconds" },
    });
    await store.upsertEdge({ label: "REFERENCES", from_rid: auth, to_rid: jwt });
    await store.upsertEdge({ label: "REFERENCES", from_rid: jwt, to_rid: cache });
  } finally {
    await store.close();
  }
  return uri;
}

async function seedConflictStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-mcp-conflict-"));
  roots.push(dir);
  const uri = `file://${join(dir, "graph.rdb")}`;
  const store = await MemoryStore.open({ uri, project: "test" });
  try {
    const oldRid = await store.upsertNode({
      label: "deploy-friday",
      node_type: "decision",
      properties: { title: "deploy friday", content: "deploys happen friday" },
    });
    const newRid = await store.upsertNode({
      label: "deploy-tuesday",
      node_type: "decision",
      properties: { title: "deploy tuesday", content: "deploys happen tuesday" },
    });
    await store.upsertEdge({
      label: "CONTRADICTS",
      from_rid: oldRid,
      to_rid: newRid,
      properties: { reason: "date changed" },
    });
  } finally {
    await store.close();
  }
  return uri;
}

async function connect(uri: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: tsx,
    args: [serverEntry],
    cwd: pkgRoot,
    env: { ...process.env, RED_MEMORY_URI: uri } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  clients.push(client);
  await client.connect(transport);
  return client;
}

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

describe("MCP server over stdio", () => {
  test(
    "lists the full tool surface",
    async () => {
      const client = await connect(await seedStore());
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "memory_ask",
          "memory_claim_check",
          "memory_conflicts",
          "memory_communities",
          "memory_context_pack",
          "memory_doctor",
          "memory_export",
          "memory_health",
          "memory_learning_debt",
          "memory_lint",
          "memory_neighbors",
          "memory_path",
          "memory_privacy_scan",
          "memory_provenance",
          "memory_readiness",
          "memory_recall",
          "memory_search",
          "memory_skill_recommendations",
          "memory_stats",
          "memory_store",
          "memory_supersede",
          "memory_timeline",
          "memory_traverse",
        ].sort(),
      );
      const recallTool = tools.find((t) => t.name === "memory_recall");
      expect(JSON.stringify(recallTool?.inputSchema)).toContain("as_of");
      expect(names).not.toContain("memory_commit");
      const communities = tools.find((tool) => tool.name === "memory_communities");
      expect(communities?.description).toBe(
        getReadOnlyMemoryOperation("memory.communities").renderer.mcp.description,
      );
      for (const operation of listReadOnlyMemoryOperations()) {
        const tool = tools.find((item) => item.name === operation.renderer.mcp.toolName);
        expect(tool?.description).toBe(operation.renderer.mcp.description);
        expect(tool?.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
      }
      const storeTool = tools.find((tool) => tool.name === "memory_store");
      const supersedeTool = tools.find((tool) => tool.name === "memory_supersede");
      expect(storeTool?.description?.toLowerCase()).toContain("mutating");
      expect(supersedeTool?.description?.toLowerCase()).toContain("mutating");
    },
    TIMEOUT,
  );

  test(
    "registry-backed readiness and trust tools return representative read-only outputs",
    async () => {
      const client = await connect(await seedStore());
      const before = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;

      const readinessRes = (await client.callTool({
        name: "memory_readiness",
        arguments: { goal: "jwt rotation", min_evidence: 1 },
      })) as ToolResult;
      const readiness = JSON.parse(readinessRes.content[0]?.text ?? "{}") as {
        contract: { version: string };
        request: { goal: string };
      };
      expect(readiness.contract.version).toBe("memory.readiness.v1");
      expect(readiness.request.goal).toBe("jwt rotation");
      expect(readinessRes.structuredContent).toMatchObject({
        operation_id: "memory.readiness",
        contract_version: "memory.readiness.v1",
      });

      const claimRes = (await client.callTool({
        name: "memory_claim_check",
        arguments: { assertion: "jwt tokens rotate every 90 days" },
      })) as ToolResult;
      const claim = JSON.parse(claimRes.content[0]?.text ?? "{}") as { status: string };
      expect(claim.status).toBe("supported");
      expect(claimRes.structuredContent).toMatchObject({
        operation_id: "memory.claim-check",
        status: "supported",
      });

      const contextPackRes = (await client.callTool({
        name: "memory_context_pack",
        arguments: { goal: "jwt rotation", budget_chars: 2_000 },
      })) as ToolResult;
      const contextPack = JSON.parse(contextPackRes.content[0]?.text ?? "{}") as {
        markdown: string;
        entries: unknown[];
      };
      expect(contextPack.markdown).toContain("Memory context pack");
      expect(contextPack.entries.length).toBeGreaterThan(0);

      const provenanceRes = (await client.callTool({
        name: "memory_provenance",
        arguments: { target: "jwt-rotation" },
      })) as ToolResult;
      const provenance = JSON.parse(provenanceRes.content[0]?.text ?? "{}") as {
        node: { label: string };
        provenance: { missing: boolean };
      };
      expect(provenance.node.label).toBe("jwt-rotation");
      expect(provenance.provenance.missing).toBe(true);

      const privacyRes = (await client.callTool({
        name: "memory_privacy_scan",
        arguments: {},
      })) as ToolResult;
      expect(JSON.parse(privacyRes.content[0]?.text ?? "{}")).toMatchObject({
        readOnly: true,
        mutated: false,
        mode: "graph",
      });

      const lintRes = (await client.callTool({
        name: "memory_lint",
        arguments: {},
      })) as ToolResult;
      expect(JSON.parse(lintRes.content[0]?.text ?? "{}")).toMatchObject({
        readOnly: true,
        mode: "graph",
        totalMemories: 3,
      });

      const recommendationsRes = (await client.callTool({
        name: "memory_skill_recommendations",
        arguments: { task: "jwt rotation", limit: 3 },
      })) as ToolResult;
      expect(JSON.parse(recommendationsRes.content[0]?.text ?? "{}")).toHaveProperty(
        "recommendations",
      );

      const learningDebtRes = (await client.callTool({
        name: "memory_learning_debt",
        arguments: {},
      })) as ToolResult;
      expect(JSON.parse(learningDebtRes.content[0]?.text ?? "{}")).toHaveProperty("summary");

      const healthRes = (await client.callTool({
        name: "memory_health",
        arguments: {},
      })) as ToolResult;
      expect(JSON.parse(healthRes.content[0]?.text ?? "{}")).toMatchObject({
        read_only: true,
        stats: { nodes: 3, edges: 2 },
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

      const analytics = JSON.parse(result.content[0]?.text ?? "{}") as {
        graph_hash: string;
        communities: Array<{ count: number; labels: string[]; titles: string[] }>;
        assignments: Array<{ label: string; title: string; community_id: string }>;
      };
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
        assignments: 3,
        nodes: 3,
        edges: 2,
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
    "memory_recall returns ranked nodes + neighborhood context",
    async () => {
      const client = await connect(await seedStore());
      const result = (await client.callTool({
        name: "memory_recall",
        arguments: { query: "rotate 90 days", depth: 1 },
      })) as ToolResult;

      const md = result.content[0]?.text ?? "";
      expect(md).toContain("Memory recall");
      expect(md).toContain("jwt rotation");

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
    "traverse and path return correct results over the seed graph",
    async () => {
      const client = await connect(await seedStore());

      const traverseRes = (await client.callTool({
        name: "memory_traverse",
        arguments: { start: "auth-service", depth: 3, direction: "outgoing" },
      })) as ToolResult;
      const walked = JSON.parse(traverseRes.content[0]?.text ?? "[]") as { label: string }[];
      expect(walked.map((n) => n.label)).toEqual([
        "auth-service",
        "jwt-rotation",
        "cache-ttl",
      ]);

      const pathRes = (await client.callTool({
        name: "memory_path",
        arguments: { from: "auth-service", to: "cache-ttl" },
      })) as ToolResult;
      const path = JSON.parse(pathRes.content[0]?.text ?? "null") as {
        reachable: boolean;
        hopCount: number;
      };
      expect(path.reachable).toBe(true);
      expect(path.hopCount).toBe(2);
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
      const conflicts = JSON.parse(conflictsRes.content[0]?.text ?? "[]") as Array<{
        from: { label: string };
        to: { label: string };
      }>;
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].from.label).toBe("deploy-friday");
      expect(conflicts[0].to.label).toBe("deploy-tuesday");
      expect(conflictsRes.structuredContent?.count).toBe(1);

      const timelineRes = (await client.callTool({
        name: "memory_timeline",
        arguments: { topic: "deploy" },
      })) as ToolResult;
      const timeline = JSON.parse(timelineRes.content[0]?.text ?? "{}") as {
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

      const answer = JSON.parse(result.content[0]?.text ?? "{}") as {
        status: string;
        citations: unknown[];
        evidence: { active: unknown[] };
        cost: unknown;
      };
      expect(answer.status).toBe("provider-unavailable");
      expect(Array.isArray(answer.citations)).toBe(true);
      expect(answer.evidence.active.length).toBeGreaterThan(0);
      expect(answer).toHaveProperty("cost");
      expect(result.structuredContent).toHaveProperty("status");
      expect(result.structuredContent).toHaveProperty("citations");
      expect(result.structuredContent).toHaveProperty("active_evidence");
      expect(result.structuredContent).toHaveProperty("ambiguous_evidence");
      expect(result.structuredContent).toHaveProperty("cost_usd");
    },
    TIMEOUT,
  );
});
