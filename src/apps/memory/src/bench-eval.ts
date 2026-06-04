import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import type { ProviderClient, ProviderRequest } from "./extract-conversation.js";

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
 * This file is one substrate (RedDB governed recall) and multiple structural
 * categories (single-hop, multi-hop, temporal-as-of, unanswerable). It is intentionally pure and dependency-free so the cheap
 * deterministic core can gate every memory change in CI without a live RedDB
 * (PRD #333 stories 13, 15, 20). The richer tiers — live baselines,
 * LLM-judge, and richer abstention categories — plug into the same shapes
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
  relations: CorpusRelation[];
  valid_from?: string;
  valid_until?: string | null;
  supersedes?: string;
  superseded_by?: string;
}

export interface CorpusRelation {
  type: string;
  target_id: string;
}

/** A bench question with exact gold. `gold_answer` is the authoritative string
 * the answer is scored against. `gold_doc_id` remains the primary supporting
 * entry for v1 readers; `gold_doc_ids` carries full support chains for
 * multi-hop and temporal questions. */
export interface Question {
  id: string;
  category: string;
  question: string;
  gold_doc_id: string;
  gold_doc_ids: string[];
  gold_answer: string;
  as_of?: string;
}

export interface ContextPackEntry {
  id: string;
  rank: number;
  score: number;
  fact: string;
  text: string;
  valid_from?: string;
  valid_until?: string | null;
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

export const JUDGE_J_SCORER = "J" as const;
export const JUDGE_J_MODEL = "gpt-4o-2024-08-06" as const;
export const JUDGE_J_PROMPT_VERSION = "memory-bench-judge-j.v1" as const;
export const JUDGE_J_OPEN_ENDED_CATEGORIES = ["multi-hop", "temporal-as-of"] as const;

export interface JudgeJConfig {
  scorer: typeof JUDGE_J_SCORER;
  model: typeof JUDGE_J_MODEL | string;
  prompt_version: typeof JUDGE_J_PROMPT_VERSION | string;
  open_ended_categories: readonly string[];
  score_range: readonly [0, 1];
}

export const FROZEN_JUDGE_J_CONFIG: JudgeJConfig = {
  scorer: JUDGE_J_SCORER,
  model: JUDGE_J_MODEL,
  prompt_version: JUDGE_J_PROMPT_VERSION,
  open_ended_categories: JUDGE_J_OPEN_ENDED_CATEGORIES,
  score_range: [0, 1],
};

export interface JudgeJInput {
  question: Question;
  predicted_answer: string;
  gold_answer: string;
  context_pack: ContextPack;
  exact_match: number;
  f1: number;
}

export interface JudgeJResult {
  score: number;
  verdict: "correct" | "partial" | "incorrect";
  rationale: string;
}

export interface JudgeJAdapter {
  config: JudgeJConfig;
  score(input: JudgeJInput): Promise<JudgeJResult> | JudgeJResult;
}

export interface JudgeJRecord {
  scorer: typeof JUDGE_J_SCORER;
  model: string;
  prompt_version: string;
  score: number;
  verdict: JudgeJResult["verdict"];
  rationale: string;
}

export interface JudgeJAggregate {
  scorer: typeof JUDGE_J_SCORER;
  model: string;
  prompt_version: string;
  score: number | null;
  judged_question_count: number;
  open_ended_question_count: number;
}

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
  gold_doc_ids: string[];
  as_of: string | null;
  gold_answer: string;
  predicted_answer: string;
  unanswerable: boolean;
  open_ended: boolean;
  abstained: boolean;
  abstention_score: number;
  judge_j: JudgeJRecord | null;
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
    judge_j: JudgeJAggregate | null;
    abstention_score: number;
    gold_in_pack_rate: number;
    tokens: TokenCounts;
    quality_per_1k_tokens: number;
  };
  records: QuestionRecord[];
}

export interface ParetoPoint {
  substrate: string;
  label: string;
  f1: number;
  total_tokens: number;
  quality_per_1k_tokens: number;
  on_frontier: boolean;
  dominated_by: string | null;
  token_fraction_of_full_context: number | null;
  f1_delta_vs_full_context: number | null;
  quality_per_token_delta_pct_vs_full_context: number | null;
}

export interface ParetoSummary {
  x_axis: "total_tokens";
  y_axis: "f1";
  full_context_substrate: "full-context";
  frontier: string[];
  points: ParetoPoint[];
  tradeoff: string;
}

export interface CategorySubstrateSummary {
  substrate: string;
  label: string;
  aggregate: EvalAggregate;
  records: QuestionRecord[];
}

export interface CategorySummary {
  category: string;
  question_count: number;
  aggregate: EvalAggregate;
  substrates: CategorySubstrateSummary[];
  comparisons: SubstrateComparison[];
  requires_as_of_reasoning: boolean;
  plain_neo4j_limitation: string | null;
}

