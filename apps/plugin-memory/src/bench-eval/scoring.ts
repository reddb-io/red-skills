import type { ProviderClient, ProviderRequest } from "../extract-conversation.js";
import { countCl100kTokens } from "../token-count.js";
import type {
  AgentSubstrateTool,
  AgentToolCallOutput,
  ContextPack,
  ContextPackEntry,
  JudgeJAdapter,
  JudgeJConfig,
  JudgeJInput,
  JudgeJResult,
  Question,
  TokenCounts,
} from "./types.js";
import { FROZEN_JUDGE_J_CONFIG, JUDGE_J_SCORER } from "./types.js";
import { isRecord, ratio, round4 } from "./util.js";

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

/* ----------------------------------------------------------------------------
 * Retrieval-quality metrics — precision@k / recall@k / NDCG@k (#825, ADR 0037)
 *
 * `gold_in_pack` only answers "did the right entry land anywhere in the pack".
 * These three answer "did recall return the *right* entries, ranked well":
 *   precision@k — fraction of the returned top-k that is a gold doc
 *   recall@k    — fraction of the gold set surfaced within the top-k
 *   NDCG@k      — rank-weighted gain (binary relevance) over the ideal ranking
 *
 * Unanswerable questions carry an empty gold set: a perfect substrate returns
 * nothing, so an empty top-k scores 1 on all three and any returned entry scores
 * 0. This mirrors the `gold_in_pack` abstention convention. Pure and
 * deterministic so it gates in CI alongside the exact-match/F1 scorer.
 * --------------------------------------------------------------------------*/

export interface RetrievalQualityMetrics {
  k: number;
  precision_at_k: number;
  recall_at_k: number;
  ndcg_at_k: number;
}

export function retrievalQualityMetrics(packIds: string[], goldIds: string[], k: number): RetrievalQualityMetrics {
  const cutoff = Math.max(0, Math.floor(k));
  const topK = packIds.slice(0, cutoff);
  const gold = new Set(goldIds);
  if (gold.size === 0) {
    const clean = topK.length === 0 ? 1 : 0;
    return { k: cutoff, precision_at_k: clean, recall_at_k: clean, ndcg_at_k: clean };
  }
  let relevant = 0;
  let dcg = 0;
  topK.forEach((id, i) => {
    if (gold.has(id)) {
      relevant += 1;
      dcg += 1 / Math.log2(i + 2);
    }
  });
  const precision = topK.length > 0 ? relevant / topK.length : 0;
  const recall = relevant / gold.size;
  const idealRelevant = Math.min(gold.size, cutoff);
  let idcg = 0;
  for (let i = 0; i < idealRelevant; i += 1) idcg += 1 / Math.log2(i + 2);
  const ndcg = idcg > 0 ? dcg / idcg : 0;
  return {
    k: cutoff,
    precision_at_k: round4(precision),
    recall_at_k: round4(recall),
    ndcg_at_k: round4(ndcg),
  };
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

export function countBenchTokens(text: string): number {
  return countCl100kTokens(text);
}

export function measureAnswererTokens(question: Question, pack: ContextPack, predictedAnswer: string): TokenCounts {
  const input = countBenchTokens(renderAnswererInput(question, pack));
  const output = countBenchTokens(predictedAnswer);
  return { input, output, total: input + output };
}

export function measureAgentToolTokens(
  question: Question,
  tool: AgentSubstrateTool,
  result: AgentToolCallOutput,
  reasoningTrace: string,
  predictedAnswer: string,
): { tokens: TokenCounts; prompt_tokens: number; reasoning_tokens: number; reasoning_prompt_ratio: number } {
  const promptTokens = countBenchTokens(renderAgentToolPrompt(question, tool));
  const toolResultTokens = countBenchTokens(renderAgentToolResult(result));
  const reasoningTokens = countBenchTokens(reasoningTrace);
  const output = countBenchTokens(predictedAnswer);
  const input = promptTokens + toolResultTokens + reasoningTokens;
  return {
    tokens: { input, output, total: input + output },
    prompt_tokens: promptTokens,
    reasoning_tokens: reasoningTokens,
    reasoning_prompt_ratio: ratio(reasoningTokens, promptTokens) ?? 0,
  };
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

function renderAgentToolPrompt(question: Question, tool: AgentSubstrateTool): string {
  return [
    "You are an eval agent answering from Memory tools only.",
    "Call the substrate tool before answering. Abstain with \"not in memory\" when the tool returns no support.",
    "",
    `Question id: ${question.id}`,
    `Category: ${question.category}`,
    `Question: ${question.question}`,
    question.as_of ? `As of: ${question.as_of}` : "",
    "",
    "Available tool:",
    JSON.stringify({
      name: tool.name,
      substrate: tool.substrate,
      description: tool.description,
      input_schema: tool.input_schema,
    }),
  ].filter(Boolean).join("\n");
}

function renderAgentToolResult(result: AgentToolCallOutput): string {
  return JSON.stringify({
    hits: result.hits.map((hit) => ({ id: hit.id, score: hit.score })),
    context_pack: result.context_pack.entries.map((entry) => ({
      id: entry.id,
      rank: entry.rank,
      score: entry.score,
      fact: entry.fact,
    })),
  });
}

export function renderAgentReasoningTrace(question: Question, result: AgentToolCallOutput, predictedAnswer: string): string {
  const packIds = result.context_pack.entries.map((entry) => entry.id);
  const supportIds = question.gold_doc_ids.filter((id) => packIds.includes(id));
  return [
    `Called ${result.context_pack.substrate} recall tool for ${question.id}.`,
    `Tool returned ${result.context_pack.entries.length} context entr${result.context_pack.entries.length === 1 ? "y" : "ies"}.`,
    supportIds.length > 0 ? `Visible support ids: ${supportIds.join(", ")}.` : "No gold support ids were visible in the returned pack.",
    `Answer decision: ${predictedAnswer || "(abstain)"}.`,
  ].join(" ");
}

export function estimateTimeToResponseMs(input: {
  tools_used: number;
  prompt_tokens: number;
  reasoning_tokens: number;
  output_tokens: number;
  returned_entries: number;
}): number {
  return round4(
    2 +
    input.tools_used * 4 +
    input.returned_entries * 0.75 +
    input.prompt_tokens * 0.015 +
    input.reasoning_tokens * 0.03 +
    input.output_tokens * 0.02,
  );
}

export function qualityPer1kTokens(quality: number, totalTokens: number): number {
  if (totalTokens <= 0) return 0;
  return round4((quality / totalTokens) * 1000);
}

/* ----------------------------------------------------------------------------
 * Runner — wires substrate → answerer → scorer, emits the report + records
 * --------------------------------------------------------------------------*/
