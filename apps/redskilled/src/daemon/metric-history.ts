/** Durable metric-history projections used by the daemon lifecycle. */
import type {
  RecordWorkerEventInput,
  RedskilledHostEvent,
} from "../event-lane.js";
import type { RedskilledWorkerView } from "../host-state.js";
import {
  pruneRedskilledMetricHistory,
  type RedskilledWorkerMetricObservation,
} from "../live-metrics.js";
import type { RedskilledWorkerDisplayRecord } from "../worker-display.js";

export interface AppendedRedskilledMetricObservation {
  readonly observations: RedskilledWorkerMetricObservation[];
  readonly record: RecordWorkerEventInput;
}

/** Project one published display into both the live history and durable event input. PURE. */
export function appendRedskilledMetricObservation(
  history: readonly RedskilledWorkerMetricObservation[],
  published: RedskilledWorkerDisplayRecord,
  worker: RedskilledWorkerView,
  now: string,
): AppendedRedskilledMetricObservation {
  const observation: RedskilledWorkerMetricObservation = {
    worker_id: worker.worker_id,
    observed_at: published.published_at,
    tokens: published.display.tokens,
    tools: published.display.tools,
    runner: published.display.runner,
    model: published.display.model,
  };
  return {
    observations: pruneRedskilledMetricHistory(
      [...history, observation],
      (entry) => entry.observed_at,
      { now },
    ),
    record: {
      kind: "worker-metrics",
      worker,
      ts: observation.observed_at,
      tokens: observation.tokens,
      tools: observation.tools,
      runner: observation.runner,
      model: observation.model,
    },
  };
}

/** Restore metric observations from the canonical host event lane. PURE. */
export function replayRedskilledMetricObservations(
  events: readonly RedskilledHostEvent[],
  now: string,
): RedskilledWorkerMetricObservation[] {
  return pruneRedskilledMetricHistory(
    events
      .filter((event) => event.kind === "worker-metrics")
      .map((event) => ({
        worker_id: event.worker_id,
        observed_at: event.ts,
        tokens: event.tokens ?? null,
        tools: event.tools ?? null,
        runner: event.runner ?? null,
        model: event.model ?? null,
      })),
    (observation) => observation.observed_at,
    { now },
  );
}
