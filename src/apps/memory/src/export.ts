import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { diagnose, type StaleNode } from "./doctor.js";
import { buildGraphContract } from "./graph-contract.js";
import type { MemoryStore, StoredNode, VectorStatusReport } from "./graph-store.js";
import { redactGraphData, type PrivacyFinding } from "./privacy.js";
import type { Confidence, MemoryDoc } from "./schema.js";
import { escapeHtmlNoSingleQuote as escapeHtml } from "./viewer-utils.js";

/**
 * memory export — dump the whole graph to a self-contained, navigable bundle.
 *
 * Emits three files into `outDir`:
 *   - graph.json  — the raw nodes + edges + stats (machine-readable, stable).
 *   - graph.html  — a single self-contained page (data inlined, no network,
 *                   no build step) with a force-directed node-link view plus a
 *                   searchable list; opens straight from disk.
 *   - audit.md    — a human-readable health summary: counts by type/edge label,
 *                   superseded chains, orphans, and the busiest nodes.
 *
 * Pure read: it never mutates the store.
 */

export interface ExportEdge {
  rid: number;
  label: string;
  from: number;
  to: number;
  weight: number;
  properties: Record<string, unknown>;
}

export interface ExportResult {
  dir: string;
  jsonPath: string;
  htmlPath: string;
  auditPath: string;
  interop?: {
    nodesJsonlPath: string;
    edgesJsonlPath: string;
    graphmlPath: string;
    cypherPath: string;
  };
  nodes: number;
  edges: number;
  redacted: boolean;
  privacyFindings: number;
}

/** Normalize a raw edge row (uppercased/promoted columns vary) into a tidy edge. */
export function toEdge(row: Record<string, unknown>): ExportEdge {
  return {
    rid: Number(row.rid ?? row.red_entity_id ?? 0),
    label: String(row.label ?? row.LABEL ?? ""),
    from: Number(row.from ?? row.from_id ?? row.from_rid ?? row.source ?? row.FROM ?? 0),
    to: Number(row.to ?? row.to_id ?? row.to_rid ?? row.target ?? row.TO ?? 0),
    weight: Number(row.weight ?? row.WEIGHT ?? 1),
    properties: asRecord(row.properties ?? row.PROPERTIES),
  };
}

export interface ExportOptions {
  /**
   * Colour nodes by community. Runs RedDB's native Louvain
   * (`MemoryStore.communities()`) and threads a `community` id onto every node
   * in both `graph.json` and the `graph.html` view. No external dependency —
   * the engine computes the partition (PRD #66 / #70).
   */
  communities?: boolean;
  /** Staleness threshold used by the dashboard health panel. Defaults to doctor. */
  staleDays?: number;
  /** Clock injection point for deterministic tests. */
  now?: number;
  /** Replace sensitive-looking values in graph.json, graph.html, and audit.md. */
  redactSensitive?: boolean;
  /** Write Neo4j/Graphify-style exchange artifacts beside the normal bundle. */
  interop?: boolean;
}

