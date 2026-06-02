import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  EVAL_SCHEMA_VERSION,
  answerFromPack,
  buildContextPack,
  exactMatch,
  formatEvalReport,
  loadCorpus,
  loadQuestions,
  normalizeAnswer,
  runBenchEval,
  toJsonl,
  tokenF1,
} from "../src/bench-eval.js";

const CORPUS_DIR = join(__dirname, "../bench/eval/single-hop");
const FIXED_NOW = new Date("2026-06-02T00:00:00.000Z");

describe("memory bench eval — fixture integrity", () => {
  test("every question's gold_doc_id resolves and its gold_answer matches that entry's fact", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    const byId = new Map(corpus.map((c) => [c.id, c]));
    const questions = await loadQuestions(CORPUS_DIR);
    expect(questions.length).toBeGreaterThanOrEqual(10);
    for (const q of questions) {
      expect(q.category).toBe("single-hop");
      const gold = byId.get(q.gold_doc_id);
      expect(gold, `gold_doc_id ${q.gold_doc_id} for ${q.id}`).toBeDefined();
      // Single-hop exact gold: the authoritative answer is the gold entry's fact.
      expect(exactMatch(q.gold_answer, gold!.fact)).toBe(1);
    }
  });
});

describe("memory bench eval — scorer (pure)", () => {
  test("normalizeAnswer lowercases, strips punctuation + articles, collapses space", () => {
    expect(normalizeAnswer("  The   pnpm! ")).toBe("pnpm");
    expect(normalizeAnswer("HttpOnly, Secure; SameSite=Lax")).toBe("httponly secure samesite lax");
    expect(normalizeAnswer("a UTC")).toBe("utc");
  });

  test("exactMatch is 1 only on normalised equality", () => {
    expect(exactMatch("pnpm", "pnpm")).toBe(1);
    expect(exactMatch("The pnpm.", "pnpm")).toBe(1);
    expect(exactMatch("npm", "pnpm")).toBe(0);
    expect(exactMatch("", "pnpm")).toBe(0);
  });

  test("tokenF1 gives partial credit and handles edge cases", () => {
    expect(tokenF1("pnpm", "pnpm")).toBe(1);
    expect(tokenF1("", "pnpm")).toBe(0);
    expect(tokenF1("totally wrong", "pnpm")).toBe(0);
    // 2 shared of 3 predicted, 2 shared of 2 gold → P=2/3, R=1, F1=0.8
    expect(tokenF1("stored in utc", "in utc")).toBeCloseTo(0.8, 5);
  });

  test("tokenF1 is symmetric in precision/recall composition", () => {
    expect(tokenF1("in utc", "stored in utc")).toBeCloseTo(0.8, 5);
  });
});

describe("memory bench eval — substrate + answerer", () => {
  test("the fixed pack is bounded, ranked, and tie-broken by id", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    const questions = await loadQuestions(CORPUS_DIR);
    const pack = buildContextPack(corpus, questions[0]!, 5, "reddb");
    expect(pack.entries.length).toBeLessThanOrEqual(5);
    expect(pack.entries.map((e) => e.rank)).toEqual(pack.entries.map((_, i) => i + 1));
    const again = buildContextPack(corpus, questions[0]!, 5, "reddb");
    expect(pack).toEqual(again);
  });

  test("governed recall surfaces the gold entry on top for a single-hop question", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    const questions = await loadQuestions(CORPUS_DIR);
    const q = questions.find((x) => x.id === "q-001")!;
    const pack = buildContextPack(corpus, q, 5, "reddb");
    expect(pack.entries[0]?.id).toBe("doc-001");
    expect(answerFromPack(pack)).toBe("pnpm");
  });

  test("answerer abstains (empty string) on an empty pack", () => {
    expect(answerFromPack({ question_id: "x", substrate: "reddb", entries: [] })).toBe("");
  });
});

describe("memory bench eval — runner", () => {
  test("report shape matches schema v1 and carries an aggregate score", async () => {
    const report = await runBenchEval({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    expect(report.schema_version).toBe(EVAL_SCHEMA_VERSION);
    expect(report.generated_at).toBe(FIXED_NOW.toISOString());
    expect(report.substrate).toBe("reddb");
    expect(report.category).toBe("single-hop");
    expect(report.corpus_size).toBeGreaterThan(0);
    expect(report.question_count).toBe(report.records.length);
    expect(report.aggregate.exact_match).toBeGreaterThan(0);
    expect(report.aggregate.exact_match).toBeLessThanOrEqual(1);
    expect(report.aggregate.f1).toBeGreaterThanOrEqual(report.aggregate.exact_match);
  });

  test("each record carries the stable per-question schema", async () => {
    const report = await runBenchEval({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    for (const r of report.records) {
      expect(r.schema_version).toBe(EVAL_SCHEMA_VERSION);
      expect(typeof r.question_id).toBe("string");
      expect(typeof r.predicted_answer).toBe("string");
      expect(Array.isArray(r.pack_ids)).toBe(true);
      expect([0, 1]).toContain(r.exact_match);
      expect(r.f1).toBeGreaterThanOrEqual(0);
      expect(r.f1).toBeLessThanOrEqual(1);
      if (r.gold_in_pack) expect(r.gold_rank).toBe(r.pack_ids.indexOf(r.gold_doc_id) + 1);
      else expect(r.gold_rank).toBeNull();
    }
  });

  test("run is byte-deterministic across runs (zero tolerance)", async () => {
    const a = await runBenchEval({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    const b = await runBenchEval({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(toJsonl(a.records)).toBe(toJsonl(b.records));
  });
});

describe("memory bench eval — JSONL emission", () => {
  test("toJsonl emits one parseable object per line with a trailing newline", async () => {
    const report = await runBenchEval({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    const jsonl = toJsonl(report.records);
    expect(jsonl.endsWith("\n")).toBe(true);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines.length).toBe(report.records.length);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.schema_version).toBe(EVAL_SCHEMA_VERSION);
    }
  });

  test("empty records produce empty JSONL (no stray newline)", () => {
    expect(toJsonl([])).toBe("");
  });
});

describe("memory bench eval — markdown report", () => {
  test("renders aggregate metrics and a per-question row for every record", async () => {
    const report = await runBenchEval({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    const md = formatEvalReport(report);
    expect(md).toContain("# memory bench eval — 2026-06-02");
    expect(md).toContain("exact-match");
    expect(md).toContain("token-F1");
    for (const r of report.records) expect(md).toContain(r.question_id);
  });
});
