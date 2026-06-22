import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BENCH_ANALYTICS_COLLECTIONS,
  BENCH_REGRESSION_AGGREGATES,
  gateBenchEvalCoreRegression,
  resolveBenchAnalyticsUri,
  writeBenchEvalAnalytics,
  writeBenchLatencyAnalytics,
  type BenchAnalyticsDb,
} from "../src/bench-analytics.js";
import { runBenchEval } from "../src/bench-eval.js";
import { runBenchLatency } from "../src/bench-latency.js";

const CORPUS_DIR = join(__dirname, "../bench/eval/single-hop");
const FIXED_NOW = new Date("2026-06-02T00:00:00.000Z");

class FakeBenchAnalyticsDb implements BenchAnalyticsDb {
  executeCalls: string[] = [];
  queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
  previousValues = new Map<string, number>();
  caNames: string[] = [];
  regressionRows: Array<Record<string, unknown>> = [];

  async execute(sql: string): Promise<void> {
    this.executeCalls.push(sql);
  }

  async query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queryCalls.push({ sql, params });
    if (sql.includes("LIST_HYPERTABLES")) return { rows: [{ names: [] }] };
    if (sql.includes("CA_REGISTER")) {
      const name = sql.match(/CA_REGISTER\('([^']+)'/)?.[1];
      if (name && !this.caNames.includes(name)) this.caNames.push(name);
      return { rows: [{ ok: true }] };
    }
    if (sql.includes("CA_LIST")) return { rows: [{ names: this.caNames }] };
    if (sql.startsWith(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.regression} (`)) {
      this.regressionRows.push({
        ts: params?.[0],
        bench: params?.[3],
        substrate: params?.[4],
        metric_name: params?.[5],
        metric_value: params?.[6],
        delta: params?.[8],
      });
      return { rows: [] };
    }
    if (sql === `SELECT * FROM ${BENCH_ANALYTICS_COLLECTIONS.regression}`) {
      return { rows: this.regressionRows };
    }
    if (sql.includes(`FROM ${BENCH_ANALYTICS_COLLECTIONS.regression}`) && sql.startsWith("SELECT")) {
      if (params?.[0] === "eval" && params?.[1] === "reddb" && params.length === 2) {
        return {
          rows: [...this.regressionRows].sort((a, b) => Number(b.ts) - Number(a.ts)),
        };
      }
      const key = `${params?.[0]}:${params?.[1]}:${params?.[2]}`;
      const value = this.previousValues.get(key);
      return { rows: value === undefined ? [] : [{ metric_value: value }] };
    }
    return { rows: [] };
  }
}

describe("memory bench analytics — RedDB writer", () => {
  test("normalizes analytics file paths to RedDB file URIs", () => {
    expect(resolveBenchAnalyticsUri("file:///tmp/bench.rdb")).toBe("file:///tmp/bench.rdb");
    expect(resolveBenchAnalyticsUri(".red/memory/bench.rdb", "/repo")).toBe("file:///repo/.red/memory/bench.rdb");
  });

  test("writes eval records into hypertables plus histogram, percentile, and regression surfaces", async () => {
    const db = new FakeBenchAnalyticsDb();
    db.previousValues.set("eval:reddb:f1", 0.5);
    const report = await runBenchEval({ corpusDir: CORPUS_DIR, now: () => FIXED_NOW });

    const result = await writeBenchEvalAnalytics(report, { db });

    expect(result.run_id).toMatch(/^memory-bench:eval:/);
    expect(result.inserted_runs).toBeGreaterThan(0);
    expect(result.inserted_histograms).toBeGreaterThan(0);
    expect(result.inserted_percentiles).toBeGreaterThan(0);
    expect(result.inserted_regressions).toBe(7);
    expect(db.executeCalls).toContainEqual(expect.stringContaining(`CREATE TABLE IF NOT EXISTS ${BENCH_ANALYTICS_COLLECTIONS.histograms}`));
    expect(db.executeCalls).toContainEqual(expect.stringContaining(`CREATE TABLE IF NOT EXISTS ${BENCH_ANALYTICS_COLLECTIONS.regression}`));
    expect(db.executeCalls).toContainEqual(expect.stringContaining(`CREATE HYPERTABLE ${BENCH_ANALYTICS_COLLECTIONS.runs} TIME_COLUMN ts`));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`CA_REGISTER('${BENCH_REGRESSION_AGGREGATES.value}'`),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.runs}`),
      params: expect.arrayContaining(["eval", "reddb", "fixed-pack", "tokens_total"]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.runs}`),
      params: expect.arrayContaining(["eval", "reddb", "agent-tools", "tools_used", 1]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.runs}`),
      params: expect.arrayContaining(["eval", "reddb", "agent-tools", "time_to_response_ms"]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.histograms}`),
      params: expect.arrayContaining(["eval", "tokens_total", "+Inf"]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.percentiles}`),
      params: expect.arrayContaining(["eval", "tokens_total", 0.95]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.regression}`),
      params: expect.arrayContaining(["eval", "reddb", "exact_match", report.aggregate.exact_match]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.regression}`),
      params: expect.arrayContaining(["eval", "reddb", "f1", report.aggregate.f1, 0.5]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.regression}`),
      params: expect.arrayContaining(["eval", "reddb", "abstention_score", report.aggregate.abstention_score]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.regression}`),
      params: expect.arrayContaining(["eval", "reddb", "ndcg_at_k", report.aggregate.ndcg_at_k]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.runs}`),
      params: expect.arrayContaining(["eval", "reddb", "fixed-pack", "precision_at_k"]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.regressionAggregate}`),
      params: expect.arrayContaining(["eval", "reddb", "f1"]),
    }));
  });

  test("writes latency distributions from sample histograms and p50/p95 rows", async () => {
    const db = new FakeBenchAnalyticsDb();
    const report = await runBenchLatency({
      workload: { iterations: 40, warmup: 10, op_classes: ["working-get"] },
      now: () => FIXED_NOW,
    });

    const result = await writeBenchLatencyAnalytics(report, { db });

    expect(result.run_id).toMatch(/^memory-bench:latency:/);
    expect(result.inserted_runs).toBeGreaterThan(0);
    expect(result.inserted_histograms).toBeGreaterThan(0);
    expect(result.inserted_percentiles).toBeGreaterThan(0);
    expect(result.inserted_regressions).toBe(3);
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.runs}`),
      params: expect.arrayContaining(["latency", "working-get", "ours", "latency_p95_us"]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.histograms}`),
      params: expect.arrayContaining(["latency", "working-get", "ours", "latency_us", "+Inf"]),
    }));
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.percentiles}`),
      params: expect.arrayContaining(["latency", "working-get", "ours", "latency_us", 0.5]),
    }));
  });

  test("gates core eval regressions from the regression hypertable", async () => {
    const db = new FakeBenchAnalyticsDb();
    db.regressionRows.push(
      {
        ts: 10,
        bench: "eval",
        substrate: "reddb",
        metric_name: "exact_match",
        metric_value: 0.9,
        previous_value: 1,
        delta: -0.1,
        delta_pct: -10,
      },
      {
        ts: 10,
        bench: "eval",
        substrate: "reddb",
        metric_name: "f1",
        metric_value: 0.95,
        previous_value: 1,
        delta: -0.05,
        delta_pct: -5,
      },
    );

    const result = await gateBenchEvalCoreRegression({ db });

    expect(result.status).toBe("fail");
    expect(result.failures.map((failure) => failure.metric_name)).toEqual(["exact_match", "f1"]);
    expect(db.queryCalls).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining(`FROM ${BENCH_ANALYTICS_COLLECTIONS.regression}`),
      params: ["eval", "reddb"],
    }));
  });

  test("gates a retrieval-quality drop (precision/recall/NDCG) beyond the allowed delta", async () => {
    const db = new FakeBenchAnalyticsDb();
    db.regressionRows.push(
      { ts: 10, bench: "eval", substrate: "reddb", metric_name: "ndcg_at_k", metric_value: 0.7, previous_value: 0.95, delta: -0.25, delta_pct: -26.3 },
      { ts: 10, bench: "eval", substrate: "reddb", metric_name: "recall_at_k", metric_value: 0.8, previous_value: 1, delta: -0.2, delta_pct: -20 },
      { ts: 10, bench: "eval", substrate: "reddb", metric_name: "precision_at_k", metric_value: 0.4, previous_value: 0.4, delta: 0, delta_pct: 0 },
    );

    const result = await gateBenchEvalCoreRegression({ db });

    expect(result.status).toBe("fail");
    expect(result.checked_metrics).toContain("ndcg_at_k");
    expect(result.failures.map((failure) => failure.metric_name).sort()).toEqual(["ndcg_at_k", "recall_at_k"]);
  });
});