export async function exportGraph(
  store: MemoryStore,
  outDir: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });

  const [storedNodes, rawEdges, stats, docs, vector] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    store.stats(),
    store.listDocs(),
    store.vectorStatus(),
  ]);
  const storedEdges = rawEdges.map(toEdge);
  const redaction = opts.redactSensitive
    ? redactGraphData(storedNodes, storedEdges)
    : {
        nodes: storedNodes,
        edges: storedEdges,
        findings: [] as PrivacyFinding[],
      };
  const nodes = redaction.nodes;
  const edges = redaction.edges;

  // Native community detection is opt-in: only run it (and only attach the
  // `community` field) when asked, so the default export stays byte-identical.
  const [communities, superseded, doctor] = await Promise.all([
    opts.communities ? store.communities() : Promise.resolve(new Map<number, string>()),
    store.supersededByMany(nodes.map((n) => n.rid)),
    diagnose(store, { staleDays: opts.staleDays, now: opts.now }),
  ]);
  const dashboard = buildDashboard(nodes, edges, stats, docs, superseded, doctor.stale);
  const withCommunity = (rid: number) =>
    opts.communities ? { community: communities.get(rid) ?? null } : {};

  // Versioned integration seam (#234): the stable contract consumers negotiate
  // against. Built from the same (redacted) nodes/edges and the community map so
  // it stays consistent with the rest of the bundle.
  const contract = buildGraphContract({ nodes, edges, communities });

  const json = {
    generated_at: new Date().toISOString(),
    contract,
    stats,
    health: dashboard.health,
    evidence: dashboard.evidence,
    contradictions: dashboard.contradictions,
    supersession: dashboard.supersession,
    context_pack_preview: dashboard.contextPackPreview,
    docs: docs.map(exportDoc),
    vector_projection: exportVectorStatus(vector),
    nodes: nodes.map((n) => ({
      rid: n.rid,
      label: n.label,
      node_type: n.node_type,
      ...withCommunity(n.rid),
      evidence_statuses: dashboard.nodeStatuses.get(n.rid) ?? ["active"],
      properties: n.properties,
    })),
    edges,
  };

  const jsonPath = join(dir, "graph.json");
  const htmlPath = join(dir, "graph.html");
  const auditPath = join(dir, "audit.md");
  const interop = opts.interop
    ? {
        nodesJsonlPath: join(dir, "nodes.jsonl"),
        edgesJsonlPath: join(dir, "edges.jsonl"),
        graphmlPath: join(dir, "graph.graphml"),
        cypherPath: join(dir, "neo4j.cypher"),
      }
    : undefined;

  const writes = [
    writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8"),
    writeFile(htmlPath, renderHtml(nodes, edges, stats, docs, vector, communities, dashboard), "utf8"),
    writeFile(auditPath, renderAudit(nodes, edges, stats, docs, vector, dashboard), "utf8"),
  ];
  if (interop) {
    writes.push(
      writeFile(interop.nodesJsonlPath, renderNodesJsonl(nodes, dashboard), "utf8"),
      writeFile(interop.edgesJsonlPath, renderEdgesJsonl(edges), "utf8"),
      writeFile(interop.graphmlPath, renderGraphml(nodes, edges, dashboard), "utf8"),
      writeFile(interop.cypherPath, renderNeo4jCypher(nodes, edges, dashboard), "utf8"),
    );
  }
  await Promise.all(writes);

  return {
    dir,
    jsonPath,
    htmlPath,
    auditPath,
    ...(interop ? { interop } : {}),
    nodes: nodes.length,
    edges: edges.length,
    redacted: opts.redactSensitive === true,
    privacyFindings: redaction.findings.length,
  };
}

type StoredDoc = MemoryDoc & { rid: number };

function exportDoc(doc: StoredDoc): Record<string, unknown> {
  return {
    rid: doc.rid,
    path: doc.path,
    title: doc.title ?? null,
    hash: doc.hash,
    body_length: doc.body.length,
    updated_at: doc.updated_at,
  };
}

