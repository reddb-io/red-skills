import { performance } from "node:perf_hooks";
import type {
  AgentSubstrateTool,
  CorpusEntry,
  EvalAggregate,
  EvalMode,
  EvalReport,
  EvalTierId,
  EvalTierSummary,
  EvalVarianceBucket,
  EvalVarianceMetric,
  EvalVarianceSummary,
  JudgeJAdapter,
  JudgeJAggregate,
  JudgeJInput,
  JudgeJRecord,
  JudgeJConfig,
  ParetoPoint,
  ParetoSummary,
  Question,
  QuestionRecord,
  CategorySubstrateSummary,
  CategorySummary,
  SubstrateAdapter,
  SubstrateComparison,
  SubstrateSummary,
  TokenCounts,
} from "./types.js";
import {
  ANSWERER_PROMPT_VERSION,
  EVAL_SCHEMA_VERSION,
  FROZEN_ANSWERER_CONFIG,
  FROZEN_JUDGE_J_CONFIG,
  JUDGE_J_SCORER,
} from "./types.js";
import { loadCorpus, loadQuestions } from "./loaders.js";
import {
  PACK_SIZE_DEFAULT,
  createFullContextAdapter,
  createGraphifySubstrateAdapter,
  createMarkdownRagAdapter,
  createNeo4jSubstrateAdapter,
  createRedDbSubstrateAdapter,
} from "./substrates.js";
import {
  abstentionScore,
  answerFromPack,
  estimateTimeToResponseMs,
  exactMatch,
  isAbstentionAnswer,
  isOpenEndedJudgeQuestion,
  isUnanswerableQuestion,
  measureAgentToolTokens,
  measureAnswererTokens,
  qualityPer1kTokens,
  renderAgentReasoningTrace,
  retrievalQualityMetrics,
  tokenF1,
} from "./scoring.js";

export interface RunEvalOptions {
  corpusDir: string;
  packSize?: number;
  substrate?: string;
  adapters?: SubstrateAdapter[];
  judge?: JudgeJAdapter;
  mode?: EvalMode;
  tiers?: EvalTierId[];
  now?: () => Date;
  clock?: () => number;
}

export async function runBenchEval(opts: RunEvalOptions): Promise<EvalReport> {
  const packSize = opts.packSize ?? PACK_SIZE_DEFAULT;
  const corpus = await loadCorpus(opts.corpusDir);
  const questions = await loadQuestions(opts.corpusDir);
  const adapters = opts.adapters ?? defaultSubstrateAdapters(opts.substrate);
  const tiersToRun = opts.tiers ?? ["fixed-pack", "agent-tools"];
  const reports: EvalReport[] = [];
  const agentReports: EvalReport[] = [];
  for (const adapter of adapters) {
    if (tiersToRun.includes("fixed-pack")) {
      reports.push(await evaluateSubstrateAdapter(adapter, corpus, questions, {
        packSize,
        judge: opts.judge,
        now: opts.now,
        mode: opts.mode,
      }));
    }
    if (tiersToRun.includes("agent-tools")) {
      agentReports.push(await evaluateAgentToolSubstrateAdapter(adapter, corpus, questions, {
        packSize,
        judge: opts.judge,
        now: opts.now,
        clock: opts.clock,
        mode: opts.mode,
      }));
    }
  }
  const primary = reports[0] ?? agentReports[0] ?? emptyEvalReport({
    corpus,
    questions,
    packSize,
    substrate: opts.substrate ?? "reddb",
    judge: opts.judge,
    now: opts.now,
    mode: opts.mode,
  });
  const substrates = reports.map(toSubstrateSummary);
  const comparisons = buildSubstrateComparisons(substrates);
  const pareto = buildParetoSummary(substrates);
  const categories = buildCategorySummaries(substrates);
  const agentSubstrates = agentReports.map(toSubstrateSummary);
  const tiers: EvalTierSummary[] = [];
  if (tiersToRun.includes("fixed-pack")) tiers.push(buildTierSummary("fixed-pack", "Fixed context pack", substrates));
  if (tiersToRun.includes("agent-tools")) tiers.push(buildTierSummary("agent-tools", "Agent calls substrate tools", agentSubstrates));
  return {
    ...primary,
    mode: opts.mode ?? "one-shot",
    repetitions: 1,
    substrates,
    comparisons,
    pareto,
    categories,
    tiers,
    variance: null,
  };
}

