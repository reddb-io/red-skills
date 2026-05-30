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

  test("surfaces call graph and type-use dependents as explicit risks", async () => {
    const target = node(1, "file:src/auth.ts", "file", "src/auth.ts");
    const rotateToken = node(2, "sym:src/auth.ts#rotateToken", "symbol", "rotateToken");
    const tokenPayload = node(3, "sym:src/auth.ts#TokenPayload", "symbol", "TokenPayload");
    const caller = node(
      4,
      "sym:src/session.ts#refreshSession",
      "symbol",
      "refreshSession",
      "Refreshes the session token.",
    );
    const typeConsumer = node(
      5,
      "sym:src/api.ts#serializeToken",
      "symbol",
      "serializeToken",
      "Serializes token payloads for API responses.",
    );

    const result = await buildPrePrMemoryReview(store(
      [target, rotateToken, tokenPayload, caller, typeConsumer],
      [
        edge(rotateToken.rid, target.rid, "DEFINED_IN"),
        edge(tokenPayload.rid, target.rid, "DEFINED_IN"),
        edge(caller.rid, rotateToken.rid, "CALLS"),
        edge(typeConsumer.rid, tokenPayload.rid, "USES_TYPE"),
      ],
    ), { changedFiles: ["src/auth.ts"] });

    expect(result.risks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Call graph dependency may be affected: refreshSession",
          evidence: [expect.objectContaining({ rid: caller.rid })],
        }),
        expect.objectContaining({
          title: "Type-use dependency may be affected: serializeToken",
          evidence: [expect.objectContaining({ rid: typeConsumer.rid })],
        }),
      ]),
    );
    expect(result.missingEvidence).not.toContain("risks");
  });

  test("surfaces SQL reference dependents as explicit risks", async () => {
    const sessionsFile = node(1, "file:db/sessions.sql", "file", "db/sessions.sql");
    const usersFile = node(2, "file:db/users.sql", "file", "db/users.sql");
    const sessions = node(3, "sql:db/sessions.sql#sessions", "symbol", "sessions");
    const sessionUserId = node(
      4,
      "sql:db/sessions.sql#sessions.user_id",
      "symbol",
      "sessions.user_id",
      "Foreign key column for session ownership.",
    );
    const users = node(
      5,
      "sql:db/users.sql#users",
      "symbol",
      "users",
      "Primary user table referenced by session records.",
    );

    const result = await buildPrePrMemoryReview(store(
      [sessionsFile, usersFile, sessions, sessionUserId, users],
      [
        edge(sessions.rid, sessionsFile.rid, "DEFINED_IN"),
        edge(sessionUserId.rid, sessionsFile.rid, "DEFINED_IN"),
        edge(users.rid, usersFile.rid, "DEFINED_IN"),
        edge(sessionUserId.rid, users.rid, "REFERENCES"),
      ],
    ), { changedFiles: ["db/sessions.sql"] });

    expect(result.risks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Reference dependency may be affected: users",
          evidence: [expect.objectContaining({ rid: users.rid })],
        }),
      ]),
    );
    expect(result.missingEvidence).not.toContain("risks");
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
