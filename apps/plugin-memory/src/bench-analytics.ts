import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { connect } from "@reddb-io/sdk";
import type { EvalReport, QuestionRecord } from "./bench-eval.js";
import type { LatencyReport, PercentileStats } from "./bench-latency.js";

type TimestampNs = number;

export const BENCH_ANALYTICS_COLLECTIONS = {
  runs: "memory_bench_runs",
  histograms: "memory_bench_histograms",
  percentiles: "memory_bench_percentiles",
  regression: "memory_bench_regression",
  regressionAggregate: "memory_bench_regression_1d",
} as const;

export const BENCH_REGRESSION_AGGREGATES = {
  value: "memory_bench_regression_value_1d",
  delta: "memory_bench_regression_delta_1d",
} as const;

export interface BenchAnalyticsDb {
  execute(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  close?(): Promise<void>;
}

export interface BenchAnalyticsWriteOptions {
  db: BenchAnalyticsDb;
  source?: string;
  registerAggregates?: boolean;
}

export interface BenchAnalyticsWriteResult {
  run_id: string;
  inserted_runs: number;
  inserted_histograms: number;
  inserted_percentiles: number;
  inserted_regressions: number;
}

export interface BenchRegressionGateFailure {
  bench: string;
  substrate: string;
  metric_name: string;
  metric_value: number;
  previous_value: number | null;
  delta: number;
  delta_pct: number | null;
  allowed_delta: number;
}

export interface BenchRegressionGateResult {
  status: "pass" | "fail";
  bench: string;
  substrate: string;
  checked_metrics: string[];
  failures: BenchRegressionGateFailure[];
}

export async function openBenchAnalyticsDb(uri: string): Promise<BenchAnalyticsDb> {
  return connect(uri);
}

export function resolveBenchAnalyticsUri(raw: string, cwd = process.cwd()): string {
  if (/^[a-z]+:\/\//i.test(raw)) return raw;
  return `file://${resolve(cwd, raw)}`;
}

export async function writeBenchEvalAnalytics(
  report: EvalReport,
  opts: BenchAnalyticsWriteOptions,
): Promise<BenchAnalyticsWriteResult> {
  await ensureBenchAnalyticsSchema(opts.db);
  const runId = runIdFor("eval", report);
  const ts = nsFromIso(report.generated_at);
  let insertedRuns = 0;
  let insertedHistograms = 0;
  let insertedPercentiles = 0;

  const tierInputs = report.tiers.length > 0
    ? report.tiers.map((tier) => ({ strategy: tier.tier, substrates: tier.substrates }))
    : [{ strategy: null, substrates: report.substrates }];

  for (const tier of tierInputs) {
    for (const summary of tier.substrates) {
      for (const record of summary.records) {
        for (const metric of evalRecordMetrics(record)) {
          await insertRunMetric(opts.db, {
            ts,
            generated_at: report.generated_at,
            run_id: runId,
            bench: "eval",
            substrate: summary.substrate,
            category: record.category,
            op: null,
            strategy: tier.strategy,
            record_id: `${record.tier}:${record.question_id}`,
            metric: metric.name,
            value: metric.value,
            unit: metric.unit,
            sample_count: 1,
            raw: record,
          });
          insertedRuns += 1;
        }
      }

      for (const [category, records] of recordsByCategory(summary.records)) {
        const tokenSamples = records.map((record) => record.tokens.total);
        for (const bucket of histogramFromSamples(tokenSamples, TOKEN_BUCKETS)) {
          await insertHistogram(opts.db, {
            ts,
            run_id: runId,
            bench: "eval",
            substrate: summary.substrate,
            category,
            op: null,
            strategy: tier.strategy,
            metric: "tokens_total",
            bucket_le: bucket.le,
            count: bucket.count,
            sample_count: tokenSamples.length,
            unit: "tokens",
          });
          insertedHistograms += 1;
        }

        for (const p of [0.5, 0.95]) {
          await insertPercentile(opts.db, {
            ts,
            run_id: runId,
            bench: "eval",
            substrate: summary.substrate,
            category,
            op: null,
            strategy: tier.strategy,
            metric: "tokens_total",
            quantile: p,
            value: percentile(tokenSamples, p),
            sample_count: tokenSamples.length,
            unit: "tokens",
          });
          insertedPercentiles += 1;
        }
      }
    }
  }

  const insertedRegressions = await insertRegressionMetrics(opts.db, {
    ts,
    generated_at: report.generated_at,
    run_id: runId,
    bench: "eval",
    substrate: report.substrate,
    metrics: [
      { name: "exact_match", value: report.aggregate.exact_match, unit: "score" },
      { name: "f1", value: report.aggregate.f1, unit: "score" },
      { name: "abstention_score", value: report.aggregate.abstention_score, unit: "score" },
      { name: "precision_at_k", value: report.aggregate.precision_at_k, unit: "score" },
      { name: "recall_at_k", value: report.aggregate.recall_at_k, unit: "score" },
      { name: "ndcg_at_k", value: report.aggregate.ndcg_at_k, unit: "score" },
      { name: "quality_per_1k_tokens", value: report.aggregate.quality_per_1k_tokens, unit: "score_per_1k_tokens" },
      ...(report.aggregate.judge_j?.score !== null && report.aggregate.judge_j?.score !== undefined
        ? [{ name: "judge_j", value: report.aggregate.judge_j.score, unit: "score" }]
        : []),
    ],
    raw: {
      source: opts.source ?? "benchmark-memory bench eval",
      schema_version: report.schema_version,
      aggregate: report.aggregate,
      comparisons: report.comparisons,
    },
  });
  if (opts.registerAggregates !== false) await ensureBenchRegressionAggregates(opts.db);
  await refreshRegressionAggregate(opts.db, ts, report.generated_at);

  return {
    run_id: runId,
    inserted_runs: insertedRuns,
    inserted_histograms: insertedHistograms,
    inserted_percentiles: insertedPercentiles,
    inserted_regressions: insertedRegressions,
  };
}

export async function writeBenchLatencyAnalytics(
  report: LatencyReport,
  opts: BenchAnalyticsWriteOptions,
): Promise<BenchAnalyticsWriteResult> {
  await ensureBenchAnalyticsSchema(opts.db);
  const runId = runIdFor("latency", report);
  const ts = nsFromIso(report.generated_at);
  let insertedRuns = 0;
  let insertedHistograms = 0;
  let insertedPercentiles = 0;

  for (const result of report.results) {
    for (const strategy of ["ours", "ams_reference"] as const) {
      const stats = result[strategy];
      for (const metric of latencyStatsMetrics(stats)) {
        await insertRunMetric(opts.db, {
          ts,
          generated_at: report.generated_at,
          run_id: runId,
          bench: "latency",
          substrate: "reddb",
          category: null,
          op: result.op,
          strategy,
          record_id: `${result.op}:${strategy}`,
          metric: metric.name,
          value: metric.value,
          unit: "us",
          sample_count: stats.count,
          raw: { op: result.op, strategy, stats },
        });
        insertedRuns += 1;
      }

      for (const bucket of stats.histogram) {
        await insertHistogram(opts.db, {
          ts,
          run_id: runId,
          bench: "latency",
          substrate: "reddb",
          category: null,
          op: result.op,
          strategy,
          metric: "latency_us",
          bucket_le: String(bucket.le_us),
          count: bucket.count,
          sample_count: stats.count,
          unit: "us",
        });
        insertedHistograms += 1;
      }

      for (const [quantile, value] of [[0.5, stats.p50_us], [0.95, stats.p95_us]] as const) {
        await insertPercentile(opts.db, {
          ts,
          run_id: runId,
          bench: "latency",
          substrate: "reddb",
          category: null,
          op: result.op,
          strategy,
          metric: "latency_us",
          quantile,
          value,
          sample_count: stats.count,
          unit: "us",
        });
        insertedPercentiles += 1;
      }
    }
  }

  const insertedRegressions = await insertRegressionMetrics(opts.db, {
    ts,
    generated_at: report.generated_at,
    run_id: runId,
    bench: "latency",
    substrate: "reddb",
    metrics: latencyRegressionMetrics(report),
    raw: {
      source: opts.source ?? "benchmark-memory bench latency",
      schema_version: report.schema_version,
      workload: report.workload,
    },
  });
  if (opts.registerAggregates !== false) await ensureBenchRegressionAggregates(opts.db);
  await refreshRegressionAggregate(opts.db, ts, report.generated_at);

  return {
    run_id: runId,
    inserted_runs: insertedRuns,
    inserted_histograms: insertedHistograms,
    inserted_percentiles: insertedPercentiles,
    inserted_regressions: insertedRegressions,
  };
}

export async function ensureBenchAnalyticsSchema(db: BenchAnalyticsDb): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${BENCH_ANALYTICS_COLLECTIONS.histograms} (ts BIGINT, run_id TEXT, bench TEXT, substrate TEXT, category TEXT, op TEXT, run_strategy TEXT, metric_name TEXT, bucket_le TEXT, bucket_count BIGINT, sample_count BIGINT, unit TEXT)`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${BENCH_ANALYTICS_COLLECTIONS.percentiles} (ts BIGINT, run_id TEXT, bench TEXT, substrate TEXT, category TEXT, op TEXT, run_strategy TEXT, metric_name TEXT, quantile DOUBLE, metric_value DOUBLE, sample_count BIGINT, unit TEXT)`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${BENCH_ANALYTICS_COLLECTIONS.regression} (ts BIGINT, generated_at TEXT, run_id TEXT, bench TEXT, substrate TEXT, metric_name TEXT, metric_value DOUBLE, previous_value DOUBLE, delta DOUBLE, delta_pct DOUBLE, unit TEXT, raw JSON)`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${BENCH_ANALYTICS_COLLECTIONS.regressionAggregate} (ts BIGINT, bucket_ts BIGINT, bench TEXT, substrate TEXT, metric_name TEXT, avg_value DOUBLE, avg_delta DOUBLE, samples BIGINT, refreshed_at TEXT)`,
  );

