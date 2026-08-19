import { describe, expect, test } from "vitest";
import {
  buildMemoryMapContextSlice,
  normalizeContextFilters,
  type MemoryMapContextStore,
} from "../src/map-context.js";
import type { StoredNode } from "../src/graph-store.js";

function node(rid: number, label: string, content: string, source = `src/${label}.ts`): StoredNode {
  return {
    rid,
    label,
    node_type: label.startsWith("sym:") ? "symbol" : "concept",
    properties: {
      title: label,
      content,
      source,
      confidence: "EXTRACTED",
    },
  };
}

function store(): MemoryMapContextStore & { accessed: number[] } {
  const accessed: number[] = [];
  return {
    accessed,
    async listNodes() {
      return [
        node(1, "sym:src/auth.ts#issueToken", "issues signed jwt tokens for users"),
        node(2, "sym:src/auth.ts#verifyToken", "verifies signed jwt tokens"),
        node(3, "sym:src/cache.ts#cacheTtl", "redis cache ttl is 300 seconds"),
        node(4, "jwt-rotation-decision", "decision: rotate jwt signing keys quarterly", "docs/adr.md"),
        node(5, "generic-error-handler", "error error error handler"),
      ];
    },
    async listEdges() {
      return [
        {
          from_rid: 1,
          to_rid: 2,
          label: "CALLS",
          weight: 2,
          properties: { confidence: "EXTRACTED" },
        },
        {
          from_rid: 2,
          to_rid: 3,
          label: "IMPORTS",
          properties: { confidence: "EXTRACTED" },
        },
        {
          from_rid: 4,
          to_rid: 1,
          label: "REFERENCES",
          properties: { confidence: "INFERRED" },
        },
      ];
    },
    async communities() {
      return new Map([
        [1, "auth"],
        [2, "auth"],
        [3, "cache"],
        [4, "docs"],
      ]);
    },
    async recordAccess(rids: number[]) {
      accessed.push(...rids);
    },
  };
}

describe("memory map context slice", () => {
  test("selects a rare symbol seed and emits compact NODE/EDGE context", async () => {
    const s = store();
    const slice = await buildMemoryMapContextSlice(s, "issueToken jwt", { depth: 1 });

    expect(slice.schema_version).toBe("memory.map_context.v1");
    expect(slice.seeds[0]?.label).toBe("sym:src/auth.ts#issueToken");
    expect(slice.context_md).toContain("NODE 1 sym:src/auth.ts#issueToken");
    expect(slice.context_md).toContain("EDGE 1 --CALLS");
    expect(slice.context_md).toContain("community=auth");
    expect(s.accessed).toContain(1);
  });

  test("infers call context from the question and avoids import/reference traversal", async () => {
    const slice = await buildMemoryMapContextSlice(store(), "who calls issueToken", { depth: 2 });

    expect(slice.traversal.context_filters).toEqual(["call"]);
    expect(slice.traversal.context_source).toBe("heuristic");
    expect(slice.nodes.map((n) => n.rid).sort()).toEqual([1, 2]);
    expect(slice.nodes.some((n) => n.rid === 3)).toBe(false);
    expect(slice.nodes.some((n) => n.rid === 4)).toBe(false);
  });

  test("explicit context aliases normalize before traversal", async () => {
    expect(normalizeContextFilters(["calls", "refs", "parameter_type"])).toEqual([
      "call",
      "reference",
      "type",
    ]);

    const slice = await buildMemoryMapContextSlice(store(), "jwt rotation", {
      depth: 1,
      contextFilters: ["refs"],
    });
    expect(slice.traversal.context_source).toBe("explicit");
    expect(slice.edges.every((edge) => edge.context === "reference")).toBe(true);
  });

  test("keeps edge weight topological and derives salience separately", async () => {
    const slice = await buildMemoryMapContextSlice(store(), "issueToken", { depth: 1 });
    const call = slice.edges.find((edge) => edge.label === "CALLS");

    expect(call?.weight).toBe(2);
    expect(call?.salience).toBe(2);
  });

  test("dfs does not include edges beyond the selected depth", async () => {
    const slice = await buildMemoryMapContextSlice(store(), "issueToken", {
      depth: 1,
      mode: "dfs",
    });
    const selected = new Set(slice.nodes.map((node) => node.rid));

    expect(slice.edges.length).toBeGreaterThan(0);
    expect(
      slice.edges.every(
        (edge) => selected.has(edge.source_rid) && selected.has(edge.target_rid),
      ),
    ).toBe(true);
  });

  test("truncates markdown by token budget without dropping JSON result details", async () => {
    const slice = await buildMemoryMapContextSlice(store(), "jwt", {
      depth: 2,
      tokenBudget: 100,
    });

    expect(slice.diagnostics.truncated).toBe(true);
    expect(slice.context_md).toContain("truncated");
    expect(slice.nodes.length).toBeGreaterThan(1);
  });
});
