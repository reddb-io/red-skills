import { graphStateHash } from "./communities.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";

export type HubRankBy = "total" | "in" | "out";

export interface HubReportOptions {
  limit?: number;
  rankBy?: HubRankBy;
}

export interface HubReportRow {
  rid: number;
  label: string;
  title: string;
  node_type: string;
  community_id: string | null;
  total_degree: number;
  in_degree: number;
  out_degree: number;
  seal_mix: string;
  seal_count: number;
  seals: string[];
}

export interface HubReport {
  schema_version: "memory.hub-report.v1";
  read_only: true;
  graph_hash: string;
  generated_at: string;
  rank_by: HubRankBy;
  limit: number;
  summary: {
    nodes: number;
    edges: number;
    reported: number;
    max_total_degree: number;
    max_in_degree: number;
    max_out_degree: number;
    communities: number;
    empty: boolean;
  };
  next: string[];
  hubs: HubReportRow[];
}

interface DegreeStats {
  total: number;
  in: number;
  out: number;
  seals: Set<string>;
}

const DEFAULT_LIMIT = 10;
const NEXT_STEPS = [
  "memory communities --json",
  "memory export --communities",
];

export async function buildHubReport(
  store: MemoryStore,
  opts: HubReportOptions = {},
): Promise<HubReport> {
  const limit = clampLimit(opts.limit);
  const rankBy = opts.rankBy ?? "total";
  const [nodes, edges, communities] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    store.communities(),
  ]);
  const graphHash = graphStateHash(nodes, edges);
  const degreeByRid = new Map<number, DegreeStats>();
  for (const node of nodes) {
    degreeByRid.set(node.rid, { total: 0, in: 0, out: 0, seals: new Set() });
  }

  for (const edge of edges) {
    const from = edgeEndpoint(edge, "from");
    const to = edgeEndpoint(edge, "to");
    const fromStats = degreeByRid.get(from);
    const toStats = degreeByRid.get(to);
    if (!fromStats || !toStats) continue;
    const seal = edgeSeal(edge);
    fromStats.out += 1;
    fromStats.total += 1;
    fromStats.seals.add(seal);
    toStats.in += 1;
    toStats.total += 1;
    toStats.seals.add(seal);
  }

  const rows = nodes
    .map((node) => hubRow(node, degreeByRid.get(node.rid), communities.get(node.rid) ?? null))
    .sort((a, b) => compareHubRows(a, b, rankBy))
    .slice(0, limit);

  return {
    schema_version: "memory.hub-report.v1",
    read_only: true,
    graph_hash: graphHash,
    generated_at: new Date().toISOString(),
    rank_by: rankBy,
    limit,
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      reported: rows.length,
      max_total_degree: max(rows.map((row) => row.total_degree)),
      max_in_degree: max(rows.map((row) => row.in_degree)),
      max_out_degree: max(rows.map((row) => row.out_degree)),
      communities: new Set([...communities.values()]).size,
      empty: nodes.length === 0,
    },
    next: NEXT_STEPS,
    hubs: rows,
  };
}

function hubRow(
  node: StoredNode,
  stats: DegreeStats | undefined,
  communityId: string | null,
): HubReportRow {
  const seals = [...(stats?.seals ?? [])].sort();
  return {
    rid: node.rid,
    label: node.label,
    title: node.properties.title ?? node.label,
    node_type: String(node.node_type),
    community_id: communityId,
    total_degree: stats?.total ?? 0,
    in_degree: stats?.in ?? 0,
    out_degree: stats?.out ?? 0,
    seal_mix: seals.length === 0 ? "none" : seals.join("+"),
    seal_count: seals.length,
    seals,
  };
}

function compareHubRows(a: HubReportRow, b: HubReportRow, rankBy: HubRankBy): number {
  const primary =
    rankBy === "in"
      ? b.in_degree - a.in_degree
      : rankBy === "out"
        ? b.out_degree - a.out_degree
        : b.total_degree - a.total_degree;
  return (
    primary ||
    b.total_degree - a.total_degree ||
    b.in_degree - a.in_degree ||
    b.out_degree - a.out_degree ||
    a.label.localeCompare(b.label) ||
    a.rid - b.rid
  );
}

function edgeEndpoint(edge: Record<string, unknown>, side: "from" | "to"): number {
  const value =
    side === "from"
      ? edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM
      : edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO;
  return Number(value ?? 0);
}

function edgeSeal(edge: Record<string, unknown>): string {
  const properties = isRecord(edge.properties)
    ? edge.properties
    : isRecord(edge.PROPERTIES)
      ? edge.PROPERTIES
      : {};
  const value =
    edge.seal ??
    edge.audit_seal ??
    edge.confidence ??
    properties.seal ??
    properties.audit_seal ??
    properties.confidence ??
    edge.label ??
    edge.LABEL;
  return String(value ?? "unsealed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}