  await ensureHypertable(db, BENCH_ANALYTICS_COLLECTIONS.runs);
}

export async function ensureBenchRegressionAggregates(db: BenchAnalyticsDb): Promise<void> {
  await ensureContinuousAggregate(db, BENCH_REGRESSION_AGGREGATES.value, "metric_value", "avg_value");
  await ensureContinuousAggregate(db, BENCH_REGRESSION_AGGREGATES.delta, "delta", "avg_delta");
}

export async function gateBenchEvalCoreRegression(opts: {
  db: BenchAnalyticsDb;
  substrate?: string;
  metrics?: string[];
  allowedNegativeDelta?: number;
}): Promise<BenchRegressionGateResult> {
  const bench = "eval";
  const substrate = opts.substrate ?? "reddb";
  const checkedMetrics = opts.metrics
    ?? ["exact_match", "f1", "abstention_score", "precision_at_k", "recall_at_k", "ndcg_at_k", "quality_per_1k_tokens"];
  const allowedDelta = opts.allowedNegativeDelta ?? 0;
  const result = await opts.db.query(
    `SELECT * FROM ${BENCH_ANALYTICS_COLLECTIONS.regression} WHERE bench = $1 AND substrate = $2 ORDER BY ts DESC`,
    [bench, substrate],
  );
  const latestByMetric = new Map<string, Record<string, unknown>>();
  for (const row of [...result.rows].sort((a, b) => (numberField(b.ts) ?? 0) - (numberField(a.ts) ?? 0))) {
    const metricName = stringValue(row.metric_name);
    if (!checkedMetrics.includes(metricName) || latestByMetric.has(metricName)) continue;
    latestByMetric.set(metricName, row);
  }

  const failures: BenchRegressionGateFailure[] = [];
  for (const metricName of checkedMetrics) {
    const row = latestByMetric.get(metricName);
    if (!row) continue;
    const delta = numberField(row.delta);
    if (delta === null || delta >= -allowedDelta) continue;
    failures.push({
      bench,
      substrate,
      metric_name: metricName,
      metric_value: numberField(row.metric_value) ?? 0,
      previous_value: numberField(row.previous_value),
      delta,
      delta_pct: numberField(row.delta_pct),
      allowed_delta: -allowedDelta,
    });
  }

  return {
    status: failures.length > 0 ? "fail" : "pass",
    bench,
    substrate,
    checked_metrics: checkedMetrics,
    failures,
  };
}

