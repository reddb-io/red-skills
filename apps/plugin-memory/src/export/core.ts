import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildCommunityAnalytics,
  type BridgeEdge,
  type BridgeNode,
  type CommunityAnalyticsReport,
  type CommunityNodeAnalytics,
} from "../communities.js";
import { diagnose, type StaleNode } from "../doctor.js";
import { buildGraphContract } from "../graph-contract.js";
import type { MemoryStore, StoredNode, VectorStatusReport } from "../graph-store.js";
import { redactGraphData, type PrivacyFinding } from "../privacy.js";
import type { Confidence, MemoryDoc } from "../schema.js";
import { renderHtml } from "./html.js";

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
  const [communityReport, superseded, doctor] = await Promise.all([
    opts.communities
      ? buildCommunityAnalytics(store, { cache: "read-only", now: opts.now ? new Date(opts.now) : undefined })
      : Promise.resolve(null),
    store.supersededByMany(nodes.map((n) => n.rid)),
    diagnose(store, { staleDays: opts.staleDays, now: opts.now }),
  ]);
  const communityModel = buildCommunityExportModel(communityReport);
  const communities = communityModel.assignments;
  const dashboard = buildDashboard(nodes, edges, stats, docs, superseded, doctor.stale);
  const withCommunity = (rid: number) => {
    if (!opts.communities) return {};
    const community = communities.get(rid) ?? null;
    return {
      community,
      community_label: community ? communityModel.labels.get(community) ?? community : null,
    };
  };

  // Versioned integration seam (#234): the stable contract consumers negotiate
  // against. Built from the same (redacted) nodes/edges and the community map so
  // it stays consistent with the rest of the bundle.
  const contract = buildGraphContract({ nodes, edges, communities });

  const jsonEdges = edges.map((edge) => decorateEdge(edge, communityModel));
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
    semantic_lane: buildSemanticLaneSummary(nodes, edges),
    ...(communityReport ? { communities: communityReport } : {}),
    nodes: nodes.map((n) => ({
      rid: n.rid,
      label: n.label,
      node_type: n.node_type,
      ...withCommunity(n.rid),
      confidence: confidenceValue(n.properties),
      audit_seal: auditSeal(n.properties),
      confidence_band: confidenceBand(n.properties),
      semantic_lane: semanticLane(n.properties),
      navigation: communityModel.navigation.get(n.rid) ?? null,
      evidence_statuses: dashboard.nodeStatuses.get(n.rid) ?? ["active"],
      properties: n.properties,
    })),
    edges: jsonEdges,
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
    writeFile(
      htmlPath,
      renderHtml(nodes, edges, stats, docs, vector, communityModel, dashboard),
      "utf8",
    ),
    writeFile(auditPath, renderAudit(nodes, edges, stats, docs, vector, dashboard, communityModel), "utf8"),
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

export type StoredDoc = MemoryDoc & { rid: number };

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

export interface CommunityExportModel {
  report: CommunityAnalyticsReport | null;
  assignments: Map<number, string>;
  labels: Map<string, string>;
  navigation: Map<number, NodeNavigation>;
  bridgeNodes: Map<number, BridgeNode>;
  bridgeEdges: Set<string>;
}

interface NodeNavigation {
  degree: number;
  in_degree: number;
  out_degree: number;
  weighted_degree: number;
  centrality: number;
  hub: boolean;
  bridge: boolean;
  connected_community_count: number;
  connected_community_ids: string[];
  cross_community_edge_count: number;
  cross_community_weight: number;
}

function buildCommunityExportModel(report: CommunityAnalyticsReport | null): CommunityExportModel {
  const labels = new Map<string, string>();
  const assignments = new Map<number, string>();
  const bridgeNodes = new Map<number, BridgeNode>();
  const bridgeEdges = new Set<string>();
  const navigation = new Map<number, NodeNavigation>();
  if (!report) return { report, assignments, labels, navigation, bridgeNodes, bridgeEdges };

  for (const community of report.communities) {
    labels.set(community.id, community.short_label ?? community.id);
  }
  for (const assignment of report.assignments) assignments.set(assignment.rid, assignment.community_id);
  for (const bridge of report.bridge_nodes) bridgeNodes.set(bridge.rid, bridge);
  for (const edge of report.bridge_edges) bridgeEdges.add(edgeKey(edge));
  for (const item of report.node_analytics) {
    const bridge = bridgeNodes.get(item.rid);
    navigation.set(item.rid, nodeNavigation(item, bridge));
  }
  return { report, assignments, labels, navigation, bridgeNodes, bridgeEdges };
}

function nodeNavigation(item: CommunityNodeAnalytics, bridge: BridgeNode | undefined): NodeNavigation {
  return {
    degree: item.degree,
    in_degree: item.in_degree,
    out_degree: item.out_degree,
    weighted_degree: item.weighted_degree,
    centrality: item.centrality,
    hub: item.degree > 0 && item.centrality >= 0.75,
    bridge: bridge != null,
    connected_community_count: bridge?.connected_community_count ?? 0,
    connected_community_ids: bridge?.connected_community_ids ?? [],
    cross_community_edge_count: bridge?.cross_community_edge_count ?? 0,
    cross_community_weight: bridge?.cross_community_weight ?? 0,
  };
}

