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
  short_label: string | null;
  label_provenance: CommunityLabelProvenance | null;
  count: number;
  total_degree: number;
  avg_centrality: number;
  internal_edge_weight: number;
  external_edge_weight: number;
  cohesion_score: number;
  labels: string[];
  titles: string[];
}

export interface CommunityLabelProvenance {
  source: "provider" | "deterministic" | "cached";
  provider: {
    mode: string | null;
    model: string | null;
  };
  membership_hash: string;
  generated_at: string;
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

export interface BridgeNode {
  rid: number;
  label: string;
  title: string;
  node_type: string;
  community_id: string;
  connected_community_count: number;
  connected_community_ids: string[];
  cross_community_edge_count: number;
  cross_community_weight: number;
}

export interface BridgeEdge {
  from_rid: number;
  to_rid: number;
  from_label: string;
  to_label: string;
  from_community_id: string;
  to_community_id: string;
  label: string;
  weight: number;
}

export interface CommunityAnalyticsSummary {
  status: "empty" | "ready";
  next: string;
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
  bridge_nodes: BridgeNode[];
  bridge_edges: BridgeEdge[];
  summary: CommunityAnalyticsSummary;
}

interface CachedCommunityAnalytics {
  schema_version: "memory.communities.cache.v3";
  graph_hash: string;
  assignments: Array<{ rid: number; community_id: string }>;
  node_analytics: CommunityNodeAnalytics[];
  inter_community_edges: InterCommunityEdge[];
  bridge_nodes: BridgeNode[];
  bridge_edges: BridgeEdge[];
  community_edge_weights: CommunityEdgeWeights[];
  generated_at: string;
}

interface CommunityEdgeWeights {
  community_id: string;
  internal_edge_weight: number;
  external_edge_weight: number;
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
  const cacheKey = `cache:communities:v3:${graphHash}`;
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
          bridge_nodes: cached.bridge_nodes,
          bridge_edges: cached.bridge_edges,
          community_edge_weights: cached.community_edge_weights,
        }
      : buildNavigationAnalytics(communityPairs, nodes, edges);

  if (cacheMode === "read-write" && !cacheHit) {
    await store.kvPut(cacheKey, {
      schema_version: "memory.communities.cache.v3",
      graph_hash: graphHash,
      assignments: communityPairs,
      ...analytics,
      generated_at: generatedAt,
    } satisfies CachedCommunityAnalytics);
  }

