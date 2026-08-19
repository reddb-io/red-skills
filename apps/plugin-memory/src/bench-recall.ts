import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CorpusEntry {
  id: string;
  type: string;
  tags: string[];
  text: string;
}

export interface QueryEntry {
  id: string;
  query: string;
  intent: string;
  relevant_ids: string[];
}

export interface PerQueryResult {
  query_id: string;
  query: string;
  intent: string;
  relevant_ids: string[];
  ours: { hits: string[]; precision_at_k: Record<string, number>; recall_at_k: Record<string, number> };
  ams_reference: { hits: string[]; precision_at_k: Record<string, number>; recall_at_k: Record<string, number> };
}

export interface BenchReport {
  schema_version: "memory.bench.recall.v1";
  generated_at: string;
  corpus_size: number;
  query_count: number;
  k_values: number[];
  aggregate: {
    ours: { precision_at_k: Record<string, number>; recall_at_k: Record<string, number> };
    ams_reference: { precision_at_k: Record<string, number>; recall_at_k: Record<string, number> };
    delta: { precision_at_k: Record<string, number>; recall_at_k: Record<string, number> };
  };
  per_query: PerQueryResult[];
}

/* ----------------------------------------------------------------------------
 * Corpus loaders
 * --------------------------------------------------------------------------*/

