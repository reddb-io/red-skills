import { graphStateHash } from "./communities.js";
import {
  type AiProviderConfig,
  type Egress,
  type ProviderClient,
  type ProviderMode,
  resolveProvider,
} from "./extract-conversation.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";
import { redDbProviderClient } from "./provider-client.js";

export type CommunityDigestCacheMode = "read-write" | "read-only" | "off";

/**
 * A deterministic frequency count over a community member field (label or
 * node_type), ranked count-desc then value-asc for stable, reproducible output.
 */
export interface CommunityDigestCount {
  value: string;
  count: number;
}

export interface CommunityDigestProviderStatus {
  status: "available" | "unavailable";
  mode: ProviderMode | null;
  model: string | null;
  egress: Egress | null;
  error?: string;
}

/**
 * The per-community digest entry: a deterministic top-label baseline summary
 * over the RedDB-native community assignment, optionally enriched by a provider
 * narrative when one is configured. Analytics only — never written back into
 * the graph as a node or edge (see the `Community digest` glossary term and the
 * analytics-only stance for derived community artifacts).
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
  /** Provider-written natural-language summary; null when provider enrichment is unavailable. */
  narrative_summary: string | null;
}

export interface CommunityDigestReport {
  schema_version: "memory.community-digest.v1";
  read_only: true;
  graph_hash: string;
  cache_key: string;
  cached: boolean;
  generated_at: string;
  provider: CommunityDigestProviderStatus;
  community_count: number;
  digests: CommunityDigest[];
}

interface CachedDigest {
  graph_hash: string;
  provider: CommunityDigestProviderStatus;
  generated_at: string;
  community_count: number;
  digests: CommunityDigest[];
}

interface BuildCommunityDigestOptions {
  cache?: CommunityDigestCacheMode;
  now?: Date;
  providerConfig?: AiProviderConfig;
  providerClient?: ProviderClient;
}

/**
 * Build a per-community digest from the existing RedDB-native community
 * assignments. The deterministic top-label baseline always runs; when a
 * provider is configured the baseline is enriched with one narrative summary
 * per community. The digest is cached by graph hash plus provider identity; a
 * second run on an unchanged graph/provider is a cache hit, and any graph
 * movement changes the hash so the digest is recomputed. The digest is
 * analytics and is never written back into the graph as a node or edge.
 */
