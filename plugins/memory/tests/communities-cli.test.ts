import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

      const before = await openStore(root);
      const beforeStats = await before.stats();
      await before.close();

      const first = runMemory(["communities", "--root", root, "--json"]);
      expect(first.status).toBe(0);
      const firstBody = JSON.parse(first.stdout) as {
        cached: boolean;
        graph_hash: string;
        communities: Array<{ id: string; count: number; labels: string[]; titles: string[] }>;
        assignments: Array<{ rid: number; community_id: string; label: string; title: string }>;
      };

      expect(firstBody.cached).toBe(false);
      expect(firstBody.graph_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(firstBody.communities).toHaveLength(2);
      expect(firstBody.assignments).toHaveLength(6);
      expect(firstBody.communities.map((c) => c.count).sort()).toEqual([3, 3]);
      expect(firstBody.communities.some((c) => c.labels.includes("auth-login"))).toBe(true);
      expect(firstBody.communities.some((c) => c.titles.includes("cache ttl"))).toBe(true);

      const second = runMemory(["communities", "--root", root, "--json"]);
      expect(second.status).toBe(0);
      const secondBody = JSON.parse(second.stdout) as typeof firstBody;
      expect(secondBody.cached).toBe(true);
      expect(secondBody.graph_hash).toBe(firstBody.graph_hash);
      expect(secondBody.assignments).toEqual(firstBody.assignments);

      const after = await openStore(root);
      const afterStats = await after.stats();
      await after.close();
      expect(afterStats).toEqual(beforeStats);
    },
    TIMEOUT,
  );
});