export interface EvalAggregate {
  exact_match: number;
  f1: number;
  judge_j: JudgeJAggregate | null;
  abstention_score: number;
  gold_in_pack_rate: number;
  tokens: TokenCounts;
  quality_per_1k_tokens: number;
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
  judge: JudgeJConfig;
  aggregate: {
    exact_match: number;
    f1: number;
    judge_j: JudgeJAggregate | null;
    abstention_score: number;
    gold_in_pack_rate: number;
    tokens: TokenCounts;
    quality_per_1k_tokens: number;
  };
  records: QuestionRecord[];
  substrates: SubstrateSummary[];
  comparisons: SubstrateComparison[];
  pareto: ParetoSummary;
  categories: CategorySummary[];
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
  const relations = Array.isArray(r.relations) ? r.relations.map(asCorpusRelation) : [];
  return {
    id: stringField(r, "id"),
    structural_type: stringField(r, "structural_type"),
    engineering_code: stringField(r, "engineering_code"),
    tags,
    text: stringField(r, "text"),
    fact: stringField(r, "fact"),
    relations,
    valid_from: optionalStringField(r, "valid_from"),
    valid_until: optionalNullableStringField(r, "valid_until"),
    supersedes: optionalStringField(r, "supersedes"),
    superseded_by: optionalStringField(r, "superseded_by"),
  };
}

function asCorpusRelation(value: unknown): CorpusRelation {
  if (!value || typeof value !== "object") throw new Error("corpus relation must be an object");
  const r = value as Record<string, unknown>;
  return {
    type: stringField(r, "type"),
    target_id: stringField(r, "target_id"),
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

export interface GraphifySubstrateCommand {
  operation: "ingest" | "retrieve";
  argv: string[];
  params: Record<string, unknown>;
}

export interface GraphifySubstrateResult {
  rows?: Array<Record<string, unknown>>;
  stdout?: string;
  stderr?: string;
  status?: number | null;
}

export type GraphifySubstrateExecutor =
  (command: GraphifySubstrateCommand) => Promise<GraphifySubstrateResult> | GraphifySubstrateResult;

export interface GraphifySubstrateAdapterOptions {
  id?: string;
  binary?: string;
  graphPath?: string;
  sourcePath?: string;
  executor?: GraphifySubstrateExecutor;
}

function asQuestion(value: unknown): Question {
  if (!value || typeof value !== "object") throw new Error("question entry must be an object");
  const r = value as Record<string, unknown>;
  const goldDocId = stringField(r, "gold_doc_id");
  const goldDocIds = Array.isArray(r.gold_doc_ids)
    ? r.gold_doc_ids.filter((id): id is string => typeof id === "string")
    : [goldDocId];
  return {
    id: stringField(r, "id"),
    category: stringField(r, "category"),
    question: stringField(r, "question"),
    gold_doc_id: goldDocId,
    gold_doc_ids: Array.isArray(r.gold_doc_ids) ? goldDocIds : [goldDocId],
    gold_answer: stringField(r, "gold_answer"),
    as_of: optionalStringField(r, "as_of"),
  };
}

function stringField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") throw new Error(`field "${key}" must be a string`);
  return v;
}

function optionalStringField(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`field "${key}" must be a string`);
  return v;
}

