import { describe, expect, test } from "vitest";
import { decode } from "@reddb-io/toon";
import type { RecalledNode } from "../src/engine.js";
import type { StoredNode } from "../src/graph-store.js";
import {
  executeReadOnlyMemoryOperation,
  getReadOnlyMemoryOperation,
} from "../src/operations.js";
import {
  buildRecallQueryVariants,
  rankRecallCandidates,
} from "../src/recall-ranking.js";

const NOW = Date.UTC(2026, 6, 6);
const DAY = 86_400_000;

function node(
  rid: number,
  label: string,
  summary: string,
  opts: {
    daysOld?: number;
    session?: string;
    score?: number;
  } = {},
): RecalledNode {
  return {
    rid,
    label,
    node_type: "decision",
    score: opts.score ?? 1,
    depth: 0,
    excerpt: summary,
    properties: {
      title: label,
      summary,
      content: summary,
      created_at: NOW - (opts.daysOld ?? 0) * DAY,
      updated_at: NOW - (opts.daysOld ?? 0) * DAY,
      scope: opts.session ? "session" : "project",
      ...(opts.session ? { scope_id: opts.session, session_id: opts.session } : {}),
    },
  };
}

describe("recall ranking pipeline", () => {
  test("query variants are deterministic and bounded", () => {
    expect(buildRecallQueryVariants("cache invalidation pipeline", 3)).toEqual([
      "cache invalidation pipeline",
      "cache",
      "invalidation",
    ]);
  });

  test("golden ordering shows RRF, recency decay, MMR, and session round-robin contributions", () => {
    const freshFusion = node(
      1,
      "cache invalidation pipeline canonical",
      "cache invalidation ranking pipeline keeps the current deterministic decision",
      { session: "s1" },
    );
    const singleQueryLeader = node(
      2,
      "cache invalidation one channel",
      "cache invalidation result that only the full query ranks first",
      { session: "s1" },
    );
    const diverseSession = node(
      3,
      "ttl eviction session",
      "ttl eviction policy documents a different session angle for recall ranking",
      { session: "s2" },
    );
    const staleDuplicate = node(
      4,
      "cache invalidation pipeline stale duplicate",
      "cache invalidation ranking pipeline keeps the current deterministic decision",
      { daysOld: 120, session: "s1" },
    );
    const nearDuplicate = node(
      5,
      "cache invalidation pipeline near duplicate",
      "cache invalidation ranking pipeline repeats the same current deterministic decision",
      { session: "s1" },
    );

    const candidates = [
      freshFusion,
      singleQueryLeader,
      diverseSession,
      staleDuplicate,
      nearDuplicate,
    ];

    const singleQueryOnly = rankRecallCandidates({
      query: "cache invalidation pipeline",
      candidates,
      rankings: [{ source: "query:full", rids: [2, 1, 4, 5, 3] }],
      limit: 5,
      now: NOW,
      config: { sessionRoundRobin: false },
    });
    expect(singleQueryOnly[0]!.node.rid).toBe(2);

    const fused = rankRecallCandidates({
      query: "cache invalidation pipeline",
      candidates,
      rankings: [
        { source: "query:full", rids: [2, 1, 4, 5, 3] },
        { source: "query:cache", rids: [1, 4, 5, 2, 3] },
        { source: "query:pipeline", rids: [1, 5, 4, 2, 3] },
      ],
      limit: 5,
      now: NOW,
    });

    expect(fused.map((hit) => hit.node.rid)).toEqual([1, 3, 2, 5, 4]);
    expect(fused[0]!.signalProvenance).toEqual([
      { source: "query:cache", rank: 1, contribution: 1 / 61 },
      { source: "query:pipeline", rank: 1, contribution: 1 / 61 },
      { source: "query:full", rank: 2, contribution: 1 / 62 },
    ]);
    expect(fused[0]!.rrfScore).toBeGreaterThan(singleQueryOnly[0]!.rrfScore);
    expect(fused.find((hit) => hit.node.rid === 4)!.recencyMultiplier).toBeLessThan(0.07);

    const noDiversity = rankRecallCandidates({
      query: "cache invalidation pipeline",
      candidates,
      rankings: [
        { source: "query:full", rids: [2, 1, 4, 5, 3] },
        { source: "query:cache", rids: [1, 4, 5, 2, 3] },
        { source: "query:pipeline", rids: [1, 5, 4, 2, 3] },
      ],
      limit: 5,
      now: NOW,
      config: { mmrLambda: 1, sessionRoundRobin: false },
    });
    expect(noDiversity.findIndex((hit) => hit.node.rid === 5)).toBeLessThan(
      noDiversity.findIndex((hit) => hit.node.rid === 3),
    );

    const noRoundRobin = rankRecallCandidates({
      query: "cache invalidation pipeline",
      candidates,
      rankings: [
        { source: "query:full", rids: [2, 1, 4, 5, 3] },
        { source: "query:cache", rids: [1, 4, 5, 2, 3] },
        { source: "query:pipeline", rids: [1, 5, 4, 2, 3] },
      ],
      limit: 5,
      now: NOW,
      config: { sessionRoundRobin: false },
    });
    expect(noRoundRobin.findIndex((hit) => hit.node.rid === 3)).toBeLessThan(
      noRoundRobin.findIndex((hit) => hit.node.rid === 5),
    );

    const roundRobinOnly = rankRecallCandidates({
      query: "cache invalidation pipeline",
      candidates,
      rankings: [
        { source: "query:full", rids: [2, 1, 4, 5, 3] },
        { source: "query:cache", rids: [1, 4, 5, 2, 3] },
        { source: "query:pipeline", rids: [1, 5, 4, 2, 3] },
      ],
      limit: 5,
      now: NOW,
      config: { mmrLambda: 1 },
    });
    expect(noDiversity.map((hit) => hit.node.rid).slice(0, 2)).toEqual([1, 2]);
    expect(roundRobinOnly.map((hit) => hit.node.rid).slice(0, 3)).toEqual([1, 3, 2]);
  });

  test("recall ranking is registered as a MemoryOperation and runs through the registry seam", async () => {
    const storeNodes: StoredNode[] = [
      node(1, "cache pipeline canonical", "cache pipeline current", { session: "s1" }),
      node(2, "cache single query", "cache only full query", { session: "s1" }),
      node(3, "pipeline other session", "pipeline alternative session", { session: "s2" }),
    ].map((candidate) => ({
      rid: candidate.rid,
      label: candidate.label,
      node_type: candidate.node_type,
      properties: { ...candidate.properties, scope: "project" },
    }));
    const searchRows = (query: string) => {
      if (query === "cache pipeline") return [{ rid: 2, score: 1 }, { rid: 1, score: 0.9 }];
      if (query === "cache") return [{ rid: 1, score: 1 }, { rid: 2, score: 0.9 }];
      if (query === "pipeline") return [{ rid: 1, score: 1 }, { rid: 3, score: 0.9 }];
      return [];
    };
    const fakeStore = {
      listNodes: async () => storeNodes,
      searchText: async (query: string) => searchRows(query),
      searchVector: async () => [],
      listEdges: async () => [],
      neighborhood: async () => [],
      supersededByMany: async () => new Map<number, number>(),
    };

    expect(getReadOnlyMemoryOperation("memory.recall-ranking").renderer.cli.command).toBe(
      "recall-ranked",
    );

    const result = await executeReadOnlyMemoryOperation(
      "memory.recall-ranking",
      {
        store: fakeStore as never,
        now: NOW,
        memoryConfig: { recallRanking: { sessionRoundRobin: false } } as never,
      },
      { query: "cache pipeline", limit: 3 },
    );

    const recall = result as {
      hits: Array<{
        rid: number;
        signal_provenance: Array<{ source: string; rank: number; contribution: number }>;
      }>;
      context_md: string;
    };
    expect(recall.hits.map((hit) => hit.rid)).toEqual([
      1,
      2,
      3,
    ]);
    expect(recall.hits[0]!.signal_provenance).toEqual([
      { source: "keyword:cache", rank: 1, contribution: 1 / 61 },
      { source: "keyword:pipeline", rank: 1, contribution: 1 / 61 },
      { source: "graph", rank: 1, contribution: 1 / 61 },
      { source: "keyword:cache pipeline", rank: 2, contribution: 1 / 62 },
    ]);
    expect(recall.context_md).toContain("signal_provenance[4]{source,rank,contribution}:");
    expect(recall.context_md).toContain("\"keyword:cache\",1,0.016393");
    const lines = recall.context_md.split("\n");
    const signalStart = lines.findIndex((line) => line.startsWith("signal_provenance["));
    const signalBlock = lines.slice(signalStart, signalStart + 5);
    expect(decode(signalBlock.join("\n"))).toEqual({
      signal_provenance: [
        { source: "keyword:cache", rank: 1, contribution: 0.016393 },
        { source: "keyword:pipeline", rank: 1, contribution: 0.016393 },
        { source: "graph", rank: 1, contribution: 0.016393 },
        { source: "keyword:cache pipeline", rank: 2, contribution: 0.016129 },
      ],
    });
  });
});
