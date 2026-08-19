import { describe, expect, test } from "vitest";
import {
  GRAPH_CONTRACT_VERSION,
  buildGraphContract,
  classifyEdgeKind,
  graphContractJsonSchema,
  validateGraphContract,
} from "../src/graph-contract.js";
import type { ExportEdge } from "../src/export.js";
import type { StoredNode } from "../src/graph-store.js";

/**
 * Fixture: a tiny graph with known shape so the contract's derivations are
 * pinned exactly.
 *
 *   file(1)  --DEFINED_IN(from sym)-->            parent/child: file defines sym
 *   sym(2)   --DEFINED_IN--> file(1)              (stored child→parent)
 *   file(1)  --IMPORTS--> import(3)               imports kind
 *   sym(2)   --CALLS--> sym(4)                     references kind
 *   note(5)                                        orphan: no inbound edges
 *
 * Communities: file(1)/sym(2)/import(3)/sym(4) in "c0"; note(5) in "c1".
 */
function fixture(): { nodes: StoredNode[]; edges: ExportEdge[]; communities: Map<number, string> } {
  const node = (
    rid: number,
    node_type: StoredNode["node_type"],
    label: string,
    properties: Record<string, unknown>,
  ): StoredNode => ({ rid, label, node_type, properties: properties as StoredNode["properties"] });

  const nodes: StoredNode[] = [
    node(1, "file", "file:/repo/src/auth.ts", {
      title: "/repo/src/auth.ts",
      language: "typescript",
      description: "auth module",
      exports: ["issueToken", "TokenStore"],
      layer: "L3",
      confidence: "EXTRACTED",
      source: "src/auth.ts",
      salience: 0.83,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_100_000,
      accessed_at: 1_700_000_200_000,
      provenance: {
        source_kind: "derived",
        writer: "memory ingest",
        confidence: "EXTRACTED",
        evidence: ["src/auth.ts:1"],
      },
    }),
    node(2, "symbol", "sym:/repo/src/auth.ts#issueToken", {
      title: "issueToken",
      summary: "function",
      layer: "L3",
    }),
    node(3, "import", "import:/repo/src/auth.ts#node:crypto", { title: "node:crypto" }),
    node(4, "symbol", "sym:/repo/src/auth.ts#verifyToken", {
      title: "verifyToken",
      summary: "const",
    }),
    node(5, "concept", "lonely-note", { title: "lonely note", content: "no inbound edges" }),
  ];

  const edge = (
    rid: number,
    label: string,
    from: number,
    to: number,
    properties: Record<string, unknown> = {},
    weight = 1,
  ): ExportEdge => ({
    rid,
    label,
    from,
    to,
    weight,
    properties,
  });

  const edges: ExportEdge[] = [
    edge(
      10,
      "DEFINED_IN",
      2,
      1,
      {
        confidence: "EXTRACTED",
        source: "src/auth.ts:1",
        salience: 0.71,
        created_at: 1_700_000_300_000,
        reason: "code extraction",
        provenance: { source_kind: "derived", evidence: ["src/auth.ts:1"] },
      },
      2.5,
    ), // symbol defined in file (child→parent as stored)
    edge(11, "IMPORTS", 1, 3), // file imports specifier
    edge(12, "CALLS", 2, 4), // symbol references symbol
  ];

  const communities = new Map<number, string>([
    [1, "c0"],
    [2, "c0"],
    [3, "c0"],
    [4, "c0"],
    [5, "c1"],
  ]);

  return { nodes, edges, communities };
}

describe("classifyEdgeKind", () => {
  test("maps stored labels onto the three contract kinds", () => {
    expect(classifyEdgeKind("IMPORTS").kind).toBe("imports");
    expect(classifyEdgeKind("DEFINED_IN").kind).toBe("defines");
    expect(classifyEdgeKind("CONTAINS").kind).toBe("defines");
    expect(classifyEdgeKind("CALLS").kind).toBe("references");
    expect(classifyEdgeKind("REFERENCES").kind).toBe("references");
    // Unknown labels fall back to references — the safe, lossless default.
    expect(classifyEdgeKind("SOME_FUTURE_LABEL").kind).toBe("references");
  });

  test("DEFINED_IN flips so `defines` reads parent→child (file defines symbol)", () => {
    expect(classifyEdgeKind("DEFINED_IN").flip).toBe(true);
    expect(classifyEdgeKind("IMPORTS").flip).toBeFalsy();
  });
});

