import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMOTION_BAR,
  computeDrainMetrics,
  evaluatePromotion,
  readDrainMetrics,
} from "../src/core/proof-by-drain.js";
import type { HistoryRecord } from "../src/core/history.js";

const HOUR = 3600;

function rec(partial: Partial<HistoryRecord> & Pick<HistoryRecord, "event" | "epoch">): HistoryRecord {
  return {
    ts: new Date(partial.epoch * 1000).toISOString(),
    worker: "w1",
    issue: 1,
    duration_s: 60,
    runner: "claude",
    ...partial,
  };
}

describe("computeDrainMetrics", () => {
  it("counts merges, terminal events, failure ratio and the observed window", () => {
    const base = 1_000_000 * HOUR;
    const records: HistoryRecord[] = [
      rec({ event: "done", epoch: base, merge_sha: "aaa" }),
      rec({ event: "done", epoch: base + HOUR, merge_sha: "bbb" }),
      rec({ event: "done", epoch: base + 2 * HOUR }), // done without merge_sha → not a merge
      rec({ event: "blocked", epoch: base + 3 * HOUR }),
      rec({ event: "exhausted", epoch: base + 4 * HOUR }),
    ];
    const m = computeDrainMetrics(records);
    expect(m.merges).toBe(2);
    expect(m.done).toBe(3);
    expect(m.blocked).toBe(1);
    expect(m.exhausted).toBe(1);
    expect(m.terminal).toBe(5);
    expect(m.failureRatio).toBeCloseTo(2 / 5);
    expect(m.windowHours).toBeCloseTo(4);
    expect(m.records).toBe(5);
  });

  it("filters records before sinceEpoch", () => {
    const base = 2_000_000 * HOUR;
    const records: HistoryRecord[] = [
      rec({ event: "done", epoch: base - HOUR, merge_sha: "old" }),
      rec({ event: "done", epoch: base + HOUR, merge_sha: "new" }),
    ];
    const m = computeDrainMetrics(records, base);
    expect(m.merges).toBe(1);
    expect(m.records).toBe(1);
  });

  it("reports a zero failure ratio for an empty ledger", () => {
    const m = computeDrainMetrics([]);
    expect(m.failureRatio).toBe(0);
    expect(m.terminal).toBe(0);
    expect(m.windowHours).toBe(0);
  });
});

describe("evaluatePromotion", () => {
  const base = 3_000_000 * HOUR;

  function manyMerges(n: number, spanHours: number): HistoryRecord[] {
    const out: HistoryRecord[] = [];
    for (let i = 0; i < n; i++) {
      const epoch = base + Math.floor((i * spanHours * HOUR) / Math.max(1, n - 1));
      out.push(rec({ event: "done", epoch, merge_sha: `sha${i}` }));
    }
    return out;
  }

  it("promotes when merges, window and failure ratio all clear the bar", () => {
    const metrics = computeDrainMetrics(manyMerges(DEFAULT_PROMOTION_BAR.minMerges, 30));
    const verdict = evaluatePromotion(metrics);
    expect(verdict.promotable).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("blocks promotion with too few merges and explains why", () => {
    const metrics = computeDrainMetrics(manyMerges(3, 30));
    const verdict = evaluatePromotion(metrics);
    expect(verdict.promotable).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/merges/i);
  });

  it("blocks promotion when the observed window is too short", () => {
    const metrics = computeDrainMetrics(manyMerges(DEFAULT_PROMOTION_BAR.minMerges, 1));
    const verdict = evaluatePromotion(metrics);
    expect(verdict.promotable).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/window/i);
  });

  it("blocks promotion when the failure ratio exceeds the ceiling", () => {
    const merges = manyMerges(DEFAULT_PROMOTION_BAR.minMerges, 30);
    const failures: HistoryRecord[] = [];
    for (let i = 0; i < DEFAULT_PROMOTION_BAR.minMerges; i++) {
      failures.push(rec({ event: "blocked", epoch: base + i * HOUR }));
    }
    const metrics = computeDrainMetrics([...merges, ...failures]);
    const verdict = evaluatePromotion(metrics);
    expect(verdict.promotable).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/failure/i);
  });
});

describe("readDrainMetrics", () => {
  it("reads and parses the ledger through injected IO", async () => {
    const base = 4_000_000 * HOUR;
    const lines = [
      JSON.stringify(rec({ event: "done", epoch: base, merge_sha: "x" })),
      "",
      JSON.stringify(rec({ event: "blocked", epoch: base + HOUR })),
    ].join("\n");
    const io = { read: async () => lines };
    const m = await readDrainMetrics("/ledger.jsonl", io);
    expect(m.merges).toBe(1);
    expect(m.blocked).toBe(1);
    expect(m.records).toBe(2);
  });

  it("returns empty metrics when the ledger is missing", async () => {
    const io = { read: async () => null };
    const m = await readDrainMetrics("/missing.jsonl", io);
    expect(m.records).toBe(0);
  });
});
