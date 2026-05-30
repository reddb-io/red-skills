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
  labels: string[];
  titles: string[];
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
}

interface CachedAssignments {
  graph_hash: string;
  assignments: Array<{ rid: number; community_id: string }>;
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
  const cacheKey = `cache:communities:${graphHash}`;
  const cached =
    cacheMode === "off" ? null : parseCached(await store.kvGet<CachedAssignments | string>(cacheKey));
  const communityPairs =
    cached?.graph_hash === graphHash
      ? cached.assignments
      : mapToPairs(await store.communities());

  if (cacheMode === "read-write" && cached?.graph_hash !== graphHash) {
    await store.kvPut(cacheKey, {
      graph_hash: graphHash,
      assignments: communityPairs,
      generated_at: (opts.now ?? new Date()).toISOString(),
    } satisfies CachedAssignments);
  }

  const assignments = decorateAssignments(nodes, communityPairs);
  return {
    schema_version: "memory.communities.v1",
    read_only: true,
    graph_hash: graphHash,
    cache_key: cacheKey,
    cached: cached?.graph_hash === graphHash,
    generated_at: (opts.now ?? new Date()).toISOString(),
    communities: summarizeCommunities(assignments),
    assignments,
  };
}

function parseCached(raw: CachedAssignments | string | null): CachedAssignments | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as CachedAssignments;
  } catch {
    return null;
  }
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

function summarizeCommunities(assignments: CommunityAssignment[]): CommunitySummary[] {
  const groups = new Map<string, CommunityAssignment[]>();
  for (const assignment of assignments) {
    const group = groups.get(assignment.community_id) ?? [];
    group.push(assignment);
    groups.set(assignment.community_id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      const sorted = [...group].sort((a, b) => a.title.localeCompare(b.title));
      return {
        id,
        count: group.length,
        labels: sorted.slice(0, 5).map((item) => item.label),
        titles: sorted.slice(0, 5).map((item) => item.title),
      };
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function graphStateHash(nodes: StoredNode[], edges: Record<string, unknown>[]): string {
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
