import { RRF_K, hybridRecall, type Ranking } from "./hybrid-recall.js";
import type { RecalledNode } from "./engine.js";
import { tokenize } from "./recall.js";

export interface RecallRankingConfig {
  /** RRF smoothing constant. Default: 60. */
  rrfK: number;
  /** Half-life for exponential recency decay. Default: 30 days. */
  recencyHalfLifeDays: number;
  /** Relevance-vs-diversity balance for MMR. Default: 0.72. */
  mmrLambda: number;
  /** Number of deterministic query variants to ask each retrieval channel for. Default: 4. */
  queryVariantLimit: number;
  /** Whether to interleave final hits by session id. Default: true. */
  sessionRoundRobin: boolean;
}

export const DEFAULT_RECALL_RANKING_CONFIG: RecallRankingConfig = {
  rrfK: RRF_K,
  recencyHalfLifeDays: 30,
  mmrLambda: 0.72,
  queryVariantLimit: 4,
  sessionRoundRobin: true,
};

export interface RecallRankingInput {
  query: string;
  candidates: readonly RecalledNode[];
  rankings: readonly Ranking[];
  limit: number;
  now?: number;
  config?: Partial<RecallRankingConfig>;
}

export interface RankedRecallCandidate {
  node: RecalledNode;
  score: number;
  rrfScore: number;
  recencyMultiplier: number;
  mmrScore: number;
  signalProvenance: RecallSignalProvenance[];
}

export interface RecallSignalProvenance {
  source: string;
  rank: number;
  contribution: number;
}

export function resolveRecallRankingConfig(
  config: Partial<RecallRankingConfig> | null | undefined,
): RecallRankingConfig {
  const defaults = DEFAULT_RECALL_RANKING_CONFIG;
  return {
    rrfK: positive(config?.rrfK) ?? defaults.rrfK,
    recencyHalfLifeDays: positive(config?.recencyHalfLifeDays) ?? defaults.recencyHalfLifeDays,
    mmrLambda: unit(config?.mmrLambda) ?? defaults.mmrLambda,
    queryVariantLimit: positiveInteger(config?.queryVariantLimit) ?? defaults.queryVariantLimit,
    sessionRoundRobin:
      typeof config?.sessionRoundRobin === "boolean"
        ? config.sessionRoundRobin
        : defaults.sessionRoundRobin,
  };
}

export function buildRecallQueryVariants(
  query: string,
  limit = DEFAULT_RECALL_RANKING_CONFIG.queryVariantLimit,
): string[] {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  const variants: string[] = [normalized];
  const tokens = tokenize(normalized);
  if (tokens.length > 1) variants.push(tokens.join(" "));
  for (const token of tokens) {
    if (token.length >= 4) variants.push(token);
  }
  return unique(variants).slice(0, Math.max(1, limit));
}

