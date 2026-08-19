import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildMemorySmartSearch } from "../src/smart-search.js";
import { buildMemorySmartSearchViewerArtifact } from "../src/smart-search-viewer.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "memory-smart-search-"));
  roots.push(root);
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  await seed(store);
  return { root, store };
}

async function seed(store: MemoryStore): Promise<void> {
  await store.upsertNode({
    label: "jwt-rotation",
    node_type: "decision",
    properties: {
      title: "JWT rotation",
      content: "JWT tokens rotate every 90 days in staging.",
      confidence: "EXTRACTED",
      tier: "durable",
    },
  });
  await store.upsertDoc({
    path: "docs/auth.md",
    title: "Auth Guide",
    body: "The auth guide says JWT tokens rotate every 90 days and sessions refresh on login.",
    frontmatter: { tags: ["auth", "jwt"] },
    hash: "auth-doc-hash",
    updated_at: 1_700_000_000_000,
  });
  await store.upsertNode({
    label: "asset:docs/architecture.pdf",
    node_type: "file",
    properties: {
      title: "architecture.pdf",
      summary: "document asset at docs/architecture.pdf with service blueprint boundaries",
      source: "docs/architecture.pdf",
      asset_kind: "document",
      media_type: "application/pdf",
      bytes: 1200,
      binary: true,
      hash: "asset-hash",
      confidence: "EXTRACTED",
      tier: "durable",
    },
  });
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory smart search", () => {
  test("composes governed recall, document search, and vector diagnostics", async () => {
    const { store } = await graphRoot();

    const report = await buildMemorySmartSearch(store, "jwt rotation", {
      now: 1_700_000_000_000,
    });

    expect(report).toMatchObject({
      schema_version: "memory.smart_search.v1",
      read_only: true,
      query: "jwt rotation",
      summary: {
        recall_hits: expect.any(Number),
        doc_hits: 1,
        asset_hits: 0,
        vector_status: "unavailable",
      },
    });
    expect(report.recall.nodes.some((node) => node.label === "jwt-rotation")).toBe(true);
    expect(report.docs.hits[0]).toMatchObject({ path: "docs/auth.md" });
    expect(report.top_results).toEqual([
      expect.objectContaining({
        rank: 1,
        kind: "memory",
        sources: expect.arrayContaining(["recall"]),
        ref: expect.objectContaining({ label: "jwt-rotation" }),
      }),
      expect.objectContaining({
        kind: "doc",
        sources: ["doc"],
        ref: expect.objectContaining({ path: "docs/auth.md" }),
      }),
    ]);
    expect(report.vector.hits).toEqual([]);
    expect(report.recommended_next_actions).toContain(
      "run `memory vector maintain --local` for local-dev vectors or configure a vector provider",
    );
  });

  test("promotes matching assets as first-class smart-search results", async () => {
    const { store } = await graphRoot();

    const report = await buildMemorySmartSearch(store, "architecture pdf", {
      now: 1_700_000_000_000,
    });

    expect(report.summary.asset_hits).toBe(1);
    expect(report.assets).toMatchObject({
      schema_version: "memory.asset_inventory.v1",
      query: "architecture pdf",
      total_assets: 1,
      assets: [expect.objectContaining({ path: "docs/architecture.pdf" })],
    });
    expect(report.top_results).toContainEqual(
      expect.objectContaining({
        kind: "asset",
        sources: expect.arrayContaining(["asset"]),
        ref: expect.objectContaining({ path: "docs/architecture.pdf" }),
      }),
    );
  });

  test("keeps asset identity when a vector hit contributes to smart-search", async () => {
    const { store } = await graphRoot();
    const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
    process.env.RED_MEMORY_VECTOR_PROVIDER = "local";
    try {
      await store.maintainVectorProjection();

      const report = await buildMemorySmartSearch(store, "service blueprint", {
        now: 1_700_000_000_000,
      });

      expect(report.summary.vector_hits).toBeGreaterThan(0);
      expect(report.vector.hits).toContainEqual(
        expect.objectContaining({
          kind: "asset",
          path: "docs/architecture.pdf",
          asset_kind: "document",
          media_type: "application/pdf",
        }),
      );
      expect(report.top_results).toContainEqual(
        expect.objectContaining({
          kind: "asset",
          sources: expect.arrayContaining(["vector"]),
          ref: expect.objectContaining({ path: "docs/architecture.pdf" }),
        }),
      );
    } finally {
      if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
      else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
    }
  });

  test("builds a self-contained smart-search viewer artifact", async () => {
    const { store } = await graphRoot();
    const report = await buildMemorySmartSearch(store, "architecture pdf", {
      now: 1_700_000_000_000,
    });

    const artifact = buildMemorySmartSearchViewerArtifact(report);

    expect(artifact.contract).toEqual({
      name: "memory.smart_search.viewer",
      version: "memory.smart_search.viewer.v1",
      consumes: "memory.smart_search.v1",
    });
    expect(artifact.html).toContain("Smart Search");
    expect(artifact.html).toContain("architecture.pdf");
    expect(artifact.html).toContain("Asset Hits");
    expect(artifact.html).toContain("Vector Hits");
    expect(artifact.html).toContain('id="smart-search-data"');
    expect(artifact.html).not.toContain("<script src=");
  });

  test(
    "CLI emits smart search JSON",
    async () => {
      const { root, store } = await graphRoot();
      await store.close();
      stores.pop();

      const result = runMemory(["smart-search", "jwt", "rotation", "--root", root, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        schema_version: string;
        summary: { doc_hits: number; asset_hits: number };
        docs: { hits: Array<{ path: string }> };
        assets: { assets: Array<{ path: string }> };
        top_results: Array<{ kind: string; sources: string[] }>;
      };
      expect(body.schema_version).toBe("memory.smart_search.v1");
      expect(body.summary.doc_hits).toBe(1);
      expect(body.summary.asset_hits).toBe(0);
      expect(body.docs.hits[0].path).toBe("docs/auth.md");
      expect(body.top_results.map((item) => item.kind)).toContain("memory");
      expect(body.top_results.map((item) => item.sources).flat()).toContain("doc");
    },
    TIMEOUT,
  );

  test(
    "CLI writes smart-search viewer HTML",
    async () => {
      const { root, store } = await graphRoot();
      await store.close();
      stores.pop();
      const out = join(root, "smart-search.html");

      const result = runMemory([
        "smart-search-viewer",
        "architecture",
        "pdf",
        "--root",
        root,
        "--out",
        out,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: smart-search viewer written");
      expect(result.stdout).toContain("contract: memory.smart_search.v1");
      await expect(readFile(out, "utf8")).resolves.toContain("Smart Search");
    },
    TIMEOUT,
  );
});