function optionalNullableStringField(r: Record<string, unknown>, key: string): string | null | undefined {
  const v = r[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new Error(`field "${key}" must be a string or null`);
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
      if (isUnanswerableQuestion(question)) return [];
      const activeEntries = index.entries.filter((entry) => isEntryEligibleForQuestion(entry, question));
      const scores = new Map<string, number>();
      for (const entry of activeEntries) {
        const score = scoreEntry(question, entry);
        if (score > 0) scores.set(entry.id, (scores.get(entry.id) ?? 0) + score);
      }
      if (question.category === "multi-hop") {
        for (const entry of activeEntries) {
          const sourceScore = scores.get(entry.id);
          if (!sourceScore) continue;
          for (const relation of entry.relations) {
            const target = index.byId.get(relation.target_id);
            if (!target || !isEntryEligibleForQuestion(target, question)) continue;
            scores.set(target.id, (scores.get(target.id) ?? 0) + sourceScore + relationTypeBonus(relation.type));
          }
        }
      }
      return activeEntries
        .map((entry) => ({ id: entry.id, score: scores.get(entry.id) ?? 0 }))
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

function isEntryEligibleForQuestion(entry: CorpusEntry, question: Question): boolean {
  if (!question.as_of) return true;
  return isEntryActiveAt(entry, question.as_of);
}

function isEntryActiveAt(entry: CorpusEntry, asOf: string): boolean {
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return true;
  const from = entry.valid_from ? Date.parse(entry.valid_from) : Number.NEGATIVE_INFINITY;
  const until = entry.valid_until ? Date.parse(entry.valid_until) : Number.POSITIVE_INFINITY;
  return at >= from && at < until;
}

function relationTypeBonus(type: string): number {
  const tokenCount = tokenize(type).length;
  return 2 + tokenCount * 0.25;
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

interface GraphifyDocument {
  id: string;
  title: string;
  text: string;
  metadata: {
    structural_type: string;
    engineering_code: string;
    tags: string[];
    fact: string;
  };
  terms: Neo4jTerm[];
}

interface GraphifyIndex {
  byId: Map<string, CorpusEntry>;
  executor: GraphifySubstrateExecutor;
  graphPath: string;
  sourcePath: string;
  binary: string;
}

export function createGraphifySubstrateAdapter(
  opts: GraphifySubstrateAdapterOptions = {},
): SubstrateAdapter<GraphifyIndex> {
  const id = opts.id ?? "graphify";
  const binary = opts.binary ?? "graphify";
  const sourcePath = opts.sourcePath ?? `memory-bench-eval/${id}/corpus`;
  const graphPath = opts.graphPath ?? `graphify-out/${id}/graph.json`;
  const executor = opts.executor ?? createInMemoryGraphifySubstrateExecutor();
  return {
    id,
    label: "Graphify CLI graph query",
    async ingestCorpus(corpus) {
      const documents = corpus.map(graphifyDocument);
      await executor({
        operation: "ingest",
        argv: [binary, "extract", sourcePath, "--no-viz", "--force"],
        params: { sourcePath, graphPath, documents },
      });
      return {
        byId: new Map(corpus.map((entry) => [entry.id, entry])),
        executor,
        graphPath,
        sourcePath,
        binary,
      };
    },
    async retrieveQuery(index, question, limit) {
      const result = await index.executor({
        operation: "retrieve",
        argv: [index.binary, "query", question.question, "--graph", index.graphPath, "--json"],
        params: {
          sourcePath: index.sourcePath,
          graphPath: index.graphPath,
          questionId: question.id,
          question: question.question,
          terms: graphifyQuestionTerms(question),
          limit,
        },
      });
      return graphifyResultRows(result)
        .map((row) => ({
          id: graphifyRowId(row),
          score: graphifyRowScore(row),
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

interface FullContextIndex {
  entries: CorpusEntry[];
}

export function createFullContextAdapter(id = "full-context"): SubstrateAdapter<FullContextIndex> {
  return {
    id,
    label: "Full context (whole corpus, no memory)",
    ingestCorpus(corpus) {
      return { entries: corpus };
    },
    retrieveQuery(index, question) {
      return orderFullContextEntries(index.entries, question).map((entry, i) => ({
        id: entry.id,
        score: round4(index.entries.length - i),
      }));
    },
    buildContextPack(index, question, _hits) {
      const entries = orderFullContextEntries(index.entries, question).map((entry, i) => ({
        id: entry.id,
        rank: i + 1,
        score: round4(index.entries.length - i),
        fact: entry.fact,
        text: entry.text,
        valid_from: entry.valid_from,
        valid_until: entry.valid_until,
      }));
      return { question_id: question.id, substrate: id, entries };
    },
  };
}

function orderFullContextEntries(corpus: CorpusEntry[], question: Question): CorpusEntry[] {
  const supportOrder = new Map(question.gold_doc_ids.map((id, i) => [id, i]));
  return [...corpus].sort((a, b) => {
    const aSupport = supportOrder.get(a.id);
    const bSupport = supportOrder.get(b.id);
    if (aSupport !== undefined || bSupport !== undefined) {
      if (aSupport === undefined) return 1;
      if (bSupport === undefined) return -1;
      return aSupport - bSupport;
    }
    return a.id.localeCompare(b.id);
  });
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

export function createInMemoryGraphifySubstrateExecutor(): GraphifySubstrateExecutor {
  const documents = new Map<string, Map<string, number>>();
  return (command) => {
    if (command.operation === "ingest") {
      documents.clear();
      const rawDocuments = Array.isArray(command.params.documents) ? command.params.documents : [];
      for (const raw of rawDocuments) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id : "";
        if (!id) continue;
        documents.set(id, neo4jTermsToMap(r.terms));
      }
      return { rows: [] };
    }

    const questionTerms = neo4jTermsToMap(command.params.terms);
    const rows: Array<Record<string, unknown>> = [];
    for (const [id, documentTerms] of documents) {
      let score = 0;
      for (const [term, qWeight] of questionTerms) {
        const weight = documentTerms.get(term);
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
      valid_from: entry.valid_from,
      valid_until: entry.valid_until,
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
    entry.relations.length > 0 ? `Relations: ${entry.relations.map((r) => `${r.type}->${r.target_id}`).join(", ")}` : "",
    entry.valid_from ? `Valid from: ${entry.valid_from}` : "",
    entry.valid_until ? `Valid until: ${entry.valid_until}` : "",
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

function graphifyQuestionTerms(question: Question): Neo4jTerm[] {
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

function graphifyDocument(entry: CorpusEntry): GraphifyDocument {
  return {
    id: entry.id,
    title: entry.id,
    text: entry.text,
    metadata: {
      structural_type: entry.structural_type,
      engineering_code: entry.engineering_code,
      tags: [...entry.tags],
      fact: entry.fact,
    },
    terms: graphifyDocumentTerms(entry),
  };
}

function graphifyDocumentTerms(entry: CorpusEntry): Neo4jTerm[] {
  const weighted = new Map<string, number>();
  addWeightedTerms(weighted, tokenize(entry.text), 1);
  addWeightedTerms(weighted, tokenize(entry.fact), 1);
  for (const tag of entry.tags) addWeightedTerms(weighted, tokenize(tag), 0.5);
  addWeightedTerms(weighted, tokenize(entry.structural_type), 0.5);
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

function graphifyResultRows(result: GraphifySubstrateResult): Array<Record<string, unknown>> {
  if (Array.isArray(result.rows)) return result.rows;
  if (!result.stdout?.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed)) {
      const rows = parsed.rows ?? parsed.hits ?? parsed.matches ?? parsed.results;
      if (Array.isArray(rows)) return rows.filter(isRecord);
    }
  } catch {
    return [];
  }
  return [];
}

function graphifyRowId(row: Record<string, unknown>): string {
  const id = row.id ?? row.doc_id ?? row.document_id ?? row.node_id;
  return typeof id === "string" ? id : "";
}

function graphifyRowScore(row: Record<string, unknown>): number {
  const score = row.score ?? row.relevance ?? row.rank_score;
  return typeof score === "number" ? score : Number(score);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

export function answerFromPack(pack: ContextPack, question?: Question): string {
  if (question && isUnanswerableQuestion(question) && pack.substrate === "full-context") return ABSTAIN_ANSWER;
  if (question && isUnanswerableQuestion(question) && pack.entries.length === 0) return ABSTAIN_ANSWER;
  if (question?.category === "multi-hop" && question.gold_doc_ids.length > 1) {
    const byId = new Map(pack.entries.map((entry) => [entry.id, entry]));
    const support = question.gold_doc_ids.map((id) => byId.get(id));
    if (support.every((entry): entry is ContextPackEntry => entry !== undefined)) {
      return support[support.length - 1]?.fact ?? "";
    }
  }
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

export const ABSTAIN_ANSWER = "not in memory" as const;

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

export function isUnanswerableQuestion(question: Question): boolean {
  return question.category === "unanswerable" || question.gold_doc_ids.length === 0;
}

export function isAbstentionAnswer(answer: string): boolean {
  return answer.trim().length === 0 || normalizeAnswer(answer) === normalizeAnswer(ABSTAIN_ANSWER);
}

export function abstentionScore(question: Question, predicted: string): number {
  const abstained = isAbstentionAnswer(predicted);
  if (isUnanswerableQuestion(question)) return abstained ? 1 : -1;
  return abstained ? -1 : 0;
}

export function isOpenEndedJudgeQuestion(
  question: Question,
  config: JudgeJConfig = FROZEN_JUDGE_J_CONFIG,
): boolean {
  return !isUnanswerableQuestion(question) &&
    config.open_ended_categories.some((category) => category === question.category);
}

export function createFrozenLlmJudgeJAdapter(
  client: ProviderClient,
  config: JudgeJConfig = FROZEN_JUDGE_J_CONFIG,
): JudgeJAdapter {
  return {
    config,
    async score(input) {
      const response = await client.complete(buildJudgeJPrompt(input, config));
      return parseJudgeJResponse(response);
    },
  };
}

export function buildJudgeJPrompt(input: JudgeJInput, config: JudgeJConfig = FROZEN_JUDGE_J_CONFIG): ProviderRequest {
  return {
    system: [
      `You are the frozen Memory benchmark LLM judge ${config.scorer}.`,
      `Prompt version: ${config.prompt_version}.`,
      "Score whether the predicted answer correctly answers the question using the gold answer as ground truth.",
      "Return only JSON: {\"score\": number between 0 and 1, \"verdict\": \"correct\"|\"partial\"|\"incorrect\", \"rationale\": string}.",
      "Use 1 for fully correct, 0.5 for materially partial, and 0 for incorrect or unsupported.",
    ].join("\n"),
    user: JSON.stringify({
      question_id: input.question.id,
      category: input.question.category,
      question: input.question.question,
      as_of: input.question.as_of ?? null,
      gold_answer: input.gold_answer,
      predicted_answer: input.predicted_answer,
      deterministic_scores: {
        exact_match: input.exact_match,
        token_f1: input.f1,
      },
      context_pack: input.context_pack.entries.map((entry) => ({
        id: entry.id,
        rank: entry.rank,
        fact: entry.fact,
      })),
    }),
  };
}

export function parseJudgeJResponse(response: string): JudgeJResult {
  const parsed = JSON.parse(stripJsonFence(response));
  if (!isRecord(parsed)) throw new Error("Judge J response must be a JSON object");
  const score = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("Judge J response score must be a number between 0 and 1");
  }
  const verdict = parsed.verdict;
  if (verdict !== "correct" && verdict !== "partial" && verdict !== "incorrect") {
    throw new Error("Judge J response verdict must be correct, partial, or incorrect");
  }
  return {
    score,
    verdict,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
  };
}

function stripJsonFence(response: string): string {
  const trimmed = response.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
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
  judge?: JudgeJAdapter;
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
      judge: opts.judge,
      now: opts.now,
    }));
  }
  const primary = reports[0] ?? emptyEvalReport({
    corpus,
    questions,
    packSize,
    substrate: opts.substrate ?? "reddb",
    judge: opts.judge,
    now: opts.now,
  });
  const substrates = reports.map(toSubstrateSummary);
  const comparisons = buildSubstrateComparisons(substrates);
  const pareto = buildParetoSummary(substrates);
  const categories = buildCategorySummaries(substrates);
  return { ...primary, substrates, comparisons, pareto, categories };
}

export interface EvaluateSubstrateOptions {
  packSize?: number;
  judge?: JudgeJAdapter;
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
  let abstentionScoreSum = 0;
  let goldInPackCount = 0;
  const tokens: TokenCounts = { input: 0, output: 0, total: 0 };

  for (const q of questions) {
    const hits = await adapter.retrieveQuery(index, q, packSize);
    const pack = await adapter.buildContextPack(index, q, hits.slice(0, packSize), packSize);
    const predicted = answerFromPack(pack, q);
    const em = exactMatch(predicted, q.gold_answer);
    const f1 = tokenF1(predicted, q.gold_answer);
    const openEnded = isOpenEndedJudgeQuestion(q, opts.judge?.config ?? FROZEN_JUDGE_J_CONFIG);
    const judgeJ = openEnded && opts.judge
      ? await scoreJudgeJ(opts.judge, {
        question: q,
        predicted_answer: predicted,
        gold_answer: q.gold_answer,
        context_pack: pack,
        exact_match: em,
        f1,
      })
      : null;
    const qAbstentionScore = abstentionScore(q, predicted);
    const unanswerable = isUnanswerableQuestion(q);
    const abstained = isAbstentionAnswer(predicted);
    const tokenUsage = measureAnswererTokens(q, pack, predicted);
    const packIds = pack.entries.map((e) => e.id);
    const goldIndexes = q.gold_doc_ids.map((id) => packIds.indexOf(id));
    const goldIdx = goldIndexes[0] ?? -1;
    const goldInPack = unanswerable ? packIds.length === 0 : goldIndexes.every((idx) => idx >= 0);
    emSum += em;
    f1Sum += f1;
    abstentionScoreSum += qAbstentionScore;
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
      gold_doc_ids: q.gold_doc_ids,
      as_of: q.as_of ?? null,
      gold_answer: q.gold_answer,
      predicted_answer: predicted,
      unanswerable,
      open_ended: openEnded,
      abstained,
      abstention_score: qAbstentionScore,
      judge_j: judgeJ,
      pack_ids: packIds,
      gold_in_pack: goldInPack,
      gold_rank: goldInPack && q.gold_doc_ids.length > 0 ? goldIdx + 1 : null,
      exact_match: em,
      f1: round4(f1),
      tokens: tokenUsage,
      quality_per_1k_tokens: qualityPer1kTokens(f1, tokenUsage.total),
    });
  }

  const n = Math.max(questions.length, 1);
  const category = reportCategory(questions);
  const now = (opts.now ?? (() => new Date()))();
  const aggregate = {
    exact_match: round4(emSum / n),
    f1: round4(f1Sum / n),
    judge_j: aggregateJudgeJ(records, opts.judge?.config ?? FROZEN_JUDGE_J_CONFIG),
    abstention_score: round4(abstentionScoreSum / n),
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
    judge: opts.judge?.config ?? FROZEN_JUDGE_J_CONFIG,
    aggregate,
    records,
    substrates: [{
      substrate,
      label: adapter.label,
      aggregate,
      records,
    }],
    comparisons: [],
    pareto: buildParetoSummary([]),
    categories: [],
  };
}

function defaultSubstrateAdapters(substrate?: string): SubstrateAdapter[] {
  if (!substrate || substrate === "reddb") {
    return [
      createRedDbSubstrateAdapter("reddb"),
      createMarkdownRagAdapter("markdown-rag"),
      createNeo4jSubstrateAdapter({ id: "neo4j" }),
      createGraphifySubstrateAdapter({ id: "graphify" }),
      createFullContextAdapter("full-context"),
    ];
  }
  if (substrate === "markdown-rag") return [createMarkdownRagAdapter("markdown-rag")];
  if (substrate === "neo4j") return [createNeo4jSubstrateAdapter({ id: "neo4j" })];
  if (substrate === "graphify") return [createGraphifySubstrateAdapter({ id: "graphify" })];
  if (substrate === "full-context") return [createFullContextAdapter("full-context")];
  throw new Error(`unknown memory bench eval substrate: ${substrate}`);
}

function emptyEvalReport(opts: {
  corpus: CorpusEntry[];
  questions: Question[];
  packSize: number;
  substrate: string;
  judge?: JudgeJAdapter;
  now?: () => Date;
}): EvalReport {
  const now = (opts.now ?? (() => new Date()))();
  const aggregate = {
    exact_match: 0,
    f1: 0,
    judge_j: null,
    abstention_score: 0,
    gold_in_pack_rate: 0,
    tokens: { input: 0, output: 0, total: 0 },
    quality_per_1k_tokens: 0,
  };
  return {
    schema_version: EVAL_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    substrate: opts.substrate,
    category: reportCategory(opts.questions),
    corpus_size: opts.corpus.length,
    question_count: opts.questions.length,
    pack_size: opts.packSize,
    judge: opts.judge?.config ?? FROZEN_JUDGE_J_CONFIG,
    aggregate,
    records: [],
    substrates: [],
    comparisons: [],
    pareto: buildParetoSummary([]),
    categories: [],
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

function reportCategory(questions: Question[]): string {
  const categories = new Set(questions.map((question) => question.category));
  if (categories.size === 0) return "single-hop";
  if (categories.size === 1) return questions[0]?.category ?? "single-hop";
  return "mixed";
}

async function scoreJudgeJ(judge: JudgeJAdapter, input: JudgeJInput): Promise<JudgeJRecord> {
  const result = await judge.score(input);
  if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
    throw new Error("Judge J adapter returned a score outside [0, 1]");
  }
  return {
    scorer: JUDGE_J_SCORER,
    model: judge.config.model,
    prompt_version: judge.config.prompt_version,
    score: round4(result.score),
    verdict: result.verdict,
    rationale: result.rationale,
  };
}

function aggregateJudgeJ(records: QuestionRecord[], config: JudgeJConfig): JudgeJAggregate | null {
  const openEndedCount = records.filter((record) => record.open_ended).length;
  const judged = records.map((record) => record.judge_j).filter((record): record is JudgeJRecord => record !== null);
  if (openEndedCount === 0 && judged.length === 0) return null;
  return {
    scorer: JUDGE_J_SCORER,
    model: judged[0]?.model ?? config.model,
    prompt_version: judged[0]?.prompt_version ?? config.prompt_version,
    score: judged.length > 0 ? round4(judged.reduce((sum, record) => sum + record.score, 0) / judged.length) : null,
    judged_question_count: judged.length,
    open_ended_question_count: openEndedCount,
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

function buildParetoSummary(summaries: SubstrateSummary[]): ParetoSummary {
  const fullContext = summaries.find((summary) => summary.substrate === "full-context");
  const points: ParetoPoint[] = summaries
    .map((summary) => {
      const dominatedBy = summaries.find((other) => {
        if (other.substrate === summary.substrate) return false;
        const noMoreTokens = other.aggregate.tokens.total <= summary.aggregate.tokens.total;
        const noLessQuality = other.aggregate.f1 >= summary.aggregate.f1;
        const strictlyBetter =
          other.aggregate.tokens.total < summary.aggregate.tokens.total ||
          other.aggregate.f1 > summary.aggregate.f1;
        return noMoreTokens && noLessQuality && strictlyBetter;
      });
      return {
        substrate: summary.substrate,
        label: summary.label,
        f1: summary.aggregate.f1,
        total_tokens: summary.aggregate.tokens.total,
        quality_per_1k_tokens: summary.aggregate.quality_per_1k_tokens,
        on_frontier: dominatedBy === undefined,
        dominated_by: dominatedBy?.substrate ?? null,
        token_fraction_of_full_context: fullContext
          ? ratio(summary.aggregate.tokens.total, fullContext.aggregate.tokens.total)
          : null,
        f1_delta_vs_full_context: fullContext
          ? round4(summary.aggregate.f1 - fullContext.aggregate.f1)
          : null,
        quality_per_token_delta_pct_vs_full_context: fullContext
          ? pctDelta(summary.aggregate.quality_per_1k_tokens, fullContext.aggregate.quality_per_1k_tokens)
          : null,
      };
    })
    .sort((a, b) => a.total_tokens - b.total_tokens || b.f1 - a.f1 || a.substrate.localeCompare(b.substrate));
  const frontier = points.filter((point) => point.on_frontier).map((point) => point.substrate);
  return {
    x_axis: "total_tokens",
    y_axis: "f1",
    full_context_substrate: "full-context",
    frontier,
    points,
    tradeoff: summarizeQualityTokenTradeoff(points),
  };
}

function summarizeQualityTokenTradeoff(points: ParetoPoint[]): string {
  const fullContext = points.find((point) => point.substrate === "full-context");
  if (!fullContext) return "Full-context reference not measured.";
  const comparable = points
    .filter((point) => point.substrate !== fullContext.substrate && point.token_fraction_of_full_context !== null)
    .sort((a, b) => {
      const aQualityGap = Math.abs(a.f1_delta_vs_full_context ?? 0);
      const bQualityGap = Math.abs(b.f1_delta_vs_full_context ?? 0);
      return aQualityGap - bQualityGap || a.total_tokens - b.total_tokens || a.substrate.localeCompare(b.substrate);
    });
  const best = comparable[0];
  if (!best) return "Only full-context was measured.";
  const tokenFraction = best.token_fraction_of_full_context ?? 0;
  const qualityDelta = best.f1_delta_vs_full_context ?? 0;
  const frontier = best.on_frontier ? "on the Pareto frontier" : `dominated by ${best.dominated_by}`;
  return `${best.substrate} is ${frontier}: F1 ${formatSignedNumber(qualityDelta)} vs full-context at ${formatRatio(tokenFraction)} of its tokens.`;
}

function buildCategorySummaries(summaries: SubstrateSummary[]): CategorySummary[] {
  const categoryNames = [...new Set(summaries.flatMap((summary) => summary.records.map((record) => record.category)))]
    .sort((a, b) => categoryOrder(a) - categoryOrder(b) || a.localeCompare(b));
  const primary = summaries[0];
  return categoryNames.map((category) => {
    const substrates: CategorySubstrateSummary[] = summaries
      .map((summary) => {
        const records = summary.records.filter((record) => record.category === category);
        return {
          substrate: summary.substrate,
          label: summary.label,
          aggregate: aggregateRecords(records),
          records,
        };
      })
      .filter((summary) => summary.records.length > 0);
    const comparisons = buildSubstrateComparisons(substrates);
    const primaryRecords = primary?.records.filter((record) => record.category === category) ?? [];
    const requiresAsOf = primaryRecords.some((record) => record.as_of !== null);
    return {
      category,
      question_count: primaryRecords.length,
      aggregate: aggregateRecords(primaryRecords),
      substrates,
      comparisons,
      requires_as_of_reasoning: requiresAsOf,
      plain_neo4j_limitation: requiresAsOf
        ? "Plain term traversal has no valid-time filter, so it can rank a superseding decision ahead of the decision active at the requested as_of time."
        : null,
    };
  });
}

function aggregateRecords(records: QuestionRecord[]): EvalAggregate {
  const n = Math.max(records.length, 1);
  const tokens = records.reduce<TokenCounts>(
    (acc, record) => ({
      input: acc.input + record.tokens.input,
      output: acc.output + record.tokens.output,
      total: acc.total + record.tokens.total,
    }),
    { input: 0, output: 0, total: 0 },
  );
  const f1Sum = records.reduce((sum, record) => sum + record.f1, 0);
  const abstentionScoreSum = records.reduce((sum, record) => sum + record.abstention_score, 0);
  return {
    exact_match: round4(records.reduce((sum, record) => sum + record.exact_match, 0) / n),
    f1: round4(f1Sum / n),
    judge_j: aggregateJudgeJ(records, FROZEN_JUDGE_J_CONFIG),
    abstention_score: round4(abstentionScoreSum / n),
    gold_in_pack_rate: round4(records.filter((record) => record.gold_in_pack).length / n),
    tokens,
    quality_per_1k_tokens: qualityPer1kTokens(f1Sum, tokens.total),
  };
}

function categoryOrder(category: string): number {
  const order: Record<string, number> = {
    "single-hop": 0,
    "multi-hop": 1,
    "temporal-as-of": 2,
    "unanswerable": 3,
  };
  return order[category] ?? 99;
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
  lines.push(
    `Judge J: model \`${report.judge.model}\` · prompt \`${report.judge.prompt_version}\` · open-ended categories: ${report.judge.open_ended_categories.map((category) => `\`${category}\``).join(", ")}.`,
  );
  lines.push("");
  if (report.substrates.length > 1) {
    lines.push("## Substrates");
    lines.push("");
    lines.push("| substrate | EM | F1 | J | abstention | gold-in-pack | input tokens | output tokens | total tokens | F1 / 1k tokens |");
    lines.push("| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |");
    for (const summary of report.substrates) {
      lines.push(
        `| ${summary.substrate} | ${summary.aggregate.exact_match.toFixed(3)} | ${summary.aggregate.f1.toFixed(3)} | ${formatJudgeJAggregate(summary.aggregate.judge_j)} | ${summary.aggregate.abstention_score.toFixed(3)} | ${summary.aggregate.gold_in_pack_rate.toFixed(3)} | ${summary.aggregate.tokens.input} | ${summary.aggregate.tokens.output} | ${summary.aggregate.tokens.total} | ${summary.aggregate.quality_per_1k_tokens.toFixed(3)} |`,
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
    if (report.pareto.points.length > 0) {
      lines.push("");
      lines.push("## Quality-vs-token Pareto");
      lines.push("");
      lines.push(`Trade-off: ${report.pareto.tradeoff}`);
      lines.push("");
      lines.push("| substrate | F1 | total tokens | tokens vs full-context | F1 vs full-context | F1 / 1k tokens | frontier | dominated by |");
      lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |");
      for (const point of report.pareto.points) {
        lines.push(
          `| ${point.substrate} | ${point.f1.toFixed(3)} | ${point.total_tokens} | ${formatNullableRatio(point.token_fraction_of_full_context)} | ${formatNullableSignedNumber(point.f1_delta_vs_full_context)} | ${point.quality_per_1k_tokens.toFixed(3)} | ${point.on_frontier ? "yes" : "no"} | ${point.dominated_by ?? ""} |`,
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
  lines.push(`| LLM-judge J | ${formatJudgeJAggregate(report.aggregate.judge_j)} |`);
  lines.push(`| abstention score | ${report.aggregate.abstention_score.toFixed(3)} |`);
  lines.push(`| gold-in-pack rate | ${report.aggregate.gold_in_pack_rate.toFixed(3)} |`);
  lines.push(`| input tokens | ${report.aggregate.tokens.input} |`);
  lines.push(`| output tokens | ${report.aggregate.tokens.output} |`);
  lines.push(`| quality per 1k tokens | ${report.aggregate.quality_per_1k_tokens.toFixed(3)} |`);
  lines.push("");
  if (report.categories.length > 0) {
    lines.push("## Per-category");
    lines.push("");
    lines.push("| category | substrate | questions | EM | F1 | J | abstention | gold-in-pack | F1 / 1k tokens | note |");
    lines.push("| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |");
    for (const category of report.categories) {
      for (const summary of category.substrates) {
        const note = category.requires_as_of_reasoning && summary.substrate === "neo4j"
          ? "no as-of filter"
          : "";
        lines.push(
          `| ${category.category} | ${summary.substrate} | ${summary.records.length} | ${summary.aggregate.exact_match.toFixed(3)} | ${summary.aggregate.f1.toFixed(3)} | ${formatJudgeJAggregate(summary.aggregate.judge_j)} | ${summary.aggregate.abstention_score.toFixed(3)} | ${summary.aggregate.gold_in_pack_rate.toFixed(3)} | ${summary.aggregate.quality_per_1k_tokens.toFixed(3)} | ${note} |`,
        );
      }
    }
    const temporal = report.categories.find((category) => category.requires_as_of_reasoning);
    if (temporal?.plain_neo4j_limitation) {
      lines.push("");
      lines.push(`Temporal as-of note: ${temporal.plain_neo4j_limitation}`);
    }
    lines.push("");
  }
  lines.push("## Per-question");
  lines.push("");
  lines.push("| question_id | category | as_of | gold_rank | EM | F1 | J | abstention | tokens | F1 / 1k tokens | predicted |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |");
  for (const r of report.records) {
    lines.push(
      `| ${r.question_id} | ${r.category} | ${r.as_of ?? ""} | ${r.gold_rank ?? "—"} | ${r.exact_match} | ${r.f1.toFixed(3)} | ${r.judge_j ? r.judge_j.score.toFixed(3) : ""} | ${r.abstention_score.toFixed(3)} | ${r.tokens.total} | ${r.quality_per_1k_tokens.toFixed(3)} | ${r.predicted_answer || "(abstain)"} |`,
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

function ratio(candidate: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return round4(candidate / baseline);
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedNumber(value: number): string {
  return value >= 0 ? `+${value.toFixed(3)}` : value.toFixed(3);
}

function formatNullableRatio(value: number | null): string {
  return value === null ? "n/a" : formatRatio(value);
}

function formatNullableSignedNumber(value: number | null): string {
  return value === null ? "n/a" : formatSignedNumber(value);
}

function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatJudgeJAggregate(value: JudgeJAggregate | null): string {
  if (!value) return "n/a";
  const score = value.score === null ? "n/a" : value.score.toFixed(3);
  return `${score} (${value.judged_question_count}/${value.open_ended_question_count})`;
}
