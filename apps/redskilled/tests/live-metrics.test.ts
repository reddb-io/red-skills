// The daemon derives its live metrics from what it already holds. Every case
// here poses a sequence of observations and outcomes against an injected clock,
// so the arithmetic is checked without a machine, a socket or a sampler.
import { describe, expect, it } from "vitest";
import {
  deriveRedskilledLiveMetrics,
  pruneRedskilledMetricHistory,
  REDSKILLED_METRIC_DAY_MS,
  REDSKILLED_METRIC_HOUR_MS,
  type RedskilledWorkerMetricObservation,
  type RedskilledWorkerOutcomeMark,
} from "../src/live-metrics.js";

const NOW = "2026-08-02T12:00:00.000Z";

/** `NOW` minus `minutes`, as an ISO instant. */
function ago(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

function observation(
  overrides: Partial<RedskilledWorkerMetricObservation> & Pick<RedskilledWorkerMetricObservation, "observed_at">,
): RedskilledWorkerMetricObservation {
  return {
    worker_id: "wAAAA",
    tokens: null,
    tools: null,
    runner: null,
    model: null,
    ...overrides,
  };
}

function outcome(ts: string, worker_id = "wAAAA"): RedskilledWorkerOutcomeMark {
  return { worker_id, ts, outcome: "worker-death" };
}

describe("live metrics over rolling windows", () => {
  it("derives tokens/min and tools/min from the deltas of the vitals it holds", () => {
    const metrics = deriveRedskilledLiveMetrics({
      now: NOW,
      observations: [
        observation({ observed_at: ago(10), tokens: 1_000, tools: 4 }),
        observation({ observed_at: ago(5), tokens: 2_500, tools: 9 }),
        observation({ observed_at: ago(0), tokens: 4_000, tools: 14 }),
      ],
      outcomes: [],
    });

    // 3000 tokens and 10 tools across the 10 minutes the samples span.
    expect(metrics.hour.tokens_per_min.value).toBe(300);
    expect(metrics.hour.tools_per_min.value).toBe(1);
    expect(metrics.hour.tokens_per_min.absent_reason).toBeNull();
    expect(metrics.hour.tokens_per_min.samples).toBe(3);
  });

  it("sums each Worker's own deltas and spans them over the union of their samples", () => {
    const metrics = deriveRedskilledLiveMetrics({
      now: NOW,
      observations: [
        observation({ worker_id: "wAAAA", observed_at: ago(20), tokens: 0 }),
        observation({ worker_id: "wBBBB", observed_at: ago(15), tokens: 500 }),
        observation({ worker_id: "wAAAA", observed_at: ago(10), tokens: 1_000 }),
        observation({ worker_id: "wBBBB", observed_at: ago(10), tokens: 1_000 }),
      ],
      // Two Workers, 1000 + 500 tokens, over the 10 minutes their samples span.
      outcomes: [],
    });

    expect(metrics.hour.tokens_per_min.value).toBe(150);
  });

  it("counts a counter that restarted as its own climb, never as a negative", () => {
    const metrics = deriveRedskilledLiveMetrics({
      now: NOW,
      observations: [
        observation({ observed_at: ago(10), tokens: 900 }),
        // A Worker whose project restarted its count: the drop is not -800 spent.
        observation({ observed_at: ago(5), tokens: 100 }),
        observation({ observed_at: ago(0), tokens: 400 }),
      ],
      outcomes: [],
    });

    expect(metrics.hour.tokens_per_min.value).toBe(30);
  });

  it("derives issues per hour from the outcome events in each window", () => {
    const metrics = deriveRedskilledLiveMetrics({
      now: NOW,
      observations: [],
      outcomes: [
        outcome(ago(10)),
        outcome(ago(40)),
        outcome(ago(90)),
        outcome(ago(600)),
      ],
    });

    expect(metrics.hour.issues_per_hour.value).toBe(2);
    expect(metrics.hour.issues_per_hour.samples).toBe(2);
    // Four outcomes across the 24-hour window.
    expect(metrics.day.issues_per_hour.value).toBeCloseTo(4 / 24, 10);
  });

  it("reports usage share by runner and by model, per window", () => {
    const metrics = deriveRedskilledLiveMetrics({
      now: NOW,
      observations: [
        observation({ worker_id: "wAAAA", observed_at: ago(5), runner: "claude", model: "opus" }),
        observation({ worker_id: "wBBBB", observed_at: ago(5), runner: "claude", model: "sonnet" }),
        observation({ worker_id: "wCCCC", observed_at: ago(5), runner: "codex", model: "sonnet" }),
        // Observed but never attributed: it is not a share, and not invisible.
        observation({ worker_id: "wDDDD", observed_at: ago(5) }),
        // Outside the hour, inside the day.
        observation({ worker_id: "wEEEE", observed_at: ago(200), runner: "opencode", model: "opus" }),
      ],
      outcomes: [],
    });

    expect(metrics.hour.runner_share.shares).toEqual([
      { key: "claude", worker_count: 2, share: 2 / 3 },
      { key: "codex", worker_count: 1, share: 1 / 3 },
    ]);
    expect(metrics.hour.runner_share.attributed_workers).toBe(3);
    expect(metrics.hour.runner_share.unattributed_workers).toBe(1);
    expect(metrics.hour.model_share.shares.map((share) => share.key)).toEqual(["sonnet", "opus"]);
    expect(metrics.day.runner_share.shares.map((share) => share.key)).toEqual(["claude", "codex", "opencode"]);
  });

  it("takes each Worker's newest attribution, counting the Worker once", () => {
    const metrics = deriveRedskilledLiveMetrics({
      now: NOW,
      observations: [
        observation({ worker_id: "wAAAA", observed_at: ago(30), runner: "codex" }),
        observation({ worker_id: "wAAAA", observed_at: ago(5), runner: "claude" }),
      ],
      outcomes: [],
    });

    expect(metrics.hour.runner_share.shares).toEqual([{ key: "claude", worker_count: 1, share: 1 }]);
  });

  it("reports an empty window as absence, never as zero", () => {
    const metrics = deriveRedskilledLiveMetrics({ now: NOW, observations: [], outcomes: [] });

    for (const metric of [
      metrics.hour.tokens_per_min,
      metrics.hour.tools_per_min,
      metrics.hour.issues_per_hour,
      metrics.day.tokens_per_min,
      metrics.day.tools_per_min,
      metrics.day.issues_per_hour,
    ]) {
      expect(metric.value).toBeNull();
      expect(metric.samples).toBe(0);
      expect(metric.absent_reason).toBeTruthy();
    }
    expect(metrics.hour.runner_share.shares).toEqual([]);
    expect(metrics.hour.runner_share.absent_reason).toBeTruthy();
    expect(metrics.hour.unavailable).toContain("worker-vitals");
    expect(metrics.hour.unavailable).toContain("worker-outcomes");
  });

  it("names the source a metric is missing, rather than reporting a bare absence", () => {
    const metrics = deriveRedskilledLiveMetrics({
      now: NOW,
      observations: [
        // Vitals arrived; a tokens count never did.
        observation({ observed_at: ago(10), tools: 2, runner: "claude" }),
        observation({ observed_at: ago(5), tools: 7, runner: "claude" }),
      ],
      outcomes: [outcome(ago(20))],
    });

    expect(metrics.hour.tools_per_min.value).toBe(1);
    expect(metrics.hour.tokens_per_min.value).toBeNull();
    expect(metrics.hour.tokens_per_min.absent_reason).toContain("tokens");
    expect(metrics.hour.unavailable).toEqual(["worker-vitals.tokens"]);
  });

  it("holds a single sample as absence: one instant spans no window", () => {
    const metrics = deriveRedskilledLiveMetrics({
      now: NOW,
      observations: [observation({ observed_at: ago(5), tokens: 1_000, tools: 3 })],
      outcomes: [],
    });

    expect(metrics.hour.tokens_per_min.value).toBeNull();
    expect(metrics.hour.tokens_per_min.absent_reason).toContain("one sample");
    // The Worker was seen, so its share is real even though no rate is.
    expect(metrics.hour.tokens_per_min.samples).toBe(1);
  });

  it("dates each window and states the span it covers", () => {
    const metrics = deriveRedskilledLiveMetrics({ now: NOW, observations: [], outcomes: [] });

    expect(metrics.generated_at).toBe(NOW);
    expect(metrics.hour.window).toBe("hour");
    expect(metrics.hour.window_ms).toBe(REDSKILLED_METRIC_HOUR_MS);
    expect(metrics.hour.to).toBe(NOW);
    expect(metrics.hour.from).toBe(ago(60));
    expect(metrics.day.window_ms).toBe(REDSKILLED_METRIC_DAY_MS);
    expect(metrics.day.from).toBe(ago(24 * 60));
  });

  it("drops everything older than the widest window it will ever answer for", () => {
    const kept = pruneRedskilledMetricHistory(
      [
        observation({ observed_at: ago(25 * 60) }),
        observation({ observed_at: ago(23 * 60) }),
        observation({ observed_at: ago(1) }),
      ],
      (entry) => entry.observed_at,
      { now: NOW },
    );

    expect(kept.map((entry) => entry.observed_at)).toEqual([ago(23 * 60), ago(1)]);
  });

  it("keeps the newest entries when a burst outruns the retention limit", () => {
    const entries = Array.from({ length: 10 }, (_unused, index) => observation({ observed_at: ago(10 - index) }));
    const kept = pruneRedskilledMetricHistory(entries, (entry) => entry.observed_at, { now: NOW, limit: 4 });

    expect(kept.map((entry) => entry.observed_at)).toEqual([ago(4), ago(3), ago(2), ago(1)]);
  });
});
