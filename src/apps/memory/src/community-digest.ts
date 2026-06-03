import { graphStateHash } from "./communities.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";

export type CommunityDigestCacheMode = "read-write" | "read-only" | "off";

/**
 * A deterministic frequency count over a community member field (label or
 * node_type), ranked count-desc then value-asc for stable, reproducible output.
 */
export interface CommunityDigestCount {
  value: string;
  count: number;
}

/**
 * The per-community digest entry: a deterministic top-label baseline summary
 * over the RedDB-native community assignment. Analytics only — never written
 * back into the graph as a node or edge (see the `Community digest` glossary
 * term and the analytics-only stance for derived community artifacts).
 */
export interface CommunityDigest {
  community_id: string;
  size: number;
  /** Representative label: most frequent node label, ties broken alphabetically. */
  top_label: string;
  /** Dominant node_type: most frequent node_type, ties broken alphabetically. */
  top_node_type: string;
  /** Ranked label histogram for the community. */
  labels: CommunityDigestCount[];
  /** Ranked node_type histogram for the community. */
  node_types: CommunityDigestCount[];
}

export interface CommunityDigestReport {
  schema_version: "memory.community-digest.v1";
  read_only: true;
  graph_hash: string;
  cache_key: string;
  cached: boolean;
  generated_at: string;
  community_count: number;
  digests: CommunityDigest[];
}

interface CachedDigest {
  graph_hash: string;
  generated_at: string;
  community_count: number;
  digests: CommunityDigest[];
}

interface BuildCommunityDigestOptions {
  cache?: CommunityDigestCacheMode;
  now?: Date;
}

/**
 * Build a deterministic per-community top-label digest from the existing
 * RedDB-native community assignments. The digest is cached keyed by the graph
 * hash; a second run on an unchanged graph is a cache hit, and any graph
 * movement changes the hash so the digest is recomputed. The digest is
 * analytics and is never written back into the graph as a node or edge.
 */
export async function buildCommunityDigest(
  store: MemoryStore,
  opts: BuildCommunityDigestOptions = {},
): Promise<CommunityDigestReport> {
  const cacheMode = opts.cache ?? "read-write";
  const [nodes, edges] = await Promise.all([store.listNodes(), store.listEdges()]);
  const graphHash = graphStateHash(nodes, edges);
  const cacheKey = `cache:community-digest:${graphHash}`;
  const cached =
    cacheMode === "off" ? null : parseCached(await store.kvGet<CachedDigest | string>(cacheKey));
  const isHit = cached?.graph_hash === graphHash;

  if (isHit && cached) {
    return {
      schema_version: "memory.community-digest.v1",
      read_only: true,
      graph_hash: graphHash,
      cache_key: cacheKey,
      cached: true,
      generated_at: cached.generated_at,
      community_count: cached.community_count,
      digests: cached.digests,
    };
  }

  const assignments = await store.communities();
  const digests = computeDigests(nodes, assignments);
  const generatedAt = (opts.now ?? new Date()).toISOString();

  if (cacheMode === "read-write") {
    await store.kvPut(cacheKey, {
      graph_hash: graphHash,
      generated_at: generatedAt,
      community_count: digests.length,
      digests,
    } satisfies CachedDigest);
  }

  return {
    schema_version: "memory.community-digest.v1",
    read_only: true,
    graph_hash: graphHash,
    cache_key: cacheKey,
    cached: false,
    generated_at: generatedAt,
    community_count: digests.length,
    digests,
  };
}

function parseCached(raw: CachedDigest | string | null): CachedDigest | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as CachedDigest;
  } catch {
    return null;
  }
}

function computeDigests(
  nodes: StoredNode[],
  assignments: Map<number, string>,
): CommunityDigest[] {
  const byRid = new Map(nodes.map((node) => [node.rid, node]));
  const groups = new Map<string, StoredNode[]>();
  for (const [rid, communityId] of assignments) {
    const node = byRid.get(rid);
    if (!node) continue;
    const group = groups.get(communityId) ?? [];
    group.push(node);
    groups.set(communityId, group);
  }

  return [...groups.entries()]
    .map(([communityId, members]) => {
      const labels = rankCounts(members.map((node) => node.label));
      const nodeTypes = rankCounts(members.map((node) => String(node.node_type)));
      return {
        community_id: communityId,
        size: members.length,
        top_label: labels[0]?.value ?? "",
        top_node_type: nodeTypes[0]?.value ?? "",
        labels,
        node_types: nodeTypes,
      };
    })
    .sort((a, b) => b.size - a.size || a.community_id.localeCompare(b.community_id));
}

/** Frequency histogram ranked count-desc then value-asc — deterministic. */
function rankCounts(values: string[]): CommunityDigestCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
