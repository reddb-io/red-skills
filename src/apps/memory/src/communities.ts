import { createHash } from "node:crypto";
import type { MemoryStore, StoredNode } from "./graph-store.js";

export type CommunityCacheMode = "read-write" | "read-only" | "off";

export interface CommunityAssignment {
  rid: number;
  community_id: string;
  label: string;
  node_type: string;
  title: string;
}

export interface CommunitySummary {
  id: string;
  count: number;
  total_degree: number;
  avg_centrality: number;
  external_edge_weight: number;
  labels: string[];
  titles: string[];
}

export interface CommunityNodeAnalytics {
  rid: number;
  community_id: string;
  degree: number;
  in_degree: number;
  out_degree: number;
  weighted_degree: number;
  centrality: number;
}

export interface InterCommunityEdge {
  from_community_id: string;
  to_community_id: string;
  weight: number;
  edge_count: number;
}

export interface CommunityAnalyticsReport {
  schema_version: "memory.communities.v1";
  read_only: true;
  graph_hash: string;
  cache_key: string;
  cached: boolean;
  generated_at: string;
  communities: CommunitySummary[];
  assignments: CommunityAssignment[];
  node_analytics: CommunityNodeAnalytics[];
  inter_community_edges: InterCommunityEdge[];
}

interface CachedCommunityAnalytics {
  schema_version: "memory.communities.cache.v2";
  graph_hash: string;
  assignments: Array<{ rid: number; community_id: string }>;
  node_analytics: CommunityNodeAnalytics[];
  inter_community_edges: InterCommunityEdge[];
  generated_at: string;
}

interface BuildCommunityAnalyticsOptions {
  cache?: CommunityCacheMode;
  now?: Date;
}

export async function buildCommunityAnalytics(
  store: MemoryStore,
  opts: BuildCommunityAnalyticsOptions = {},
): Promise<CommunityAnalyticsReport> {
  const cacheMode = opts.cache ?? "read-write";
  const [nodes, edges] = await Promise.all([store.listNodes(), store.listEdges()]);
  const graphHash = graphStateHash(nodes, edges);
  const cacheKey = `cache:communities:v2:${graphHash}`;
  const cached =
    cacheMode === "off"
      ? null
      : parseCached(await store.kvGet<CachedCommunityAnalytics | string>(cacheKey));
  const generatedAt = (opts.now ?? new Date()).toISOString();
  const cacheHit = cached?.graph_hash === graphHash;
  const communityPairs = cacheHit ? cached.assignments : mapToPairs(await store.communities());
  const analytics = cacheHit
    ? {
        node_analytics: cached.node_analytics,
        inter_community_edges: cached.inter_community_edges,
      }
    : buildNavigationAnalytics(communityPairs, edges);

  if (cacheMode === "read-write" && !cacheHit) {
    await store.kvPut(cacheKey, {
      schema_version: "memory.communities.cache.v2",
      graph_hash: graphHash,
      assignments: communityPairs,
      ...analytics,
      generated_at: generatedAt,
    } satisfies CachedCommunityAnalytics);
  }

  const assignments = decorateAssignments(nodes, communityPairs);
  return {
    schema_version: "memory.communities.v1",
    read_only: true,
    graph_hash: graphHash,
    cache_key: cacheKey,
    cached: cacheHit,
    generated_at: cacheHit ? cached.generated_at : generatedAt,
    communities: summarizeCommunities(assignments, analytics.node_analytics, analytics.inter_community_edges),
    assignments,
    node_analytics: analytics.node_analytics,
    inter_community_edges: analytics.inter_community_edges,
  };
}