  const assignments = decorateAssignments(nodes, communityPairs);
  const communities = await attachStoredLabels(
    store,
    summarizeCommunities(
    assignments,
    analytics.node_analytics,
    analytics.inter_community_edges,
    analytics.community_edge_weights,
    ),
    assignments,
    nodes,
  );
  return {
    schema_version: "memory.communities.v1",
    read_only: true,
    graph_hash: graphHash,
    cache_key: cacheKey,
    cached: cacheHit,
    generated_at: cacheHit ? cached.generated_at : generatedAt,
    communities,
    assignments,
    node_analytics: analytics.node_analytics,
    inter_community_edges: analytics.inter_community_edges,
    bridge_nodes: analytics.bridge_nodes,
    bridge_edges: analytics.bridge_edges,
    summary: summarizeReport(communities, analytics.bridge_nodes, analytics.bridge_edges),
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
    item.schema_version === "memory.communities.cache.v3" &&
    typeof item.graph_hash === "string" &&
    Array.isArray(item.assignments) &&
    Array.isArray(item.node_analytics) &&
    Array.isArray(item.inter_community_edges) &&
    Array.isArray(item.bridge_nodes) &&
    Array.isArray(item.bridge_edges) &&
    Array.isArray(item.community_edge_weights) &&
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
  communityEdgeWeights: CommunityEdgeWeights[],
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
  const weightsByCommunity = new Map(communityEdgeWeights.map((item) => [item.community_id, item]));
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
        short_label: null,
        label_provenance: null,
        count: group.length,
        total_degree: totalDegree,
        avg_centrality: avgCentrality,
        internal_edge_weight: round6(weightsByCommunity.get(id)?.internal_edge_weight ?? 0),
        external_edge_weight: round6(externalWeight.get(id) ?? 0),
        cohesion_score: cohesionScore(weightsByCommunity.get(id)),
        labels: sorted.slice(0, 5).map((item) => item.label),
        titles: sorted.slice(0, 5).map((item) => item.title),
      };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

async function attachStoredLabels(
  store: MemoryStore,
  communities: CommunitySummary[],
  assignments: CommunityAssignment[],
  nodes: StoredNode[],
): Promise<CommunitySummary[]> {
  const membersByCommunity = new Map<string, CommunityAssignment[]>();
  for (const assignment of assignments) {
    const group = membersByCommunity.get(assignment.community_id) ?? [];
    group.push(assignment);
    membersByCommunity.set(assignment.community_id, group);
  }
  const nodesByRid = new Map(nodes.map((node) => [node.rid, node]));
  return Promise.all(
    communities.map(async (community) => {
      const membership_hash = membershipHash(
        (membersByCommunity.get(community.id) ?? [])
          .map((assignment) => nodesByRid.get(assignment.rid))
          .filter((node): node is StoredNode => node != null),
      );
      const label = parseStoredCommunityLabel(
        await store.kvGet<StoredCommunityLabel | string>(communityLabelKey(membership_hash)),
      );
      if (!label || label.provenance.membership_hash !== membership_hash) return community;
      return {
        ...community,
        short_label: label.short_label,
        label_provenance: label.provenance,
      };
    }),
  );
}

interface StoredCommunityLabel {
  schema_version: "memory.community-label.v1";
  community_id: string;
  short_label: string;
  provenance: CommunityLabelProvenance;
}

function parseStoredCommunityLabel(raw: StoredCommunityLabel | string | null): StoredCommunityLabel | null {
  if (raw == null) return null;
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  if (!parsed || typeof parsed !== "object") return null;
  const item = parsed as Partial<StoredCommunityLabel>;
  if (
    item.schema_version !== "memory.community-label.v1" ||
    typeof item.community_id !== "string" ||
    typeof item.short_label !== "string" ||
    !item.provenance ||
    typeof item.provenance.membership_hash !== "string"
  ) {
    return null;
  }
  return item as StoredCommunityLabel;
}

function membershipHash(members: StoredNode[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        members
          .slice()
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((node) => ({
            rid: node.rid,
            label: node.label,
            node_type: node.node_type,
            title: node.properties.title,
            hash: node.properties.hash,
          })),
      ),
    )
    .digest("hex");
}

