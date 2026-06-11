import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
  const root = await mkdtemp(join(tmpdir(), "memory-communities-cli-"));
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

describe("memory communities CLI", () => {
  test(
    "reports assignments, counts, readable labels, cache hits, and does not mutate graph evidence",
    async () => {
      const root = await initRoot();
      await seedTwoCommunities(root);
      expect(getReadOnlyMemoryOperation("memory.communities").renderer.cli).toMatchObject({
        command: "communities",
        supportsJson: true,
      });
      expect(getReadOnlyMemoryOperation("memory.communities-viewer").renderer.cli).toMatchObject({
        command: "communities-viewer",
        supportsJson: false,
      });

      const before = await openStore(root);
      const beforeStats = await before.stats();
      await before.close();

      const first = runMemory(["communities", "--root", root, "--json"]);
      expect(first.status).toBe(0);
      const firstBody = JSON.parse(first.stdout) as {
        schema_version: string;
        read_only: boolean;
        cached: boolean;
        graph_hash: string;
        cache_key: string;
        communities: Array<{
          id: string;
          count: number;
          total_degree: number;
          avg_centrality: number;
          external_edge_weight: number;
          labels: string[];
          titles: string[];
        }>;
        assignments: Array<{ rid: number; community_id: string; label: string; title: string }>;
        node_analytics: Array<{
          rid: number;
          community_id: string;
          degree: number;
          in_degree: number;
          out_degree: number;
          weighted_degree: number;
          centrality: number;
        }>;
        inter_community_edges: Array<{
          from_community_id: string;
          to_community_id: string;
          weight: number;
          edge_count: number;
        }>;
      };

      expect(firstBody.schema_version).toBe("memory.communities.v1");
      expect(firstBody.read_only).toBe(true);
      expect(firstBody.cached).toBe(false);
      expect(firstBody.graph_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(firstBody.cache_key).toContain("cache:communities:v2:");
      expect(firstBody.communities).toHaveLength(2);
      expect(firstBody.assignments).toHaveLength(6);
      expect(firstBody.node_analytics).toHaveLength(6);
      expect(firstBody.inter_community_edges).toHaveLength(1);
      expect(firstBody.inter_community_edges[0]).toMatchObject({ weight: 1, edge_count: 1 });
      expect(firstBody.node_analytics[0].centrality).toBeGreaterThan(0);
      expect(firstBody.node_analytics[0].degree).toBeGreaterThan(0);
      expect(firstBody.communities.map((c) => c.count).sort()).toEqual([3, 3]);
      expect(firstBody.communities.every((c) => c.total_degree > 0)).toBe(true);
      expect(firstBody.communities.every((c) => c.avg_centrality > 0)).toBe(true);
      expect(firstBody.communities.every((c) => c.external_edge_weight === 1)).toBe(true);
      expect(firstBody.communities.some((c) => c.labels.includes("auth-login"))).toBe(true);
      expect(firstBody.communities.some((c) => c.titles.includes("cache ttl"))).toBe(true);

      const second = runMemory(["communities", "--root", root, "--json"]);
      expect(second.status).toBe(0);
      const secondBody = JSON.parse(second.stdout) as typeof firstBody;
      expect(secondBody.cached).toBe(true);
      expect(secondBody.graph_hash).toBe(firstBody.graph_hash);
      expect(secondBody.assignments).toEqual(firstBody.assignments);
      expect(secondBody.node_analytics).toEqual(firstBody.node_analytics);
      expect(secondBody.inter_community_edges).toEqual(firstBody.inter_community_edges);

      const out = join(root, "communities.html");
      const viewer = runMemory(["communities-viewer", "--root", root, "--out", out]);
      expect(viewer.status).toBe(0);
      expect(viewer.stdout).toContain("memory: communities viewer written");
      expect(viewer.stdout).toContain("contract: memory.communities.v1");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Graph Communities");
      expect(html).toContain("auth login flow");
      expect(html).toContain('id="communities-data"');
      expect(html).not.toContain("<script src=");

      const afterAnalytics = await openStore(root);
      const afterAnalyticsStats = await afterAnalytics.stats();
      await afterAnalytics.close();
      expect(afterAnalyticsStats).toEqual(beforeStats);

      const changed = await openStore(root);
      const newRid = await changed.upsertNode({
        label: "auth-metrics",
        node_type: "concept",
        properties: { title: "auth metrics", content: "auth metrics" },
      });
      const authLogin = firstBody.assignments.find((assignment) => assignment.label === "auth-login");
      expect(authLogin).toBeDefined();
      await changed.upsertEdge({ label: "REFERENCES", from_rid: newRid, to_rid: authLogin!.rid });
      await changed.close();

      const regenerated = runMemory(["communities", "--root", root, "--json"]);
      expect(regenerated.status).toBe(0);
      const regeneratedBody = JSON.parse(regenerated.stdout) as typeof firstBody;
      expect(regeneratedBody.cached).toBe(false);
      expect(regeneratedBody.graph_hash).not.toBe(firstBody.graph_hash);
      expect(regeneratedBody.assignments).toHaveLength(7);
      expect(regeneratedBody.node_analytics).toHaveLength(7);

      const regeneratedSecond = runMemory(["communities", "--root", root, "--json"]);
      expect(regeneratedSecond.status).toBe(0);
      const regeneratedSecondBody = JSON.parse(regeneratedSecond.stdout) as typeof firstBody;
      expect(regeneratedSecondBody.cached).toBe(true);
      expect(regeneratedSecondBody.graph_hash).toBe(regeneratedBody.graph_hash);

      const after = await openStore(root);
      const afterStats = await after.stats();
      await after.close();
      expect(afterStats).toEqual({ nodes: beforeStats.nodes + 1, edges: beforeStats.edges + 1 });
    },
    TIMEOUT,
  );
});
