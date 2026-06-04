import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  EVAL_SCHEMA_VERSION,
  answerFromPack,
  buildContextPack,
  createNeo4jSubstrateAdapter,
  countBenchTokens,
  evaluateSubstrateAdapter,
  exactMatch,
  formatEvalReport,
  loadCorpus,
  loadQuestions,
  normalizeAnswer,
  runBenchEval,
  toJsonl,
  tokenF1,
  type Neo4jSubstrateCommand,
  type SubstrateAdapter,
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
  test("adapter interface evaluates ingest, retrieval, and context pack through a fake adapter", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    const questions = await loadQuestions(CORPUS_DIR);
    const q = questions.find((x) => x.id === "q-001")!;
    const calls: string[] = [];
    const fake: SubstrateAdapter<{ byId: Map<string, (typeof corpus)[number]> }> = {
      id: "fake",
      label: "Fake substrate",
      async ingestCorpus(entries) {
        calls.push(`ingest:${entries.length}`);
        return { byId: new Map(entries.map((entry) => [entry.id, entry])) };
      },
      async retrieveQuery(_index, question, limit) {
        calls.push(`retrieve:${question.id}:${limit}`);
        return [
          { id: "doc-001", score: 9 },
          { id: "doc-002", score: 1 },
        ].slice(0, limit);
      },
      async buildContextPack(index, question, hits) {
        calls.push(`pack:${question.id}:${hits.map((hit) => hit.id).join(",")}`);
        return {
          question_id: question.id,
          substrate: "fake",
          entries: hits.map((hit, i) => {
            const entry = index.byId.get(hit.id)!;
            return {
              id: entry.id,
              rank: i + 1,
              score: hit.score,
              fact: entry.fact,
              text: entry.text,
            };
          }),
        };
      },
    };

    const report = await evaluateSubstrateAdapter(fake, corpus, [q], {
      packSize: 2,
      now: () => FIXED_NOW,
    });

    expect(calls).toEqual(["ingest:12", "retrieve:q-001:2", "pack:q-001:doc-001,doc-002"]);
    expect(report.substrate).toBe("fake");
    expect(report.records[0]).toMatchObject({
      question_id: "q-001",
      pack_ids: ["doc-001", "doc-002"],
      predicted_answer: "pnpm",
      exact_match: 1,
    });
    expect(report.records[0]!.tokens.input).toBeGreaterThan(0);
    expect(report.records[0]!.tokens.output).toBeGreaterThan(0);
    expect(report.records[0]!.quality_per_1k_tokens).toBeGreaterThan(0);
  });

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

  test("neo4j adapter runs native traversal through an injectable executor", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    const questions = await loadQuestions(CORPUS_DIR);
    const q = questions.find((x) => x.id === "q-001")!;
    const commands: Neo4jSubstrateCommand[] = [];
    const adapter = createNeo4jSubstrateAdapter({
      executor(command) {
        commands.push(command);
        if (command.operation === "retrieve") {
          expect(command.cypher).toContain("MATCH (question)-[qTerm:HAS_TERM]->");
          expect(command.cypher).toContain("<-[mention:MENTIONS]-(memory:BenchMemory)");
          expect(command.cypher).toContain("ORDER BY score DESC, id ASC");
          expect(command.params).toMatchObject({ questionId: "q-001", limit: 2 });
          return {
            rows: [
              { id: "doc-001", score: 7 },
              { id: "doc-002", score: 1 },
            ],
          };
        }
        expect(command.cypher).toContain("CREATE (memory:BenchMemory");
        expect(command.cypher).toContain("MERGE (memory)-[mention:MENTIONS]->");
        expect(command.params).toMatchObject({ runId: "memory-bench-eval:neo4j" });
        expect(Array.isArray(command.params.entries)).toBe(true);
        return { rows: [] };
      },
    });

    const report = await evaluateSubstrateAdapter(adapter, corpus, [q], {
      packSize: 2,
      now: () => FIXED_NOW,
    });

    expect(commands.map((command) => command.operation)).toEqual(["ingest", "retrieve"]);
    expect(report.substrate).toBe("neo4j");
    expect(report.substrates[0]?.label).toBe("Neo4j native graph traversal");
    expect(report.records[0]).toMatchObject({
      question_id: "q-001",
      pack_ids: ["doc-001", "doc-002"],
      predicted_answer: "pnpm",
      exact_match: 1,
    });
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

  test("default run compares RedDB, markdown embedding-RAG, and Neo4j traversal", async () => {
    const report = await runBenchEval({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    expect(report.substrates.map((summary) => summary.substrate)).toEqual([
      "reddb",
      "markdown-rag",
      "neo4j",
    ]);
    expect(report.comparisons.map((comparison) => comparison.id)).toEqual([
      "reddb_vs_markdown-rag",
      "reddb_vs_neo4j",
    ]);
    for (const summary of report.substrates) {
      expect(summary.records).toHaveLength(report.question_count);
      expect(summary.aggregate.tokens.input).toBeGreaterThan(0);
      expect(summary.aggregate.tokens.output).toBeGreaterThan(0);
      expect(summary.aggregate.quality_per_1k_tokens).toBeGreaterThan(0);
    }
    expect(countBenchTokens("hello world")).toBeLessThan("hello world".length);
  });

  test("explicit neo4j substrate runs only the Neo4j adapter", async () => {
    const report = await runBenchEval({
      corpusDir: CORPUS_DIR,
      substrate: "neo4j",
      now: () => FIXED_NOW,
    });
    expect(report.substrate).toBe("neo4j");
    expect(report.substrates.map((summary) => summary.substrate)).toEqual(["neo4j"]);
    expect(report.comparisons).toEqual([]);
    expect(report.aggregate.f1).toBeGreaterThan(0);
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
    expect(md).toContain("markdown-rag");
    expect(md).toContain("F1 / 1k tokens");
    expect(md).toContain("exact-match");
    expect(md).toContain("token-F1");
    for (const r of report.records) expect(md).toContain(r.question_id);
  });
});