async function ensureHypertable(db: BenchAnalyticsDb, name: string): Promise<void> {
  const rows = await db.query("SELECT LIST_HYPERTABLES() AS names");
  if (readNameList(rows.rows[0]?.names).includes(name)) return;
  await db.execute(`CREATE HYPERTABLE ${name} TIME_COLUMN ts CHUNK_INTERVAL '1d' TTL '180d'`);
}

async function ensureContinuousAggregate(
  db: BenchAnalyticsDb,
  name: string,
  field: "metric_value" | "delta",
  alias: string,
): Promise<void> {
  const rows = await db.query("SELECT CA_LIST() AS names");
  if (readNameList(rows.rows[0]?.names).includes(name)) return;
  try {
    await db.query(
      `SELECT CA_REGISTER('${name}', '${BENCH_ANALYTICS_COLLECTIONS.regression}', '1d', '${alias}', 'avg', '${field}', '0s', '365d') AS ok`,
    );
  } catch {
    // Older embedded RedDB builds expose CA_REGISTER as an in-memory dogfood
    // primitive. The durable regression_1d table below remains the portable
    // query surface when native CA registration is unavailable.
  }
}

function readNameList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      const quoted = [...value.matchAll(/'([^']+)'/g)].map((match) => match[1]!).filter(Boolean);
      return quoted.length > 0 ? quoted : [value];
    }
  }
  return [];
}

