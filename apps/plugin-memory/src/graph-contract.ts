import { z } from "zod";
import type { ExportEdge } from "./export.js";
import type { StoredNode } from "./graph-store.js";

/**
 * Graph contract v2 — the versioned integration seam between RedDB-backed
 * Memory state and any consumer (red-ui, scripts, future tools).
 *
 * `memory map-contract` and the MCP `memory_map_contract` tool return this
 * object directly. `memory:export` also emits it under `graph.json#contract`.
 * The contract carries a `version` so producers and consumers can negotiate,
 * and is the only part of `graph.json` that consumers should treat as stable.
 * The surrounding dashboard fields (health, evidence, …) are diagnostic and
 * may change.
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

export const GRAPH_CONTRACT_VERSION = "2.0.0";

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
  /** Producer confidence signal; null when unavailable on legacy rows. */
  confidence: string | null;
  /** Canonical source path/range/URN string; null when unavailable. */
  source_location: string | null;
  /** Write provenance as stored by Memory; null when unavailable. */
  provenance: Record<string, unknown> | null;
  /** Authority tier for ranking/governance; null when unavailable on legacy rows. */
  provenance_tier: "oracle" | "proxy" | null;
  /** Freshness timestamps and retention horizon, in epoch ms when available. */
  freshness: ContractFreshness;
  /** Node salience signal for ranking/filtering; null when unavailable. */
  salience: number | null;
  /** True when no edge targets this node (no inbound edges). */
  orphan: boolean;
  /** Remaining node properties, preserved losslessly for consumers. */
  metadata: Record<string, unknown>;
}

export interface ContractEdge {
  /** Stable edge id (RedDB rid). */
  id: number;
  /** Source node id; the edge points source → target. */
  source: number;
  /** Target node id. */
  target: number;
  /** Directional kind the original label collapses onto. */
  kind: EdgeKind;
  /** Original stored edge label, preserved for traceability. */
  label: string;
  /** RedDB edge weight. Distinct from salience. */
  weight: number;
  /** Consumer ranking salience. Null when Memory has not computed one. */
  salience: number | null;
  /** Producer confidence signal; null when unavailable on legacy rows. */
  confidence: string | null;
  /** Canonical source path/range/URN string; null when unavailable. */
  source_location: string | null;
  /** Write provenance as stored by Memory; null when unavailable. */
  provenance: Record<string, unknown> | null;
  /** Authority tier for ranking/governance; null when unavailable on legacy rows. */
  provenance_tier: "oracle" | "proxy" | null;
  /** Freshness timestamps and retention horizon, in epoch ms when available. */
  freshness: ContractFreshness;
  /** Edges are directed; `source → target` is the semantic direction. */
  direction: "directed";
  /** Remaining edge properties, preserved losslessly for consumers. */
  metadata: Record<string, unknown>;
}

export interface ContractFreshness {
  created_at: number | null;
  updated_at: number | null;
  accessed_at?: number | null;
  expires_at?: number | null;
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

const PROMOTED_NODE_PROPS = new Set([
  "description",
  "exports",
  "layer",
  "community",
  "confidence",
  "source",
  "source_location",
  "provenance",
  "provenance_tier",
  "created_at",
  "updated_at",
  "accessed_at",
  "expires_at",
  "salience",
]);

const PROMOTED_EDGE_PROPS = new Set([
  "weight",
  "confidence",
  "source",
  "source_location",
  "provenance",
  "provenance_tier",
  "created_at",
  "updated_at",
  "expires_at",
  "salience",
]);

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

function metadataWithout(
  props: Record<string, unknown>,
  promoted: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!promoted.has(key)) out[key] = value;
  }
  return out;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function confidenceValue(props: Record<string, unknown>): string | null {
  const provenance = recordValue(props.provenance);
  return stringValue(props.confidence) ?? stringValue(provenance?.confidence);
}

function provenanceTierValue(props: Record<string, unknown>): "oracle" | "proxy" | null {
  const value = props.provenance_tier;
  return value === "oracle" || value === "proxy" ? value : null;
}

function sourceLocation(props: Record<string, unknown>): string | null {
  return stringValue(props.source_location) ?? stringValue(props.source);
}