export function rankRecallCandidates(input: RecallRankingInput): RankedRecallCandidate[] {
  const config = resolveRecallRankingConfig(input.config);
  const now = input.now ?? Date.now();
  const candidates = new Map<number, RecalledNode>();
  for (const node of input.candidates) candidates.set(node.rid, node);
  if (candidates.size === 0 || input.limit <= 0) return [];

  const rankings = input.rankings.length > 0
    ? input.rankings
    : [{ source: "candidate", rids: input.candidates.map((node) => node.rid) }];
  const fused = hybridRecall([...rankings], { k: config.rrfK });
  const fusedRids = new Set(fused.map((hit) => hit.rid));
  const baseOrder = input.candidates.map((node) => node.rid).filter((rid) => !fusedRids.has(rid));
  const completeFused = baseOrder.length > 0
    ? [
        ...fused,
        ...hybridRecall([{ source: "candidate", rids: baseOrder }], { k: config.rrfK }),
      ]
    : fused;

  const scored: RankedRecallCandidate[] = [];
  for (const hit of completeFused) {
    const node = candidates.get(hit.rid);
    if (!node) continue;
    const recencyMultiplier = recencyDecay(node, now, config.recencyHalfLifeDays);
    const score = hit.score * recencyMultiplier;
    scored.push({
      node,
      score,
      rrfScore: hit.score,
      recencyMultiplier,
      mmrScore: score,
      signalProvenance: signalProvenanceFromContributors(hit.contributors, config.rrfK),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.node.rid - b.node.rid);

  const diversified = mmr(scored, config.mmrLambda, input.limit);
  const finalOrder = config.sessionRoundRobin ? roundRobinBySession(diversified) : diversified;
  return finalOrder.slice(0, input.limit);
}

function mmr(
  candidates: readonly RankedRecallCandidate[],
  lambda: number,
  limit: number,
): RankedRecallCandidate[] {
  const remaining = [...candidates];
  const selected: RankedRecallCandidate[] = [];
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const maxSimilarity = selected.reduce(
        (max, chosen) => Math.max(max, similarity(candidate.node, chosen.node)),
        0,
      );
      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSimilarity;
      if (
        mmrScore > bestScore ||
        (mmrScore === bestScore && candidate.node.rid < remaining[bestIndex]!.node.rid)
      ) {
        bestIndex = i;
        bestScore = mmrScore;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push({ ...chosen!, mmrScore: bestScore });
  }
  return selected;
}

function roundRobinBySession(
  candidates: readonly RankedRecallCandidate[],
): RankedRecallCandidate[] {
  const groups = new Map<string, RankedRecallCandidate[]>();
  for (const candidate of candidates) {
    const key = sessionKey(candidate.node);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const orderedKeys = [...groups.entries()]
    .sort((a, b) => b[1]![0]!.mmrScore - a[1]![0]!.mmrScore || a[0].localeCompare(b[0]))
    .map(([key]) => key);
  const out: RankedRecallCandidate[] = [];
  while (out.length < candidates.length) {
    let progressed = false;
    for (const key of orderedKeys) {
      const next = groups.get(key)?.shift();
      if (!next) continue;
      out.push(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

function recencyDecay(node: RecalledNode, now: number, halfLifeDays: number): number {
  const halfLifeMs = halfLifeDays * 86_400_000;
  const ts = latestTimestamp(node);
  const ageMs = Math.max(0, now - ts);
  return 0.5 ** (ageMs / halfLifeMs);
}

function latestTimestamp(node: RecalledNode): number {
  const p = node.properties;
  return Math.max(p.accessed_at ?? 0, p.updated_at ?? 0, p.created_at ?? 0);
}

function similarity(a: RecalledNode, b: RecalledNode): number {
  const left = textTokens(a);
  const right = textTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function textTokens(node: RecalledNode): Set<string> {
  const p = node.properties;
  const tags = Array.isArray(p.tags) ? p.tags.join(" ") : "";
  return new Set(tokenize([node.label, p.title, p.summary, p.content, tags].filter(Boolean).join(" ")));
}

function sessionKey(node: RecalledNode): string {
  const p = node.properties;
  const explicit = p.session_id ?? p.sessionId ?? p.session;
  if (typeof explicit === "string" && explicit) return explicit;
  if (p.scope === "session" && typeof p.scope_id === "string" && p.scope_id) return p.scope_id;
  const provenanceScope = p.provenance?.scope;
  if (provenanceScope?.level === "session" && provenanceScope.id) return provenanceScope.id;
  return `rid:${node.rid}`;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function unit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function signalProvenanceFromContributors(
  contributors: Record<string, number>,
  rrfK: number,
): RecallSignalProvenance[] {
  return Object.entries(contributors)
    .map(([source, rank], index) => ({
      source,
      rank,
      contribution: 1 / (rrfK + rank),
      index,
    }))
    .sort((a, b) => b.contribution - a.contribution || a.index - b.index)
    .map(({ source, rank, contribution }) => ({ source, rank, contribution }));
}