async function insertRunMetric(db: BenchAnalyticsDb, row: {
  ts: TimestampNs;
  generated_at: string;
  run_id: string;
  bench: string;
  substrate: string;
  category: string | null;
  op: string | null;
  strategy: string | null;
  record_id: string;
  metric: string;
  value: number;
  unit: string;
  sample_count: number;
  raw: unknown;
}): Promise<void> {
  await db.query(
    `INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.runs} (ts, generated_at, run_id, bench, substrate, category, op, run_strategy, record_id, metric_name, metric_value, unit, sample_count, raw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.ts,
      row.generated_at,
      row.run_id,
      row.bench,
      row.substrate,
      row.category,
      row.op,
      row.strategy,
      row.record_id,
      row.metric,
      row.value,
      row.unit,
      row.sample_count,
      row.raw,
    ],
  );
}

async function insertHistogram(db: BenchAnalyticsDb, row: {
  ts: TimestampNs;
  run_id: string;
  bench: string;
  substrate: string;
  category: string | null;
  op: string | null;
  strategy: string | null;
  metric: string;
  bucket_le: string;
  count: number;
  sample_count: number;
  unit: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.histograms} (ts, run_id, bench, substrate, category, op, run_strategy, metric_name, bucket_le, bucket_count, sample_count, unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.ts,
      row.run_id,
      row.bench,
      row.substrate,
      row.category,
      row.op,
      row.strategy,
      row.metric,
      row.bucket_le,
      row.count,
      row.sample_count,
      row.unit,
    ],
  );
}

async function insertPercentile(db: BenchAnalyticsDb, row: {
  ts: TimestampNs;
  run_id: string;
  bench: string;
  substrate: string;
  category: string | null;
  op: string | null;
  strategy: string | null;
  metric: string;
  quantile: number;
  value: number;
  sample_count: number;
  unit: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.percentiles} (ts, run_id, bench, substrate, category, op, run_strategy, metric_name, quantile, metric_value, sample_count, unit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.ts,
      row.run_id,
      row.bench,
      row.substrate,
      row.category,
      row.op,
      row.strategy,
      row.metric,
      row.quantile,
      row.value,
      row.sample_count,
      row.unit,
    ],
  );
}

async function insertRegressionMetrics(db: BenchAnalyticsDb, row: {
  ts: TimestampNs;
  generated_at: string;
  run_id: string;
  bench: string;
  substrate: string;
  metrics: Array<{ name: string; value: number; unit: string }>;
  raw: unknown;
}): Promise<number> {
  let inserted = 0;
  for (const metric of row.metrics) {
    const previous = await previousRegressionValue(db, row.bench, row.substrate, metric.name);
    const delta = previous === null ? null : round6(metric.value - previous);
    const deltaPct = previous === null || previous === 0 ? null : round6(((metric.value - previous) / previous) * 100);
    await db.query(
      `INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.regression} (ts, generated_at, run_id, bench, substrate, metric_name, metric_value, previous_value, delta, delta_pct, unit, raw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        row.ts,
        row.generated_at,
        row.run_id,
        row.bench,
        row.substrate,
        metric.name,
        metric.value,
        previous,
        delta,
        deltaPct,
        metric.unit,
        row.raw,
      ],
    );
    inserted += 1;
  }
  return inserted;
}

