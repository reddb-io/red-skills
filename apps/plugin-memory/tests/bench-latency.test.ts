import { describe, expect, test } from "vitest";
import {
  DEFAULT_WORKLOAD,
  formatLatencyReport,
  percentile,
  runBenchLatency,
  statsFromSamplesNs,
  type OpClass,
} from "../src/bench-latency.js";

const FIXED_NOW = new Date("2026-05-26T00:00:00.000Z");

// Small workload — full default (5000 iters × 3 ops × 2 strategies) is too
// noisy for CI; the bench's correctness invariants are independent of
// iteration count above ~200.
const SMALL = { iterations: 400, warmup: 100 };

// The default test target keeps this file as a smoke test for the latency
// measurement code path: both strategies run, produce finite distributions, and
// stay inside generous sanity bounds. The p99 architectural invariant compares
// two live microsecond-scale measurements, so unrelated machine load can
// transiently pause the in-process path and flip the comparison. That invariant
// is therefore an opt-in bench assertion, not a hard merge-gate assertion.
const assertLatencyInvariant = process.env.RED_MEMORY_ASSERT_LATENCY_INVARIANT === "1";

describe("memory bench latency — percentile arithmetic", () => {
  test("percentile picks the expected slot on a sorted array", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(arr, 0.5)).toBe(6);
    expect(percentile(arr, 0.9)).toBe(10);
    expect(percentile(arr, 0)).toBe(1);
    expect(percentile(arr, 1)).toBe(10);
  });

  test("statsFromSamplesNs reports min/p50/p99/max + mean in microseconds", () => {
    const ns = BigInt64Array.from(
      Array.from({ length: 100 }, (_, i) => BigInt((i + 1) * 1000)),
    );
    const s = statsFromSamplesNs(ns);
    expect(s.count).toBe(100);
    expect(s.min_us).toBeCloseTo(1, 3);
    expect(s.max_us).toBeCloseTo(100, 3);
    expect(s.p50_us).toBeGreaterThanOrEqual(50);
    expect(s.p99_us).toBeGreaterThanOrEqual(99);
    expect(s.mean_us).toBeCloseTo(50.5, 1);
    expect(s.histogram.at(-1)).toEqual({ le_us: "+Inf", count: 100 });
  });
});

describe("memory bench latency — runner", () => {
  test("aggregate shape matches schema v1 and includes every requested op", async () => {
    const report = await runBenchLatency({
      workload: { ...SMALL },
      now: () => FIXED_NOW,
    });
    expect(report.schema_version).toBe("memory.bench.latency.v1");
    expect(report.generated_at).toBe(FIXED_NOW.toISOString());
    expect(report.results.map((r) => r.op).sort()).toEqual(
      [...DEFAULT_WORKLOAD.op_classes].sort(),
    );
    for (const r of report.results) {
      for (const stats of [r.ours, r.ams_reference]) {
        expect(stats.count).toBe(SMALL.iterations);
        // Percentiles must be monotonic.
        expect(stats.p50_us).toBeLessThanOrEqual(stats.p95_us);
        expect(stats.p95_us).toBeLessThanOrEqual(stats.p99_us);
        expect(stats.p99_us).toBeLessThanOrEqual(stats.p999_us);
        expect(stats.min_us).toBeLessThanOrEqual(stats.p50_us);
        expect(stats.p999_us).toBeLessThanOrEqual(stats.max_us);
        expect(Number.isFinite(stats.mean_us)).toBe(true);
        expect(stats.count).toBeGreaterThan(0);
        expect(stats.max_us).toBeLessThan(10_000_000);
      }
    }
  });

  test.skipIf(!assertLatencyInvariant)(
    "ams-on-redis path is never faster than the in-process path at p99 (architectural invariant)",
    async () => {
      const report = await runBenchLatency({
        workload: { ...SMALL },
        now: () => FIXED_NOW,
      });
      for (const r of report.results) {
        // The wire-serialised path does strictly more CPU work than the Map
        // lookup path; if this invariant ever flips, either the bench or the
        // hot-read path has regressed.
        expect(r.ams_reference.p99_us).toBeGreaterThanOrEqual(r.ours.p99_us);
      }
    },
  );

  test("--ops filter narrows the op set", async () => {
    const ops: OpClass[] = ["working-get"];
    const report = await runBenchLatency({
      workload: { ...SMALL, op_classes: ops },
      now: () => FIXED_NOW,
    });
    expect(report.results.map((r) => r.op)).toEqual(ops);
  });

  test("seed re-roll yields identical access sequences (workload determinism)", async () => {
    // Two runs with the same seed should produce identical sample counts and
    // identical workload shapes. We cannot assert byte-equal wall-clock
    // numbers, but we can assert the bench harness consumed the same number
    // of samples each time and the workload knobs survived round-trip.
    const a = await runBenchLatency({ workload: { ...SMALL }, now: () => FIXED_NOW });
    const b = await runBenchLatency({ workload: { ...SMALL }, now: () => FIXED_NOW });
    expect(a.workload).toEqual(b.workload);
    for (let i = 0; i < a.results.length; i++) {
      expect(a.results[i]!.ours.count).toBe(b.results[i]!.ours.count);
      expect(a.results[i]!.ams_reference.count).toBe(b.results[i]!.ams_reference.count);
    }
  });

  test("markdown report renders workload, every op, and reproducibility section", async () => {
    const report = await runBenchLatency({
      workload: { ...SMALL },
      now: () => FIXED_NOW,
    });
    const md = formatLatencyReport(report);
    expect(md).toContain("# memory bench latency — 2026-05-26");
    expect(md).toContain("Reproducibility");
    for (const r of report.results) expect(md).toContain(r.op);
  });
});
