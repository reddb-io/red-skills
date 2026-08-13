import type { AgentStreamEvent } from "../AgentStreamEmitter.js";
import type { CastleLaneWriter } from "./lane-writers.js";
import {
  evaluateSpin,
  SPIN_THRESHOLDS,
  type NormalizedRunnerStreamEvent,
  type SpinPattern,
  type SpinVerdict,
} from "./spin-evaluator.js";

export interface SpinStreamProcessorOptions {
  readonly workerLog: Pick<CastleLaneWriter, "append">;
  readonly steer?: (message: string) => void | Promise<void>;
}

export interface SpinStreamProcessor {
  observe(event: AgentStreamEvent): Promise<SpinVerdict | null>;
}

const MAX_SPIN_WINDOW = Math.max(
  SPIN_THRESHOLDS.monologueMessages,
  SPIN_THRESHOLDS.repeatedActionObservationPairs * 2,
  SPIN_THRESHOLDS.errorStreakPairs * 2,
  SPIN_THRESHOLDS.alternatingPingPongCycles * 4,
);

function normalizeSpinEvent(
  event: AgentStreamEvent,
): NormalizedRunnerStreamEvent | null {
  if (event.type === "text") {
    return { kind: "message", content: event.message };
  }
  return null;
}

export function renderSpinSteer(pattern: SpinPattern): string {
  return `Spin detected: ${pattern}. Break this pattern and take a materially different approach.`;
}

export function createSpinStreamProcessor(
  options: SpinStreamProcessorOptions,
): SpinStreamProcessor {
  const events: NormalizedRunnerStreamEvent[] = [];
  let lastReportedPattern: SpinPattern | undefined;

  return {
    async observe(event) {
      const normalized = normalizeSpinEvent(event);
      if (!normalized) return null;
      events.push(normalized);
      if (events.length > MAX_SPIN_WINDOW) events.shift();

      const verdict = evaluateSpin(events);
      if (!verdict || verdict.pattern === lastReportedPattern) return verdict;
      lastReportedPattern = verdict.pattern;

      await options.workerLog.append({
        kind: "worker.spin",
        payload: { pattern: verdict.pattern },
      });
      await options.steer?.(renderSpinSteer(verdict.pattern));
      return verdict;
    },
  };
}