export async function buildCommunityDigest(
  store: MemoryStore,
  opts: BuildCommunityDigestOptions = {},
): Promise<CommunityDigestReport> {
  const cacheMode = opts.cache ?? "read-write";
  const providerConfig = opts.providerConfig;
  const provider = resolveProviderStatus(providerConfig);
  const [nodes, edges] = await Promise.all([store.listNodes(), store.listEdges()]);
  const graphHash = graphStateHash(nodes, edges);
  const cacheKey = `cache:community-digest:${graphHash}:${providerCachePart(provider)}`;
  const cached =
    cacheMode === "off" ? null : parseCached(await store.kvGet<CachedDigest | string>(cacheKey));
  const isHit =
    cached?.graph_hash === graphHash &&
    cached.provider?.status === provider.status &&
    cached.provider?.mode === provider.mode &&
    cached.provider?.model === provider.model;

  if (isHit && cached) {
    return {
      schema_version: "memory.community-digest.v1",
      read_only: true,
      graph_hash: graphHash,
      cache_key: cacheKey,
      cached: true,
      generated_at: cached.generated_at,
      provider: cached.provider,
      community_count: cached.community_count,
      digests: cached.digests,
    };
  }

  const assignments = await store.communities();
  let digests = computeDigests(nodes, assignments);
  let finalProvider = provider;
  if (provider.status === "available" && providerConfig) {
    const enriched = await enrichDigestsWithNarratives({
      digests,
      nodes,
      assignments,
      client: opts.providerClient ?? redDbProviderClient(store, providerConfig),
    });
    digests = enriched.digests;
    if (enriched.error) {
      finalProvider = { ...provider, status: "unavailable", error: enriched.error };
    }
  }
  const generatedAt = (opts.now ?? new Date()).toISOString();

  if (cacheMode === "read-write") {
    await store.kvPut(cacheKey, {
      graph_hash: graphHash,
      provider: finalProvider,
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
    provider: finalProvider,
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
        narrative_summary: null,
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

function resolveProviderStatus(
  config: AiProviderConfig | undefined,
): CommunityDigestProviderStatus {
  if (!config) {
    return {
      status: "unavailable",
      mode: null,
      model: null,
      egress: null,
      error: "no AI provider configured",
    };
  }
  try {
    const resolved = resolveProvider(config);
    return {
      status: "available",
      mode: resolved.mode,
      model: resolved.model,
      egress: resolved.egress,
    };
  } catch (err) {
    return {
      status: "unavailable",
      mode: config.mode,
      model: config.model,
      egress: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function providerCachePart(provider: CommunityDigestProviderStatus): string {
  if (provider.status !== "available") return "provider:none";
  return `provider:${provider.mode}:${provider.model}`;
}

async function enrichDigestsWithNarratives(opts: {
  digests: CommunityDigest[];
  nodes: StoredNode[];
  assignments: Map<number, string>;
  client: ProviderClient;
}): Promise<{ digests: CommunityDigest[]; error?: string }> {
  if (opts.digests.length === 0) return { digests: opts.digests };
  let raw: string;
  try {
    raw = await opts.client.complete(
      buildNarrativePrompt(opts.digests, opts.nodes, opts.assignments),
    );
  } catch (err) {
    return {
      digests: opts.digests,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const summaries = parseNarrativeSummaries(raw);
  if (summaries.size === 0) {
    return { digests: opts.digests, error: "provider returned no parseable summaries" };
  }
  const missing = opts.digests.filter((digest) => !summaries.has(digest.community_id));
  if (missing.length > 0) {
    return { digests: opts.digests, error: "provider returned incomplete summaries" };
  }
  return {
    digests: opts.digests.map((digest) => ({
      ...digest,
      narrative_summary: summaries.get(digest.community_id) ?? null,
    })),
  };
}

function buildNarrativePrompt(
  digests: CommunityDigest[],
  nodes: StoredNode[],
  assignments: Map<number, string>,
) {
  const byRid = new Map(nodes.map((node) => [node.rid, node]));
  const members = new Map<string, StoredNode[]>();
  for (const [rid, communityId] of assignments) {
    const node = byRid.get(rid);
    if (!node) continue;
    const group = members.get(communityId) ?? [];
    group.push(node);
    members.set(communityId, group);
  }
  return {
    system: [
      "You summarize Memory graph communities for an engineering agent.",
      "Return ONLY JSON of the form:",
      '{ "summaries": [ { "community_id": string, "summary": string } ] }',
      "Write one concise natural-language summary per community.",
      "Stay grounded in labels, node types, titles, and content snippets. Do not invent facts.",
    ].join("\n"),
    user: JSON.stringify({
      communities: digests.map((digest) => ({
        community_id: digest.community_id,
        size: digest.size,
        top_label: digest.top_label,
        top_node_type: digest.top_node_type,
        labels: digest.labels.slice(0, 10),
        node_types: digest.node_types,
        members: (members.get(digest.community_id) ?? [])
          .slice()
          .sort((a, b) => a.label.localeCompare(b.label))
          .slice(0, 12)
          .map((node) => ({
            label: node.label,
            node_type: String(node.node_type),
            title: typeof node.properties.title === "string" ? node.properties.title : undefined,
            content:
              typeof node.properties.content === "string"
                ? node.properties.content.slice(0, 240)
                : undefined,
          })),
      })),
    }),
  };
}

function parseNarrativeSummaries(raw: string): Map<string, string> {
  const parsed = parseJson(unfence(raw));
  if (!parsed || typeof parsed !== "object") return new Map();
  const summaries = Array.isArray((parsed as { summaries?: unknown }).summaries)
    ? (parsed as { summaries: unknown[] }).summaries
    : [];
  const out = new Map<string, string>();
  for (const item of summaries) {
    if (!item || typeof item !== "object") continue;
    const communityId = (item as { community_id?: unknown }).community_id;
    const summary = (item as { summary?: unknown }).summary;
    if (typeof communityId !== "string" || typeof summary !== "string") continue;
    const trimmed = summary.trim();
    if (trimmed) out.set(communityId, trimmed);
  }
  return out;
}

function unfence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
