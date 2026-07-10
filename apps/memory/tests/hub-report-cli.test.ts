import { decode } from "@reddb-io/toon";
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
  const root = await mkdtemp(join(tmpdir(), "memory-hub-report-cli-"));
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

async function seedHubTopology(root: string): Promise<void> {
  const store = await openStore(root);
  const mk = (label: string, title: string) =>
    store.upsertNode({
      label,
      node_type: "concept",
      properties: { title, content: title },
    });
  const [hub, inboundA, inboundB, outboundA, satellite] = await Promise.all([
    mk("auth-hub", "auth hub"),
    mk("token-rotation", "token rotation"),
    mk("session-policy", "session policy"),
    mk("audit-log", "audit log"),
    mk("cache-ttl", "cache ttl"),
  ]);
  await store.upsertEdge({
    label: "REFERENCES",
    from_rid: inboundA,
    to_rid: hub,
    properties: { seal: "EXTRACTED" },
  });
  await store.upsertEdge({
    label: "REFERENCES",
    from_rid: inboundB,
    to_rid: hub,
    properties: { seal: "INFERRED" },
  });
  await store.upsertEdge({
    label: "REFERENCES",
    from_rid: hub,
    to_rid: outboundA,
    properties: { seal: "EXTRACTED" },
  });
  await store.upsertEdge({
    label: "REFERENCES",
    from_rid: satellite,
    to_rid: outboundA,
    properties: { seal: "AMBIGUOUS" },
  });
  await store.close();
}

describe("memory hub-report CLI", () => {
  test(
    "ranks top-N graph hubs with community membership and seal mix in TOON and JSON",
    async () => {
      const root = await initRoot();
      await seedHubTopology(root);
      expect(getReadOnlyMemoryOperation("memory.hub-report").renderer.cli).toMatchObject({
        command: "hub-report",
        supportsJson: true,
      });

      const toonResult = runMemory(["hub-report", "--root", root, "--limit", "3"]);
      expect(toonResult.status).toBe(0);
      const toon = decode(toonResult.stdout) as {
        schema_version: string;
        hubs: Array<{
          label: string;
          title: string;
          community_id: string | null;
          total_degree: number;
          in_degree: number;
          out_degree: number;
          seal_mix: string;
          rid?: number;
          seals?: string[];
        }>;
        summary: { reported: number; max_total_degree: number; next: string[] };
      };

      expect(toon.schema_version).toBe("memory.hub-report.v1");
      expect(toon.hubs).toHaveLength(3);
      expect(toon.hubs[0]).toMatchObject({
        label: "auth-hub",
        title: "auth hub",
        total_degree: 3,
        in_degree: 2,
        out_degree: 1,
        seal_mix: "EXTRACTED+INFERRED",
      });
      expect(toon.hubs[0].community_id).toEqual(expect.any(String));
      expect(toon.hubs[0]).not.toHaveProperty("rid");
      expect(toon.hubs[0]).not.toHaveProperty("seals");
      expect(toon.summary).toMatchObject({
        reported: 3,
        max_total_degree: 3,
      });
      expect(toon.summary.next).toContain("memory communities --json");

      const wideResult = runMemory(["hub-report", "--root", root, "--limit", "1", "--wide"]);
      expect(wideResult.status).toBe(0);
      const wide = decode(wideResult.stdout) as {
        hubs: Array<{ rid: number; node_type: string; seal_count: number; seals: string[] }>;
      };
      expect(wide.hubs[0]).toMatchObject({
        node_type: "concept",
        seal_count: 2,
        seals: ["EXTRACTED", "INFERRED"],
      });
      expect(wide.hubs[0].rid).toEqual(expect.any(Number));

      const jsonResult = runMemory(["hub-report", "--root", root, "--rank-by", "in", "--json"]);
      expect(jsonResult.status).toBe(0);
      const json = JSON.parse(jsonResult.stdout) as {
        schema_version: string;
        rank_by: string;
        hubs: Array<{ label: string; in_degree: number; total_degree: number }>;
      };
      expect(json.schema_version).toBe("memory.hub-report.v1");
      expect(json.rank_by).toBe("in");
      expect(json.hubs[0]).toMatchObject({ label: "auth-hub", in_degree: 2, total_degree: 3 });
    },
    TIMEOUT,
  );

  test(
    "emits a definitive empty state with a next-step suggestion",
    async () => {
      const root = await initRoot();

      const result = runMemory(["hub-report", "--root", root]);
      expect(result.status).toBe(0);
      const body = decode(result.stdout) as {
        hubs: unknown[];
        summary: { state: string; message: string; nodes: number; edges: number; next: string[] };
      };

      expect(body.hubs).toEqual([]);
      expect(body.summary).toMatchObject({
        state: "empty_graph",
        message: "No graph nodes found.",
        nodes: 0,
        edges: 0,
      });
      expect(body.summary.next).toContain("memory export --communities");
    },
    TIMEOUT,
  );
});
