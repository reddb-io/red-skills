import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";

/* ----------------------------------------------------------------------------
 * memory bench eval — the deterministic eval spine (#334, parent #333, ADR 0037)
 *
 * The minimal end-to-end, deterministic QA path that the substrate benchmark is
 * built on:
 *
 *   corpus + question
 *     → the governed-recall substrate produces a FIXED context pack per question
 *     → the same answerer answers from that pack
 *     → an exact-match / token-F1 scorer scores against exact gold
 *     → raw per-question records are emitted as JSONL
 *
 * This file is one substrate (RedDB governed recall) and one category
 * (single-hop). It is intentionally pure and dependency-free so the cheap
 * deterministic core can gate every memory change in CI without a live RedDB
 * (PRD #333 stories 13, 15, 20). The richer tiers — live baselines, LLM-judge,
 * multi-hop / temporal / abstention categories — plug into the same shapes
 * later; this is the spine they hang off.
 *
 * Determinism contract: every function here is a pure function of its inputs.
 * No clocks, no randomness, no I/O beyond reading the checked-in fixtures. Ties
 * always break on entry id. Same fixture + same git ref ⇒ byte-identical output.
 * --------------------------------------------------------------------------*/

/** A curated engineering-memory entry. The two axes follow ADR 0035: a closed
 * `structural_type` and an open `engineering_code`. `fact` is the concise
 * canonical answer this entry supports — the fixed-pack answerer reads it. */
export interface CorpusEntry {
  id: string;
  structural_type: string;
  engineering_code: string;
  tags: string[];
  text: string;
  fact: string;
}

/** A single-hop question with exact gold. `gold_answer` is the authoritative
 * string the answer is scored against; `gold_doc_id` is the one corpus entry
 * that supports it (single-hop ⇒ exactly one). */
export interface Question {
  id: string;
  category: string;
  question: string;
  gold_doc_id: string;
  gold_answer: string;
}

export interface ContextPackEntry {
  id: string;
  rank: number;
  score: number;
  fact: string;
  text: string;
}

/** The fixed context pack a substrate hands to the answerer for one question. */
export interface ContextPack {
  question_id: string;
  substrate: string;
  entries: ContextPackEntry[];
}

export interface RetrievalHit {
  id: string;
  score: number;
}

export interface SubstrateAdapter<TIndex = unknown> {
  id: string;
  label: string;
  ingestCorpus(corpus: CorpusEntry[]): Promise<TIndex> | TIndex;
  retrieveQuery(index: TIndex, question: Question, limit: number): Promise<RetrievalHit[]> | RetrievalHit[];
  buildContextPack(
    index: TIndex,
    question: Question,
    hits: RetrievalHit[],
    packSize: number,
  ): Promise<ContextPack> | ContextPack;
}

export interface TokenCounts {
  input: number;
  output: number;
  total: number;
}

export const EVAL_SCHEMA_VERSION = "memory.bench.eval.v1" as const;

/** One raw per-question record. Written verbatim as a JSONL line; the schema is
 * stable and versioned so downstream readers (the RedDB analytics hypertable,
 * CI regression diffing) can rely on it. */
export interface QuestionRecord {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  substrate: string;
  category: string;
  question_id: string;
  question: string;
  gold_doc_id: string;
  gold_answer: string;
  predicted_answer: string;
  pack_ids: string[];
  gold_in_pack: boolean;
  gold_rank: number | null;
  exact_match: number;
  f1: number;
  tokens: TokenCounts;
  quality_per_1k_tokens: number;
}

export interface SubstrateSummary {
  substrate: string;
  label: string;
  aggregate: {
    exact_match: number;
    f1: number;
    gold_in_pack_rate: number;
    tokens: TokenCounts;
    quality_per_1k_tokens: number;
  };
  records: QuestionRecord[];
}

