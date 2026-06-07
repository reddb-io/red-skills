import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { GRAPH_CONTRACT_VERSION } from "../src/graph-contract.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

/** Seed a tiny layered graph: two L3 file/import nodes and two L2 symbol nodes,
 *  with imports/defines/references edges between them. */
async function seedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-arch-overview-cli-"));
  roots.push(root);
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);

  const file = await store.upsertNode({
    label: "file:/repo/src/auth.ts",
    node_type: "file",
    properties: { title: "auth.ts", layer: "L3" },
  });
  const sym = await store.upsertNode({
    label: "sym:issueToken",
    node_type: "symbol",
    properties: { title: "issueToken", summary: "fn", layer: "L2" },
  });
  const imp = await store.upsertNode({
    label: "import:node:crypto",
    node_type: "import",
    properties: { title: "node:crypto", layer: "L3" },
  });
  const sym2 = await store.upsertNode({
    label: "sym:verifyToken",
    node_type: "symbol",
    properties: { title: "verifyToken", summary: "fn", layer: "L2" },
  });

  await store.upsertEdge({ label: "IMPORTS", from_rid: file, to_rid: imp, properties: {} });
  await store.upsertEdge({ label: "DEFINED_IN", from_rid: sym, to_rid: file, properties: {} });
  await store.upsertEdge({ label: "CALLS", from_rid: sym, to_rid: sym2, properties: {} });

  await store.close();
  stores.pop();
  return root;
}

describe("memory architecture-overview CLI", () => {
  test(
    "emits a structured overview with layer and community connection counts",
    async () => {
      const root = await seedRoot();

      const result = runMemory(["architecture-overview", "--root", root, "--json"]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        schema_version: string;
        read_only: boolean;
        generated_from: { contract_version: string };
        totals: { nodes: number; edges: number };
        layers: Array<{
          layer: string;
          nodes: number;
          internalConnections: number;
          externalConnections: number;
        }>;
        communities: Array<{ community: string; nodes: number }>;
        markdown: string;
      };

      expect(body.schema_version).toBe("memory.architecture_overview.v1");
      expect(body.read_only).toBe(true);
      expect(body.generated_from.contract_version).toBe(GRAPH_CONTRACT_VERSION);
      expect(body.totals.nodes).toBe(4);
      expect(body.totals.edges).toBe(3);

      const l3 = body.layers.find((l) => l.layer === "L3");
      const l2 = body.layers.find((l) => l.layer === "L2");
      expect(l3).toMatchObject({ nodes: 2, internalConnections: 1, externalConnections: 1 });
      expect(l2).toMatchObject({ nodes: 2, internalConnections: 1, externalConnections: 1 });
      // Native community detection ran, so communities are summarised too.
      expect(body.communities.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  test(
    "writes a single architecture-overview file that complements the wiki",
    async () => {
      const root = await seedRoot();
      const out = join(root, "architecture-overview.md");

      const result = runMemory(["architecture-overview", "--root", root, "--out", out]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: architecture overview written");

      const markdown = await readFile(out, "utf8");
      expect(markdown).toContain("# Architecture overview");
      expect(markdown).toContain("## Layers");
      expect(markdown).toContain("## Communities");
      expect(markdown).toContain("Internal connections");
      expect(markdown).toContain("External connections");
      expect(markdown).toContain("L3");
      // AC4: framed as orientation alongside the wiki, not a replacement.
      expect(markdown.toLowerCase()).toContain("wiki");
    },
    TIMEOUT,
  );

  test(
    "is generated from an existing graph.json contract (#234), not a bespoke shape",
    async () => {
      const root = await seedRoot();
      const exportDir = join(root, "export");

      const exported = runMemory([
        "export",
        exportDir,
        "--root",
        root,
        "--communities",
      ]);
      expect(exported.status, exported.stderr).toBe(0);

      const graphJson = join(exportDir, "graph.json");
      const result = runMemory([
        "architecture-overview",
        "--root",
        root,
        "--from",
        graphJson,
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        totals: { nodes: number; edges: number };
        layers: Array<{ layer: string }>;
      };
      expect(body.totals.nodes).toBe(4);
      expect(body.totals.edges).toBe(3);
      expect(body.layers.map((l) => l.layer).sort()).toEqual(["L2", "L3"]);
    },
    TIMEOUT,
  );
});