function parseCached(raw: CachedCommunityAnalytics | string | null): CachedCommunityAnalytics | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return isCachedCommunityAnalytics(raw) ? raw : null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isCachedCommunityAnalytics(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCachedCommunityAnalytics(value: unknown): value is CachedCommunityAnalytics {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CachedCommunityAnalytics>;
  return (
    item.schema_version === "memory.communities.cache.v2" &&
    typeof item.graph_hash === "string" &&
    Array.isArray(item.assignments) &&
    Array.isArray(item.node_analytics) &&
    Array.isArray(item.inter_community_edges) &&
    typeof item.generated_at === "string"
  );
}

function mapToPairs(map: Map<number, string>): Array<{ rid: number; community_id: string }> {
  return [...map.entries()]
    .map(([rid, community_id]) => ({ rid, community_id }))
    .sort((a, b) => a.rid - b.rid);
}

function decorateAssignments(
  nodes: StoredNode[],
  assignments: Array<{ rid: number; community_id: string }>,
): CommunityAssignment[] {
  const byRid = new Map(nodes.map((node) => [node.rid, node]));
  return assignments
    .map((assignment) => {
      const node = byRid.get(assignment.rid);
      if (!node) return null;
      return {
        rid: node.rid,
        community_id: assignment.community_id,
        label: node.label,
        node_type: String(node.node_type),
        title: node.properties.title ?? node.label,
      };
    })
    .filter((item): item is CommunityAssignment => item != null)
    .sort((a, b) => a.community_id.localeCompare(b.community_id) || a.label.localeCompare(b.label));
}

function summarizeCommunities(
  assignments: CommunityAssignment[],
  nodeAnalytics: CommunityNodeAnalytics[],
  interCommunityEdges: InterCommunityEdge[],
): CommunitySummary[] {
  const groups = new Map<string, CommunityAssignment[]>();
  for (const assignment of assignments) {
    const group = groups.get(assignment.community_id) ?? [];
    group.push(assignment);
    groups.set(assignment.community_id, group);
  }
  const analyticsByCommunity = new Map<string, CommunityNodeAnalytics[]>();
  for (const item of nodeAnalytics) {
    const group = analyticsByCommunity.get(item.community_id) ?? [];
    group.push(item);
    analyticsByCommunity.set(item.community_id, group);
  }
  const externalWeight = new Map<string, number>();
  for (const edge of interCommunityEdges) {
    externalWeight.set(
      edge.from_community_id,
      (externalWeight.get(edge.from_community_id) ?? 0) + edge.weight,
    );
    externalWeight.set(
      edge.to_community_id,
      (externalWeight.get(edge.to_community_id) ?? 0) + edge.weight,
    );
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      const sorted = [...group].sort((a, b) => a.title.localeCompare(b.title));
      const analytics = analyticsByCommunity.get(id) ?? [];
      const totalDegree = analytics.reduce((sum, item) => sum + item.degree, 0);
      const avgCentrality =
        analytics.length === 0
          ? 0
          : round6(analytics.reduce((sum, item) => sum + item.centrality, 0) / analytics.length);
      return {
        id,
        count: group.length,
        total_degree: totalDegree,
        avg_centrality: avgCentrality,
        external_edge_weight: round6(externalWeight.get(id) ?? 0),
        labels: sorted.slice(0, 5).map((item) => item.label),
        titles: sorted.slice(0, 5).map((item) => item.title),
      };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function buildNavigationAnalytics(
  assignments: Array<{ rid: number; community_id: string }>,
  edges: Record<string, unknown>[],
): {
  node_analytics: CommunityNodeAnalytics[];
  inter_community_edges: InterCommunityEdge[];
} {
  const communityByRid = new Map(assignments.map((assignment) => [assignment.rid, assignment.community_id]));
  const degree = new Map<number, number>();
  const inDegree = new Map<number, number>();
  const outDegree = new Map<number, number>();
  const weightedDegree = new Map<number, number>();
  for (const rid of communityByRid.keys()) {
    degree.set(rid, 0);
    inDegree.set(rid, 0);
    outDegree.set(rid, 0);
    weightedDegree.set(rid, 0);
  }

  const interCommunity = new Map<string, InterCommunityEdge>();
  for (const edge of edges) {
    const from = edgeEndpoint(edge, "from");
    const to = edgeEndpoint(edge, "to");
    if (!communityByRid.has(from) || !communityByRid.has(to)) continue;
    const weight = edgeWeight(edge);
    outDegree.set(from, (outDegree.get(from) ?? 0) + 1);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
    weightedDegree.set(from, (weightedDegree.get(from) ?? 0) + weight);
    weightedDegree.set(to, (weightedDegree.get(to) ?? 0) + weight);

    const fromCommunity = communityByRid.get(from);
    const toCommunity = communityByRid.get(to);
    if (!fromCommunity || !toCommunity || fromCommunity === toCommunity) continue;
    const key = `${fromCommunity}\u0000${toCommunity}`;
    const current = interCommunity.get(key) ?? {
      from_community_id: fromCommunity,
      to_community_id: toCommunity,
      weight: 0,
      edge_count: 0,
    };
    current.weight = round6(current.weight + weight);
    current.edge_count += 1;
    interCommunity.set(key, current);
  }

  const maxDegree = Math.max(1, ...degree.values());
  return {
    node_analytics: [...communityByRid.entries()]
      .map(([rid, community_id]) => ({
        rid,
        community_id,
        degree: degree.get(rid) ?? 0,
        in_degree: inDegree.get(rid) ?? 0,
        out_degree: outDegree.get(rid) ?? 0,
        weighted_degree: round6(weightedDegree.get(rid) ?? 0),
        centrality: round6((degree.get(rid) ?? 0) / maxDegree),
      }))
      .sort((a, b) => b.centrality - a.centrality || b.degree - a.degree || a.rid - b.rid),
    inter_community_edges: [...interCommunity.values()].sort(
      (a, b) =>
        b.weight - a.weight ||
        b.edge_count - a.edge_count ||
        a.from_community_id.localeCompare(b.from_community_id) ||
        a.to_community_id.localeCompare(b.to_community_id),
    ),
  };
}

function edgeEndpoint(edge: Record<string, unknown>, side: "from" | "to"): number {
  const value =
    side === "from"
      ? edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM
      : edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO;
  return Number(value ?? 0);
}

function edgeWeight(edge: Record<string, unknown>): number {
  const weight = Number(edge.weight ?? edge.WEIGHT ?? 1);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function graphStateHash(nodes: StoredNode[], edges: Record<string, unknown>[]): string {
  const normalized = {
    nodes: nodes
      .map((node) => ({
        rid: node.rid,
        label: node.label,
        node_type: node.node_type,
        hash: node.properties.hash,
      }))
      .sort((a, b) => a.rid - b.rid),
    edges: edges
      .map((edge) => ({
        rid: Number(edge.rid ?? edge.red_entity_id ?? 0),
        label: String(edge.label ?? edge.LABEL ?? ""),
        from: Number(edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM ?? 0),
        to: Number(edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO ?? 0),
        weight: Number(edge.weight ?? edge.WEIGHT ?? 1),
      }))
      .sort((a, b) => a.rid - b.rid || a.from - b.from || a.to - b.to || a.label.localeCompare(b.label)),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
