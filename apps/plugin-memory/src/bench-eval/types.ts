
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
 * Determinism contract: fixed-pack evaluation is a pure function of its inputs.
 * The agent-tools tier measures wall-clock response time in normal CLI runs and
 * uses deterministic timing when tests pass a fixed `now`. Ties always break on
 * entry id. Same fixture + same git ref + fixed time ⇒ byte-identical output.
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
  /** Governed-recall axes (ADR 0035/0037). `scope` confines a fact to one
   * entity so a near-duplicate from another scope is filtered out; `confidence`
   * and `tier` weight a fact down when a contradictory lower-trust source is
   * textually tempting. All are optional — an entry without them is a global,
   * full-confidence, canonical fact and recall behaves exactly as before. */
  scope?: string;
  confidence?: string;
  tier?: string;
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
  /** Restricts an adversarial near-duplicate question to one entity. Governed
   * recall drops scoped entries whose `scope` differs from the question's. */
  scope?: string;
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

export interface AgentToolCallInput {
  question: Question;
  limit: number;
}

export interface AgentToolCallOutput {
  hits: RetrievalHit[];
  context_pack: ContextPack;
}

export interface AgentSubstrateTool {
  name: string;
  substrate: string;
  description: string;
  input_schema: Record<string, unknown>;
  call(input: AgentToolCallInput): Promise<AgentToolCallOutput>;
}

export interface TokenCounts {
  input: number;
  output: number;
  total: number;
}

export const EVAL_SCHEMA_VERSION = "memory.bench.eval.v1" as const;
export type EvalTierId = "fixed-pack" | "agent-tools";

export const JUDGE_J_SCORER = "J" as const;
export const JUDGE_J_MODEL = "gpt-4o-2024-08-06" as const;
export const JUDGE_J_PROMPT_VERSION = "memory-bench-judge-j.v1" as const;
export const JUDGE_J_OPEN_ENDED_CATEGORIES = ["multi-hop", "temporal-as-of"] as const;
export const ANSWERER_MODEL = "memory-fixed-pack-answerer-2026-06-02" as const;
export const ANSWERER_PROMPT_VERSION = "memory-bench-answerer.v1" as const;
export type EvalMode = "one-shot" | "deterministic-core" | "showcase";

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

export interface AnswererConfig {
  id: "fixed-pack-answerer";
  model: typeof ANSWERER_MODEL | string;
  prompt_version: typeof ANSWERER_PROMPT_VERSION | string;
}

export const FROZEN_ANSWERER_CONFIG: AnswererConfig = {
  id: "fixed-pack-answerer",
  model: ANSWERER_MODEL,
  prompt_version: ANSWERER_PROMPT_VERSION,
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
  tier: EvalTierId;
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
  retrieval_k: number;
  precision_at_k: number;
  recall_at_k: number;
  ndcg_at_k: number;
  exact_match: number;
  f1: number;
  tokens: TokenCounts;
  quality_per_1k_tokens: number;
  tools_used: number;
  prompt_tokens: number;
  reasoning_tokens: number;
  reasoning_prompt_ratio: number;
  time_to_response_ms: number;
}

export interface SubstrateSummary {
  substrate: string;
  label: string;
  aggregate: EvalAggregate;
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
  precision_at_k: number;
  recall_at_k: number;
  ndcg_at_k: number;
  tokens: TokenCounts;
  quality_per_1k_tokens: number;
  tools_used: number;
  prompt_tokens: number;
  reasoning_tokens: number;
  reasoning_prompt_ratio: number;
  time_to_response_ms: number;
}

export interface EvalTierSummary {
  tier: EvalTierId;
  label: string;
  aggregate: EvalAggregate;
  substrates: SubstrateSummary[];
  comparisons: SubstrateComparison[];
  pareto: ParetoSummary;
  categories: CategorySummary[];
}

export interface EvalVarianceMetric {
  metric: string;
  samples: number;
  mean: number;
  std_dev: number;
  ci95_low: number;
  ci95_high: number;
}

export interface EvalVarianceBucket {
  tier: EvalTierId;
  substrate: string;
  metrics: EvalVarianceMetric[];
}

export interface EvalVarianceSummary {
  repetitions: number;
  metrics: EvalVarianceMetric[];
  by_tier_substrate: EvalVarianceBucket[];
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
  mode: EvalMode;
  repetitions: number;
  generated_at: string;
  substrate: string;
  category: string;
  corpus_size: number;
  question_count: number;
  pack_size: number;
  answerer: AnswererConfig;
  judge: JudgeJConfig;
  aggregate: EvalAggregate;
  records: QuestionRecord[];
  substrates: SubstrateSummary[];
  comparisons: SubstrateComparison[];
  pareto: ParetoSummary;
  categories: CategorySummary[];
  tiers: EvalTierSummary[];
  variance: EvalVarianceSummary | null;
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
