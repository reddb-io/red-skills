import {
  pathConfidence,
  type ConfidenceBreakdown,
} from "./confidence-scoring.js";
import {
  buildConfidenceContext,
  confidenceForNode,
  type ConfidenceContext,
} from "./engine.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";
import type { EdgeLabel, NodeType } from "./schema.js";

export interface PathExplainInput {
  from: string;
  to: string;
  maxDepth?: number;
}

export interface PathExplainNode {
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
  /** Composed confidence in [0, 1] for this node (issue #167). */
  confidence?: number;
  confidence_breakdown?: ConfidenceBreakdown;
}

export interface PathExplainEdge {
  from: PathExplainNode;
  to: PathExplainNode;
  label: EdgeLabel | string;
}

export interface PathExplainReport {
  schema_version: "memory.path_explain.v1";
  read_only: true;
  request: {
    from: string;
    to: string;
    max_depth: number;
  };
  reachable: boolean;
  hop_count: number | null;
  path: PathExplainNode[];
  edges: PathExplainEdge[];
  markdown: string;
  recommended_next_actions: string[];
  /** Path-level confidence: weakest-link min over node confidences (issue #167). */
  path_confidence: number | null;
}

interface NormalizedEdge {
  from_rid: number;
  to_rid: number;
  label: string;
}

interface QueueItem {
  rid: number;
  path: number[];
  edges: NormalizedEdge[];
}

export async function buildPathExplainReport(
  store: MemoryStore,
  input: PathExplainInput,
): Promise<PathExplainReport> {
  const maxDepth = clampDepth(input.maxDepth);
  const [nodes, rawEdges] = await Promise.all([store.listNodes(), store.listEdges()]);
  const from = resolveNode(nodes, input.from);
  const to = resolveNode(nodes, input.to);
  const edgeRows = rawEdges.map(normalizeEdge).filter((edge): edge is NormalizedEdge => edge != null);
  const result = from && to ? findPath(from.rid, to.rid, edgeRows, maxDepth) : null;
  const nodeByRid = new Map(nodes.map((node) => [node.rid, node]));
  const path = result?.path.map((rid) => nodeByRid.get(rid)).filter((node): node is StoredNode => node != null) ?? [];
  const confidenceCtx = await buildConfidenceContext(store);
  const pathRefs = path.map((node) => nodeRef(node, confidenceCtx));
  const edges = result?.edges.map((edge) => toExplainedEdge(edge, nodeByRid, confidenceCtx)).filter((edge): edge is PathExplainEdge => edge != null) ?? [];
  const report: Omit<PathExplainReport, "markdown"> = {
    schema_version: "memory.path_explain.v1",
    read_only: true,
    request: {
      from: input.from,
      to: input.to,
      max_depth: maxDepth,
    },
    reachable: path.length > 0,
    hop_count: path.length > 0 ? Math.max(0, path.length - 1) : null,
    path: pathRefs,
    edges,
    recommended_next_actions: nextActions(from, to, path.length > 0),
    path_confidence: pathConfidence(pathRefs.map((n) => n.confidence ?? 0)),
  };
  return { ...report, markdown: renderMarkdown(report) };
}

function findPath(
  fromRid: number,
  toRid: number,
  edges: NormalizedEdge[],
  maxDepth: number,
): { path: number[]; edges: NormalizedEdge[] } | null {
  if (fromRid === toRid) return { path: [fromRid], edges: [] };
  const adjacency = new Map<number, NormalizedEdge[]>();
  for (const edge of edges) {
    const outgoing = adjacency.get(edge.from_rid) ?? [];
    outgoing.push(edge);
    adjacency.set(edge.from_rid, outgoing);
  }
  const queue: QueueItem[] = [{ rid: fromRid, path: [fromRid], edges: [] }];
  const visited = new Set<number>([fromRid]);
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.path.length - 1 >= maxDepth) continue;
    for (const edge of adjacency.get(item.rid) ?? []) {
      if (visited.has(edge.to_rid)) continue;
      const nextPath = [...item.path, edge.to_rid];
      const nextEdges = [...item.edges, edge];
      if (edge.to_rid === toRid) return { path: nextPath, edges: nextEdges };
      visited.add(edge.to_rid);
      queue.push({ rid: edge.to_rid, path: nextPath, edges: nextEdges });
    }
  }
  return null;
}

function resolveNode(nodes: StoredNode[], query: string): StoredNode | null {
  const normalized = query.trim().toLowerCase();
  return (
    nodes.find((node) => node.label === query) ??
    nodes.find((node) => node.label.toLowerCase() === normalized) ??
    nodes.find((node) => String(node.properties.title ?? "").toLowerCase() === normalized) ??
    null
  );
}

function normalizeEdge(row: Record<string, unknown>): NormalizedEdge | null {
  const from = Number(row.from_rid ?? row.from ?? row.from_id ?? row.source ?? row.FROM);
  const to = Number(row.to_rid ?? row.to ?? row.to_id ?? row.target ?? row.TO);
  const label = row.label ?? row.LABEL;
  if (!Number.isFinite(from) || !Number.isFinite(to) || typeof label !== "string") return null;
  return { from_rid: from, to_rid: to, label };
}

function toExplainedEdge(
  edge: NormalizedEdge,
  nodeByRid: Map<number, StoredNode>,
  confidenceCtx: ConfidenceContext,
): PathExplainEdge | null {
  const from = nodeByRid.get(edge.from_rid);
  const to = nodeByRid.get(edge.to_rid);
  if (!from || !to) return null;
  return { from: nodeRef(from, confidenceCtx), to: nodeRef(to, confidenceCtx), label: edge.label };
}

function nodeRef(node: StoredNode, confidenceCtx?: ConfidenceContext): PathExplainNode {
  const breakdown = confidenceCtx ? confidenceForNode(node, confidenceCtx) : undefined;
  return {
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: typeof node.properties.title === "string" ? node.properties.title : node.label,
    ...(breakdown
      ? { confidence: breakdown.confidence, confidence_breakdown: breakdown }
      : {}),
  };
}

function renderMarkdown(report: Omit<PathExplainReport, "markdown">): string {
  const lines = [
    "# Memory path explanation",
    "",
    `From: ${report.request.from}`,
    `To: ${report.request.to}`,
    `Reachable: ${report.reachable ? "yes" : "no"}`,
    "",
  ];
  if (report.reachable) {
    const conf = report.path_confidence;
    lines.push(`Hop count: ${report.hop_count}`);
    if (conf != null) lines.push(`Path confidence: ${conf.toFixed(3)}`);
    lines.push("", "## Path");
    for (const edge of report.edges) {
      lines.push(
        `- ${edge.from.title} (${edge.from.label}) --${edge.label}--> ${edge.to.title} (${edge.to.label})`,
      );
    }
  } else {
    lines.push("No directed path was found within the requested depth.");
  }
  if (report.recommended_next_actions.length > 0) {
    lines.push("", "## Next Actions");
    for (const action of report.recommended_next_actions) lines.push(`- ${action}`);
  }
  return lines.join("\n").trimEnd();
}

function nextActions(
  from: StoredNode | null,
  to: StoredNode | null,
  reachable: boolean,
): string[] {
  if (!from) return ["check the source label with `memory search <from>`"];
  if (!to) return ["check the target label with `memory search <to>`"];
  if (!reachable) return ["try a higher --max-depth or inspect neighbors with `memory traverse <label>`"];
  return ["use this path as cited graph evidence; verify source files before changing code"];
}

function clampDepth(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 6;
  return Math.max(1, Math.min(20, Math.floor(value)));
}