function freshness(props: Record<string, unknown>, includeAccess = false): ContractFreshness {
  return {
    created_at: numberValue(props.created_at),
    updated_at: numberValue(props.updated_at),
    ...(includeAccess ? { accessed_at: numberValue(props.accessed_at) } : {}),
    ...(props.expires_at != null ? { expires_at: numberValue(props.expires_at) } : {}),
  };
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
    const props = edge.properties as Record<string, unknown>;
    return {
      id: edge.rid,
      source,
      target,
      kind: rule.kind,
      label: edge.label,
      weight: edge.weight,
      salience: numberValue(props.salience),
      confidence: confidenceValue(props),
      source_location: sourceLocation(props),
      provenance: recordValue(props.provenance),
      provenance_tier: provenanceTierValue(props),
      freshness: freshness(props),
      direction: "directed" as const,
      metadata: metadataWithout(props, PROMOTED_EDGE_PROPS),
    };
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
      confidence: confidenceValue(props),
      source_location: sourceLocation(props),
      provenance: recordValue(props.provenance),
      provenance_tier: provenanceTierValue(props),
      freshness: freshness(props, true),
      salience: numberValue(props.salience),
      orphan: !inbound.has(node.rid),
      metadata: metadataWithout(props, PROMOTED_NODE_PROPS),
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
  confidence: z.string().nullable(),
  source_location: z.string().nullable(),
  provenance: z.record(z.unknown()).nullable(),
  provenance_tier: z.enum(["oracle", "proxy"]).nullable(),
  freshness: z.object({
    created_at: z.number().nullable(),
    updated_at: z.number().nullable(),
    accessed_at: z.number().nullable().optional(),
    expires_at: z.number().nullable().optional(),
  }),
  salience: z.number().nullable(),
  orphan: z.boolean(),
  metadata: z.record(z.unknown()),
});

const ContractEdgeZ = z.object({
  id: z.number(),
  source: z.number(),
  target: z.number(),
  kind: EDGE_KIND,
  label: z.string(),
  weight: z.number(),
  salience: z.number().nullable(),
  confidence: z.string().nullable(),
  source_location: z.string().nullable(),
  provenance: z.record(z.unknown()).nullable(),
  provenance_tier: z.enum(["oracle", "proxy"]).nullable(),
  freshness: z.object({
    created_at: z.number().nullable(),
    updated_at: z.number().nullable(),
    expires_at: z.number().nullable().optional(),
  }),
  direction: z.literal("directed"),
  metadata: z.record(z.unknown()),
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
    $id: "https://reddb.io/schemas/memory/graph-contract/v2.json",
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
            "confidence",
            "source_location",
            "provenance",
            "provenance_tier",
            "freshness",
            "salience",
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
            confidence: { type: ["string", "null"] },
            source_location: { type: ["string", "null"] },
            provenance: { type: ["object", "null"] },
            provenance_tier: { enum: ["oracle", "proxy", null] },
            freshness: {
              type: "object",
              required: ["created_at", "updated_at"],
              additionalProperties: false,
              properties: {
                created_at: { type: ["number", "null"] },
                updated_at: { type: ["number", "null"] },
                accessed_at: { type: ["number", "null"] },
                expires_at: { type: ["number", "null"] },
              },
            },
            salience: { type: ["number", "null"] },
            orphan: { type: "boolean" },
            metadata: { type: "object" },
          },
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          required: [
            "id",
            "source",
            "target",
            "kind",
            "label",
            "weight",
            "salience",
            "confidence",
            "source_location",
            "provenance",
            "provenance_tier",
            "freshness",
            "direction",
            "metadata",
          ],
          additionalProperties: false,
          properties: {
            id: { type: "integer" },
            source: { type: "integer" },
            target: { type: "integer" },
            kind: { enum: ["imports", "defines", "references"] },
            label: { type: "string" },
            weight: { type: "number" },
            salience: { type: ["number", "null"] },
            confidence: { type: ["string", "null"] },
            source_location: { type: ["string", "null"] },
            provenance: { type: ["object", "null"] },
            provenance_tier: { enum: ["oracle", "proxy", null] },
            freshness: {
              type: "object",
              required: ["created_at", "updated_at"],
              additionalProperties: false,
              properties: {
                created_at: { type: ["number", "null"] },
                updated_at: { type: ["number", "null"] },
                expires_at: { type: ["number", "null"] },
              },
            },
            direction: { const: "directed" },
            metadata: { type: "object" },
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
