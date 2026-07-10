import { createHash } from "node:crypto";
import { graphStateHash } from "./communities.js";
import {
  loadEngineeringCodeCuration,
  resolveEngineeringCodeAlias,
  type EngineeringCodeCurationState,
} from "./code-curation.js";
import { normalizeEngineeringCode } from "./extraction-schema.js";
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

export interface CommunityLabelProvenance {
  source: "provider" | "deterministic" | "cached";
  provider: {
    mode: ProviderMode | null;
    model: string | null;
  };
  membership_hash: string;
  generated_at: string;
}

export interface CommunityLabelingSummary {
  generated: number;
  reused: number;
  token_cost: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated: true;
  };
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
  /** Short provider-readable theme label for listings and downstream reports. */
  short_label: string | null;
  /** Provenance for the persisted short label, including the membership hash. */
  label_provenance: CommunityLabelProvenance | null;
  /** Representative label: most frequent node label, ties broken alphabetically. */
  top_label: string;
  /** Dominant node_type: most frequent node_type, ties broken alphabetically. */
  top_node_type: string;
  /** Dominant canonical engineering code, when community members carry codes. */
  top_engineering_code: string | null;
  /** Ranked label histogram for the community. */
  labels: CommunityDigestCount[];
  /** Ranked node_type histogram for the community. */
  node_types: CommunityDigestCount[];
  /** Ranked canonical engineering-code histogram for the community. */
  engineering_codes: CommunityDigestCount[];
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
  summary: {
    labeling: CommunityLabelingSummary;
  };
}

interface CachedDigest {
  graph_hash: string;
  provider: CommunityDigestProviderStatus;
  generated_at: string;
  community_count: number;
  digests: CommunityDigest[];
  summary?: {
    labeling?: CommunityLabelingSummary;
  };
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
  const [nodes, edges, curation] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    loadEngineeringCodeCuration(store),
  ]);
  const graphHash = graphStateHash(nodes, edges);
  const cacheKey = `cache:community-digest:${graphHash}:codes:${curationHash(curation)}:${providerCachePart(provider)}`;
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
      summary: {
        labeling: cached.summary?.labeling ?? emptyLabelingSummary(),
      },
    };
  }

  const assignments = await store.communities();
  let digests = computeDigests(nodes, assignments, curation);
  const labelRun = await labelCommunities({
    store,
    digests,
    nodes,
    assignments,
    provider,
    providerConfig,
    client:
      provider.status === "available" && providerConfig
        ? opts.providerClient ?? redDbProviderClient(store, providerConfig)
        : undefined,
    now: opts.now ?? new Date(),
  });
  digests = labelRun.digests;
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
      summary: {
        labeling: labelRun.summary,
      },
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
    summary: {
      labeling: labelRun.summary,
    },
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
  curation: EngineeringCodeCurationState,
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
      const engineeringCodes = rankCounts(
        members
          .map((node) => canonicalEngineeringCode(node, curation))
          .filter((code): code is string => code != null),
      );
      return {
        community_id: communityId,
        size: members.length,
        short_label: null,
        label_provenance: null,
        top_label: labels[0]?.value ?? "",
        top_node_type: nodeTypes[0]?.value ?? "",
        top_engineering_code: engineeringCodes[0]?.value ?? null,
        labels,
        node_types: nodeTypes,
        engineering_codes: engineeringCodes,
        narrative_summary: null,
      };
    })
    .sort((a, b) => b.size - a.size || a.community_id.localeCompare(b.community_id));
}

interface CommunityMembersForPrompt {
  community_id: string;
  digest: CommunityDigest;
  members: StoredNode[];
  membership_hash: string;
}

interface StoredCommunityLabel {
  schema_version: "memory.community-label.v1";
  community_id: string;
  short_label: string;
  provenance: CommunityLabelProvenance;
}