export function runBenchEvalCore(opts: Omit<RunEvalOptions, "mode" | "tiers">): Promise<EvalReport> {
  const coreAdapters = opts.adapters ?? (
    opts.substrate && opts.substrate !== "reddb"
      ? defaultSubstrateAdapters(opts.substrate)
      : [createRedDbSubstrateAdapter("reddb")]
  );
  return runBenchEval({
    ...opts,
    mode: "deterministic-core",
    substrate: opts.substrate ?? "reddb",
    adapters: coreAdapters,
    tiers: ["fixed-pack"],
  });
}

export interface RunEvalShowcaseOptions extends Omit<RunEvalOptions, "mode" | "tiers"> {
  repetitions?: number;
}

export async function runBenchEvalShowcase(opts: RunEvalShowcaseOptions): Promise<EvalReport> {
  const repetitions = opts.repetitions ?? 10;
  if (repetitions < 10) throw new Error("memory bench eval showcase requires at least 10 repetitions");
  const reports: EvalReport[] = [];
  for (let i = 0; i < repetitions; i += 1) {
    reports.push(await runBenchEval({
      ...opts,
      mode: "showcase",
      tiers: ["fixed-pack", "agent-tools"],
    }));
  }
  const primary = reports[0]!;
  return {
    ...primary,
    mode: "showcase",
    repetitions,
    variance: buildEvalVarianceSummary(reports),
  };
}

