import { z } from "zod";
import type { ExportEdge } from "./export.js";
import type { StoredNode } from "./graph-store.js";

/**
 * Graph contract v1 — the versioned integration seam between `memory:export`
 * and any consumer (red-ui, scripts, future tools).
 *
 * `memory:export` emits this object under `graph.json#contract`. The contract
 * carries a `version` so producers and consumers can negotiate, and is the only
 * part of `graph.json` that consumers should treat as stable. The surrounding
 * dashboard fields (health, evidence, …) are diagnostic and may change.
 *
 * Design notes:
 *  - Every stored edge label collapses onto one of three directional **kinds**
 *    (`imports` | `defines` | `references`). `source → target` is the semantic
 *    direction. `DEFINED_IN` is stored child→parent (symbol defined-in file);
 *    the contract flips it so `defines` always reads parent→child.
 *  - A node is an **orphan** when no edge targets it (no inbound edges). This is
 *    computed at export time over the contract edges, after kind flipping.
 *  - `description` and `exports` round-trip from ingest: `description` prefers an
 *    explicit `properties.description`, then `summary`, then `content`;
 *    `exports` is the `properties.exports` string list captured by extraction.
 */

export const GRAPH_CONTRACT_VERSION = "1.0.0";

export type EdgeKind = "imports" | "defines" | "references";

export interface ContractNode {
  /** Stable node id (RedDB rid). */
  id: number;
  /** Node type (file, symbol, concept, decision, …). */
  type: string;
  /** Stable label/key. */
  label: string;
  /** Human-readable description, round-tripped from ingest; null when absent. */
  description: string | null;
  /** Exported names round-tripped from ingest; empty when none. */
  exports: string[];
  /** Physical memory layer (L1/L2/L3); null when unknown. */
  layer: string | null;
  /** Community/cluster id when community detection ran; null otherwise. */
  community: string | null;
  /** True when no edge targets this node (no inbound edges). */
  orphan: boolean;
  /** Remaining node properties, preserved losslessly for consumers. */
  metadata: Record<string, unknown>;
}

export interface ContractEdge {
  /** Source node id; the edge points source → target. */
  source: number;
  /** Target node id. */
  target: number;
  /** Directional kind the original label collapses onto. */
  kind: EdgeKind;
  /** Original stored edge label, preserved for traceability. */
  label: string;
  /** Edges are directed; `source → target` is the semantic direction. */
  direction: "directed";
}

export interface ContractStats {
  node_count: number;
  edge_count: number;
  orphan_count: number;
  community_count: number;
  edge_kinds: Record<EdgeKind, number>;
  node_types: Record<string, number>;
}

export interface GraphContract {
  version: string;
  nodes: ContractNode[];
  edges: ContractEdge[];
  stats: ContractStats;
}

interface KindRule {
  kind: EdgeKind;
  /** When true, the stored edge is reversed so the kind reads parent→child. */
  flip?: boolean;
}

/**
 * Map a stored {@link EdgeLabel} onto a contract kind. Unknown/future labels
 * default to `references` — lossless and safe, so a new edge label never breaks
 * a consumer that only understands the three kinds.
 */
const EDGE_KIND_RULES: Record<string, KindRule> = {
  IMPORTS: { kind: "imports" },
  // `DEFINED_IN` is stored symbol→file; flip so `defines` reads file→symbol.
  DEFINED_IN: { kind: "defines", flip: true },
  CONTAINS: { kind: "defines" },
};

export function classifyEdgeKind(label: string): KindRule {
  return EDGE_KIND_RULES[label] ?? { kind: "references" };
}

const PROMOTED_PROPS = new Set(["description", "exports", "layer", "community"]);