async function labelCommunities(opts: {
  store: MemoryStore;
  digests: CommunityDigest[];
  nodes: StoredNode[];
  assignments: Map<number, string>;
  provider: CommunityDigestProviderStatus;
  providerConfig?: AiProviderConfig;
  client?: ProviderClient;
  now: Date;
}): Promise<{ digests: CommunityDigest[]; summary: CommunityLabelingSummary }> {
  if (opts.digests.length === 0) {
    return { digests: opts.digests, summary: emptyLabelingSummary() };
  }
  const contexts = communityMemberContexts(opts.digests, opts.nodes, opts.assignments);
  const labelByCommunity = new Map<string, StoredCommunityLabel>();
  const needsProvider: CommunityMembersForPrompt[] = [];
  let reused = 0;
  for (const context of contexts) {
    const cached = parseStoredCommunityLabel(
      await opts.store.kvGet<StoredCommunityLabel | string>(
        communityLabelKey(context.membership_hash),
      ),
    );
    if (cached?.provenance.membership_hash === context.membership_hash && cached.short_label) {
      reused += 1;
      labelByCommunity.set(context.community_id, cached);
    } else {
      needsProvider.push(context);
    }
  }

  let generated = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  if (needsProvider.length > 0) {
    let generatedLabels = new Map<string, string>();
    if (opts.provider.status === "available" && opts.providerConfig && opts.client) {
      const request = buildLabelPrompt(needsProvider);
      promptTokens += estimateTokens(request.system) + estimateTokens(request.user);
      try {
        const raw = await opts.client.complete(request);
        completionTokens += estimateTokens(raw);
        generatedLabels = parseCommunityLabels(raw);
      } catch {
        generatedLabels = new Map();
      }
    }
    const generatedAt = opts.now.toISOString();
    for (const context of needsProvider) {
      const shortLabel =
        sanitizeShortLabel(generatedLabels.get(context.community_id)) ??
        deterministicShortLabel(context.digest);
      const source = generatedLabels.has(context.community_id) ? "provider" : "deterministic";
      const record: StoredCommunityLabel = {
        schema_version: "memory.community-label.v1",
        community_id: context.community_id,
        short_label: shortLabel,
        provenance: {
          source,
          provider: {
            mode: opts.provider.mode,
            model: opts.provider.model,
          },
          membership_hash: context.membership_hash,
          generated_at: generatedAt,
        },
      };
      await opts.store.kvPut(communityLabelKey(context.membership_hash), record);
      labelByCommunity.set(context.community_id, record);
      generated += 1;
    }
  }

  return {
    digests: opts.digests.map((digest) => {
      const record = labelByCommunity.get(digest.community_id);
      return {
        ...digest,
        short_label: record?.short_label ?? null,
        label_provenance: record?.provenance ?? null,
      };
    }),
    summary: {
      generated,
      reused,
      token_cost: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        estimated: true,
      },
    },
  };
}

function communityMemberContexts(
  digests: CommunityDigest[],
  nodes: StoredNode[],
  assignments: Map<number, string>,
): CommunityMembersForPrompt[] {
  const byRid = new Map(nodes.map((node) => [node.rid, node]));
  const byCommunity = new Map<string, StoredNode[]>();
  for (const [rid, communityId] of assignments) {
    const node = byRid.get(rid);
    if (!node) continue;
    const group = byCommunity.get(communityId) ?? [];
    group.push(node);
    byCommunity.set(communityId, group);
  }
  return digests.map((digest) => {
    const members = (byCommunity.get(digest.community_id) ?? [])
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      community_id: digest.community_id,
      digest,
      members,
      membership_hash: membershipHash(members),
    };
  });
}

function buildLabelPrompt(contexts: CommunityMembersForPrompt[]) {
  return {
    system: [
      "You label Memory graph communities for an engineering agent.",
      "Return ONLY JSON of the form:",
      '{ "labels": [ { "community_id": string, "label": string } ] }',
      "Write a short human-readable theme name, two to four words.",
      "Use the member hubs, labels, titles, content snippets, and cohesion context. Do not invent facts.",
    ].join("\n"),
    user: JSON.stringify({
      task: "community-labels",
      communities: contexts.map((context) => ({
        community_id: context.community_id,
        size: context.digest.size,
        top_label: context.digest.top_label,
        top_node_type: context.digest.top_node_type,
        top_engineering_code: context.digest.top_engineering_code,
        cohesion: {
          labels: context.digest.labels.slice(0, 10),
          node_types: context.digest.node_types,
          engineering_codes: context.digest.engineering_codes,
        },
        members: context.members.slice(0, 12).map((node) => ({
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

function parseCommunityLabels(raw: string): Map<string, string> {
  const parsed = parseJson(unfence(raw));
  if (!parsed || typeof parsed !== "object") return new Map();
  const labels = Array.isArray((parsed as { labels?: unknown }).labels)
    ? (parsed as { labels: unknown[] }).labels
    : [];
  const out = new Map<string, string>();
  for (const item of labels) {
    if (!item || typeof item !== "object") continue;
    const communityId = (item as { community_id?: unknown }).community_id;
    const label = sanitizeShortLabel((item as { label?: unknown }).label);
    if (typeof communityId === "string" && label) out.set(communityId, label);
  }
  return out;
}

function sanitizeShortLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return null;
  return cleaned.split(" ").slice(0, 4).join(" ");
}

function deterministicShortLabel(digest: CommunityDigest): string {
  return titleCase(digest.top_engineering_code ?? digest.top_label.replace(/^.*[#:/]/, ""));
}

function titleCase(value: string): string {
  const words = value
    .replace(/[-_./:]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) return "Community";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function membershipHash(members: StoredNode[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        members.map((node) => ({
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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function emptyLabelingSummary(): CommunityLabelingSummary {
  return {
    generated: 0,
    reused: 0,
    token_cost: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated: true,
    },
  };
}

function canonicalEngineeringCode(
  node: StoredNode,
  curation: EngineeringCodeCurationState,
): string | null {
  const raw = node.properties.engineering_code;
  if (typeof raw !== "string") return null;
  const code = normalizeEngineeringCode(raw);
  if (!code) return null;
  return resolveEngineeringCodeAlias(code, curation);
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
        top_engineering_code: digest.top_engineering_code,
        labels: digest.labels.slice(0, 10),
        node_types: digest.node_types,
        engineering_codes: digest.engineering_codes,
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

function curationHash(curation: EngineeringCodeCurationState): string {
  return createHash("sha256").update(JSON.stringify(curation)).digest("hex").slice(0, 12);
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
