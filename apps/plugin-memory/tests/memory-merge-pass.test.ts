import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildMemoryMergePassReport,
  type MemoryMergePassStore,
} from "../src/memory-merge-pass.js";
import { graphRecall } from "../src/graph-recall.js";
import { MemoryStore, type StoredNode } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";

const NOW = Date.parse("2026-05-25T12:00:00.000Z");
const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

class FakeMergePassStore implements MemoryMergePassStore {
  constructor(
    private readonly nodes: StoredNode[],
    private readonly edges: Record<string, unknown>[] = [],
    private readonly hidden = new Map<number, number>(),
  ) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.nodes;
  }

  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.edges;
  }

  async supersededByMany(): Promise<Map<number, number>> {
    return this.hidden;
  }
}

function node(input: {
  rid: number;
  label: string;
  title: string;
  content: string;
  importance?: number;
  node_type?: StoredNode["node_type"];
}): StoredNode {
  return {
    rid: input.rid,
    label: input.label,
    node_type: input.node_type ?? "decision",
    properties: {
      title: input.title,
      content: input.content,
      tier: "durable",
      importance: input.importance ?? 0.5,
      updated_at: NOW,
      provenance: {
        source_kind: "manual",
        evidence: [`transcript:${input.label}`],
      },
    },
  };
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-merge-pass-"));
  roots.push(dir);
  return dir;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Memory merge pass", () => {
  test("ranks near-duplicate node pairs with evidence and suppresses already hidden pairs", async () => {
    const report = await buildMemoryMergePassReport(
      new FakeMergePassStore(
        [
          node({
            rid: 1,
            label: "jwt-rotation-policy-copy",
            title: "JWT rotation policy",
            content: "JWT rotation tokens stay server side and never log signing keys.",
            importance: 0.3,
          }),
          node({
            rid: 2,
            label: "jwt-rotation-policy",
            title: "JWT rotation policy",
            content: "JWT rotation tokens stay server-side and never log signing keys.",
            importance: 0.9,
          }),
          node({
            rid: 3,
            label: "billing-retry-policy",
            title: "Billing retry policy",
            content: "Billing retries use exponential backoff after webhook failures.",
          }),
          node({
            rid: 4,
            label: "billing-retry-policy-duplicate",
            title: "Billing retry policy",
            content: "Billing retries use exponential backoff after webhook failures.",
          }),
        ],
        [{ label: "SAME_AS", from: 4, to: 3 }],
      ),
      { now: NOW, min_score: 0.72 },
    );

    expect(report.schema_version).toBe("memory.merge_pass.v1");
    expect(report.read_only).toBe(true);
    expect(report.status).toBe("candidates");
    expect(report.summary).toMatchObject({
      considered_nodes: 4,
      suppressed_existing_hidden_edges: 1,
      candidates: 1,
    });
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({
      rank: 1,
      duplicate_rid: 1,
      canonical_rid: 2,
      proposed_edge_label: "SAME_AS",
      evidence: {
        same_node_type: true,
      },
    });
    expect(report.candidates[0]!.score).toBeGreaterThanOrEqual(0.9);
    expect(report.candidates[0]!.evidence.shared_terms).toEqual(
      expect.arrayContaining(["jwt", "rotation", "token"]),
    );
    expect(report.candidates[0]!.left.provenance_evidence).toEqual([
      "transcript:jwt-rotation-policy-copy",
    ]);
    expect(report.markdown).toContain("# Memory merge pass");
    expect(report.markdown).toContain("SAME_AS memory_nodes:1 -> memory_nodes:2");
  });

  test("CLI emits advisory JSON without adding merge edges", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await store.upsertNode({
      label: "cache-ttl-policy-copy",
      node_type: "decision",
      properties: {
        title: "Cache TTL policy",
        content: "Cache TTL defaults to 300 seconds for API responses.",
        tier: "durable",
        importance: 0.4,
      },
    });
    await store.upsertNode({
      label: "cache-ttl-policy",
      node_type: "decision",
      properties: {
        title: "Cache TTL policy",
        content: "Cache TTL defaults to 300 seconds for API response caching.",
        tier: "durable",
        importance: 0.8,
      },
    });
    const beforeEdges = await store.listEdges();
    await store.close();

    const result = runMemory(["merge-pass", "--root", root, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      schema_version: string;
      read_only: boolean;
      candidates: Array<{ score: number; proposed_edge_label: string }>;
    };
    expect(body.schema_version).toBe("memory.merge_pass.v1");
    expect(body.read_only).toBe(true);
    expect(body.candidates[0]).toMatchObject({ proposed_edge_label: "SAME_AS" });
    expect(body.candidates[0]!.score).toBeGreaterThanOrEqual(0.72);

    const after = await openStore(root);
    const afterEdges = await after.listEdges();
    expect(afterEdges).toHaveLength(beforeEdges.length);
    expect(afterEdges.some((edge) => edge.label === "SAME_AS")).toBe(false);
  }, TIMEOUT);

  test("CLI executes an approval-gated merge batch and unmerges it without deleting nodes", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    const duplicate = await store.upsertNode({
      label: "jwt-rotation-policy-copy",
      node_type: "decision",
      properties: {
        title: "JWT rotation policy",
        content: "JWT rotation tokens stay server side and never log signing keys.",
        tier: "durable",
        importance: 0.2,
        provenance: {
          source_kind: "manual",
          writer: "agent-a",
          evidence: ["transcript:duplicate-node"],
        },
      },
    });
    const canonical = await store.upsertNode({
      label: "jwt-rotation-policy",
      node_type: "decision",
      properties: {
        title: "JWT rotation policy",
        content: "JWT rotation tokens stay server-side and never log signing keys.",
        tier: "durable",
        importance: 0.9,
        provenance: {
          source_kind: "manual",
          writer: "agent-b",
          evidence: ["transcript:canonical-node"],
        },
      },
    });
    await store.close();

    const blocked = runMemory([
      "merge-pass",
      "execute",
      "--root",
      root,
      "--candidate-ranks",
      "1",
      "--approver",
      "agent:test",
      "--json",
    ]);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("requires explicit --yes approval");

    const afterBlocked = await openStore(root);
    await expect(afterBlocked.findEdge(duplicate, canonical, "SAME_AS")).resolves.toBeNull();
    await afterBlocked.close();

    const executed = runMemory([
      "merge-pass",
      "execute",
      "--root",
      root,
      "--candidate-ranks",
      "1",
      "--approver",
      "agent:test",
      "--batch-id",
      "batch-jwt-rotation",
      "--yes",
      "--json",
    ]);
    expect(executed.status, executed.stderr).toBe(0);
    const executeBody = JSON.parse(executed.stdout) as {
      batch_id: string;
      summary: { merged: number };
      merged_edges: Array<{ duplicate_rid: number; canonical_rid: number; label: string }>;
    };
    expect(executeBody.batch_id).toBe("batch-jwt-rotation");
    expect(executeBody.summary.merged).toBe(1);
    expect(executeBody.merged_edges[0]).toMatchObject({
      duplicate_rid: duplicate,
      canonical_rid: canonical,
      label: "SAME_AS",
    });

    const merged = await openStore(root);
    await expect(merged.findEdge(duplicate, canonical, "SAME_AS")).resolves.toBeGreaterThan(0);
    const hiddenHits = await graphRecall(
      merged,
      "jwt rotation duplicate provenance canonical guidance",
      10,
    );
    expect(hiddenHits.map((hit) => hit.rid)).toContain(canonical);
    expect(hiddenHits.map((hit) => hit.rid)).not.toContain(duplicate);
    await expect(merged.getNode(duplicate)).resolves.toMatchObject({
      rid: duplicate,
      properties: {
        provenance: {
          source_kind: "manual",
          writer: "agent-a",
          evidence: ["transcript:duplicate-node"],
        },
      },
    });
    await merged.close();

    const unmerged = runMemory([
      "merge-pass",
      "unmerge",
      "--root",
      root,
      "--batch-id",
      "batch-jwt-rotation",
      "--yes",
      "--json",
    ]);
    expect(unmerged.status, unmerged.stderr).toBe(0);
    const unmergeBody = JSON.parse(unmerged.stdout) as {
      summary: { found: number; removed: number };
    };
    expect(unmergeBody.summary).toEqual({ found: 1, removed: 1 });

    const visible = await openStore(root);
    await expect(visible.findEdge(duplicate, canonical, "SAME_AS")).resolves.toBeNull();
    const visibleHits = await graphRecall(
      visible,
      "jwt rotation duplicate original provenance",
      10,
    );
    expect(visibleHits.map((hit) => hit.rid)).toContain(duplicate);
  }, TIMEOUT);
});
