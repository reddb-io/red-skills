import type { MemoryStore, StoredNode, VectorStatusReport } from "./graph-store.js";
import { readMemoryEvents, type MemoryEvent } from "./memory-events.js";
import type { EdgeLabel, NodeType } from "./schema.js";

export type MemoryLayerId =
  | "short-term"
  | "long-term"
  | "reasoning"
  | "docs-code"
  | "vectors";

export type MemoryLayerStatus = "ready" | "available" | "empty" | "degraded";

export interface MemoryLayer {
  id: MemoryLayerId;
  title: string;
  status: MemoryLayerStatus;
  red_db_collections: string[];
  counts: Record<string, number | string>;
  evidence: string[];
  notes: string[];
}

export interface MemoryLayersReport {
  schema_version: "memory.memory_layers.v1";
  read_only: true;
  generated_at: string;
  summary: {
    total_layers: number;
    ready_layers: number;
    available_layers: number;
    empty_layers: number;
    degraded_layers: number;
    red_db_backed_layers: number;
  };
  layers: MemoryLayer[];
  reference_alignment: Array<{
    reference: string;
    maps_to: MemoryLayerId[];
    advantage: string;
  }>;
  recommended_next_actions: string[];
}

interface NormalizedEdge {
  label: EdgeLabel | string;
  from: number;
  to: number;
}

export async function buildMemoryLayersReport(
  store: MemoryStore,
  opts: { now?: number } = {},
): Promise<MemoryLayersReport> {
  const [nodes, rawEdges, docs, vector, events] = await Promise.all([
    store.listNodes(opts.now),
    store.listEdges(),
    store.listDocs(),
    store.vectorStatus(),
    readMemoryEvents(store).catch(() => [] as MemoryEvent[]),
  ]);
  const edges = rawEdges.map(toEdge);
  const layers = [
    shortTermLayer(events),
    longTermLayer(nodes),
    reasoningLayer(nodes, edges),
    docsCodeLayer(nodes, edges, docs.length),
    vectorLayer(vector),
  ];

  return {
    schema_version: "memory.memory_layers.v1",
    read_only: true,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    summary: summarize(layers),
    layers,
    reference_alignment: [
      {
        reference: "neo4j-labs/agent-memory",
        maps_to: ["short-term", "long-term", "reasoning", "vectors"],
        advantage:
          "Memory exposes the same layered shape over embedded project-local RedDB, without requiring a Neo4j service.",
      },
      {
        reference: "rohitg00/agentmemory",
        maps_to: ["short-term", "long-term", "docs-code", "vectors"],
        advantage:
          "Memory combines MCP/HTTP/hook access with RedDB graph, docs, and vector diagnostics for coding-agent workflows.",
      },
      {
        reference: "safishamsi/graphify",
        maps_to: ["docs-code", "reasoning", "vectors"],
        advantage:
          "Memory keeps code/doc graph evidence queryable in the same persistent RedDB store used by recall and hooks.",
      },
    ],
    recommended_next_actions: recommendations(layers),
  };
}

function shortTermLayer(rawEvents: MemoryEvent[]): MemoryLayer {
  // Engine ops (store/recall/promote/evict/conflict-detected) are surfaced
  // separately by `memory health`; the short-term layer stays focused on the
  // hook + skill lifecycle evidence it was originally introduced for.
  const events = rawEvents.filter((event) => event.kind !== "engine.op");
  const sessions = new Set(events.map((event) => String(event.scope.id ?? "unknown")));
  const hookEvents = events.filter((event) => event.kind === "hook.lifecycle").length;
  const skillEvents = events.filter((event) => event.kind === "skill.telemetry").length;
  return {
    id: "short-term",
    title: "Short-term session and lifecycle memory",
    status: events.length > 0 ? "ready" : "available",
    red_db_collections: ["memory_events"],
    counts: {
      events: events.length,
      sessions: sessions.size,
      hook_events: hookEvents,
      skill_events: skillEvents,
    },
    evidence: ["memory_events", "memory_session_timeline"],
    notes: [
      events.length > 0
        ? "Append-only lifecycle evidence is available without exposing raw transcripts."
        : "No lifecycle events found; hooks or Skill telemetry can populate short-term replay evidence.",
    ],
  };
}

function longTermLayer(nodes: StoredNode[]): MemoryLayer {
  const durable = nodes.filter((node) => node.properties.tier !== "ephemeral");
  const byType = countTypes(durable);
  return {
    id: "long-term",
    title: "Long-term durable project memory",
    status: durable.length > 0 ? "ready" : "empty",
    red_db_collections: ["memory_nodes", "memory_edges", "memory_kv"],
    counts: {
      nodes: durable.length,
      decisions: byType.decision ?? 0,
      concepts: byType.concept ?? 0,
      fixes: byType.fix ?? 0,
      workflows: byType.workflow ?? 0,
    },
    evidence: ["memory_nodes", "memory_recall", "memory_context_pack"],
    notes: [
      "Durable facts, decisions, fixes, and workflows persist in RedDB graph collections with scope and provenance metadata.",
    ],
  };
}

