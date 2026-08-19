import { describe, expect, test } from "vitest";
import {
  ARCHITECTURE_OVERVIEW_SCHEMA_VERSION,
  buildArchitectureOverview,
} from "../src/architecture-overview.js";
import { GRAPH_CONTRACT_VERSION, buildGraphContract } from "../src/graph-contract.js";
import type { ExportEdge } from "../src/export.js";
import type { StoredNode } from "../src/graph-store.js";

/**
 * Fixture: two layers and two communities with known cross-connections so the
 * overview's per-group counts are pinned exactly.
 *
 *   file(1)  L3 / c0   --IMPORTS--> import(3) L3 / c0      (internal to L3 + c0)
 *   sym(2)   L2 / c0   --DEFINED_IN--> file(1) L3 / c0     (stored child→parent; flips to file→sym; crosses L3↔L2, internal to c0)
 *   sym(2)   L2 / c1   ... actually sym(4) L2 / c1
 *   sym(2)   L2 / c0   --CALLS--> sym(4) L2 / c1           (internal to L2, crosses c0↔c1)
 *   note(5)  unassigned layer / no community                orphan, isolated
 */
function fixtureContract() {
  const node = (
    rid: number,
    node_type: StoredNode["node_type"],
    label: string,
    properties: Record<string, unknown>,
  ): StoredNode => ({ rid, label, node_type, properties: properties as StoredNode["properties"] });

  const nodes: StoredNode[] = [
    node(1, "file", "file:/repo/src/auth.ts", { title: "auth.ts", layer: "L3" }),
    node(2, "symbol", "sym:issueToken", { title: "issueToken", summary: "fn", layer: "L2" }),
    node(3, "import", "import:node:crypto", { title: "node:crypto", layer: "L3" }),
    node(4, "symbol", "sym:verifyToken", { title: "verifyToken", summary: "fn", layer: "L2" }),
    node(5, "concept", "lonely-note", { title: "lonely note", content: "isolated" }),
  ];

  const edge = (rid: number, label: string, from: number, to: number): ExportEdge => ({
    rid,
    label,
    from,
    to,
    weight: 1,
    properties: {},
  });

  const edges: ExportEdge[] = [
    edge(11, "IMPORTS", 1, 3), // L3→L3, c0→c0
    edge(10, "DEFINED_IN", 2, 1), // stored sym→file; flips to file(1,L3)→sym(2,L2)
    edge(12, "CALLS", 2, 4), // L2→L2, c0→c1
  ];

  const communities = new Map<number, string>([
    [1, "c0"],
    [2, "c0"],
    [3, "c0"],
    [4, "c1"],
  ]);

  return buildGraphContract({ nodes, edges, communities });
}

describe("buildArchitectureOverview", () => {
  test("carries a schema version and echoes the source contract version", () => {
    const overview = buildArchitectureOverview(fixtureContract());
    expect(overview.schema_version).toBe(ARCHITECTURE_OVERVIEW_SCHEMA_VERSION);
    expect(overview.generated_from.contract_version).toBe(GRAPH_CONTRACT_VERSION);
  });

  test("summarises totals from the contract stats", () => {
    const overview = buildArchitectureOverview(fixtureContract());
    expect(overview.totals).toMatchObject({
      nodes: 5,
      edges: 3,
      communities: 2,
      orphans: expect.any(Number),
      edge_kinds: { imports: 1, defines: 1, references: 1 },
    });
  });

  test("summarises layers with internal vs external connection counts", () => {
    const overview = buildArchitectureOverview(fixtureContract());
    const byLayer = new Map(overview.layers.map((l) => [l.layer, l]));

    // L3 nodes: file(1), import(3). Edges touching L3: IMPORTS(1→3) internal,
    // defines(1→2) external (L3→L2).
    expect(byLayer.get("L3")).toMatchObject({
      nodes: 2,
      internalConnections: 1,
      externalConnections: 1,
    });
    // L2 nodes: sym(2), sym(4). CALLS(2→4) internal; defines(1→2) external.
    expect(byLayer.get("L2")).toMatchObject({
      nodes: 2,
      internalConnections: 1,
      externalConnections: 1,
    });
    // note(5) has no layer → bucketed as unassigned, no connections.
    expect(byLayer.get("unassigned")).toMatchObject({
      nodes: 1,
      internalConnections: 0,
      externalConnections: 0,
    });
  });

  test("summarises communities with internal vs external connection counts", () => {
    const overview = buildArchitectureOverview(fixtureContract());
    const byCommunity = new Map(overview.communities.map((c) => [c.community, c]));

    // c0: file(1), sym(2), import(3). IMPORTS(1→3) internal, defines(1→2) internal,
    // CALLS(2→4) external (c0→c1).
    expect(byCommunity.get("c0")).toMatchObject({
      nodes: 3,
      internalConnections: 2,
      externalConnections: 1,
    });
    // c1: sym(4). CALLS(2→4) external.
    expect(byCommunity.get("c1")).toMatchObject({
      nodes: 1,
      internalConnections: 0,
      externalConnections: 1,
    });
  });

  test("orders layers by name with unassigned last, communities by size", () => {
    const overview = buildArchitectureOverview(fixtureContract());
    expect(overview.layers.map((l) => l.layer)).toEqual(["L2", "L3", "unassigned"]);
    // c0 (3 nodes) before c1 (1 node).
    expect(overview.communities.map((c) => c.community)).toEqual(["c0", "c1"]);
  });

  test("renders a single markdown overview that frames itself against the wiki", () => {
    const overview = buildArchitectureOverview(fixtureContract());
    expect(overview.markdown).toContain("# Architecture overview");
    // AC4: explicitly complements (not replaces) the richer wiki.
    expect(overview.markdown.toLowerCase()).toContain("wiki");
    expect(overview.markdown).toContain("## Layers");
    expect(overview.markdown).toContain("## Communities");
    expect(overview.markdown).toContain("L3");
    expect(overview.markdown).toContain("c0");
    // Generated from the contract version, surfaced for traceability.
    expect(overview.markdown).toContain(GRAPH_CONTRACT_VERSION);
  });

  test("handles an empty graph without throwing", () => {
    const empty = buildGraphContract({ nodes: [], edges: [], communities: new Map() });
    const overview = buildArchitectureOverview(empty);
    expect(overview.totals.nodes).toBe(0);
    expect(overview.layers).toEqual([]);
    expect(overview.communities).toEqual([]);
    expect(overview.markdown).toContain("# Architecture overview");
  });
});