describe("buildGraphContract", () => {
  test("carries the schema version", () => {
    const contract = buildGraphContract(fixture());
    expect(contract.version).toBe(GRAPH_CONTRACT_VERSION);
  });

  test("nodes round-trip canonical fields and consumer metadata", () => {
    const contract = buildGraphContract(fixture());
    const file = contract.nodes.find((n) => n.id === 1)!;
    expect(file).toMatchObject({
      id: 1,
      type: "file",
      label: "file:/repo/src/auth.ts",
      description: "auth module",
      exports: ["issueToken", "TokenStore"],
      layer: "L3",
      community: "c0",
      confidence: "EXTRACTED",
      source_location: "src/auth.ts",
      salience: 0.83,
      freshness: {
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
        accessed_at: 1_700_000_200_000,
      },
      provenance: {
        source_kind: "derived",
        writer: "memory ingest",
        confidence: "EXTRACTED",
        evidence: ["src/auth.ts:1"],
      },
    });
    expect(file.metadata).toMatchObject({ title: "/repo/src/auth.ts", language: "typescript" });
    expect(file.metadata).not.toHaveProperty("provenance");
    // A symbol's description falls back to its `summary` captured by ingest.
    const sym = contract.nodes.find((n) => n.id === 2)!;
    expect(sym.description).toBe("function");
    expect(sym.exports).toEqual([]);
  });

  test("edges carry directional kind, with DEFINED_IN flipped parent→child", () => {
    const contract = buildGraphContract(fixture());
    const defines = contract.edges.find((e) => e.kind === "defines")!;
    expect(defines).toMatchObject({ source: 1, target: 2, kind: "defines", direction: "directed" });
    const imports = contract.edges.find((e) => e.kind === "imports")!;
    expect(imports).toMatchObject({ source: 1, target: 3, kind: "imports" });
    const references = contract.edges.find((e) => e.kind === "references")!;
    expect(references).toMatchObject({ source: 2, target: 4, kind: "references" });
  });

  test("edges carry separate weight and salience plus provenance metadata", () => {
    const contract = buildGraphContract(fixture());
    const defines = contract.edges.find((e) => e.kind === "defines")!;
    expect(defines).toMatchObject({
      id: 10,
      weight: 2.5,
      salience: 0.71,
      confidence: "EXTRACTED",
      source_location: "src/auth.ts:1",
      freshness: { created_at: 1_700_000_300_000, updated_at: null },
      provenance: { source_kind: "derived", evidence: ["src/auth.ts:1"] },
      metadata: { reason: "code extraction" },
    });
    expect(defines.metadata).not.toHaveProperty("salience");
  });

  test("flags orphans by absence of inbound edges", () => {
    const contract = buildGraphContract(fixture());
    const orphans = contract.nodes.filter((n) => n.orphan).map((n) => n.id).sort();
    // file(1) has no inbound (nothing targets it after the flip); note(5) is isolated.
    expect(orphans).toEqual([1, 5]);
    expect(contract.nodes.find((n) => n.id === 2)!.orphan).toBe(false); // defined-in from file
    expect(contract.nodes.find((n) => n.id === 3)!.orphan).toBe(false); // imported
    expect(contract.nodes.find((n) => n.id === 4)!.orphan).toBe(false); // referenced
  });

  test("stats summarize counts, kinds, types, communities, orphans", () => {
    const contract = buildGraphContract(fixture());
    expect(contract.stats).toMatchObject({
      node_count: 5,
      edge_count: 3,
      orphan_count: 2,
      community_count: 2,
      edge_kinds: { imports: 1, defines: 1, references: 1 },
    });
    expect(contract.stats.node_types).toMatchObject({ file: 1, symbol: 2, import: 1, concept: 1 });
  });
});

describe("validateGraphContract", () => {
  test("accepts a contract built by buildGraphContract", () => {
    const contract = buildGraphContract(fixture());
    const result = validateGraphContract(contract);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects an edge with an unknown kind", () => {
    const contract = buildGraphContract(fixture());
    const broken = {
      ...contract,
      edges: [{ ...contract.edges[0], kind: "wat" }],
    };
    const result = validateGraphContract(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/kind/);
  });

  test("rejects a node missing the orphan flag", () => {
    const contract = buildGraphContract(fixture());
    const { orphan: _drop, ...nodeMissingOrphan } = contract.nodes[0];
    const broken = { ...contract, nodes: [nodeMissingOrphan, ...contract.nodes.slice(1)] };
    expect(validateGraphContract(broken).valid).toBe(false);
  });
});

describe("graphContractJsonSchema", () => {
  test("is a documented, versioned draft-07 schema with nodes/edges/stats", () => {
    const schema = graphContractJsonSchema();
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.title).toMatch(/graph contract/i);
    expect(schema.properties.version.const).toBe(GRAPH_CONTRACT_VERSION);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["version", "nodes", "edges", "stats"]),
    );
  });
});
