import { describe, expect, test } from "vitest";
import { buildPrePrMemoryReview } from "../src/pre-pr-review.js";
import type { MemoryEdge, MemoryNode } from "../src/schema.js";

type StoredNode = MemoryNode & { rid: number };

function node(
  rid: number,
  label: string,
  node_type: MemoryNode["node_type"],
  title: string,
  content = title,
): StoredNode {
  return {
    rid,
    label,
    node_type,
    properties: {
      title,
      content,
      source: "fixture",
      confidence: "EXTRACTED",
    },
  };
}

function edge(from_rid: number, to_rid: number, label: MemoryEdge["label"]): MemoryEdge {
  return { from_rid, to_rid, label };
}

function store(nodes: StoredNode[], edges: MemoryEdge[]) {
  return {
    listNodes: async () => nodes,
    listEdges: async () => edges,
  };
}

describe("buildPrePrMemoryReview", () => {
  test("summarizes changed code impact with cited decisions and concepts", async () => {
    const target = node(1, "file:src/auth.ts", "file", "src/auth.ts");
    const exported = node(2, "sym:src/auth.ts#rotateToken", "symbol", "rotateToken");
    const concept = node(3, "concept:jwt-rotation", "concept", "JWT rotation");
    const decision = node(
      4,
      "decision:jwt-ttl",
      "decision",
      "JWT TTL policy",
      "Keep JWT access tokens below 15 minutes.",
    );
    const result = await buildPrePrMemoryReview(store(
      [target, exported, concept, decision],
      [
        edge(exported.rid, target.rid, "DEFINED_IN"),
        edge(exported.rid, concept.rid, "REFERENCES"),
        edge(decision.rid, concept.rid, "MENTIONS"),
      ],
    ), { changedFiles: ["src/auth.ts"] });

    expect(result.changedFiles).toEqual(["src/auth.ts"]);
    expect(result.impactedConcepts.items).toEqual([
      expect.objectContaining({
        title: "JWT rotation",
        evidence: [expect.objectContaining({ marker: "[1]", rid: concept.rid })],
      }),
    ]);
    expect(result.relatedDecisions.items).toEqual([
      expect.objectContaining({
        title: "JWT TTL policy",
        evidence: [expect.objectContaining({ marker: "[2]", rid: decision.rid })],
      }),
    ]);
    expect(result.missingEvidence).not.toContain("impacted concepts");
    expect(result.missingEvidence).not.toContain("related decisions");
  });

  test("surfaces known failures and suggested validations from related evidence", async () => {
    const target = node(1, "file:src/cache.ts", "file", "src/cache.ts");
    const exported = node(2, "sym:src/cache.ts#refreshCache", "symbol", "refreshCache");
    const failure = node(
      3,
      "problem:cache-timeout",
      "problem",
      "Cache refresh timeout",
      "Refresh failed when the Redis fixture exceeded 250ms.",
    );
    const validation = node(
      4,
      "validation:cache-suite",
      "validation",
      "cache integration test",
      "Run pnpm test tests/cache.integration.test.ts",
    );

    const result = await buildPrePrMemoryReview(store(
      [target, exported, failure, validation],
      [
        edge(exported.rid, target.rid, "DEFINED_IN"),
        edge(failure.rid, exported.rid, "CAUSES"),
        edge(failure.rid, validation.rid, "TESTED_BY"),
      ],
    ), { changedFiles: ["src/cache.ts"] });

    expect(result.knownFailures.items).toEqual([
      expect.objectContaining({
        title: "Cache refresh timeout",
        evidence: [expect.objectContaining({ marker: "[1]", rid: failure.rid })],
      }),
    ]);
    expect(result.suggestedValidations.items).toEqual([
      expect.objectContaining({
        title: "cache integration test",
        evidence: [expect.objectContaining({ marker: "[2]", rid: validation.rid })],
      }),
    ]);
    expect(result.risks.items[0]).toEqual(
      expect.objectContaining({
        title: "Known failure risk: Cache refresh timeout",
        evidence: [expect.objectContaining({ rid: failure.rid })],
      }),
    );
  });

  test("reports missing evidence explicitly and remains snapshot-only", async () => {
    const calls: string[] = [];
    const result = await buildPrePrMemoryReview({
      listNodes: async () => {
        calls.push("listNodes");
        return [];
      },
      listEdges: async () => {
        calls.push("listEdges");
        return [];
      },
    }, { changedFiles: ["src/missing.ts"], comparison: "main...HEAD" });

    expect(calls).toEqual(["listNodes", "listEdges"]);
    expect(result).toMatchObject({
      comparison: "main...HEAD",
      changedFiles: ["src/missing.ts"],
      readOnly: true,
      evidence: [],
    });
    expect(result.missingEvidence).toEqual([
      "impacted concepts",
      "related decisions",
      "known failures",
      "suggested validations",
      "risks",
    ]);
  });
});
