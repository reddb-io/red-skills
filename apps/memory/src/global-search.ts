import {
  buildCommunityDigest,
  type CommunityDigest,
  type CommunityDigestCacheMode,
  type CommunityDigestReport,
} from "./community-digest.js";
import type { AiProviderConfig } from "./extract-conversation.js";
import type { MemoryStore } from "./graph-store.js";

export const GLOBAL_SEARCH_SCHEMA_VERSION = "memory.global-search.v1";

export interface GlobalSearchDigestEvidence {
  source: "community-digest";
  community_id: string;
  score: number;
  matched_terms: string[];
  size: number;
  short_label: string | null;
  top_label: string;
  top_node_type: string;
  top_engineering_code: string | null;
  labels: Array<{ value: string; count: number }>;
  node_types: Array<{ value: string; count: number }>;
  engineering_codes: Array<{ value: string; count: number }>;
  narrative_summary: string | null;
}

export interface MemoryGlobalSearchReport {
  schema_version: typeof GLOBAL_SEARCH_SCHEMA_VERSION;
  read_only: true;
  surface: "memory.global-search";
  query: string;
  generated_from: {
    operation_id: "memory.community-digest";
    schema_version: CommunityDigestReport["schema_version"];
    graph_hash: string;
    cache_key: string;
    cached: boolean;
    provider: CommunityDigestReport["provider"];
  };
  total_hits: number;
  evidence: GlobalSearchDigestEvidence[];
  markdown: string;
}

interface BuildMemoryGlobalSearchOptions {
  cache?: CommunityDigestCacheMode;
  limit?: number;
  providerConfig?: AiProviderConfig;
}

/**
 * Broad, opt-in search over community digest evidence. This is intentionally
 * separate from governed recall: it reads deterministic digest summaries and
 * never calls or re-ranks the canonical recall path.
 */
export async function buildMemoryGlobalSearch(
  store: MemoryStore,
  query: string,
  opts: BuildMemoryGlobalSearchOptions = {},
): Promise<MemoryGlobalSearchReport> {
  const trimmedQuery = query.trim();
  const digest = await buildCommunityDigest(store, {
    cache: opts.cache ?? "read-only",
    providerConfig: opts.providerConfig,
  });
  const terms = uniqueTokens(trimmedQuery);
  const limit = opts.limit ?? 10;
  const evidence = digest.digests
    .map((entry) => scoreDigest(entry, terms))
    .filter((entry): entry is GlobalSearchDigestEvidence => entry !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.size - a.size ||
        a.community_id.localeCompare(b.community_id),
    )
    .slice(0, limit);

  const report: Omit<MemoryGlobalSearchReport, "markdown"> = {
    schema_version: GLOBAL_SEARCH_SCHEMA_VERSION,
    read_only: true,
    surface: "memory.global-search",
    query: trimmedQuery,
    generated_from: {
      operation_id: "memory.community-digest",
      schema_version: digest.schema_version,
      graph_hash: digest.graph_hash,
      cache_key: digest.cache_key,
      cached: digest.cached,
      provider: digest.provider,
    },
    total_hits: evidence.length,
    evidence,
  };

  return { ...report, markdown: renderGlobalSearchMarkdown(report) };
}

function scoreDigest(
  digest: CommunityDigest,
  terms: string[],
): GlobalSearchDigestEvidence | null {
  if (terms.length === 0) return null;
  const matched = new Set<string>();
  let score = 0;

  for (const label of digest.labels) {
    const labelTokens = uniqueTokens(label.value);
    for (const term of terms) {
      if (!tokensMatch(term, labelTokens)) continue;
      matched.add(term);
      score += label.count * 3;
    }
  }

  for (const nodeType of digest.node_types) {
    const typeTokens = uniqueTokens(nodeType.value);
    for (const term of terms) {
      if (!tokensMatch(term, typeTokens)) continue;
      matched.add(term);
      score += nodeType.count;
    }
  }

  for (const code of digest.engineering_codes) {
    const codeTokens = uniqueTokens(code.value);
    for (const term of terms) {
      if (!tokensMatch(term, codeTokens)) continue;
      matched.add(term);
      score += code.count * 2;
    }
  }

  if (digest.narrative_summary) {
    const narrativeTokens = uniqueTokens(digest.narrative_summary);
    for (const term of terms) {
      if (!tokensMatch(term, narrativeTokens)) continue;
      matched.add(term);
      score += 2;
    }
  }

  if (score === 0) return null;
  return {
    source: "community-digest",
    community_id: digest.community_id,
    score,
    matched_terms: [...matched].sort(),
    size: digest.size,
    short_label: digest.short_label,
    top_label: digest.top_label,
    top_node_type: digest.top_node_type,
    top_engineering_code: digest.top_engineering_code,
    labels: digest.labels.slice(0, 8),
    node_types: digest.node_types,
    engineering_codes: digest.engineering_codes,
    narrative_summary: digest.narrative_summary,
  };
}

function uniqueTokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean))];
}

function tokensMatch(term: string, candidateTokens: string[]): boolean {
  return candidateTokens.some((candidate) => {
    if (candidate === term) return true;
    if (term.length >= 4 && candidate.startsWith(term)) return true;
    if (candidate.length >= 4 && term.startsWith(candidate)) return true;
    return false;
  });
}

function renderGlobalSearchMarkdown(
  report: Omit<MemoryGlobalSearchReport, "markdown">,
): string {
  const lines = [
    "# Memory global search",
    "",
    `_Query: ${report.query}_`,
    "",
    "Opt-in broad search over Community digest evidence. This surface does not alter `memory recall` ranking.",
    "",
    `Generated from ${report.generated_from.operation_id} (${report.generated_from.schema_version}) on graph ${report.generated_from.graph_hash}.`,
    "",
    "## Evidence",
    "",
  ];

  if (report.evidence.length === 0) {
    lines.push("_No matching community digest evidence._", "");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push(
    "| Community | Score | Size | Matched terms | Top label | Top type | Labels |",
    "| --- | ---: | ---: | --- | --- | --- | --- |",
  );
  for (const item of report.evidence) {
    lines.push(
      `| ${item.community_id} | ${item.score} | ${item.size} | ${item.matched_terms.join(", ")} | ${item.top_label} | ${item.top_node_type} | ${item.labels.map((l) => `${l.value} ${l.count}`).join(", ")} |`,
    );
  }
  lines.push("");

  const summaries = report.evidence.filter((item) => item.narrative_summary);
  if (summaries.length > 0) {
    lines.push("## Narrative summaries", "");
    for (const item of summaries) {
      lines.push(`- ${item.community_id}: ${item.narrative_summary}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
