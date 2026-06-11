import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  formatMarkdownReport,
  loadCorpus,
  loadQueries,
  precisionAtK,
  rankAmsReference,
  rankOurs,
  recallAtK,
  runBenchRecall,
} from "../src/bench-recall.js";

const CORPUS_DIR = join(__dirname, "../bench/recall");
const FIXED_NOW = new Date("2026-05-26T00:00:00.000Z");

describe("memory bench recall — corpus loaders", () => {
  test("corpus loads with required fields", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    expect(corpus.length).toBeGreaterThanOrEqual(20);
    for (const c of corpus) {
      expect(c.id).toMatch(/^doc-/);
      expect(typeof c.type).toBe("string");
      expect(Array.isArray(c.tags)).toBe(true);
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  test("queries reference corpus ids", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    const ids = new Set(corpus.map((c) => c.id));
    const queries = await loadQueries(CORPUS_DIR);
    expect(queries.length).toBeGreaterThanOrEqual(20);
    for (const q of queries) {
      expect(q.relevant_ids.length).toBeGreaterThan(0);
      for (const id of q.relevant_ids) expect(ids.has(id)).toBe(true);
    }
  });
});

describe("memory bench recall — metrics", () => {
  test("precision@k counts matches in top-k slice", () => {
    expect(precisionAtK(["a", "b", "c", "d"], ["a", "d"], 4)).toBeCloseTo(0.5, 5);
    expect(precisionAtK(["a", "b"], ["a"], 1)).toBe(1);
    expect(precisionAtK(["x", "y"], ["a"], 2)).toBe(0);
  });

  test("recall@k is matches / |relevant|", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "b"], 5)).toBe(1);
    expect(recallAtK(["x", "a"], ["a", "b"], 5)).toBe(0.5);
    expect(recallAtK([], ["a"], 5)).toBe(0);
  });
});

describe("memory bench recall — strategies", () => {
  test("our hybrid finds the relevant doc for a typed operational query", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    const queries = await loadQueries(CORPUS_DIR);
    const q = queries.find((x) => x.id === "q-008")!;
    const hits = rankOurs(corpus, q, 5);
    expect(hits).toContain("doc-011");
    expect(hits.indexOf("doc-011")).toBeLessThanOrEqual(2);
  });

  test("ams reference produces a stable ordering on the same query", async () => {
    const corpus = await loadCorpus(CORPUS_DIR);
    const queries = await loadQueries(CORPUS_DIR);
    const q = queries[0]!;
    const a = rankAmsReference(corpus, q, 10);
    const b = rankAmsReference(corpus, q, 10);
    expect(a).toEqual(b);
  });
});

describe("memory bench recall — runner", () => {
  test("aggregate shape matches schema v1 and includes default k values", async () => {
    const report = await runBenchRecall({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    expect(report.schema_version).toBe("memory.bench.recall.v1");
    expect(report.k_values).toEqual([1, 5, 10]);
    expect(report.generated_at).toBe(FIXED_NOW.toISOString());
    expect(report.corpus_size).toBeGreaterThan(0);
    expect(report.query_count).toBeGreaterThan(0);
    for (const k of report.k_values) {
      expect(typeof report.aggregate.ours.precision_at_k[String(k)]).toBe("number");
      expect(typeof report.aggregate.ours.recall_at_k[String(k)]).toBe("number");
      expect(typeof report.aggregate.ams_reference.precision_at_k[String(k)]).toBe("number");
      expect(typeof report.aggregate.ams_reference.recall_at_k[String(k)]).toBe("number");
    }
  });

  test("bench is byte-deterministic across runs (zero tolerance)", async () => {
    const a = await runBenchRecall({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    const b = await runBenchRecall({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("our hybrid beats vector-only AMS reference on the operational corpus", async () => {
    const report = await runBenchRecall({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    // Operational queries are exactly where typed-graph + RRF should win.
    expect(report.aggregate.delta.precision_at_k["5"]!).toBeGreaterThan(0);
    expect(report.aggregate.delta.recall_at_k["5"]!).toBeGreaterThan(0);
  });

  test("markdown report renders an aggregate row plus per-query table", async () => {
    const report = await runBenchRecall({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });
    const md = formatMarkdownReport(report);
    expect(md).toContain("# memory bench recall — 2026-05-26");
    expect(md).toContain("ours (RRF: keyword + vector + graph)");
    expect(md).toContain("ams_reference (vector only)");
    for (const q of report.per_query) {
      expect(md).toContain(q.query_id);
    }
  });
});
