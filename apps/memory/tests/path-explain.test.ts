import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildPathExplainReport } from "../src/path-explain.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-path-explain-"));
  roots.push(root);
  return root;
}

async function seedStore(root: string): Promise<MemoryStore> {
  await initGraph(root);
  const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
  const auth = await store.upsertNode({
    label: "auth-service",
    node_type: "concept",
    properties: { title: "Auth service", content: "Auth service issues JWT tokens." },
  });
  const jwt = await store.upsertNode({
    label: "jwt-rotation",
    node_type: "decision",
    properties: { title: "JWT rotation", content: "JWT tokens rotate every 90 days." },
  });
  const cache = await store.upsertNode({
    label: "cache-ttl",
    node_type: "problem",
    properties: { title: "Cache TTL", content: "Cache TTL can outlive rotated tokens." },
  });
  await store.upsertEdge({ from_rid: auth, to_rid: jwt, label: "REFERENCES" });
  await store.upsertEdge({ from_rid: jwt, to_rid: cache, label: "CAUSES" });
  return store;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory path explanation", () => {
  test("explains a directed graph path with edge labels and markdown", async () => {
    const root = await tempRoot();
    const store = await seedStore(root);
    try {
      const report = await buildPathExplainReport(store, {
        from: "auth-service",
        to: "cache-ttl",
      });

      expect(report).toMatchObject({
        schema_version: "memory.path_explain.v1",
        read_only: true,
        reachable: true,
        hop_count: 2,
        path: [
          { label: "auth-service" },
          { label: "jwt-rotation" },
          { label: "cache-ttl" },
        ],
        edges: [{ label: "REFERENCES" }, { label: "CAUSES" }],
      });
      expect(report.markdown).toContain("Auth service");
      expect(report.markdown).toContain("--REFERENCES-->");
      expect(report.markdown).toContain("--CAUSES-->");
    } finally {
      await store.close();
    }
  });

  test(
    "CLI emits JSON path explanations",
    async () => {
      const root = await tempRoot();
      const store = await seedStore(root);
      await store.close();

      const result = runMemory([
        "path-explain",
        "auth-service",
        "cache-ttl",
        "--root",
        root,
        "--json",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as {
        schema_version: string;
        reachable: boolean;
        hop_count: number;
        markdown: string;
      };
      expect(report.schema_version).toBe("memory.path_explain.v1");
      expect(report.reachable).toBe(true);
      expect(report.hop_count).toBe(2);
      expect(report.markdown).toContain("Memory path explanation");
    },
    TIMEOUT,
  );
});