function communityLabelKey(membershipHash: string): string {
  return `cache:community-label:v1:${membershipHash}`;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildNavigationAnalytics(
  assignments: Array<{ rid: number; community_id: string }>,
  nodes: StoredNode[],
  edges: Record<string, unknown>[],
): {
  node_analytics: CommunityNodeAnalytics[];
  inter_community_edges: InterCommunityEdge[];
  bridge_nodes: BridgeNode[];
  bridge_edges: BridgeEdge[];
  community_edge_weights: CommunityEdgeWeights[];
} {
  const communityByRid = new Map(assignments.map((assignment) => [assignment.rid, assignment.community_id]));
  const nodeByRid = new Map(nodes.map((node) => [node.rid, node]));
  const degree = new Map<number, number>();
  const inDegree = new Map<number, number>();
  const outDegree = new Map<number, number>();
  const weightedDegree = new Map<number, number>();
  const internalWeight = new Map<string, number>();
  const externalByCommunity = new Map<string, number>();
  const bridgeCommunities = new Map<number, Set<string>>();
  const bridgeEdgeCount = new Map<number, number>();
  const bridgeWeight = new Map<number, number>();
  for (const rid of communityByRid.keys()) {
    degree.set(rid, 0);
    inDegree.set(rid, 0);
    outDegree.set(rid, 0);
    weightedDegree.set(rid, 0);
    const communityId = communityByRid.get(rid);
    if (communityId) {
      internalWeight.set(communityId, internalWeight.get(communityId) ?? 0);
      externalByCommunity.set(communityId, externalByCommunity.get(communityId) ?? 0);
    }
  }

  const interCommunity = new Map<string, InterCommunityEdge>();
  const bridgeEdges: BridgeEdge[] = [];
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
    if (!fromCommunity || !toCommunity) continue;
    if (fromCommunity === toCommunity) {
      internalWeight.set(fromCommunity, round6((internalWeight.get(fromCommunity) ?? 0) + weight));
      continue;
    }
    externalByCommunity.set(fromCommunity, round6((externalByCommunity.get(fromCommunity) ?? 0) + weight));
    externalByCommunity.set(toCommunity, round6((externalByCommunity.get(toCommunity) ?? 0) + weight));
    addBridgeCommunity(bridgeCommunities, from, fromCommunity, toCommunity);
    addBridgeCommunity(bridgeCommunities, to, toCommunity, fromCommunity);
    bridgeEdgeCount.set(from, (bridgeEdgeCount.get(from) ?? 0) + 1);
    bridgeEdgeCount.set(to, (bridgeEdgeCount.get(to) ?? 0) + 1);
    bridgeWeight.set(from, round6((bridgeWeight.get(from) ?? 0) + weight));
    bridgeWeight.set(to, round6((bridgeWeight.get(to) ?? 0) + weight));
    const fromNode = nodeByRid.get(from);
    const toNode = nodeByRid.get(to);
    bridgeEdges.push({
      from_rid: from,
      to_rid: to,
      from_label: fromNode?.label ?? String(from),
      to_label: toNode?.label ?? String(to),
      from_community_id: fromCommunity,
      to_community_id: toCommunity,
      label: String(edge.label ?? edge.LABEL ?? ""),
      weight,
    });
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
  const bridgeNodes = [...bridgeCommunities.entries()]
    .map(([rid, communities]) => {
      const node = nodeByRid.get(rid);
      const connected = [...communities].sort();
      return {
        rid,
        label: node?.label ?? String(rid),
        title: node?.properties.title ?? node?.label ?? String(rid),
        node_type: String(node?.node_type ?? ""),
        community_id: communityByRid.get(rid) ?? "",
        connected_community_count: connected.length,
        connected_community_ids: connected,
        cross_community_edge_count: bridgeEdgeCount.get(rid) ?? 0,
        cross_community_weight: round6(bridgeWeight.get(rid) ?? 0),
      };
    })
    .sort(
      (a, b) =>
        b.connected_community_count - a.connected_community_count ||
        b.cross_community_weight - a.cross_community_weight ||
        b.cross_community_edge_count - a.cross_community_edge_count ||
        a.label.localeCompare(b.label),
    );
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
    bridge_nodes: bridgeNodes,
    bridge_edges: bridgeEdges.sort(
      (a, b) =>
        b.weight - a.weight ||
        a.from_community_id.localeCompare(b.from_community_id) ||
        a.to_community_id.localeCompare(b.to_community_id) ||
        a.from_label.localeCompare(b.from_label) ||
        a.to_label.localeCompare(b.to_label),
    ),
    community_edge_weights: [...new Set([...internalWeight.keys(), ...externalByCommunity.keys()])]
      .map((community_id) => ({
        community_id,
        internal_edge_weight: round6(internalWeight.get(community_id) ?? 0),
        external_edge_weight: round6(externalByCommunity.get(community_id) ?? 0),
      }))
      .sort((a, b) => a.community_id.localeCompare(b.community_id)),
  };
}

function addBridgeCommunity(
  bridgeCommunities: Map<number, Set<string>>,
  rid: number,
  ownCommunity: string,
  otherCommunity: string,
): void {
  const set = bridgeCommunities.get(rid) ?? new Set<string>();
  set.add(ownCommunity);
  set.add(otherCommunity);
  bridgeCommunities.set(rid, set);
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

function cohesionScore(weights: CommunityEdgeWeights | undefined): number {
  const internal = weights?.internal_edge_weight ?? 0;
  const external = weights?.external_edge_weight ?? 0;
  const total = internal + external;
  return total === 0 ? 0 : round6(internal / total);
}

function summarizeReport(
  communities: CommunitySummary[],
  bridgeNodes: BridgeNode[],
  bridgeEdges: BridgeEdge[],
): CommunityAnalyticsSummary {
  if (communities.length === 0) {
    return {
      status: "empty",
      next: "ingest graph evidence, then run memory communities again",
    };
  }
  if (bridgeNodes.length === 0 && bridgeEdges.length === 0) {
    return {
      status: "ready",
      next: "no cross-community bridges found; inspect low-cohesion communities if cohesion_score is below 0.5",
    };
  }
  return {
    status: "ready",
    next: "inspect bridge_nodes and low-cohesion communities before treating clusters as independent",
  };
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
