import { describe, expect, test } from "vitest";
import { RRF_K, hybridRecall, type Ranking } from "../src/hybrid-recall.js";

/**
 * RRF spot-checks for the pure composer (#180). The fixtures lock in fold
 * order across the four canonical cases (single-source hit per axis, all-three
 * convergence, tie-breaking) plus determinism on re-run.
 */

const vectorOnly = (rids: number[]): Ranking => ({ source: "vector", rids });
const keywordOnly = (rids: number[]): Ranking => ({ source: "keyword", rids });
const graphOnly = (rids: number[]): Ranking => ({ source: "graph", rids });

describe("hybridRecall — RRF fold", () => {
  test("RRF_K matches the published convention", () => {
    expect(RRF_K).toBe(60);
  });

  test("vector-only hit surfaces with the source's RRF contribution", () => {
    const hits = hybridRecall([
      vectorOnly([42]),
      keywordOnly([]),
      graphOnly([]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      rid: 42,
      score: 1 / (RRF_K + 1),
      contributors: { vector: 1 },
    });
  });

  test("keyword-only hit surfaces with the source's RRF contribution", () => {
    const hits = hybridRecall([
      vectorOnly([]),
      keywordOnly([7]),
      graphOnly([]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      rid: 7,
      score: 1 / (RRF_K + 1),
      contributors: { keyword: 1 },
    });
  });

  test("graph-only hit surfaces with the source's RRF contribution", () => {
    const hits = hybridRecall([
      vectorOnly([]),
      keywordOnly([]),
      graphOnly([3]),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      rid: 3,
      score: 1 / (RRF_K + 1),
      contributors: { graph: 1 },
    });
  });

  test("a rid that converges across all three axes outranks any single-source rid", () => {
    // rid=1 is rank-1 everywhere; rid=2 is rank-2 in vector only; rid=3 is rank-2 in keyword only.
    const hits = hybridRecall([
      vectorOnly([1, 2]),
      keywordOnly([1, 3]),
      graphOnly([1]),
    ]);
    expect(hits[0].rid).toBe(1);
    expect(hits[0].contributors).toEqual({ vector: 1, keyword: 1, graph: 1 });
    expect(hits[0].score).toBeCloseTo(3 / (RRF_K + 1), 10);
    // Single-source rids share the same rank-2 score → tie-broken by rid asc.
    expect(hits.slice(1).map((h) => h.rid)).toEqual([2, 3]);
    const singleSourceScore = 1 / (RRF_K + 2);
    expect(hits[1].score).toBeCloseTo(singleSourceScore, 10);
    expect(hits[2].score).toBeCloseTo(singleSourceScore, 10);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  test("convergent rid score equals the sum of per-source 1/(k+rank) terms", () => {
    // rid=1 at rank 1 in all three; rid=2 at rank 2 in vector and rank 2 in keyword.
    const hits = hybridRecall([
      vectorOnly([1, 2]),
      keywordOnly([1, 2]),
      graphOnly([1]),
    ]);
    const expected1 = 3 / (RRF_K + 1);
    const expected2 = 2 / (RRF_K + 2);
    expect(hits[0]).toEqual({
      rid: 1,
      score: expected1,
      contributors: { vector: 1, keyword: 1, graph: 1 },
    });
    expect(hits[1]).toEqual({
      rid: 2,
      score: expected2,
      contributors: { vector: 2, keyword: 2 },
    });
    expect(expected1).toBeGreaterThan(expected2);
  });

  test("tie-breaking: equal RRF scores sort by ascending rid", () => {
    // Three rids, each appearing in exactly one source at rank 1 → identical scores.
    const hits = hybridRecall([
      vectorOnly([9]),
      keywordOnly([5]),
      graphOnly([2]),
    ]);
    expect(hits.map((h) => h.rid)).toEqual([2, 5, 9]);
    const score = 1 / (RRF_K + 1);
    expect(hits.every((h) => Math.abs(h.score - score) < 1e-12)).toBe(true);
  });

  test("duplicate rids inside one ranking collapse to the best rank", () => {
    // rid=4 listed twice in vector — only the rank-1 contribution counts.
    const hits = hybridRecall([vectorOnly([4, 4])]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      rid: 4,
      score: 1 / (RRF_K + 1),
      contributors: { vector: 1 },
    });
  });

  test("empty source list is allowed and contributes nothing", () => {
    const hits = hybridRecall([
      vectorOnly([]),
      keywordOnly([10]),
      graphOnly([]),
    ]);
    expect(hits.map((h) => h.rid)).toEqual([10]);
  });

  test("limit truncates the fused output", () => {
    const hits = hybridRecall(
      [vectorOnly([1, 2, 3, 4, 5])],
      { limit: 2 },
    );
    expect(hits.map((h) => h.rid)).toEqual([1, 2]);
  });

  test("custom k value scales the contributions consistently", () => {
    const k = 10;
    const hits = hybridRecall([vectorOnly([7])], { k });
    expect(hits[0].score).toBe(1 / (k + 1));
  });

  test("rerun is deterministic for the same input", () => {
    const rankings: Ranking[] = [
      vectorOnly([1, 3, 5]),
      keywordOnly([3, 1, 2]),
      graphOnly([2, 3]),
    ];
    const a = hybridRecall(rankings);
    const b = hybridRecall(rankings);
    expect(b).toEqual(a);
  });

  test("graph-only neighbor still surfaces alongside text matches", () => {
    // Direct text match (rid=1, keyword rank 1) and a graph-only neighbor (rid=2, graph rank 1).
    // RRF gives each the same score; tie-breaking by rid puts rid=1 first.
    // The relevant invariant here is that both surface — the composer does not
    // drop the graph-only neighbor, which is the property #180 promises.
    const hits = hybridRecall([
      vectorOnly([]),
      keywordOnly([1]),
      graphOnly([2]),
    ]);
    const rids = hits.map((h) => h.rid);
    expect(rids).toContain(1);
    expect(rids).toContain(2);
  });
});