async function previousRegressionValue(
  db: BenchAnalyticsDb,
  bench: string,
  substrate: string,
  metric: string,
): Promise<number | null> {
  const result = await db.query(
    `SELECT * FROM ${BENCH_ANALYTICS_COLLECTIONS.regression} WHERE bench = $1 AND substrate = $2 AND metric_name = $3 ORDER BY ts DESC LIMIT 1`,
    [bench, substrate, metric],
  );
  const raw = result.rows[0]?.metric_value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

async function refreshRegressionAggregate(db: BenchAnalyticsDb, ts: TimestampNs, refreshedAt: string): Promise<void> {
  const result = await db.query(`SELECT * FROM ${BENCH_ANALYTICS_COLLECTIONS.regression}`);
  const groups = new Map<string, {
    bucket_ts: number;
    bench: string;
    substrate: string;
    metric_name: string;
    values: number[];
    deltas: number[];
  }>();
  for (const row of result.rows) {
    const rowTs = numberField(row.ts);
    const metricValue = numberField(row.metric_value);
    if (rowTs === null || metricValue === null) continue;
    const bench = stringValue(row.bench);
    const substrate = stringValue(row.substrate);
    const metricName = stringValue(row.metric_name);
    const bucketTs = dayBucketNs(rowTs);
    const key = `${bucketTs}:${bench}:${substrate}:${metricName}`;
    const group = groups.get(key) ?? {
      bucket_ts: bucketTs,
      bench,
      substrate,
      metric_name: metricName,
      values: [],
      deltas: [],
    };
    group.values.push(metricValue);
    const delta = numberField(row.delta);
    if (delta !== null) group.deltas.push(delta);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    await db.query(
      `INSERT INTO ${BENCH_ANALYTICS_COLLECTIONS.regressionAggregate} (ts, bucket_ts, bench, substrate, metric_name, avg_value, avg_delta, samples, refreshed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ts,
        group.bucket_ts,
        group.bench,
        group.substrate,
        group.metric_name,
        average(group.values),
        group.deltas.length > 0 ? average(group.deltas) : null,
        group.values.length,
        refreshedAt,
      ],
    );
  }
}

function evalRecordMetrics(record: QuestionRecord): Array<{ name: string; value: number; unit: string }> {
  const metrics = [
    { name: "exact_match", value: record.exact_match, unit: "score" },
    { name: "f1", value: record.f1, unit: "score" },
    { name: "abstention_score", value: record.abstention_score, unit: "score" },
    { name: "precision_at_k", value: record.precision_at_k, unit: "score" },
    { name: "recall_at_k", value: record.recall_at_k, unit: "score" },
    { name: "ndcg_at_k", value: record.ndcg_at_k, unit: "score" },
    { name: "tokens_input", value: record.tokens.input, unit: "tokens" },
    { name: "tokens_output", value: record.tokens.output, unit: "tokens" },
    { name: "tokens_total", value: record.tokens.total, unit: "tokens" },
    { name: "quality_per_1k_tokens", value: record.quality_per_1k_tokens, unit: "score_per_1k_tokens" },
    { name: "tools_used", value: record.tools_used, unit: "count" },
    { name: "prompt_tokens", value: record.prompt_tokens, unit: "tokens" },
    { name: "reasoning_tokens", value: record.reasoning_tokens, unit: "tokens" },
    { name: "reasoning_prompt_ratio", value: record.reasoning_prompt_ratio, unit: "ratio" },
    { name: "time_to_response_ms", value: record.time_to_response_ms, unit: "ms" },
  ];
  if (record.judge_j) metrics.push({ name: "judge_j", value: record.judge_j.score, unit: "score" });
  return metrics;
}

function recordsByCategory(records: QuestionRecord[]): Map<string, QuestionRecord[]> {
  const out = new Map<string, QuestionRecord[]>();
  for (const record of records) {
    const bucket = out.get(record.category) ?? [];
    bucket.push(record);
    out.set(record.category, bucket);
  }
  return out;
}

function latencyStatsMetrics(stats: PercentileStats): Array<{ name: string; value: number }> {
  return [
    { name: "latency_min_us", value: stats.min_us },
    { name: "latency_p50_us", value: stats.p50_us },
    { name: "latency_p95_us", value: stats.p95_us },
    { name: "latency_p99_us", value: stats.p99_us },
    { name: "latency_p999_us", value: stats.p999_us },
    { name: "latency_max_us", value: stats.max_us },
    { name: "latency_mean_us", value: stats.mean_us },
  ];
}

function latencyRegressionMetrics(report: LatencyReport): Array<{ name: string; value: number; unit: string }> {
  return [
    { name: "avg_p50_speedup", value: average(report.results.map((r) => r.speedup.p50)), unit: "x" },
    { name: "avg_p95_speedup", value: average(report.results.map((r) => r.speedup.p95)), unit: "x" },
    { name: "avg_p95_delta_us", value: average(report.results.map((r) => r.delta.p95_us)), unit: "us" },
  ];
}

const TOKEN_BUCKETS = [64, 128, 256, 512, 1024, 2048, 4096];

function histogramFromSamples(samples: number[], buckets: number[]): Array<{ le: string; count: number }> {
  const sorted = [...samples].sort((a, b) => a - b);
  const out: Array<{ le: string; count: number }> = [];
  let cursor = 0;
  for (const bucket of buckets) {
    while (cursor < sorted.length && sorted[cursor]! <= bucket) cursor += 1;
    out.push({ le: String(bucket), count: cursor });
  }
  out.push({ le: "+Inf", count: sorted.length });
  return out;
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round6(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function dayBucketNs(ts: number): number {
  const dayNs = 86_400_000_000_000;
  return Math.floor(ts / dayNs) * dayNs;
}

function nsFromIso(iso: string): TimestampNs {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`invalid benchmark generated_at: ${iso}`);
  return Math.trunc(ms * 1_000_000);
}

function runIdFor(kind: string, report: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(report)).digest("hex").slice(0, 16);
  return `memory-bench:${kind}:${hash}`;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