export async function loadCorpus(dir: string): Promise<CorpusEntry[]> {
  const raw = await readFile(join(dir, "corpus.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("corpus.json must be a JSON array");
  return parsed.map(asCorpusEntry);
}

export async function loadQueries(dir: string): Promise<QueryEntry[]> {
  const raw = await readFile(join(dir, "queries.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("queries.json must be a JSON array");
  return parsed.map(asQueryEntry);
}

function asCorpusEntry(value: unknown): CorpusEntry {
  if (!value || typeof value !== "object") throw new Error("corpus entry must be an object");
  const r = value as Record<string, unknown>;
  const id = stringField(r, "id");
  const type = stringField(r, "type");
  const text = stringField(r, "text");
  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string => typeof t === "string")
    : [];
  return { id, type, tags, text };
}

function asQueryEntry(value: unknown): QueryEntry {
  if (!value || typeof value !== "object") throw new Error("query entry must be an object");
  const r = value as Record<string, unknown>;
  const id = stringField(r, "id");
  const query = stringField(r, "query");
  const intent = stringField(r, "intent");
  const relevant_ids = Array.isArray(r.relevant_ids)
    ? r.relevant_ids.filter((t): t is string => typeof t === "string")
    : [];
  return { id, query, intent, relevant_ids };
}

function stringField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") throw new Error(`field "${key}" must be a string`);
  return v;
}

/* ----------------------------------------------------------------------------
 * Tokenisation + embeddings (deterministic, dependency-free)
 * --------------------------------------------------------------------------*/

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

/**
 * Deterministic char-bigram TF embedding. AMS-style baselines lean on
 * external embedding providers; for a reproducible bench we replace that with
 * a frozen vector space so both strategies see the exact same vector signal
 * across runs and across machines. The shape is irrelevant — only the
 * relative cosine ordering matters for ranking.
 */
export function embed(text: string): Map<string, number> {
  const v = new Map<string, number>();
  const cleaned = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  const grams = [...cleaned.matchAll(/[a-z0-9]{2,3}/g)].map((m) => m[0]);
  for (let i = 0; i < cleaned.length - 1; i++) {
    const bi = cleaned.slice(i, i + 2);
    if (bi.length === 2 && /[a-z0-9]/.test(bi[0]!) && /[a-z0-9]/.test(bi[1]!)) {
      v.set(bi, (v.get(bi) ?? 0) + 1);
    }
  }
  for (const g of grams) v.set(g, (v.get(g) ?? 0) + 0.5);
  return v;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const u = large.get(k);
    if (u !== undefined) dot += v * u;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ----------------------------------------------------------------------------
 * Ranking strategies
 * --------------------------------------------------------------------------*/

/**
 * AMS-style reference: pure-vector cosine ranking. Mirrors the redis
 * `agent-memory-server` recall path — embed query, embed corpus, sort by
 * cosine. No type filter, no graph hops, no keyword channel. ADR 0005 documents
 * why we do not aim for wire-compat with AMS; this bench tests recall quality
 * against AMS's central design choice (vector-only ranking) on a fixed corpus.
 */
export function rankAmsReference(corpus: CorpusEntry[], query: QueryEntry, k: number): string[] {
  const qVec = embed(query.query);
  const scored = corpus.map((c) => ({ id: c.id, score: cosine(qVec, embed(c.text)) }));
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, k).map((s) => s.id);
}

/**
 * Our memory plugin's ranking, distilled: Reciprocal Rank Fusion (#180) over
 * three axes. The graph axis uses the typed-node + tag-edge signal that our
 * L3 store carries natively (intent match + shared-tag co-occurrence) — the
 * thing AMS's pure-vector path cannot represent.
 *
 * RRF weights all sources equally: a hit's final position is the sum of
 * `1 / (rrf_k + rank_in_source)` across the three axes. No per-source weights,
 * no hand-tuned multipliers — same composer the production `hybrid-recall`
 * uses.
 */
export function rankOurs(corpus: CorpusEntry[], query: QueryEntry, k: number): string[] {
  const queryTokens = new Set(tokenize(query.query));

  const keywordRanks = scoreAndRank(corpus, (c) => {
    const t = tokenize(c.text);
    let hits = 0;
    for (const tok of t) if (queryTokens.has(tok)) hits += 1;
    return hits;
  });

  const qVec = embed(query.query);
  const vectorRanks = scoreAndRank(corpus, (c) => cosine(qVec, embed(c.text)));

  const queryTagSet = inferQueryTags(query, corpus);
  const graphRanks = scoreAndRank(corpus, (c) => {
    const typeBonus = c.type === query.intent ? 1 : 0;
    let tagOverlap = 0;
    for (const tag of c.tags) if (queryTagSet.has(tag)) tagOverlap += 1;
    return typeBonus * 2 + tagOverlap;
  });

  return rrfFuse([keywordRanks, vectorRanks, graphRanks], k);
}

/**
 * Seeds the "graph" axis with tags inferred from the most keyword-relevant
 * corpus entries. Real L3 recall would expand from explicit node-tag edges;
 * the bench mirrors that with a one-hop tag-overlap proxy so it stays
 * dependency-free and deterministic.
 */
function inferQueryTags(query: QueryEntry, corpus: CorpusEntry[]): Set<string> {
  const queryTokens = new Set(tokenize(query.query));
  const scored = corpus
    .map((c) => {
      let hits = 0;
      for (const tok of tokenize(c.text)) if (queryTokens.has(tok)) hits += 1;
      return { c, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.c.id.localeCompare(b.c.id))
    .slice(0, 3);
  const tags = new Set<string>();
  for (const s of scored) for (const t of s.c.tags) tags.add(t);
  return tags;
}

function scoreAndRank(
  corpus: CorpusEntry[],
  score: (c: CorpusEntry) => number,
): Map<string, number> {
  const scored = corpus
    .map((c) => ({ id: c.id, score: score(c) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const ranks = new Map<string, number>();
  for (let i = 0; i < scored.length; i++) ranks.set(scored[i]!.id, i + 1);
  return ranks;
}

const RRF_K = 60;

function rrfFuse(rankings: Map<string, number>[], k: number): string[] {
  const fused = new Map<string, number>();
  for (const r of rankings) {
    for (const [id, rank] of r) {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map((e) => e[0]);
}

/* ----------------------------------------------------------------------------
 * Metrics
 * --------------------------------------------------------------------------*/

export function precisionAtK(hits: string[], relevant: string[], k: number): number {
  if (k === 0) return 0;
  const relevantSet = new Set(relevant);
  const top = hits.slice(0, k);
  let matched = 0;
  for (const id of top) if (relevantSet.has(id)) matched += 1;
  return matched / k;
}

export function recallAtK(hits: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const relevantSet = new Set(relevant);
  const top = hits.slice(0, k);
  let matched = 0;
  for (const id of top) if (relevantSet.has(id)) matched += 1;
  return matched / relevant.length;
}

/* ----------------------------------------------------------------------------
 * Bench runner
 * --------------------------------------------------------------------------*/

export interface RunBenchOptions {
  corpusDir: string;
  kValues?: number[];
  now?: () => Date;
}

export async function runBenchRecall(opts: RunBenchOptions): Promise<BenchReport> {
  const ks = (opts.kValues ?? [1, 5, 10]).slice().sort((a, b) => a - b);
  const corpus = await loadCorpus(opts.corpusDir);
  const queries = await loadQueries(opts.corpusDir);
  const maxK = Math.max(...ks);

  const perQuery: PerQueryResult[] = [];
  const agg = {
    ours: { precision: zeroFor(ks), recall: zeroFor(ks) },
    ams: { precision: zeroFor(ks), recall: zeroFor(ks) },
  };

  for (const q of queries) {
    const oursHits = rankOurs(corpus, q, maxK);
    const amsHits = rankAmsReference(corpus, q, maxK);
    const oursP: Record<string, number> = {};
    const oursR: Record<string, number> = {};
    const amsP: Record<string, number> = {};
    const amsR: Record<string, number> = {};
    for (const k of ks) {
      const op = precisionAtK(oursHits, q.relevant_ids, k);
      const or = recallAtK(oursHits, q.relevant_ids, k);
      const ap = precisionAtK(amsHits, q.relevant_ids, k);
      const ar = recallAtK(amsHits, q.relevant_ids, k);
      oursP[String(k)] = round4(op);
      oursR[String(k)] = round4(or);
      amsP[String(k)] = round4(ap);
      amsR[String(k)] = round4(ar);
      agg.ours.precision[k] += op;
      agg.ours.recall[k] += or;
      agg.ams.precision[k] += ap;
      agg.ams.recall[k] += ar;
    }
    perQuery.push({
      query_id: q.id,
      query: q.query,
      intent: q.intent,
      relevant_ids: q.relevant_ids,
      ours: { hits: oursHits, precision_at_k: oursP, recall_at_k: oursR },
      ams_reference: { hits: amsHits, precision_at_k: amsP, recall_at_k: amsR },
    });
  }

  const n = Math.max(queries.length, 1);
  const oursAggP: Record<string, number> = {};
  const oursAggR: Record<string, number> = {};
  const amsAggP: Record<string, number> = {};
  const amsAggR: Record<string, number> = {};
  const deltaP: Record<string, number> = {};
  const deltaR: Record<string, number> = {};
  for (const k of ks) {
    oursAggP[String(k)] = round4(agg.ours.precision[k] / n);
    oursAggR[String(k)] = round4(agg.ours.recall[k] / n);
    amsAggP[String(k)] = round4(agg.ams.precision[k] / n);
    amsAggR[String(k)] = round4(agg.ams.recall[k] / n);
    deltaP[String(k)] = round4(oursAggP[String(k)]! - amsAggP[String(k)]!);
    deltaR[String(k)] = round4(oursAggR[String(k)]! - amsAggR[String(k)]!);
  }

  const now = (opts.now ?? (() => new Date()))();
  return {
    schema_version: "memory.bench.recall.v1",
    generated_at: now.toISOString(),
    corpus_size: corpus.length,
    query_count: queries.length,
    k_values: ks,
    aggregate: {
      ours: { precision_at_k: oursAggP, recall_at_k: oursAggR },
      ams_reference: { precision_at_k: amsAggP, recall_at_k: amsAggR },
      delta: { precision_at_k: deltaP, recall_at_k: deltaR },
    },
    per_query: perQuery,
  };
}

function zeroFor(ks: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const k of ks) out[k] = 0;
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/* ----------------------------------------------------------------------------
 * Markdown report formatter
 * --------------------------------------------------------------------------*/

export function formatMarkdownReport(report: BenchReport): string {
  const ks = report.k_values;
  const headerCells = ["strategy", ...ks.map((k) => `P@${k}`), ...ks.map((k) => `R@${k}`)];
  const aggRow = (label: string, p: Record<string, number>, r: Record<string, number>) =>
    `| ${label} | ${ks.map((k) => fmt(p[String(k)])).join(" | ")} | ${ks
      .map((k) => fmt(r[String(k)]))
      .join(" | ")} |`;

  const lines: string[] = [];
  lines.push(`# memory bench recall — ${report.generated_at.slice(0, 10)}`);
  lines.push("");
  lines.push(
    `Corpus: ${report.corpus_size} transcript chunks, ${report.query_count} labeled queries. Reference baseline is pure-vector cosine ranking (the AMS recall path per ADR 0005).`,
  );
  lines.push("");
  lines.push(`| ${headerCells.join(" | ")} |`);
  lines.push(`| ${headerCells.map(() => "---").join(" | ")} |`);
  lines.push(aggRow("ours (RRF: keyword + vector + graph)", report.aggregate.ours.precision_at_k, report.aggregate.ours.recall_at_k));
  lines.push(aggRow("ams_reference (vector only)", report.aggregate.ams_reference.precision_at_k, report.aggregate.ams_reference.recall_at_k));
  lines.push(aggRow("Δ (ours − ams)", report.aggregate.delta.precision_at_k, report.aggregate.delta.recall_at_k));
  lines.push("");
  lines.push("## Reproducibility");
  lines.push("");
  lines.push(
    "The bench is deterministic: corpus, queries, embeddings (char-bigram TF), and ranking algorithms are pure functions of the checked-in inputs. Same git ref ⇒ identical numbers. Tolerance is zero — the test suite asserts byte-equal per-query hits across runs.",
  );
  lines.push("");
  lines.push("## Per-query");
  lines.push("");
  const perCells = ["query_id", "intent", ...ks.map((k) => `ours P@${k}`), ...ks.map((k) => `ams P@${k}`)];
  lines.push(`| ${perCells.join(" | ")} |`);
  lines.push(`| ${perCells.map(() => "---").join(" | ")} |`);
  for (const r of report.per_query) {
    lines.push(
      `| ${r.query_id} | ${r.intent} | ${ks.map((k) => fmt(r.ours.precision_at_k[String(k)])).join(" | ")} | ${ks
        .map((k) => fmt(r.ams_reference.precision_at_k[String(k)]))
        .join(" | ")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function fmt(n: number | undefined): string {
  return (n ?? 0).toFixed(3);
}
