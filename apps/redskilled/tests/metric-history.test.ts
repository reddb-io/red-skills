import { describe, expect, it } from "vitest";
import {
  REDSKILLED_METRIC_CHECKPOINT_MS,
  shouldCheckpointMetricObservation,
} from "../src/daemon/metric-history.js";
import type { RedskilledWorkerMetricObservation } from "../src/live-metrics.js";

const first: RedskilledWorkerMetricObservation = {
  worker_id: "w1",
  observed_at: "2026-08-13T12:00:00.000Z",
  tokens: 100,
  tools: 2,
  runner: "codex",
  model: "gpt-5.6",
};

describe("durable metric checkpoint coalescing (#3802)", () => {
  it("preserves changed endpoints and bounds identical samples to one per five minutes", () => {
    expect(shouldCheckpointMetricObservation(undefined, first)).toBe(true);
    expect(shouldCheckpointMetricObservation(first, {
      ...first,
      observed_at: new Date(Date.parse(first.observed_at) + REDSKILLED_METRIC_CHECKPOINT_MS - 1).toISOString(),
    })).toBe(false);
    expect(shouldCheckpointMetricObservation(first, {
      ...first,
      observed_at: new Date(Date.parse(first.observed_at) + REDSKILLED_METRIC_CHECKPOINT_MS).toISOString(),
    })).toBe(true);
    expect(shouldCheckpointMetricObservation(first, {
      ...first,
      observed_at: "2026-08-13T12:01:00.000Z",
      tokens: 101,
    })).toBe(true);
  });
});
