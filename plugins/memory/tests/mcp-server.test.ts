import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";

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
          "memory_export",
          "memory_neighbors",
          "memory_path",
          "memory_recall",
          "memory_search",
          "memory_stats",
          "memory_store",
          "memory_supersede",
          "memory_traverse",
        ].sort(),
      );
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
});