function reasoningLayer(nodes: StoredNode[], edges: NormalizedEdge[]): MemoryLayer {
  const reasoning = nodes.filter(
    (node) => node.node_type === "why_note" || node.properties.tier === "reasoning",
  );
  const touchedEdges = edges.filter((edge) => edge.label === "TOUCHED").length;
  return {
    id: "reasoning",
    title: "Reasoning traces and why-notes",
    status: reasoning.length > 0 || touchedEdges > 0 ? "ready" : "available",
    red_db_collections: ["memory_nodes", "memory_edges"],
    counts: {
      reasoning_nodes: reasoning.length,
      touched_edges: touchedEdges,
      why_notes: reasoning.filter((node) => node.node_type === "why_note").length,
    },
    evidence: ["why_note", "TOUCHED", "memory_handoff"],
    notes: [
      reasoning.length > 0
        ? "Reasoning evidence is preserved as graph nodes linked to affected entities."
        : "No reasoning trace nodes found; record why-notes when preserving durable implementation rationale.",
    ],
  };
}

function docsCodeLayer(
  nodes: StoredNode[],
  edges: NormalizedEdge[],
  docs: number,
): MemoryLayer {
  const byType = countTypes(nodes);
  const codeEdges = edges.filter((edge) =>
    ["IMPORTS", "CALLS", "USES_TYPE", "DEFINED_IN", "CONTAINS"].includes(edge.label),
  ).length;
  const codeNodes =
    (byType.file ?? 0) + (byType.symbol ?? 0) + (byType.import ?? 0);
  return {
    id: "docs-code",
    title: "Documentation and code graph memory",
    status: docs > 0 || codeNodes > 0 ? "ready" : "available",
    red_db_collections: ["memory_docs", "memory_nodes", "memory_edges"],
    counts: {
      docs,
      files: byType.file ?? 0,
      symbols: byType.symbol ?? 0,
      imports: byType.import ?? 0,
      code_edges: codeEdges,
    },
    evidence: ["memory_docs", "memory_doc_search", "memory_structural_impact"],
    notes: [
      "Docs, files, symbols, imports, calls, and type-use evidence share the same RedDB graph used by recall.",
    ],
  };
}

function vectorLayer(vector: VectorStatusReport): MemoryLayer {
  return {
    id: "vectors",
    title: "Vector projection and embedding diagnostics",
    status:
      vector.overall === "ready"
        ? "ready"
        : vector.overall === "unavailable"
          ? "available"
          : "degraded",
    red_db_collections: ["memory_vectors", "memory_kv"],
    counts: {
      overall: vector.overall,
      total: vector.total,
      ready: vector.ready,
      stale: vector.stale,
      unavailable: vector.unavailable,
      failed: vector.failed,
      docs: vector.docs.length,
      nodes: vector.nodes.length,
    },
    evidence: ["memory_vector_status", "memory_vector_search", "memory_smart_search"],
    notes: [
      "Provider embeddings use RedDB WITH AUTO EMBED; local-dev deterministic vectors live in RedDB KV.",
    ],
  };
}

function summarize(layers: MemoryLayer[]): MemoryLayersReport["summary"] {
  return {
    total_layers: layers.length,
    ready_layers: layers.filter((layer) => layer.status === "ready").length,
    available_layers: layers.filter((layer) => layer.status === "available").length,
    empty_layers: layers.filter((layer) => layer.status === "empty").length,
    degraded_layers: layers.filter((layer) => layer.status === "degraded").length,
    red_db_backed_layers: layers.filter((layer) => layer.red_db_collections.length > 0).length,
  };
}

function recommendations(layers: MemoryLayer[]): string[] {
  const actions: string[] = [];
  if (layerStatus(layers, "short-term") !== "ready") {
    actions.push("enable lifecycle hooks or Skill telemetry to populate short-term session evidence");
  }
  if (layerStatus(layers, "long-term") === "empty") {
    actions.push("run `memory store <fact>` or `memory ingest .` to populate durable project memory");
  }
  if (layerStatus(layers, "reasoning") !== "ready") {
    actions.push("preserve implementation rationale as why-notes when decisions need replayable reasoning");
  }
  if (layerStatus(layers, "docs-code") !== "ready") {
    actions.push("run `memory bootstrap --include-git-log` or `memory ingest .` to populate docs/code graph memory");
  }
  const vector = layers.find((layer) => layer.id === "vectors");
  if (vector?.counts.overall !== "ready") {
    actions.push("run `memory vector maintain --local` or configure `RED_MEMORY_VECTOR_PROVIDER` for embeddings");
  }
  if (actions.length === 0) actions.push("Memory layers are populated and ready");
  return actions;
}

function layerStatus(layers: MemoryLayer[], id: MemoryLayerId): MemoryLayerStatus | undefined {
  return layers.find((layer) => layer.id === id)?.status;
}

function countTypes(nodes: StoredNode[]): Record<NodeType, number> {
  const counts = {} as Record<NodeType, number>;
  for (const node of nodes) counts[node.node_type] = (counts[node.node_type] ?? 0) + 1;
  return counts;
}

function toEdge(row: Record<string, unknown>): NormalizedEdge {
  return {
    label: String(row.label ?? row.LABEL ?? "") as EdgeLabel,
    from: Number(row.from ?? row.from_id ?? row.from_rid ?? row.source ?? row.FROM ?? 0),
    to: Number(row.to ?? row.to_id ?? row.to_rid ?? row.target ?? row.TO ?? 0),
  };
}