function edgeKey(edge: Pick<BridgeEdge, "from_rid" | "to_rid" | "label">): string {
  return `${edge.from_rid}\u0000${edge.to_rid}\u0000${edge.label}`;
}

function decorateEdge(edge: ExportEdge, communityModel: CommunityExportModel): ExportEdge & Record<string, unknown> {
  const fromCommunity = communityModel.assignments.get(edge.from) ?? null;
  const toCommunity = communityModel.assignments.get(edge.to) ?? null;
  const bridge = communityModel.bridgeEdges.has(edgeKey({ from_rid: edge.from, to_rid: edge.to, label: edge.label }));
  return {
    ...edge,
    confidence: confidenceValue(edge.properties),
    audit_seal: auditSeal(edge.properties),
    confidence_band: confidenceBand(edge.properties),
    semantic_lane: semanticLane(edge.properties),
    ...(fromCommunity || toCommunity
      ? {
          from_community: fromCommunity,
          to_community: toCommunity,
          from_community_label: fromCommunity ? communityModel.labels.get(fromCommunity) ?? fromCommunity : null,
          to_community_label: toCommunity ? communityModel.labels.get(toCommunity) ?? toCommunity : null,
          navigation: { bridge },
        }
      : {}),
  };
}

function confidenceValue(props: Record<string, unknown>): string | null {
  const value = props.confidence;
  return typeof value === "string" && value.trim() ? value : null;
}

function auditSeal(props: Record<string, unknown>): string {
  const value = props.audit_seal ?? props.confidence;
  return typeof value === "string" && value.trim() ? value : "AMBIGUOUS";
}

function confidenceBand(props: Record<string, unknown>): string | null {
  const value = props.confidence_band;
  return typeof value === "string" && value.trim() ? value : null;
}

function semanticLane(props: Record<string, unknown>): "INFERRED" | "EXTRACTED" | "AMBIGUOUS" {
  const seal = auditSeal(props);
  if (seal === "INFERRED" || seal === "EXTRACTED") return seal;
  return "AMBIGUOUS";
}

interface SemanticLaneSummary {
  seal_distribution: Record<string, { nodes: number; edges: number; total: number }>;
  inferred_nodes: number;
  inferred_edges: number;
  token_cost: { input: number; output: number } | null;
}

function buildSemanticLaneSummary(nodes: StoredNode[], edges: ExportEdge[]): SemanticLaneSummary {
  const sealDistribution: Record<string, { nodes: number; edges: number; total: number }> = {};
  const bump = (seal: string, kind: "nodes" | "edges") => {
    const current = sealDistribution[seal] ?? { nodes: 0, edges: 0, total: 0 };
    current[kind] += 1;
    current.total += 1;
    sealDistribution[seal] = current;
  };
  for (const node of nodes) bump(auditSeal(node.properties), "nodes");
  for (const edge of edges) bump(auditSeal(edge.properties), "edges");
  return {
    seal_distribution: sealDistribution,
    inferred_nodes: nodes.filter((node) => semanticLane(node.properties) === "INFERRED").length,
    inferred_edges: edges.filter((edge) => semanticLane(edge.properties) === "INFERRED").length,
    token_cost: semanticTokenCost(nodes),
  };
}

function semanticTokenCost(nodes: StoredNode[]): { input: number; output: number } | null {
  for (const node of nodes) {
    const input = Number(node.properties.semantic_token_input);
    const output = Number(node.properties.semantic_token_output);
    if (Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0)) {
      return { input, output };
    }
  }
  return null;
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

export interface DashboardModel {
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
  communityModel: CommunityExportModel,
): string {
  const byType = tally(nodes, (n) => n.node_type);
  const byLabel = tally(edges, (e) => e.label);
  const semantic = buildSemanticLaneSummary(nodes, edges);

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

  lines.push("## Seal distribution", "");
  lines.push(
    "EXTRACTED evidence comes from structural extractors. INFERRED evidence is provider-inferred semantic-lane material and should be reviewed with its confidence band before treating it as source-level fact.",
  );
  for (const [seal, count] of Object.entries(semantic.seal_distribution).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- **${seal}:** ${count.total} total (${count.nodes} node(s), ${count.edges} edge(s))`);
  }
  if (semantic.token_cost) {
    lines.push(
      `- Semantic lane token cost: ${semantic.token_cost.input} input / ${semantic.token_cost.output} output tokens from the originating ingest run.`,
    );
  } else {
    lines.push("- Semantic lane token cost: unavailable in this export.");
  }
  lines.push("");

  if (communityModel.report) {
    lines.push("## Community navigation", "");
    for (const community of communityModel.report.communities) {
      const label = community.short_label ?? community.id;
      lines.push(
        `- **${label}:** ${community.count} node(s), cohesion ${community.cohesion_score}, external edge weight ${community.external_edge_weight}`,
      );
    }
    if (communityModel.report.bridge_nodes.length === 0) {
      lines.push("- **Bridges:** none detected");
    } else {
      for (const bridge of communityModel.report.bridge_nodes.slice(0, 10)) {
        lines.push(
          `- **Bridge:** ${bridge.title} links ${bridge.connected_community_count} communities (${bridge.connected_community_ids.join(", ")})`,
        );
      }
    }
    lines.push("");
  }

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

