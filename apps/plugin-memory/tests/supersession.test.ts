import { describe, expect, test } from "vitest";
import {
  listContradictions,
  resolveConflict,
  supersessionTimeline,
  type SupersessionStore,
} from "../src/supersession.js";
import type { StoredNode } from "../src/graph-store.js";

const NOW = 1_700_000_000_000;

function node(rid: number, label: string, content: string, createdAt = NOW + rid): StoredNode {
  return {
    rid,
    label,
    node_type: "decision",
    properties: {
      title: label.replace(/-/g, " "),
      content,
      created_at: createdAt,
      updated_at: createdAt,
    },
  };
}

class MockStore implements SupersessionStore {
  public superseded = new Map<number, number>();
  public supersedeCalls: Array<{ oldRid: number; newRid: number; reason?: string }> = [];

  constructor(
    private nodes: StoredNode[],
    private edges: Record<string, unknown>[],
  ) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.nodes;
  }

  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.edges;
  }

  async supersededByMany(rids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const rid of rids) {
      const to = this.superseded.get(rid);
      if (to != null) out.set(rid, to);
    }
    return out;
  }

  async supersede(oldRid: number, newRid: number, reason?: string): Promise<number> {
    this.superseded.set(oldRid, newRid);
    this.supersedeCalls.push({ oldRid, newRid, reason });
    return 99;
  }
}

describe("supersession workflows", () => {
  test("lists unresolved CONTRADICTS edges as likely contradictions", async () => {
    const store = new MockStore(
      [
        node(1, "deploy-friday", "deploys happen friday"),
        node(2, "deploy-tuesday", "deploys happen tuesday"),
      ],
      [{ label: "CONTRADICTS", from: 1, to: 2, properties: { reason: "date changed" } }],
    );

    const conflicts = await listContradictions(store);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      from: { rid: 1, label: "deploy-friday" },
      to: { rid: 2, label: "deploy-tuesday" },
      reason: "date changed",
      resolved: false,
      activeRid: null,
    });
  });

  test("resolved contradictions are hidden by default but available for audit", async () => {
    const store = new MockStore(
      [
        node(1, "deploy-friday", "deploys happen friday"),
        node(2, "deploy-tuesday", "deploys happen tuesday"),
      ],
      [{ label: "CONTRADICTS", from: 1, to: 2 }],
    );
    store.superseded.set(1, 2);

    expect(await listContradictions(store)).toEqual([]);
    expect(await listContradictions(store, { includeResolved: true })).toEqual([
      expect.objectContaining({ resolved: true, activeRid: 2 }),
    ]);
  });

  test("resolves a conflict by superseding the inactive guidance with the active guidance", async () => {
    const store = new MockStore(
      [
        node(1, "deploy-friday", "deploys happen friday"),
        node(2, "deploy-tuesday", "deploys happen tuesday"),
      ],
      [],
    );

    const edgeRid = await resolveConflict(store, {
      activeRid: 2,
      supersededRid: 1,
      reason: "human chose newer policy",
    });

    expect(edgeRid).toBe(99);
    expect(store.supersedeCalls).toEqual([
      { oldRid: 1, newRid: 2, reason: "human chose newer policy" },
    ]);
  });

  test("builds a topic timeline with active and superseded guidance plus audit links", async () => {
    const store = new MockStore(
      [
        node(1, "deploy-friday", "deploy policy friday", NOW + 1),
        node(2, "deploy-tuesday", "deploy policy tuesday", NOW + 2),
        node(3, "cache-ttl", "cache policy", NOW + 3),
      ],
      [
        { label: "SUPERSEDED_BY", from: 1, to: 2, properties: { reason: "policy changed" } },
        { label: "CONTRADICTS", from: 1, to: 2, properties: { reason: "date changed" } },
      ],
    );
    store.superseded.set(1, 2);

    const timeline = await supersessionTimeline(store, "friday");

    expect(timeline.entries.map((entry) => entry.rid)).toEqual([1, 2]);
    expect(timeline.entries).toEqual([
      expect.objectContaining({ rid: 1, status: "superseded", activeRid: 2 }),
      expect.objectContaining({ rid: 2, status: "active", activeRid: 2 }),
    ]);
    expect(timeline.auditLinks).toEqual([
      expect.objectContaining({ label: "SUPERSEDED_BY", fromRid: 1, toRid: 2 }),
      expect.objectContaining({ label: "CONTRADICTS", fromRid: 1, toRid: 2 }),
    ]);
  });
});
