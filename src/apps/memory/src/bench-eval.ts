import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  };
  records: QuestionRecord[];
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
  const scored = corpus
    .map((entry) => ({ entry, score: scoreEntry(question, entry) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, packSize);
  const entries: ContextPackEntry[] = scored.map((s, i) => ({
    id: s.entry.id,
    rank: i + 1,
    score: round4(s.score),
    fact: s.entry.fact,
    text: s.entry.text,
  }));
  return { question_id: question.id, substrate, entries };
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
 * Runner — wires substrate → answerer → scorer, emits the report + records
 * --------------------------------------------------------------------------*/

export interface RunEvalOptions {
  corpusDir: string;
  packSize?: number;
  substrate?: string;
  now?: () => Date;
}

export async function runBenchEval(opts: RunEvalOptions): Promise<EvalReport> {
  const packSize = opts.packSize ?? PACK_SIZE_DEFAULT;
  const substrate = opts.substrate ?? "reddb";
  const corpus = await loadCorpus(opts.corpusDir);
  const questions = await loadQuestions(opts.corpusDir);

  const records: QuestionRecord[] = [];
  let emSum = 0;
  let f1Sum = 0;
  let goldInPackCount = 0;

  for (const q of questions) {
    const pack = buildContextPack(corpus, q, packSize, substrate);
    const predicted = answerFromPack(pack);
    const em = exactMatch(predicted, q.gold_answer);
    const f1 = tokenF1(predicted, q.gold_answer);
    const packIds = pack.entries.map((e) => e.id);
    const goldIdx = packIds.indexOf(q.gold_doc_id);
    const goldInPack = goldIdx >= 0;
    emSum += em;
    f1Sum += f1;
    if (goldInPack) goldInPackCount += 1;
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
    });
  }

  const n = Math.max(questions.length, 1);
  const category = questions[0]?.category ?? "single-hop";
  const now = (opts.now ?? (() => new Date()))();
  return {
    schema_version: EVAL_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    substrate,
    category,
    corpus_size: corpus.length,
    question_count: questions.length,
    pack_size: packSize,
    aggregate: {
      exact_match: round4(emSum / n),
      f1: round4(f1Sum / n),
      gold_in_pack_rate: round4(goldInPackCount / n),
    },
    records,
  };
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
  lines.push("| metric | score |");
  lines.push("| --- | --- |");
  lines.push(`| exact-match | ${report.aggregate.exact_match.toFixed(3)} |`);
  lines.push(`| token-F1 | ${report.aggregate.f1.toFixed(3)} |`);
  lines.push(`| gold-in-pack rate | ${report.aggregate.gold_in_pack_rate.toFixed(3)} |`);
  lines.push("");
  lines.push("## Per-question");
  lines.push("");
  lines.push("| question_id | gold_rank | EM | F1 | predicted |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of report.records) {
    lines.push(
      `| ${r.question_id} | ${r.gold_rank ?? "—"} | ${r.exact_match} | ${r.f1.toFixed(3)} | ${r.predicted_answer || "(abstain)"} |`,
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