function exportVectorStatus(vector: VectorStatusReport): Record<string, unknown> {
  return {
    overall: vector.overall,
    total: vector.total,
    ready: vector.ready,
    stale: vector.stale,
    unavailable: vector.unavailable,
    failed: vector.failed,
    nodes: vector.nodes.map((node) => ({
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      source_collection: node.source_collection,
      status: node.status,
      error: node.error,
      updated_at: node.updated_at,
    })),
    docs: vector.docs.map((doc) => ({
      rid: doc.rid,
      path: doc.path,
      title: doc.title,
      source_collection: doc.source_collection,
      status: doc.status,
      error: doc.error,
      updated_at: doc.updated_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Interop artifacts
// ---------------------------------------------------------------------------

function renderNodesJsonl(nodes: StoredNode[], dashboard: DashboardModel): string {
  return `${nodes
    .map((node) =>
      JSON.stringify({
        rid: node.rid,
        label: node.label,
        node_type: node.node_type,
        title: node.properties.title ?? node.label,
        evidence_statuses: dashboard.nodeStatuses.get(node.rid) ?? ["active"],
        properties: node.properties,
      }),
    )
    .join("\n")}\n`;
}

function renderEdgesJsonl(edges: ExportEdge[]): string {
  return `${edges
    .map((edge) =>
      JSON.stringify({
        rid: edge.rid,
        label: edge.label,
        from: edge.from,
        to: edge.to,
        weight: edge.weight,
        properties: edge.properties,
      }),
    )
    .join("\n")}\n`;
}

function renderNeo4jCypher(
  nodes: StoredNode[],
  edges: ExportEdge[],
  dashboard: DashboardModel,
): string {
  const lines = [
    "// RedSkills Memory Neo4j import",
    "// Generated from project-local RedDB Memory export. RedDB remains the source of truth.",
    "CREATE CONSTRAINT memory_node_rid IF NOT EXISTS FOR (n:MemoryNode) REQUIRE n.rid IS UNIQUE;",
    "",
  ];
  for (const node of nodes) {
    const props = {
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      title: node.properties.title ?? node.label,
      evidence_statuses: dashboard.nodeStatuses.get(node.rid) ?? ["active"],
      properties_json: JSON.stringify(node.properties),
    };
    lines.push(`MERGE (n:MemoryNode:${cypherLabel(node.node_type)} {rid: ${node.rid}}) SET n += ${cypherMap(props)};`);
  }
  if (edges.length > 0) lines.push("");
  for (const edge of edges) {
    const relType = cypherRelationship(edge.label);
    const props = {
      rid: edge.rid,
      label: edge.label,
      weight: edge.weight,
      properties_json: JSON.stringify(edge.properties),
    };
    lines.push(
      `MATCH (a:MemoryNode {rid: ${edge.from}}), (b:MemoryNode {rid: ${edge.to}}) MERGE (a)-[r:${relType} {rid: ${edge.rid}}]->(b) SET r += ${cypherMap(props)};`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderGraphml(
  nodes: StoredNode[],
  edges: ExportEdge[],
  dashboard: DashboardModel,
): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="node_type" for="node" attr.name="node_type" attr.type="string"/>',
    '  <key id="title" for="node" attr.name="title" attr.type="string"/>',
    '  <key id="evidence_statuses" for="node" attr.name="evidence_statuses" attr.type="string"/>',
    '  <key id="properties_json" for="node" attr.name="properties_json" attr.type="string"/>',
    '  <key id="edge_label" for="edge" attr.name="label" attr.type="string"/>',
    '  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>',
    '  <key id="edge_properties_json" for="edge" attr.name="properties_json" attr.type="string"/>',
    '  <graph id="MemoryGraph" edgedefault="directed">',
  ];
  for (const node of nodes) {
    lines.push(`    <node id="memory_nodes:${node.rid}">`);
    lines.push(`      <data key="label">${xmlEscape(node.label)}</data>`);
    lines.push(`      <data key="node_type">${xmlEscape(node.node_type)}</data>`);
    lines.push(`      <data key="title">${xmlEscape(node.properties.title ?? node.label)}</data>`);
    lines.push(`      <data key="evidence_statuses">${xmlEscape(JSON.stringify(dashboard.nodeStatuses.get(node.rid) ?? ["active"]))}</data>`);
    lines.push(`      <data key="properties_json">${xmlEscape(JSON.stringify(node.properties))}</data>`);
    lines.push("    </node>");
  }
  for (const edge of edges) {
    lines.push(
      `    <edge id="memory_edges:${edge.rid}" source="memory_nodes:${edge.from}" target="memory_nodes:${edge.to}">`,
    );
    lines.push(`      <data key="edge_label">${xmlEscape(edge.label)}</data>`);
    lines.push(`      <data key="weight">${xmlEscape(String(edge.weight))}</data>`);
    lines.push(`      <data key="edge_properties_json">${xmlEscape(JSON.stringify(edge.properties))}</data>`);
    lines.push("    </edge>");
  }
  lines.push("  </graph>", "</graphml>");
  return `${lines.join("\n")}\n`;
}

function cypherMap(value: Record<string, unknown>): string {
  return `{${Object.entries(value)
    .map(([key, item]) => `${key}: ${cypherValue(item)}`)
    .join(", ")}}`;
}

function cypherValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(cypherValue).join(", ")}]`;
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function cypherLabel(value: string): string {
  const cleaned = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
  return cleaned || "Memory";
}

function cypherRelationship(value: string): string {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return cleaned || "RELATED_TO";
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// ---------------------------------------------------------------------------
// dashboard model
// ---------------------------------------------------------------------------

type EvidenceStatus = "active" | "superseded" | "stale" | "ambiguous";

interface EvidenceSummary {
  rid: number;
  label: string;
  node_type: string;
  title: string;
  confidence: Confidence;
  statuses: EvidenceStatus[];
  active_rid?: number;
  age_days?: number;
}

interface DashboardModel {
  health: {
    state: "healthy" | "needs-attention";
    total_nodes: number;
    total_edges: number;
    total_docs: number;
    orphan_nodes: number;
    active_nodes: number;
    stale_nodes: number;
    superseded_nodes: number;
    ambiguous_nodes: number;
    unresolved_contradictions: number;
    resolved_contradictions: number;
    context_pack_nodes: number;
  };
  evidence: {
    active: EvidenceSummary[];
    superseded: EvidenceSummary[];
    stale: EvidenceSummary[];
    ambiguous: EvidenceSummary[];
  };
  contradictions: Array<{
    from_rid: number;
    to_rid: number;
    from_title: string;
    to_title: string;
    reason: string | null;
    resolved: boolean;
    active_rid: number | null;
  }>;
  supersession: Array<{
    from_rid: number;
    to_rid: number;
    from_title: string;
    to_title: string;
    reason: string | null;
  }>;
  contextPackPreview: {
    representative_goal: string;
    node_rids: number[];
    context_md: string;
  };
  nodeStatuses: Map<number, EvidenceStatus[]>;
}

function buildDashboard(
  nodes: StoredNode[],
  edges: ExportEdge[],
  stats: { nodes: number; edges: number },
  docs: StoredDoc[],
  superseded: Map<number, number>,
  stale: StaleNode[],
): DashboardModel {
  const byRid = new Map(nodes.map((n) => [n.rid, n]));
  const staleByRid = new Map(stale.map((n) => [n.rid, n]));
  const degree = new Map<number, number>(nodes.map((n) => [n.rid, 0]));
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const nodeStatuses = new Map<number, EvidenceStatus[]>();
  for (const node of nodes) {
    const statuses: EvidenceStatus[] = [];
    if (superseded.has(node.rid)) statuses.push("superseded");
    else statuses.push("active");
    if (staleByRid.has(node.rid)) statuses.push("stale");
    if ((node.properties.confidence ?? "AMBIGUOUS") === "AMBIGUOUS") statuses.push("ambiguous");
    nodeStatuses.set(node.rid, statuses);
  }

  const summarize = (node: StoredNode): EvidenceSummary => {
    const staleNode = staleByRid.get(node.rid);
    return {
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      title: node.properties.title ?? node.label,
      confidence: node.properties.confidence ?? "AMBIGUOUS",
      statuses: nodeStatuses.get(node.rid) ?? ["active"],
      ...(superseded.has(node.rid) ? { active_rid: activeHead(node.rid, superseded, byRid) } : {}),
      ...(staleNode ? { age_days: staleNode.ageDays } : {}),
    };
  };

  const evidence = {
    active: nodes.filter((node) => nodeStatuses.get(node.rid)?.includes("active")).map(summarize),
    superseded: nodes
      .filter((node) => nodeStatuses.get(node.rid)?.includes("superseded"))
      .map(summarize),
    stale: nodes.filter((node) => nodeStatuses.get(node.rid)?.includes("stale")).map(summarize),
    ambiguous: nodes
      .filter((node) => nodeStatuses.get(node.rid)?.includes("ambiguous"))
      .map(summarize),
  };

  const contradictions = edges
    .filter((edge) => edge.label === "CONTRADICTS")
    .map((edge) => {
      const fromHead = activeHead(edge.from, superseded, byRid);
      const toHead = activeHead(edge.to, superseded, byRid);
      const resolved = fromHead === toHead;
      return {
        from_rid: edge.from,
        to_rid: edge.to,
        from_title: titleOf(byRid.get(edge.from), edge.from),
        to_title: titleOf(byRid.get(edge.to), edge.to),
        reason: edgeReason(edge),
        resolved,
        active_rid: resolved ? fromHead : null,
      };
    });

  const supersession = edges
    .filter((edge) => edge.label === "SUPERSEDED_BY")
    .map((edge) => ({
      from_rid: edge.from,
      to_rid: edge.to,
      from_title: titleOf(byRid.get(edge.from), edge.from),
      to_title: titleOf(byRid.get(edge.to), edge.to),
      reason: edgeReason(edge),
    }));

  const contextNodes = evidence.active
    .filter((item) => !item.statuses.includes("stale"))
    .map((item) => byRid.get(item.rid))
    .filter((node): node is StoredNode => Boolean(node))
    .sort((a, b) => Number(b.properties.importance ?? 0) - Number(a.properties.importance ?? 0))
    .slice(0, 8);
  const contextPackPreview = {
    representative_goal: "Preview active Memory evidence from this export",
    node_rids: contextNodes.map((node) => node.rid),
    context_md: renderContextPack(contextNodes),
  };
  const unresolved = contradictions.filter((item) => !item.resolved).length;
  const issueCount = stale.length + superseded.size + evidence.ambiguous.length + unresolved;

  return {
    health: {
      state: issueCount > 0 ? "needs-attention" : "healthy",
      total_nodes: stats.nodes,
      total_edges: stats.edges,
      total_docs: docs.length,
      orphan_nodes: [...degree.values()].filter((count) => count === 0).length,
      active_nodes: evidence.active.length,
      stale_nodes: stale.length,
      superseded_nodes: superseded.size,
      ambiguous_nodes: evidence.ambiguous.length,
      unresolved_contradictions: unresolved,
      resolved_contradictions: contradictions.length - unresolved,
      context_pack_nodes: contextNodes.length,
    },
    evidence,
    contradictions,
    supersession,
    contextPackPreview,
    nodeStatuses,
  };
}

function renderContextPack(nodes: StoredNode[]): string {
  const lines = [
    "# Context pack preview",
    "",
    "Goal: Preview active Memory evidence from this export",
    "",
  ];
  if (nodes.length === 0) {
    lines.push("_No active evidence available._");
  } else {
    for (const node of nodes) {
      const confidence = node.properties.confidence ?? "AMBIGUOUS";
      const content = String(node.properties.summary ?? node.properties.content ?? "").trim();
      lines.push(
        `- [memory_nodes:${node.rid}] ${node.properties.title ?? node.label} (${node.node_type}, ${confidence})${content ? ` — ${content}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function activeHead(
  rid: number,
  superseded: Map<number, number>,
  nodes: Map<number, StoredNode>,
): number {
  const seen = new Set<number>([rid]);
  let current = rid;
  while (true) {
    const next = superseded.get(current);
    if (next == null || seen.has(next) || !nodes.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

function titleOf(node: StoredNode | undefined, fallbackRid: number): string {
  return node?.properties.title ?? node?.label ?? `memory_nodes:${fallbackRid}`;
}

function edgeReason(edge: ExportEdge): string | null {
  const reason = edge.properties.reason;
  return typeof reason === "string" && reason ? reason : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// audit.md
// ---------------------------------------------------------------------------

function tally<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function renderAudit(
  nodes: StoredNode[],
  edges: ExportEdge[],
  stats: { nodes: number; edges: number },
  docs: StoredDoc[],
  vector: VectorStatusReport,
  dashboard: DashboardModel,
): string {
  const byType = tally(nodes, (n) => n.node_type);
  const byLabel = tally(edges, (e) => e.label);

  // Degree per node (in + out) and orphan detection.
  const degree = new Map<number, number>();
  for (const n of nodes) degree.set(n.rid, 0);
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const byRid = new Map(nodes.map((n) => [n.rid, n]));
  const orphans = nodes.filter((n) => (degree.get(n.rid) ?? 0) === 0);
  const superseded = edges.filter((e) => e.label === "SUPERSEDED_BY");
  const topDegree = [...degree.entries()]
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 10);

  const lines: string[] = [];
  lines.push("# Memory graph audit", "");
  lines.push(`Generated: ${new Date().toISOString()}`, "");
  lines.push(`- **Nodes:** ${stats.nodes}`);
  lines.push(`- **Edges:** ${stats.edges}`);
  lines.push(`- **Documents:** ${docs.length}`);
  lines.push(`- **Orphan nodes (no edges):** ${orphans.length}`);
  lines.push(`- **Superseded chains:** ${superseded.length}`, "");

  lines.push("## Memory health", "");
  lines.push(`- **State:** ${dashboard.health.state}`);
  lines.push(`- **Active evidence:** ${dashboard.health.active_nodes}`);
  lines.push(`- **Stale nodes:** ${dashboard.health.stale_nodes}`);
  lines.push(`- **Superseded nodes:** ${dashboard.health.superseded_nodes}`);
  lines.push(`- **Ambiguous nodes:** ${dashboard.health.ambiguous_nodes}`);
  lines.push(`- **Unresolved contradictions:** ${dashboard.health.unresolved_contradictions}`);
  lines.push(`- **Context pack preview nodes:** ${dashboard.health.context_pack_nodes}`, "");

  lines.push("## Vector projection", "");
  lines.push(`- **Overall:** ${vector.overall}`);
  lines.push(`- **Ready:** ${vector.ready}/${vector.total}`);
  lines.push(`- **Node vectors:** ${vector.nodes.length}`);
  lines.push(`- **Document vectors:** ${vector.docs.length}`);
  if (vector.stale > 0) lines.push(`- **Stale:** ${vector.stale}`);
  if (vector.unavailable > 0) lines.push(`- **Unavailable:** ${vector.unavailable}`);
  if (vector.failed > 0) lines.push(`- **Failed:** ${vector.failed}`);
  lines.push("");

  lines.push("## Documents", "");
  if (docs.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const doc of docs.slice(0, 50)) {
      const title = doc.title ? ` — ${doc.title}` : "";
      lines.push(`- \`${doc.path}\`${title}`);
    }
    if (docs.length > 50) lines.push(`- … and ${docs.length - 50} more`);
  }
  lines.push("");

  lines.push("## Contradictions", "");
  if (dashboard.contradictions.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const item of dashboard.contradictions) {
      const state = item.resolved ? `resolved via memory_nodes:${item.active_rid}` : "unresolved";
      const reason = item.reason ? ` — ${item.reason}` : "";
      lines.push(
        `- memory_nodes:${item.from_rid} **${item.from_title}** contradicts memory_nodes:${item.to_rid} **${item.to_title}** (${state})${reason}`,
      );
    }
  }
  lines.push("");

  lines.push("## Supersession", "");
  if (dashboard.supersession.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const item of dashboard.supersession) {
      const reason = item.reason ? ` — ${item.reason}` : "";
      lines.push(
        `- memory_nodes:${item.from_rid} **${item.from_title}** → memory_nodes:${item.to_rid} **${item.to_title}**${reason}`,
      );
    }
  }
  lines.push("");

  lines.push("## Context pack preview", "");
  lines.push(dashboard.contextPackPreview.context_md.trim(), "");

  lines.push("## Nodes by type", "");
  for (const [type, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${type}\` — ${n}`);
  }
  lines.push("");

  lines.push("## Edges by label", "");
  if (byLabel.size === 0) {
    lines.push("_(none)_");
  } else {
    for (const [label, n] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${label}\` — ${n}`);
    }
  }
  lines.push("");

  lines.push("## Most connected nodes", "");
  if (topDegree.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const [rid, d] of topDegree) {
      const node = byRid.get(rid);
      const title = node?.properties.title ?? node?.label ?? String(rid);
      lines.push(`- **${title}** _(${node?.node_type ?? "?"})_ — ${d} edge(s)`);
    }
  }
  lines.push("");

  if (orphans.length > 0) {
    lines.push("## Orphan nodes", "");
    for (const n of orphans.slice(0, 50)) {
      lines.push(`- **${n.properties.title ?? n.label}** _(${n.node_type})_`);
    }
    if (orphans.length > 50) lines.push(`- … and ${orphans.length - 50} more`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// graph.html
// ---------------------------------------------------------------------------

/** Escape a string for safe inlining inside a `<script>` JSON literal. The data
 *  is serialized with JSON.stringify then `<` is broken so the browser can't
 *  see a stray `</script>`. */
function inlineJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Deterministic colour per community id (golden-angle hue spread). Stable for a
 * given set of ids so the same export always paints the same clusters.
 */
function communityPalette(ids: string[]): Record<string, string> {
  const palette: Record<string, string> = {};
  ids.forEach((id, i) => {
    const hue = Math.round((i * 137.508) % 360);
    palette[id] = `hsl(${hue}, 65%, 60%)`;
  });
  return palette;
}

function renderHtml(
  nodes: StoredNode[],
  edges: ExportEdge[],
  stats: { nodes: number; edges: number },
  docs: StoredDoc[],
  vector: VectorStatusReport,
  communities: Map<number, string> = new Map(),
  dashboard: DashboardModel,
): string {
  const palette = communityPalette([...new Set(communities.values())].sort());
  const data = {
    nodes: nodes.map((n) => ({
      rid: n.rid,
      label: n.label,
      type: n.node_type,
      title: n.properties.title ?? n.label,
      excerpt: String(n.properties.summary ?? n.properties.content ?? "").slice(0, 280),
      community: communities.get(n.rid) ?? null,
      statuses: dashboard.nodeStatuses.get(n.rid) ?? ["active"],
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
    docs: docs.map((doc) => ({
      rid: doc.rid,
      path: doc.path,
      title: doc.title ?? null,
      body_length: doc.body.length,
    })),
    vector: exportVectorStatus(vector),
    palette,
  };
  const health = dashboard.health;
  const statusRows = [
    ["Active", health.active_nodes],
    ["Superseded", health.superseded_nodes],
    ["Stale", health.stale_nodes],
    ["Ambiguous", health.ambiguous_nodes],
    ["Contradictions", health.unresolved_contradictions],
    ["Docs", health.total_docs],
  ]
    .map(([label, value]) => `<div><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(String(label))}</span></div>`)
    .join("");
  const contradictionRows =
    dashboard.contradictions.length === 0
      ? `<p class="muted">None detected.</p>`
      : dashboard.contradictions
          .map((item) => {
            const state = item.resolved ? `resolved via memory_nodes:${item.active_rid}` : "unresolved";
            const reason = item.reason ? `<em>${escapeHtml(item.reason)}</em>` : "";
            return `<li><b>${escapeHtml(item.from_title)}</b> contradicts <b>${escapeHtml(item.to_title)}</b><span>${escapeHtml(state)}</span>${reason}</li>`;
          })
          .join("");
  const supersessionRows =
    dashboard.supersession.length === 0
      ? `<p class="muted">None recorded.</p>`
      : dashboard.supersession
          .map((item) => {
            const reason = item.reason ? `<em>${escapeHtml(item.reason)}</em>` : "";
            return `<li><b>${escapeHtml(item.from_title)}</b> → <b>${escapeHtml(item.to_title)}</b>${reason}</li>`;
          })
          .join("");
  const staleRows =
    dashboard.evidence.stale.length === 0
      ? `<p class="muted">No stale evidence.</p>`
      : dashboard.evidence.stale
          .slice(0, 8)
          .map((item) => `<li><b>${escapeHtml(item.title)}</b><span>${item.age_days ?? 0}d idle</span></li>`)
          .join("");
  const docRows =
    docs.length === 0
      ? `<p class="muted">No documents exported.</p>`
      : docs
          .slice(0, 8)
          .map((doc) => `<li><b>${escapeHtml(doc.path)}</b><span>${escapeHtml(doc.title ?? "untitled")}</span></li>`)
          .join("");
  const vectorRows = [
    ["Overall", vector.overall],
    ["Ready", `${vector.ready}/${vector.total}`],
    ["Node vectors", String(vector.nodes.length)],
    ["Document vectors", String(vector.docs.length)],
  ]
    .map(([label, value]) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`)
    .join("");

  // Self-contained: a tiny canvas force layout + a filterable sidebar. No CDN,
  // no build — opens straight from disk. The simulation is intentionally minimal
  // (the bundle must stay dependency-free) but enough to navigate the graph.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memory graph (${stats.nodes} nodes, ${stats.edges} edges, ${docs.length} docs)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #0f1115; color: #e6e6e6; }
  #app { display: flex; height: 100vh; }
  #side { width: 320px; flex: none; border-right: 1px solid #23262d; display: flex; flex-direction: column; }
  #side h1 { font-size: 14px; margin: 0; padding: 12px; border-bottom: 1px solid #23262d; }
  #q { margin: 8px; padding: 6px 8px; background: #1a1d23; border: 1px solid #2c2f36; color: inherit; border-radius: 6px; }
  .panel { border-bottom: 1px solid #23262d; padding: 10px 12px; }
  .panel h2 { font-size: 11px; line-height: 1.2; margin: 0 0 8px; color: #c9d1dc; text-transform: uppercase; letter-spacing: .08em; }
  .health-state { display: inline-block; padding: 2px 6px; border-radius: 999px; background: #28384d; color: #b9d8ff; font-size: 11px; margin-bottom: 8px; }
  .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .metrics div { background: #171a20; border: 1px solid #252a32; border-radius: 6px; padding: 6px; }
  .metrics strong { display: block; font-size: 15px; }
  .metrics span, .panel li span, .muted { color: #8b93a1; }
  .panel ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .panel li { display: grid; gap: 2px; }
  .panel em { color: #b6bfcc; font-style: normal; font-size: 11px; }
  .preview { max-height: 150px; overflow: auto; white-space: pre-wrap; margin: 0; padding: 8px; background: #171a20; border: 1px solid #252a32; border-radius: 6px; color: #cbd3df; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  #list { overflow: auto; flex: 1; }
  .item { padding: 8px 12px; border-bottom: 1px solid #1a1d23; cursor: pointer; }
  .item:hover, .item.active { background: #1a1d23; }
  .item .t { font-weight: 600; }
  .item .ty { color: #8b93a1; font-size: 11px; }
  .item .ex { color: #9aa3b2; font-size: 11px; margin-top: 2px; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .badge { border: 1px solid #303744; border-radius: 999px; color: #c8d0dc; font-size: 10px; padding: 1px 5px; }
  #stage { flex: 1; position: relative; }
  canvas { display: block; width: 100%; height: 100%; }
  #empty { padding: 24px; color: #8b93a1; }
</style>
</head>
<body>
<div id="app">
  <div id="side">
    <h1>Memory graph &middot; ${stats.nodes} nodes / ${stats.edges} edges / ${docs.length} docs</h1>
    <section class="panel">
      <h2>Memory health</h2>
      <div class="health-state">${escapeHtml(health.state)}</div>
      <div class="metrics">${statusRows}</div>
    </section>
    <section class="panel">
      <h2>Vector projection</h2>
      <div class="metrics">${vectorRows}</div>
    </section>
    <section class="panel">
      <h2>Documents</h2>
      <ul>${docRows}</ul>
    </section>
    <section class="panel">
      <h2>Contradictions</h2>
      <ul>${contradictionRows}</ul>
    </section>
    <section class="panel">
      <h2>Supersession</h2>
      <ul>${supersessionRows}</ul>
    </section>
    <section class="panel">
      <h2>Stale evidence</h2>
      <ul>${staleRows}</ul>
    </section>
    <section class="panel" id="context-pack-preview">
      <h2>Context pack preview</h2>
      <pre class="preview">${escapeHtml(dashboard.contextPackPreview.context_md)}</pre>
    </section>
    <input id="q" placeholder="filter nodes…" autocomplete="off" />
    <div id="list"></div>
  </div>
  <div id="stage"><canvas id="c"></canvas><div id="empty" hidden>No nodes to display.</div></div>
</div>
<script id="data" type="application/json">${inlineJson(data)}</script>
<script>
const DATA = JSON.parse(document.getElementById("data").textContent);
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const listEl = document.getElementById("list");
const qEl = document.getElementById("q");
const emptyEl = document.getElementById("empty");

const nodes = DATA.nodes.map((n, i) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, i }));
const index = new Map(nodes.map((n) => [n.rid, n]));
const edges = DATA.edges.filter((e) => index.has(e.from) && index.has(e.to));
let selected = null;

emptyEl.hidden = nodes.length > 0;

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width; canvas.height = r.height;
}
window.addEventListener("resize", resize);
resize();

// Seed positions on a circle, then relax with a cheap spring + repulsion model.
const cx0 = () => canvas.width / 2, cy0 = () => canvas.height / 2;
nodes.forEach((n, i) => {
  const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
  const rad = Math.min(canvas.width, canvas.height) / 3;
  n.x = cx0() + Math.cos(a) * rad;
  n.y = cy0() + Math.sin(a) * rad;
});

function step() {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy || 0.01;
      const f = 1400 / d2;
      const d = Math.sqrt(d2);
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    }
  }
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to);
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - 90) * 0.01;
    const ux = dx / d, uy = dy / d;
    a.vx += ux * f; a.vy += uy * f;
    b.vx -= ux * f; b.vy -= uy * f;
  }
  for (const n of nodes) {
    n.vx += (cx0() - n.x) * 0.002;
    n.vy += (cy0() - n.y) * 0.002;
    n.vx *= 0.85; n.vy *= 0.85;
    n.x += n.vx; n.y += n.vy;
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#2c2f36"; ctx.lineWidth = 1;
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (const n of nodes) {
    const on = selected === n.rid;
    ctx.beginPath(); ctx.arc(n.x, n.y, on ? 8 : 5, 0, Math.PI * 2);
    const clusterColor = (n.community && DATA.palette) ? DATA.palette[n.community] : null;
    ctx.fillStyle = on ? "#ffb454" : (clusterColor || "#5b9dd9"); ctx.fill();
    if (on) {
      ctx.fillStyle = "#e6e6e6"; ctx.font = "12px system-ui";
      ctx.fillText(n.title, n.x + 10, n.y + 4);
    }
  }
}

let frames = 0;
function loop() {
  if (frames++ < 400) step();
  draw();
  requestAnimationFrame(loop);
}
loop();

function renderList(filter) {
  const f = (filter || "").toLowerCase();
  listEl.innerHTML = "";
  for (const n of nodes) {
    if (f && !(n.title + " " + n.label + " " + n.type).toLowerCase().includes(f)) continue;
    const div = document.createElement("div");
    div.className = "item" + (selected === n.rid ? " active" : "");
    div.innerHTML =
      '<div class="t"></div><div class="ty"></div><div class="ex"></div><div class="badges"></div>';
    div.querySelector(".t").textContent = n.title;
    div.querySelector(".ty").textContent = n.type;
    div.querySelector(".ex").textContent = n.excerpt;
    const badges = div.querySelector(".badges");
    for (const status of n.statuses || ["active"]) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = status;
      badges.appendChild(badge);
    }
    div.onclick = () => { selected = n.rid; frames = 0; renderList(qEl.value); };
    listEl.appendChild(div);
  }
}
qEl.addEventListener("input", () => renderList(qEl.value));
canvas.addEventListener("click", (ev) => {
  const r = canvas.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  let best = null, bd = 1e9;
  for (const n of nodes) {
    const d = (n.x - mx) ** 2 + (n.y - my) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  if (best && bd < 400) { selected = best.rid; renderList(qEl.value); }
});
renderList("");
</script>
</body>
</html>
`;
}