export interface EvaluateSubstrateOptions {
  packSize?: number;
  judge?: JudgeJAdapter;
  mode?: EvalMode;
  now?: () => Date;
  clock?: () => number;
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
  let precisionSum = 0;
  let recallSum = 0;
  let ndcgSum = 0;
  const tokens: TokenCounts = { input: 0, output: 0, total: 0 };
  let promptTokens = 0;

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
    const retrieval = retrievalQualityMetrics(packIds, q.gold_doc_ids, packSize);
    emSum += em;
    f1Sum += f1;
    abstentionScoreSum += qAbstentionScore;
    if (goldInPack) goldInPackCount += 1;
    precisionSum += retrieval.precision_at_k;
    recallSum += retrieval.recall_at_k;
    ndcgSum += retrieval.ndcg_at_k;
    tokens.input += tokenUsage.input;
    tokens.output += tokenUsage.output;
    tokens.total += tokenUsage.total;
    promptTokens += tokenUsage.input;
    records.push({
      schema_version: EVAL_SCHEMA_VERSION,
      tier: "fixed-pack",
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
      retrieval_k: retrieval.k,
      precision_at_k: retrieval.precision_at_k,
      recall_at_k: retrieval.recall_at_k,
      ndcg_at_k: retrieval.ndcg_at_k,
      exact_match: em,
      f1: round4(f1),
      tokens: tokenUsage,
      quality_per_1k_tokens: qualityPer1kTokens(f1, tokenUsage.total),
      tools_used: 0,
      prompt_tokens: tokenUsage.input,
      reasoning_tokens: 0,
      reasoning_prompt_ratio: 0,
      time_to_response_ms: 0,
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
    precision_at_k: round4(precisionSum / n),
    recall_at_k: round4(recallSum / n),
    ndcg_at_k: round4(ndcgSum / n),
    tokens,
    quality_per_1k_tokens: qualityPer1kTokens(f1Sum, tokens.total),
    tools_used: 0,
    prompt_tokens: promptTokens,
    reasoning_tokens: 0,
    reasoning_prompt_ratio: 0,
    time_to_response_ms: 0,
  };
  return {
    schema_version: EVAL_SCHEMA_VERSION,
    mode: opts.mode ?? "one-shot",
    repetitions: 1,
    generated_at: now.toISOString(),
    substrate,
    category,
    corpus_size: corpus.length,
    question_count: questions.length,
    pack_size: packSize,
    answerer: FROZEN_ANSWERER_CONFIG,
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
    tiers: [],
    variance: null,
  };
}

export async function evaluateAgentToolSubstrateAdapter<TIndex>(
  adapter: SubstrateAdapter<TIndex>,
  corpus: CorpusEntry[],
  questions: Question[],
  opts: EvaluateSubstrateOptions = {},
): Promise<EvalReport> {
  const packSize = opts.packSize ?? PACK_SIZE_DEFAULT;
  const substrate = adapter.id;
  const index = await adapter.ingestCorpus(corpus);
  const tool = createAgentSubstrateTool(adapter, index, packSize);
  const clock = opts.clock ?? (() => performance.now());
  const useMeasuredTime = opts.clock !== undefined || opts.now === undefined;

  const records: QuestionRecord[] = [];
  let emSum = 0;
  let f1Sum = 0;
  let abstentionScoreSum = 0;
  let goldInPackCount = 0;
  let precisionSum = 0;
  let recallSum = 0;
  let ndcgSum = 0;
  const tokens: TokenCounts = { input: 0, output: 0, total: 0 };
  let toolsUsed = 0;
  let promptTokens = 0;
  let reasoningTokens = 0;
  let responseMs = 0;

  for (const q of questions) {
    const startedAt = clock();
    const result = await tool.call({ question: q, limit: packSize });
    const pack = result.context_pack;
    const predicted = answerFromPack(pack, q);
    const reasoningTrace = renderAgentReasoningTrace(q, result, predicted);
    const tokenUsage = measureAgentToolTokens(q, tool, result, reasoningTrace, predicted);
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
    const packIds = pack.entries.map((e) => e.id);
    const goldIndexes = q.gold_doc_ids.map((id) => packIds.indexOf(id));
    const goldIdx = goldIndexes[0] ?? -1;
    const goldInPack = unanswerable ? packIds.length === 0 : goldIndexes.every((idx) => idx >= 0);
    const retrieval = retrievalQualityMetrics(packIds, q.gold_doc_ids, packSize);
    const qToolsUsed = 1;
    const measuredResponseMs = round4(Math.max(0, clock() - startedAt));
    const qResponseMs = useMeasuredTime
      ? measuredResponseMs
      : estimateTimeToResponseMs({
        tools_used: qToolsUsed,
        prompt_tokens: tokenUsage.prompt_tokens,
        reasoning_tokens: tokenUsage.reasoning_tokens,
        output_tokens: tokenUsage.tokens.output,
        returned_entries: pack.entries.length,
      });
    emSum += em;
    f1Sum += f1;
    abstentionScoreSum += qAbstentionScore;
    if (goldInPack) goldInPackCount += 1;
    precisionSum += retrieval.precision_at_k;
    recallSum += retrieval.recall_at_k;
    ndcgSum += retrieval.ndcg_at_k;
    tokens.input += tokenUsage.tokens.input;
    tokens.output += tokenUsage.tokens.output;
    tokens.total += tokenUsage.tokens.total;
    toolsUsed += qToolsUsed;
    promptTokens += tokenUsage.prompt_tokens;
    reasoningTokens += tokenUsage.reasoning_tokens;
    responseMs += qResponseMs;
    records.push({
      schema_version: EVAL_SCHEMA_VERSION,
      tier: "agent-tools",
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
      retrieval_k: retrieval.k,
      precision_at_k: retrieval.precision_at_k,
      recall_at_k: retrieval.recall_at_k,
      ndcg_at_k: retrieval.ndcg_at_k,
      exact_match: em,
      f1: round4(f1),
      tokens: tokenUsage.tokens,
      quality_per_1k_tokens: qualityPer1kTokens(f1, tokenUsage.tokens.total),
      tools_used: qToolsUsed,
      prompt_tokens: tokenUsage.prompt_tokens,
      reasoning_tokens: tokenUsage.reasoning_tokens,
      reasoning_prompt_ratio: tokenUsage.reasoning_prompt_ratio,
      time_to_response_ms: qResponseMs,
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
    precision_at_k: round4(precisionSum / n),
    recall_at_k: round4(recallSum / n),
    ndcg_at_k: round4(ndcgSum / n),
    tokens,
    quality_per_1k_tokens: qualityPer1kTokens(f1Sum, tokens.total),
    tools_used: round4(toolsUsed / n),
    prompt_tokens: promptTokens,
    reasoning_tokens: reasoningTokens,
    reasoning_prompt_ratio: ratio(reasoningTokens, promptTokens) ?? 0,
    time_to_response_ms: round4(responseMs / n),
  };
  return {
    schema_version: EVAL_SCHEMA_VERSION,
    mode: opts.mode ?? "one-shot",
    repetitions: 1,
    generated_at: now.toISOString(),
    substrate,
    category,
    corpus_size: corpus.length,
    question_count: questions.length,
    pack_size: packSize,
    answerer: FROZEN_ANSWERER_CONFIG,
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
    tiers: [],
    variance: null,
  };
}

function createAgentSubstrateTool<TIndex>(
  adapter: SubstrateAdapter<TIndex>,
  index: TIndex,
  packSize: number,
): AgentSubstrateTool {
  return {
    name: `memory_${adapter.id.replace(/[^a-z0-9]+/gi, "_")}_recall`,
    substrate: adapter.id,
    description: `Retrieve a bounded Memory context pack from the ${adapter.label} substrate.`,
    input_schema: {
      type: "object",
      required: ["question_id", "question", "limit"],
      properties: {
        question_id: { type: "string" },
        question: { type: "string" },
        as_of: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: packSize },
      },
    },
    async call(input) {
      const hits = await adapter.retrieveQuery(index, input.question, input.limit);
      const contextPack = await adapter.buildContextPack(index, input.question, hits.slice(0, input.limit), input.limit);
      return { hits: hits.slice(0, input.limit), context_pack: contextPack };
    },
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
  mode?: EvalMode;
  now?: () => Date;
}): EvalReport {
  const now = (opts.now ?? (() => new Date()))();
  const aggregate = {
    exact_match: 0,
    f1: 0,
    judge_j: null,
    abstention_score: 0,
    gold_in_pack_rate: 0,
    precision_at_k: 0,
    recall_at_k: 0,
    ndcg_at_k: 0,
    tokens: { input: 0, output: 0, total: 0 },
    quality_per_1k_tokens: 0,
    tools_used: 0,
    prompt_tokens: 0,
    reasoning_tokens: 0,
    reasoning_prompt_ratio: 0,
    time_to_response_ms: 0,
  };
  return {
    schema_version: EVAL_SCHEMA_VERSION,
    mode: opts.mode ?? "one-shot",
    repetitions: 1,
    generated_at: now.toISOString(),
    substrate: opts.substrate,
    category: reportCategory(opts.questions),
    corpus_size: opts.corpus.length,
    question_count: opts.questions.length,
    pack_size: opts.packSize,
    answerer: FROZEN_ANSWERER_CONFIG,
    judge: opts.judge?.config ?? FROZEN_JUDGE_J_CONFIG,
    aggregate,
    records: [],
    substrates: [],
    comparisons: [],
    pareto: buildParetoSummary([]),
    categories: [],
    tiers: [],
    variance: null,
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

function buildTierSummary(tier: EvalTierId, label: string, substrates: SubstrateSummary[]): EvalTierSummary {
  return {
    tier,
    label,
    aggregate: aggregateRecords(substrates.flatMap((summary) => summary.records)),
    substrates,
    comparisons: buildSubstrateComparisons(substrates),
    pareto: buildParetoSummary(substrates),
    categories: buildCategorySummaries(substrates),
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
  const precisionSum = records.reduce((sum, record) => sum + record.precision_at_k, 0);
  const recallSum = records.reduce((sum, record) => sum + record.recall_at_k, 0);
  const ndcgSum = records.reduce((sum, record) => sum + record.ndcg_at_k, 0);
  const promptTokens = records.reduce((sum, record) => sum + record.prompt_tokens, 0);
  const reasoningTokens = records.reduce((sum, record) => sum + record.reasoning_tokens, 0);
  return {
    exact_match: round4(records.reduce((sum, record) => sum + record.exact_match, 0) / n),
    f1: round4(f1Sum / n),
    judge_j: aggregateJudgeJ(records, FROZEN_JUDGE_J_CONFIG),
    abstention_score: round4(abstentionScoreSum / n),
    gold_in_pack_rate: round4(records.filter((record) => record.gold_in_pack).length / n),
    precision_at_k: round4(precisionSum / n),
    recall_at_k: round4(recallSum / n),
    ndcg_at_k: round4(ndcgSum / n),
    tokens,
    quality_per_1k_tokens: qualityPer1kTokens(f1Sum, tokens.total),
    tools_used: round4(records.reduce((sum, record) => sum + record.tools_used, 0) / n),
    prompt_tokens: promptTokens,
    reasoning_tokens: reasoningTokens,
    reasoning_prompt_ratio: ratio(reasoningTokens, promptTokens) ?? 0,
    time_to_response_ms: round4(records.reduce((sum, record) => sum + record.time_to_response_ms, 0) / n),
  };
}

function buildEvalVarianceSummary(reports: EvalReport[]): EvalVarianceSummary {
  const buckets = new Map<string, { tier: EvalTierId; substrate: string; values: Map<string, number[]> }>();
  const aggregateValues = new Map<string, number[]>();

  for (const report of reports) {
    for (const [metric, value] of aggregateVarianceValues(report.aggregate)) {
      pushMetric(aggregateValues, metric, value);
    }
    for (const tier of report.tiers) {
      for (const summary of tier.substrates) {
        const key = `${tier.tier}:${summary.substrate}`;
        const bucket = buckets.get(key) ?? {
          tier: tier.tier,
          substrate: summary.substrate,
          values: new Map<string, number[]>(),
        };
        for (const [metric, value] of aggregateVarianceValues(summary.aggregate)) {
          pushMetric(bucket.values, metric, value);
        }
        buckets.set(key, bucket);
      }
    }
  }

  return {
    repetitions: reports.length,
    metrics: varianceMetrics(aggregateValues),
    by_tier_substrate: [...buckets.values()]
      .map((bucket) => ({
        tier: bucket.tier,
        substrate: bucket.substrate,
        metrics: varianceMetrics(bucket.values),
      }))
      .sort((a, b) => a.tier.localeCompare(b.tier) || a.substrate.localeCompare(b.substrate)),
  };
}

function aggregateVarianceValues(aggregate: EvalAggregate): Array<[string, number]> {
  return [
    ["exact_match", aggregate.exact_match],
    ["f1", aggregate.f1],
    ["abstention_score", aggregate.abstention_score],
    ["quality_per_1k_tokens", aggregate.quality_per_1k_tokens],
    ["tokens_total", aggregate.tokens.total],
    ["reasoning_prompt_ratio", aggregate.reasoning_prompt_ratio],
    ["time_to_response_ms", aggregate.time_to_response_ms],
  ];
}

function pushMetric(values: Map<string, number[]>, metric: string, value: number): void {
  if (!Number.isFinite(value)) return;
  const bucket = values.get(metric) ?? [];
  bucket.push(value);
  values.set(metric, bucket);
}

function varianceMetrics(values: Map<string, number[]>): EvalVarianceMetric[] {
  return [...values.entries()]
    .map(([metric, samples]) => varianceMetric(metric, samples))
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

function varianceMetric(metric: string, samples: number[]): EvalVarianceMetric {
  const n = samples.length;
  const mean = n > 0 ? samples.reduce((sum, value) => sum + value, 0) / n : 0;
  const variance = n > 1
    ? samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const margin = n > 0 ? 1.96 * (stdDev / Math.sqrt(n)) : 0;
  return {
    metric,
    samples: n,
    mean: round4(mean),
    std_dev: round4(stdDev),
    ci95_low: round4(mean - margin),
    ci95_high: round4(mean + margin),
  };
}

function categoryOrder(category: string): number {
  const order: Record<string, number> = {
    "single-hop": 0,
    "multi-hop": 1,
    "temporal-as-of": 2,
    "unanswerable": 3,
    "needle": 4,
    "adversarial": 5,
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

export function tierRecords(report: EvalReport): QuestionRecord[] {
  if (report.tiers.length === 0) return report.records;
  return report.tiers.flatMap((tier) => tier.substrates.flatMap((summary) => summary.records));
}

export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# memory bench eval — ${report.generated_at.slice(0, 10)}`);
  lines.push("");
  lines.push(
    `Mode: \`${report.mode}\` · repetitions: ${report.repetitions} · substrate: \`${report.substrate}\` · category: \`${report.category}\` · corpus: ${report.corpus_size} entries · questions: ${report.question_count} · pack size: ${report.pack_size}.`,
  );
  lines.push(
    `Answerer: model \`${report.answerer.model}\` · prompt \`${report.answerer.prompt_version}\`.`,
  );
  lines.push(
    `Judge J: model \`${report.judge.model}\` · prompt \`${report.judge.prompt_version}\` · open-ended categories: ${report.judge.open_ended_categories.map((category) => `\`${category}\``).join(", ")}.`,
  );
  lines.push("");
  if (report.variance) {
    lines.push("## Repeated-run variance");
    lines.push("");
    lines.push("| metric | samples | mean | std dev | 95% CI |");
    lines.push("| --- | ---: | ---: | ---: | --- |");
    for (const metric of report.variance.metrics) {
      lines.push(
        `| ${metric.metric} | ${metric.samples} | ${metric.mean.toFixed(3)} | ${metric.std_dev.toFixed(3)} | [${metric.ci95_low.toFixed(3)}, ${metric.ci95_high.toFixed(3)}] |`,
      );
    }
    lines.push("");
    lines.push("| tier | substrate | metric | samples | mean | std dev | 95% CI |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: | --- |");
    for (const bucket of report.variance.by_tier_substrate) {
      for (const metric of bucket.metrics) {
        lines.push(
          `| ${bucket.tier} | ${bucket.substrate} | ${metric.metric} | ${metric.samples} | ${metric.mean.toFixed(3)} | ${metric.std_dev.toFixed(3)} | [${metric.ci95_low.toFixed(3)}, ${metric.ci95_high.toFixed(3)}] |`,
        );
      }
    }
    lines.push("");
  }
  if (report.tiers.length > 0) {
    lines.push("## Tiers");
    lines.push("");
    lines.push("| tier | substrate | EM | F1 | tools/q | reasoning/prompt | avg response ms | prompt tokens | reasoning tokens | total tokens |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const tier of report.tiers) {
      for (const summary of tier.substrates) {
        lines.push(
          `| ${tier.tier} | ${summary.substrate} | ${summary.aggregate.exact_match.toFixed(3)} | ${summary.aggregate.f1.toFixed(3)} | ${summary.aggregate.tools_used.toFixed(3)} | ${summary.aggregate.reasoning_prompt_ratio.toFixed(3)} | ${summary.aggregate.time_to_response_ms.toFixed(3)} | ${summary.aggregate.prompt_tokens} | ${summary.aggregate.reasoning_tokens} | ${summary.aggregate.tokens.total} |`,
        );
      }
    }
    lines.push("");
  }
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
  lines.push(`| precision@k | ${report.aggregate.precision_at_k.toFixed(3)} |`);
  lines.push(`| recall@k | ${report.aggregate.recall_at_k.toFixed(3)} |`);
  lines.push(`| NDCG@k | ${report.aggregate.ndcg_at_k.toFixed(3)} |`);
  lines.push(`| input tokens | ${report.aggregate.tokens.input} |`);
  lines.push(`| output tokens | ${report.aggregate.tokens.output} |`);
  lines.push(`| quality per 1k tokens | ${report.aggregate.quality_per_1k_tokens.toFixed(3)} |`);
  lines.push(`| tools used / question | ${report.aggregate.tools_used.toFixed(3)} |`);
  lines.push(`| reasoning / prompt | ${report.aggregate.reasoning_prompt_ratio.toFixed(3)} |`);
  lines.push(`| time to response ms | ${report.aggregate.time_to_response_ms.toFixed(3)} |`);
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
    lines.push("## Retrieval quality");
    lines.push("");
    lines.push("Recall returning the *right* nodes, paired with the token cost it took (ADR 0037: never tokens without quality).");
    lines.push("");
    lines.push("| category | substrate | gold-in-pack | precision@k | recall@k | NDCG@k | total tokens |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const category of report.categories) {
      for (const summary of category.substrates) {
        lines.push(
          `| ${category.category} | ${summary.substrate} | ${summary.aggregate.gold_in_pack_rate.toFixed(3)} | ${summary.aggregate.precision_at_k.toFixed(3)} | ${summary.aggregate.recall_at_k.toFixed(3)} | ${summary.aggregate.ndcg_at_k.toFixed(3)} | ${summary.aggregate.tokens.total} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Per-question");
  lines.push("");
  lines.push("| tier | substrate | question_id | category | as_of | gold_rank | tools | reasoning/prompt | response ms | EM | F1 | J | abstention | tokens | F1 / 1k tokens | predicted |");
  lines.push("| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | --- |");
  for (const r of tierRecords(report)) {
    lines.push(
      `| ${r.tier} | ${r.substrate} | ${r.question_id} | ${r.category} | ${r.as_of ?? ""} | ${r.gold_rank ?? "—"} | ${r.tools_used} | ${r.reasoning_prompt_ratio.toFixed(3)} | ${r.time_to_response_ms.toFixed(3)} | ${r.exact_match} | ${r.f1.toFixed(3)} | ${r.judge_j ? r.judge_j.score.toFixed(3) : ""} | ${r.abstention_score.toFixed(3)} | ${r.tokens.total} | ${r.quality_per_1k_tokens.toFixed(3)} | ${r.predicted_answer || "(abstain)"} |`,
    );
  }
  lines.push("");
  lines.push("## Reproducibility");
  lines.push("");
  lines.push(
    "Deterministic by construction for fixed-date CI runs: recall, fixed-pack answering, agent tool calls, deterministic time-to-response fallback, and the exact-match/F1 scorer are pure functions of the checked-in corpus and questions. Normal CLI runs measure agent-tier wall-clock response time.",
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