function nodeDescription(props: Record<string, unknown>): string | null {
  for (const key of ["description", "summary", "content"] as const) {
    const value = props[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function nodeExports(props: Record<string, unknown>): string[] {
  const value = props.exports;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function nodeMetadata(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!PROMOTED_PROPS.has(key)) out[key] = value;
  }
  return out;
}

export interface BuildContractInput {
  nodes: StoredNode[];
  edges: ExportEdge[];
  communities?: Map<number, string>;
}

export function buildGraphContract({
  nodes,
  edges,
  communities = new Map(),
}: BuildContractInput): GraphContract {
  const contractEdges: ContractEdge[] = edges.map((edge) => {
    const rule = classifyEdgeKind(edge.label);
    const [source, target] = rule.flip ? [edge.to, edge.from] : [edge.from, edge.to];
    return { source, target, kind: rule.kind, label: edge.label, direction: "directed" as const };
  });

  const inbound = new Set<number>(contractEdges.map((edge) => edge.target));

  const contractNodes: ContractNode[] = nodes.map((node) => {
    const props = node.properties as Record<string, unknown>;
    return {
      id: node.rid,
      type: node.node_type,
      label: node.label,
      description: nodeDescription(props),
      exports: nodeExports(props),
      layer: typeof props.layer === "string" ? props.layer : null,
      community: communities.get(node.rid) ?? null,
      orphan: !inbound.has(node.rid),
      metadata: nodeMetadata(props),
    };
  });

  const edgeKinds: Record<EdgeKind, number> = { imports: 0, defines: 0, references: 0 };
  for (const edge of contractEdges) edgeKinds[edge.kind] += 1;

  const nodeTypes: Record<string, number> = {};
  for (const node of contractNodes) nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;

  return {
    version: GRAPH_CONTRACT_VERSION,
    nodes: contractNodes,
    edges: contractEdges,
    stats: {
      node_count: contractNodes.length,
      edge_count: contractEdges.length,
      orphan_count: contractNodes.filter((node) => node.orphan).length,
      community_count: new Set(
        contractNodes.map((node) => node.community).filter((c): c is string => c != null),
      ).size,
      edge_kinds: edgeKinds,
      node_types: nodeTypes,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EDGE_KIND = z.enum(["imports", "defines", "references"]);

const ContractNodeZ = z.object({
  id: z.number(),
  type: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  exports: z.array(z.string()),
  layer: z.string().nullable(),
  community: z.string().nullable(),
  orphan: z.boolean(),
  metadata: z.record(z.unknown()),
});

const ContractEdgeZ = z.object({
  source: z.number(),
  target: z.number(),
  kind: EDGE_KIND,
  label: z.string(),
  direction: z.literal("directed"),
});

const ContractStatsZ = z.object({
  node_count: z.number(),
  edge_count: z.number(),
  orphan_count: z.number(),
  community_count: z.number(),
  edge_kinds: z.object({
    imports: z.number(),
    defines: z.number(),
    references: z.number(),
  }),
  node_types: z.record(z.number()),
});

export const GraphContractZ = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  nodes: z.array(ContractNodeZ),
  edges: z.array(ContractEdgeZ),
  stats: ContractStatsZ,
});

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate an arbitrary value against the graph contract schema. */
export function validateGraphContract(value: unknown): ValidationResult {
  const parsed = GraphContractZ.safeParse(value);
  if (parsed.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

/**
 * The contract as a self-contained JSON Schema (draft-07) document — the
 * canonical, language-neutral spec external consumers can validate against
 * without importing this package. Kept in lockstep with {@link GraphContractZ}.
 */
export function graphContractJsonSchema(): Record<string, any> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://reddb.io/schemas/memory/graph-contract/v1.json",
    title: "Memory graph contract",
    description:
      "Versioned integration seam emitted by memory:export at graph.json#contract.",
    type: "object",
    required: ["version", "nodes", "edges", "stats"],
    additionalProperties: false,
    properties: {
      version: { const: GRAPH_CONTRACT_VERSION },
      nodes: {
        type: "array",
        items: {
          type: "object",
          required: [
            "id",
            "type",
            "label",
            "description",
            "exports",
            "layer",
            "community",
            "orphan",
            "metadata",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "integer" },
            type: { type: "string" },
            label: { type: "string" },
            description: { type: ["string", "null"] },
            exports: { type: "array", items: { type: "string" } },
            layer: { type: ["string", "null"] },
            community: { type: ["string", "null"] },
            orphan: { type: "boolean" },
            metadata: { type: "object" },
          },
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          required: ["source", "target", "kind", "label", "direction"],
          additionalProperties: false,
          properties: {
            source: { type: "integer" },
            target: { type: "integer" },
            kind: { enum: ["imports", "defines", "references"] },
            label: { type: "string" },
            direction: { const: "directed" },
          },
        },
      },
      stats: {
        type: "object",
        required: [
          "node_count",
          "edge_count",
          "orphan_count",
          "community_count",
          "edge_kinds",
          "node_types",
        ],
        additionalProperties: false,
        properties: {
          node_count: { type: "integer" },
          edge_count: { type: "integer" },
          orphan_count: { type: "integer" },
          community_count: { type: "integer" },
          edge_kinds: {
            type: "object",
            required: ["imports", "defines", "references"],
            additionalProperties: false,
            properties: {
              imports: { type: "integer" },
              defines: { type: "integer" },
              references: { type: "integer" },
            },
          },
          node_types: {
            type: "object",
            additionalProperties: { type: "integer" },
          },
        },
      },
    },
  };
}
