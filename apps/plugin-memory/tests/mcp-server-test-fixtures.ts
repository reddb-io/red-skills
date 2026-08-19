import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MemoryStore } from "../src/graph-store.js";

// Spawning tsx + booting RedDB twice (seed, then server) is slow; be generous.
export const TIMEOUT = 40_000;

const pkgRoot = resolve(__dirname, "..");
export const pluginRoot = resolve(pkgRoot, "..", "..", "plugins", "memory");
const tsx = join(pkgRoot, "node_modules", ".bin", "tsx");
const serverEntry = join(pkgRoot, "src", "mcp-server.ts");

export const roots: string[] = [];
const clients: Client[] = [];

export async function cleanupMcpServerTest(): Promise<void> {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Seed a graph in a fresh store, close it, and return its file:// URI so the
 *  server can reopen the same store (file:// is single-writer). */
export async function seedStore(): Promise<string> {
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
      properties: {
        title: "jwt rotation",
        content: "jwt tokens rotate every 90 days",
        hash: "jwt-doc",
      },
    });
    const cache = await store.upsertNode({
      label: "cache-ttl",
      node_type: "concept",
      properties: { title: "cache ttl", content: "redis cache ttl is 300 seconds" },
    });
    await store.upsertDoc({
      path: "docs/jwt.md",
      title: "JWT docs",
      body: "jwt tokens rotate every 90 days. Cache TTL details live elsewhere.",
      hash: "jwt-doc",
      updated_at: 123,
    });
    await store.upsertEdge({
      label: "REFERENCES",
      from_rid: auth,
      to_rid: jwt,
      weight: 2,
      properties: { confidence: "EXTRACTED" },
    });
    await store.upsertEdge({
      label: "REFERENCES",
      from_rid: jwt,
      to_rid: cache,
      properties: { confidence: "INFERRED" },
    });
  } finally {
    await store.close();
  }
  return uri;
}

export async function seedConfiguredStore(): Promise<{ uri: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), "memory-mcp-configured-"));
  roots.push(dir);
  const uri = `file://${join(dir, "graph.rdb")}`;
  const store = await MemoryStore.open({ uri, project: "test" });
  try {
    await store.upsertNode({
      label: "configured-memory",
      node_type: "concept",
      properties: { title: "configured memory", content: "hook coverage root" },
    });
  } finally {
    await store.close();
  }
  await mkdir(join(dir, ".red", "memory"), { recursive: true });
  await writeFile(
    join(dir, ".red", "memory", "config.json"),
    JSON.stringify(
      {
        version: 1,
        mode: "graph",
        notesDir: ".red/memory/notes",
        storePath: "graph.rdb",
        hooks: {
          sessionStart: true,
          postToolUse: true,
          stop: true,
          preCompact: true,
        },
        mcp: true,
        reddb: true,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { uri, root: dir };
}

export async function seedWritableStore(): Promise<{ uri: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), "memory-mcp-writable-"));
  roots.push(dir);
  const uri = `file://${join(dir, "graph.rdb")}`;
  const store = await MemoryStore.open({ uri, project: "test" });
  await store.close();
  return { uri, root: dir };
}

export async function seedConflictStore(): Promise<string> {
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

export async function connect(uri: string, env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: tsx,
    args: [serverEntry],
    cwd: pkgRoot,
    env: { ...process.env, RED_MEMORY_URI: uri, ...env } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  clients.push(client);
  await client.connect(transport);
  return client;
}

export interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function toolText(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}