export interface SubstrateComparison {
  id: "reddb_vs_markdown-rag" | string;
  candidate: string;
  baseline: string;
  f1_delta: number;
  input_token_delta_pct: number | null;
  output_token_delta_pct: number | null;
  total_token_delta_pct: number | null;
  quality_per_token_delta_pct: number | null;
}

export interface EvalReport {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  generated_at: string;
  substrate: string;
  category: string;
  corpus_size: number;
  question_count: number;
  pack_size: number;
  aggregate: {
    exact_match: number;
    f1: number;
    gold_in_pack_rate: number;
    tokens: TokenCounts;
    quality_per_1k_tokens: number;
  };
  records: QuestionRecord[];
  substrates: SubstrateSummary[];
  comparisons: SubstrateComparison[];
}

/* ----------------------------------------------------------------------------
 * Corpus + question loaders
 * --------------------------------------------------------------------------*/

export async function loadCorpus(dir: string): Promise<CorpusEntry[]> {
  const raw = await readFile(join(dir, "corpus.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("corpus.json must be a JSON array");
  return parsed.map(asCorpusEntry);
}

export async function loadQuestions(dir: string): Promise<Question[]> {
  const raw = await readFile(join(dir, "questions.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("questions.json must be a JSON array");
  return parsed.map(asQuestion);
}

function asCorpusEntry(value: unknown): CorpusEntry {
  if (!value || typeof value !== "object") throw new Error("corpus entry must be an object");
  const r = value as Record<string, unknown>;
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    id: stringField(r, "id"),
    structural_type: stringField(r, "structural_type"),
    engineering_code: stringField(r, "engineering_code"),
    tags,
    text: stringField(r, "text"),
    fact: stringField(r, "fact"),
  };
}

export interface Neo4jSubstrateCommand {
  operation: "ingest" | "retrieve";
  cypher: string;
  params: Record<string, unknown>;
}

export interface Neo4jSubstrateResult {
  rows: Array<Record<string, unknown>>;
}

export type Neo4jSubstrateExecutor =
  (command: Neo4jSubstrateCommand) => Promise<Neo4jSubstrateResult> | Neo4jSubstrateResult;

export interface Neo4jSubstrateAdapterOptions {
  id?: string;
  executor?: Neo4jSubstrateExecutor;
}

function asQuestion(value: unknown): Question {
  if (!value || typeof value !== "object") throw new Error("question entry must be an object");
  const r = value as Record<string, unknown>;
  return {
    id: stringField(r, "id"),
    category: stringField(r, "category"),
    question: stringField(r, "question"),
    gold_doc_id: stringField(r, "gold_doc_id"),
    gold_answer: stringField(r, "gold_answer"),
  };
}

function stringField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") throw new Error(`field "${key}" must be a string`);
  return v;
}

/* ----------------------------------------------------------------------------
 * Governed-recall substrate → fixed context pack
 *
 * A deterministic stand-in for RedDB governed recall: it ranks the corpus by a
 * typed signal (question-token overlap against the entry text, plus a bonus for
 * tag/engineering-code overlap) and returns the top `packSize` entries as the
 * fixed pack. The shape mirrors the production recall path; the live RedDB
 * adapter slots in here later behind the same `ContextPack` contract without
 * touching the answerer or the scorer.
 * --------------------------------------------------------------------------*/

const PACK_SIZE_DEFAULT = 5;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

export function scoreEntry(question: Question, entry: CorpusEntry): number {
  const qTokens = new Set(tokenize(question.question));
  if (qTokens.size === 0) return 0;
  let overlap = 0;
  for (const tok of new Set(tokenize(entry.text))) if (qTokens.has(tok)) overlap += 1;
  // Typed bonus: the governed substrate also indexes tags + engineering code,
  // so a question token landing on one of those axes counts for more than a
  // bare body-text hit. Kept small so body overlap stays the dominant signal.
  let typed = 0;
  for (const tag of entry.tags) for (const part of tokenize(tag)) if (qTokens.has(part)) typed += 1;
  for (const part of tokenize(entry.engineering_code)) if (qTokens.has(part)) typed += 1;
  return overlap + typed * 0.5;
}

export function buildContextPack(
  corpus: CorpusEntry[],
  question: Question,
  packSize: number,
  substrate: string,
): ContextPack {
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  const hits = corpus
    .map((entry) => ({ id: entry.id, score: scoreEntry(question, entry) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, packSize)
    .map((hit) => ({ ...hit, score: round4(hit.score) }));
  return hitsToContextPack(byId, question, substrate, hits);
}

interface RedDbIndex {
  byId: Map<string, CorpusEntry>;
  entries: CorpusEntry[];
}

export function createRedDbSubstrateAdapter(id = "reddb"): SubstrateAdapter<RedDbIndex> {
  return {
    id,
    label: "RedDB governed recall",
    ingestCorpus(corpus) {
      return { byId: new Map(corpus.map((entry) => [entry.id, entry])), entries: corpus };
    },
    retrieveQuery(index, question, limit) {
      return index.entries
        .map((entry) => ({ id: entry.id, score: scoreEntry(question, entry) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((hit) => ({ ...hit, score: round4(hit.score) }));
    },
    buildContextPack(index, question, hits, packSize) {
      return hitsToContextPack(index.byId, question, id, hits.slice(0, packSize));
    },
  };
}

interface MarkdownNote {
  id: string;
  embedding: Map<string, number>;
}

interface MarkdownRagIndex {
  byId: Map<string, CorpusEntry>;
  notes: MarkdownNote[];
}

export function createMarkdownRagAdapter(id = "markdown-rag"): SubstrateAdapter<MarkdownRagIndex> {
  return {
    id,
    label: "Markdown embedding-RAG",
    ingestCorpus(corpus) {
      const notes = corpus.map((entry) => {
        const markdown = corpusEntryToMarkdown(entry);
        return { id: entry.id, embedding: embedText(markdown) };
      });
      return { byId: new Map(corpus.map((entry) => [entry.id, entry])), notes };
    },
    retrieveQuery(index, question, limit) {
      const qVec = embedText(question.question);
      return index.notes
        .map((note) => ({ id: note.id, score: cosine(qVec, note.embedding) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((hit) => ({ ...hit, score: round4(hit.score) }));
    },
    buildContextPack(index, question, hits, packSize) {
      return hitsToContextPack(index.byId, question, id, hits.slice(0, packSize));
    },
  };
}

interface Neo4jTerm {
  value: string;
  weight: number;
}

interface Neo4jIndex {
  byId: Map<string, CorpusEntry>;
  executor: Neo4jSubstrateExecutor;
  runId: string;
}

const NEO4J_INGEST_CORPUS_CYPHER = `
OPTIONAL MATCH (old:BenchMemory {bench_run: $runId})
DETACH DELETE old
WITH 1 AS _
UNWIND $entries AS entry
CREATE (memory:BenchMemory {id: entry.id, bench_run: $runId})
SET memory.structural_type = entry.structural_type,
    memory.engineering_code = entry.engineering_code,
    memory.fact = entry.fact,
    memory.text = entry.text
WITH memory, entry
UNWIND entry.terms AS term
MERGE (termNode:BenchTerm {value: term.value})
MERGE (memory)-[mention:MENTIONS]->(termNode)
SET mention.weight = term.weight
`;

const NEO4J_RETRIEVE_QUERY_CYPHER = `
MERGE (question:BenchQuestion {id: $questionId})
SET question.text = $question
WITH question
OPTIONAL MATCH (question)-[oldTerm:HAS_TERM]->()
DELETE oldTerm
WITH question
UNWIND $terms AS term
MERGE (termNode:BenchTerm {value: term.value})
MERGE (question)-[qTerm:HAS_TERM]->(termNode)
SET qTerm.weight = term.weight
WITH question
MATCH (question)-[qTerm:HAS_TERM]->(term:BenchTerm)<-[mention:MENTIONS]-(memory:BenchMemory)
WHERE memory.bench_run = $runId
WITH memory, sum(qTerm.weight * mention.weight) AS score
WHERE score > 0
RETURN memory.id AS id, score
ORDER BY score DESC, id ASC
LIMIT $limit
`;

export function createNeo4jSubstrateAdapter(
  opts: Neo4jSubstrateAdapterOptions = {},
): SubstrateAdapter<Neo4jIndex> {
  const id = opts.id ?? "neo4j";
  const executor = opts.executor ?? createInMemoryNeo4jSubstrateExecutor();
  const runId = `memory-bench-eval:${id}`;
  return {
    id,
    label: "Neo4j native graph traversal",
    async ingestCorpus(corpus) {
      const entries = corpus.map((entry) => ({
        id: entry.id,
        structural_type: entry.structural_type,
        engineering_code: entry.engineering_code,
        fact: entry.fact,
        text: entry.text,
        terms: neo4jEntryTerms(entry),
      }));
      await executor({
        operation: "ingest",
        cypher: NEO4J_INGEST_CORPUS_CYPHER,
        params: { runId, entries },
      });
      return { byId: new Map(corpus.map((entry) => [entry.id, entry])), executor, runId };
    },
    async retrieveQuery(index, question, limit) {
      const result = await index.executor({
        operation: "retrieve",
        cypher: NEO4J_RETRIEVE_QUERY_CYPHER,
        params: {
          runId: index.runId,
          questionId: question.id,
          question: question.question,
          terms: neo4jQuestionTerms(question),
          limit,
        },
      });
      return result.rows
        .map((row) => ({
          id: String(row.id ?? ""),
          score: typeof row.score === "number" ? row.score : Number(row.score),
        }))
        .filter((hit) => hit.id.length > 0 && Number.isFinite(hit.score) && hit.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((hit) => ({ ...hit, score: round4(hit.score) }));
    },
    buildContextPack(index, question, hits, packSize) {
      return hitsToContextPack(index.byId, question, id, hits.slice(0, packSize));
    },
  };
}

export function createInMemoryNeo4jSubstrateExecutor(): Neo4jSubstrateExecutor {
  const memories = new Map<string, Map<string, number>>();
  return (command) => {
    if (command.operation === "ingest") {
      memories.clear();
      const entries = Array.isArray(command.params.entries) ? command.params.entries : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const r = entry as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id : "";
        if (!id) continue;
        memories.set(id, neo4jTermsToMap(r.terms));
      }
      return { rows: [] };
    }

    const questionTerms = neo4jTermsToMap(command.params.terms);
    const rows: Array<Record<string, unknown>> = [];
    for (const [id, entryTerms] of memories) {
      let score = 0;
      for (const [term, qWeight] of questionTerms) {
        const weight = entryTerms.get(term);
        if (weight !== undefined) score += qWeight * weight;
      }
      if (score > 0) rows.push({ id, score: round4(score) });
    }
    rows.sort((a, b) => Number(b.score) - Number(a.score) || String(a.id).localeCompare(String(b.id)));
    const limit = typeof command.params.limit === "number" ? command.params.limit : rows.length;
    return { rows: rows.slice(0, limit) };
  };
}

function hitsToContextPack(
  byId: Map<string, CorpusEntry>,
  question: Question,
  substrate: string,
  hits: RetrievalHit[],
): ContextPack {
  const entries: ContextPackEntry[] = [];
  for (const hit of hits) {
    const entry = byId.get(hit.id);
    if (!entry) continue;
    entries.push({
      id: entry.id,
      rank: entries.length + 1,
      score: round4(hit.score),
      fact: entry.fact,
      text: entry.text,
    });
  }
  return { question_id: question.id, substrate, entries };
}

function corpusEntryToMarkdown(entry: CorpusEntry): string {
  return [
    `# ${entry.id}`,
    "",
    `Structural type: ${entry.structural_type}`,
    `Engineering code: ${entry.engineering_code}`,
    `Tags: ${entry.tags.join(", ")}`,
    "",
    "## Fact",
    "",
    entry.fact,
    "",
    "## Note",
    "",
    entry.text,
    "",
  ].join("\n");
}

function neo4jQuestionTerms(question: Question): Neo4jTerm[] {
  return uniqueTerms(tokenize(question.question), 1);
}

function neo4jEntryTerms(entry: CorpusEntry): Neo4jTerm[] {
  const weighted = new Map<string, number>();
  addWeightedTerms(weighted, tokenize(entry.text), 1);
  for (const tag of entry.tags) addWeightedTerms(weighted, tokenize(tag), 0.5);
  addWeightedTerms(weighted, tokenize(entry.engineering_code), 0.5);
  return [...weighted]
    .map(([value, weight]) => ({ value, weight: round4(weight) }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function uniqueTerms(tokens: string[], weight: number): Neo4jTerm[] {
  return [...new Set(tokens)].sort().map((value) => ({ value, weight }));
}

function addWeightedTerms(weighted: Map<string, number>, tokens: string[], weight: number): void {
  for (const token of new Set(tokens)) weighted.set(token, (weighted.get(token) ?? 0) + weight);
}

function neo4jTermsToMap(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const term = typeof r.value === "string" ? r.value : "";
    const weight = typeof r.weight === "number" ? r.weight : Number(r.weight);
    if (term && Number.isFinite(weight) && weight > 0) out.set(term, weight);
  }
  return out;
}

/**
 * Deterministic embedding vector for the markdown-RAG baseline. This is a real
 * embedding retrieval path (query vector → cosine top-k over note vectors), but
 * frozen and local so CI does not depend on a provider.
 */
export function embedText(text: string): Map<string, number> {
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
 * Answerer (fixed-pack, single-turn, deterministic)
 *
 * The fixed-pack answerer reads the top-ranked entry's canonical fact. This
 * cleanly isolates the substrate's contribution (PRD story 12): a correct
 * answer means governed recall put the answer-bearing entry on top of the pack;
 * an empty pack means the substrate surfaced nothing, so the answerer abstains.
 * The LLM answerer of the heavier tier replaces this one behind the same
 * (pack) → string signature.
 * --------------------------------------------------------------------------*/

export function answerFromPack(pack: ContextPack): string {
  return pack.entries[0]?.fact ?? "";
}

/* ----------------------------------------------------------------------------
 * Scorer — pure, unit-tested (PRD story 2; acceptance: pure module)
 *
 * SQuAD-style normalisation: lowercase, drop punctuation, drop leading articles,
 * collapse whitespace. Exact-match is the deterministic primary number; token
 * F1 gives partial credit so a "right entry, differently phrased" answer is not
 * scored identically to a wrong one.
 * --------------------------------------------------------------------------*/

export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function exactMatch(predicted: string, gold: string): number {
  return normalizeAnswer(predicted) === normalizeAnswer(gold) ? 1 : 0;
}

export function tokenF1(predicted: string, gold: string): number {
  const predTokens = normalizeAnswer(predicted).split(" ").filter(Boolean);
  const goldTokens = normalizeAnswer(gold).split(" ").filter(Boolean);
  if (predTokens.length === 0 && goldTokens.length === 0) return 1;
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;
  const goldCounts = new Map<string, number>();
  for (const t of goldTokens) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of predTokens) {
    const remaining = goldCounts.get(t);
    if (remaining && remaining > 0) {
      shared += 1;
      goldCounts.set(t, remaining - 1);
    }
  }
  if (shared === 0) return 0;
  const precision = shared / predTokens.length;
  const recall = shared / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/* ----------------------------------------------------------------------------
 * Token accounting — real tokenizer, not character counts
 * --------------------------------------------------------------------------*/

const CL100K = getEncoding("cl100k_base");

export function countBenchTokens(text: string): number {
  return CL100K.encode(text).length;
}

export function measureAnswererTokens(question: Question, pack: ContextPack, predictedAnswer: string): TokenCounts {
  const input = countBenchTokens(renderAnswererInput(question, pack));
  const output = countBenchTokens(predictedAnswer);
  return { input, output, total: input + output };
}

function renderAnswererInput(question: Question, pack: ContextPack): string {
  const lines = [
    "Answer the question using only the provided Memory context pack.",
    "",
    `Question: ${question.question}`,
    "",
    "Memory context pack:",
  ];
  for (const entry of pack.entries) {
    lines.push(
      `[${entry.rank}] id=${entry.id} score=${entry.score}`,
      `Fact: ${entry.fact}`,
      `Text: ${entry.text}`,
      "",
    );
  }
  return lines.join("\n");
}

function qualityPer1kTokens(quality: number, totalTokens: number): number {
  if (totalTokens <= 0) return 0;
  return round4((quality / totalTokens) * 1000);
}

/* ----------------------------------------------------------------------------
 * Runner — wires substrate → answerer → scorer, emits the report + records
 * --------------------------------------------------------------------------*/

export interface RunEvalOptions {
  corpusDir: string;
  packSize?: number;
  substrate?: string;
  adapters?: SubstrateAdapter[];
  now?: () => Date;
}

export async function runBenchEval(opts: RunEvalOptions): Promise<EvalReport> {
  const packSize = opts.packSize ?? PACK_SIZE_DEFAULT;
  const corpus = await loadCorpus(opts.corpusDir);
  const questions = await loadQuestions(opts.corpusDir);
  const adapters = opts.adapters ?? defaultSubstrateAdapters(opts.substrate);
  const reports: EvalReport[] = [];
  for (const adapter of adapters) {
    reports.push(await evaluateSubstrateAdapter(adapter, corpus, questions, {
      packSize,
      now: opts.now,
    }));
  }
  const primary = reports[0] ?? emptyEvalReport({
    corpus,
    questions,
    packSize,
    substrate: opts.substrate ?? "reddb",
    now: opts.now,
  });
  const substrates = reports.map(toSubstrateSummary);
  const comparisons = buildSubstrateComparisons(substrates);
  return { ...primary, substrates, comparisons };
}

export interface EvaluateSubstrateOptions {
  packSize?: number;
  now?: () => Date;
}

export async function evaluateSubstrateAdapter<TIndex>(
  adapter: SubstrateAdapter<TIndex>,
  corpus: CorpusEntry[],
  questions: Question[],
  opts: EvaluateSubstrateOptions = {},
): Promise<EvalReport> {
  const packSize = opts.packSize ?? PACK_SIZE_DEFAULT;
  const substrate = adapter.id;
  const index = await adapter.ingestCorpus(corpus);

  const records: QuestionRecord[] = [];
  let emSum = 0;
  let f1Sum = 0;
  let goldInPackCount = 0;
  const tokens: TokenCounts = { input: 0, output: 0, total: 0 };

  for (const q of questions) {
    const hits = await adapter.retrieveQuery(index, q, packSize);
    const pack = await adapter.buildContextPack(index, q, hits.slice(0, packSize), packSize);
    const predicted = answerFromPack(pack);
    const em = exactMatch(predicted, q.gold_answer);
    const f1 = tokenF1(predicted, q.gold_answer);
    const tokenUsage = measureAnswererTokens(q, pack, predicted);
    const packIds = pack.entries.map((e) => e.id);
    const goldIdx = packIds.indexOf(q.gold_doc_id);
    const goldInPack = goldIdx >= 0;
    emSum += em;
    f1Sum += f1;
    if (goldInPack) goldInPackCount += 1;
    tokens.input += tokenUsage.input;
    tokens.output += tokenUsage.output;
    tokens.total += tokenUsage.total;
    records.push({
      schema_version: EVAL_SCHEMA_VERSION,
      substrate,
      category: q.category,
      question_id: q.id,
      question: q.question,
      gold_doc_id: q.gold_doc_id,
      gold_answer: q.gold_answer,
      predicted_answer: predicted,
      pack_ids: packIds,
      gold_in_pack: goldInPack,
      gold_rank: goldInPack ? goldIdx + 1 : null,
      exact_match: em,
      f1: round4(f1),
      tokens: tokenUsage,
      quality_per_1k_tokens: qualityPer1kTokens(f1, tokenUsage.total),
    });
  }

  const n = Math.max(questions.length, 1);
  const category = questions[0]?.category ?? "single-hop";
  const now = (opts.now ?? (() => new Date()))();
  const aggregate = {
    exact_match: round4(emSum / n),
    f1: round4(f1Sum / n),
    gold_in_pack_rate: round4(goldInPackCount / n),
    tokens,
    quality_per_1k_tokens: qualityPer1kTokens(f1Sum, tokens.total),
  };
  return {
    schema_version: EVAL_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    substrate,
    category,
    corpus_size: corpus.length,
    question_count: questions.length,
    pack_size: packSize,
    aggregate,
    records,
    substrates: [{
      substrate,
      label: adapter.label,
      aggregate,
      records,
    }],
    comparisons: [],
  };
}

function defaultSubstrateAdapters(substrate?: string): SubstrateAdapter[] {
  if (!substrate || substrate === "reddb") {
    return [
      createRedDbSubstrateAdapter("reddb"),
      createMarkdownRagAdapter("markdown-rag"),
      createNeo4jSubstrateAdapter({ id: "neo4j" }),
    ];
  }
  if (substrate === "markdown-rag") return [createMarkdownRagAdapter("markdown-rag")];
  if (substrate === "neo4j") return [createNeo4jSubstrateAdapter({ id: "neo4j" })];
  throw new Error(`unknown memory bench eval substrate: ${substrate}`);
}

function emptyEvalReport(opts: {
  corpus: CorpusEntry[];
  questions: Question[];
  packSize: number;
  substrate: string;
  now?: () => Date;
}): EvalReport {
  const now = (opts.now ?? (() => new Date()))();
  const aggregate = {
    exact_match: 0,
    f1: 0,
    gold_in_pack_rate: 0,
    tokens: { input: 0, output: 0, total: 0 },
    quality_per_1k_tokens: 0,
  };
  return {
    schema_version: EVAL_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    substrate: opts.substrate,
    category: opts.questions[0]?.category ?? "single-hop",
    corpus_size: opts.corpus.length,
    question_count: opts.questions.length,
    pack_size: opts.packSize,
    aggregate,
    records: [],
    substrates: [],
    comparisons: [],
  };
}

function toSubstrateSummary(report: EvalReport): SubstrateSummary {
  return {
    substrate: report.substrate,
    label: report.substrates[0]?.label ?? report.substrate,
    aggregate: report.aggregate,
    records: report.records,
  };
}

function buildSubstrateComparisons(summaries: SubstrateSummary[]): SubstrateComparison[] {
  const reddb = summaries.find((summary) => summary.substrate === "reddb");
  if (!reddb) return [];
  return summaries
    .filter((summary) => summary.substrate !== reddb.substrate)
    .map((baseline) => ({
      id: `reddb_vs_${baseline.substrate}`,
      candidate: reddb.substrate,
      baseline: baseline.substrate,
      f1_delta: round4(reddb.aggregate.f1 - baseline.aggregate.f1),
      input_token_delta_pct: pctDelta(reddb.aggregate.tokens.input, baseline.aggregate.tokens.input),
      output_token_delta_pct: pctDelta(reddb.aggregate.tokens.output, baseline.aggregate.tokens.output),
      total_token_delta_pct: pctDelta(reddb.aggregate.tokens.total, baseline.aggregate.tokens.total),
      quality_per_token_delta_pct: pctDelta(
        reddb.aggregate.quality_per_1k_tokens,
        baseline.aggregate.quality_per_1k_tokens,
      ),
    }));
}

/* ----------------------------------------------------------------------------
 * JSONL + markdown serialisation
 * --------------------------------------------------------------------------*/

/** Stable JSONL: one record object per line, trailing newline. Field order is
 * fixed by `QuestionRecord` construction above, so the bytes are reproducible. */
export function toJsonl(records: QuestionRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
}

export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# memory bench eval — ${report.generated_at.slice(0, 10)}`);
  lines.push("");
  lines.push(
    `Substrate: \`${report.substrate}\` · category: \`${report.category}\` · corpus: ${report.corpus_size} entries · questions: ${report.question_count} · pack size: ${report.pack_size}.`,
  );
  lines.push("");
  if (report.substrates.length > 1) {
    lines.push("## Substrates");
    lines.push("");
    lines.push("| substrate | EM | F1 | gold-in-pack | input tokens | output tokens | total tokens | F1 / 1k tokens |");
    lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: |");
    for (const summary of report.substrates) {
      lines.push(
        `| ${summary.substrate} | ${summary.aggregate.exact_match.toFixed(3)} | ${summary.aggregate.f1.toFixed(3)} | ${summary.aggregate.gold_in_pack_rate.toFixed(3)} | ${summary.aggregate.tokens.input} | ${summary.aggregate.tokens.output} | ${summary.aggregate.tokens.total} | ${summary.aggregate.quality_per_1k_tokens.toFixed(3)} |`,
      );
    }
    if (report.comparisons.length > 0) {
      lines.push("");
      lines.push("## Quality Per Token");
      lines.push("");
      lines.push("| comparison | F1 Δ | total token Δ | quality/token Δ |");
      lines.push("| --- | ---: | ---: | ---: |");
      for (const comparison of report.comparisons) {
        lines.push(
          `| ${comparison.id} | ${comparison.f1_delta.toFixed(3)} | ${formatPct(comparison.total_token_delta_pct)} | ${formatPct(comparison.quality_per_token_delta_pct)} |`,
        );
      }
    }
    lines.push("");
    lines.push("## Primary Substrate");
    lines.push("");
  }
  lines.push("| metric | score |");
  lines.push("| --- | --- |");
  lines.push(`| exact-match | ${report.aggregate.exact_match.toFixed(3)} |`);
  lines.push(`| token-F1 | ${report.aggregate.f1.toFixed(3)} |`);
  lines.push(`| gold-in-pack rate | ${report.aggregate.gold_in_pack_rate.toFixed(3)} |`);
  lines.push(`| input tokens | ${report.aggregate.tokens.input} |`);
  lines.push(`| output tokens | ${report.aggregate.tokens.output} |`);
  lines.push(`| quality per 1k tokens | ${report.aggregate.quality_per_1k_tokens.toFixed(3)} |`);
  lines.push("");
  lines.push("## Per-question");
  lines.push("");
  lines.push("| question_id | gold_rank | EM | F1 | tokens | F1 / 1k tokens | predicted |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | --- |");
  for (const r of report.records) {
    lines.push(
      `| ${r.question_id} | ${r.gold_rank ?? "—"} | ${r.exact_match} | ${r.f1.toFixed(3)} | ${r.tokens.total} | ${r.quality_per_1k_tokens.toFixed(3)} | ${r.predicted_answer || "(abstain)"} |`,
    );
  }
  lines.push("");
  lines.push("## Reproducibility");
  lines.push("");
  lines.push(
    "Deterministic by construction: recall, the fixed-pack answerer, and the exact-match/F1 scorer are pure functions of the checked-in corpus and questions. Same git ref ⇒ identical scores and identical JSONL bytes (the test suite asserts byte-equality across runs).",
  );
  lines.push("");
  return lines.join("\n");
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function pctDelta(candidate: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return round4(((candidate - baseline) / baseline) * 100);
}

function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}
