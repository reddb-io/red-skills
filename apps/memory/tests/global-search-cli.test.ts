import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildMemoryGlobalSearch } from "../src/global-search.js";
import { graphRecall } from "../src/graph-recall.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { getReadOnlyMemoryOperation } from "../src/operations.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function initRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-global-search-cli-"));
  roots.push(root);
  await initGraph(root);
  return root;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

async function seedTwoCommunities(root: string): Promise<void> {
  const store = await openStore(root);
  const mk = (label: string, title: string) =>
    store.upsertNode({
      label,
      node_type: "concept",
      properties: { title, content: title },
    });
  const [a, b, c, x, y, z] = await Promise.all([
    mk("auth-login", "auth login flow"),
    mk("auth-token", "auth token rotation"),
    mk("auth-session", "auth session policy"),
    mk("cache-index", "cache index"),
    mk("cache-ttl", "cache ttl"),
    mk("cache-warmup", "cache warmup"),
  ]);
  const e = (from: number, to: number) =>
    store.upsertEdge({ label: "REFERENCES", from_rid: from, to_rid: to });
  await e(a, b);
  await e(b, c);
  await e(c, a);
  await e(x, y);
  await e(y, z);
  await e(z, x);
  await e(c, x);
  await store.close();
}

interface GlobalSearchBody {
  schema_version: string;
  read_only: boolean;
  surface: string;
  query: string;
  generated_from: {
    operation_id: string;
    schema_version: string;
    graph_hash: string;
    cached: boolean;
    provider: { status: "available" | "unavailable"; error?: string };
  };
  total_hits: number;
  evidence: Array<{
    source: string;
    community_id: string;
    score: number;
    matched_terms: string[];
    top_label: string;
    top_node_type: string;
    narrative_summary: string | null;
    labels: Array<{ value: string; count: number }>;
  }>;
  markdown: string;
}

describe("memory global-search CLI", () => {
  test(
    "returns opt-in digest-level evidence from the deterministic community digest baseline",
    async () => {
      const root = await initRoot();
      await seedTwoCommunities(root);

      expect(getReadOnlyMemoryOperation("memory.global-search").renderer.cli).toMatchObject({
        command: "global-search",
        supportsJson: true,
      });

      const result = runMemory(["global-search", "auth", "cache", "--root", root, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as GlobalSearchBody;

      expect(body.schema_version).toBe("memory.global-search.v1");
      expect(body.read_only).toBe(true);
      expect(body.surface).toBe("memory.global-search");
      expect(body.query).toBe("auth cache");
      expect(body.generated_from).toMatchObject({
        operation_id: "memory.community-digest",
        schema_version: "memory.community-digest.v1",
        cached: false,
        provider: {
          status: "unavailable",
          error: "no AI provider configured",
        },
      });
      expect(body.generated_from.graph_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(body.total_hits).toBe(2);
      expect(body.evidence.every((item) => item.source === "community-digest")).toBe(true);
      expect(body.evidence.every((item) => item.narrative_summary === null)).toBe(true);
      expect(body.evidence.map((item) => item.top_label).sort()).toEqual([
        "auth-login",
        "cache-index",
      ]);
      expect(body.evidence.flatMap((item) => item.matched_terms).sort()).toEqual([
        "auth",
        "cache",
      ]);
      expect(body.markdown).toContain("Opt-in broad search over Community digest evidence");
      expect(body.markdown).toContain("does not alter `memory recall` ranking");
    },
    TIMEOUT,
  );

  test(
    "does not alter canonical graph recall ranking",
    async () => {
      const root = await initRoot();
      await seedTwoCommunities(root);
      const store = await openStore(root);
      const now = Date.UTC(2026, 6, 6);

      const before = await graphRecall(store, "auth token", 10, { now });
      await buildMemoryGlobalSearch(store, "auth cache", { cache: "off" });
      const after = await graphRecall(store, "auth token", 10, { now });

      expect(after.map((hit) => hit.label)).toEqual(before.map((hit) => hit.label));
      expect(after.map((hit) => hit.score)).toEqual(before.map((hit) => hit.score));
    },
    TIMEOUT,
  );
});
