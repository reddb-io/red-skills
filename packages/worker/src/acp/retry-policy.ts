/** Worker failure retry policy, declared once and consumed by the Ticket loop. */

export const WORKER_FAILURE_RETRY_CLASSES = [
  "cap-hit",
  "oom",
  "network-drop",
  "tool-error",
  "unknown",
] as const;

export type WorkerFailureRetryClass =
  (typeof WORKER_FAILURE_RETRY_CLASSES)[number];

export type WorkerFailureRetryShape =
  "smaller-scope" | "as-is" | "different-model";

export interface WorkerFailureRetryRule {
  readonly shape: WorkerFailureRetryShape;
  /** Per-class retry ceiling. The global ceiling still applies first. */
  readonly maxRetries: number;
  readonly instruction: string;
}

export const WORKER_FAILURE_GLOBAL_RETRY_LIMIT = 2;

export const WORKER_FAILURE_RETRY_TABLE = {
  "cap-hit": {
    shape: "smaller-scope",
    maxRetries: 2,
    instruction:
      "Retry with smaller scope: narrow the implementation to the smallest independently shippable slice.",
  },
  oom: {
    shape: "smaller-scope",
    maxRetries: 2,
    instruction:
      "Retry with smaller scope: reduce the working set and avoid broad scans before continuing.",
  },
  "network-drop": {
    shape: "as-is",
    maxRetries: 2,
    instruction:
      "Retry as-is: the failure was a transient network drop, so keep the same scope.",
  },
  "tool-error": {
    shape: "different-model",
    maxRetries: 2,
    instruction:
      "Retry on a different model: keep the task scope, but route the next implementation round away from the failed tool/model.",
  },
  unknown: {
    shape: "as-is",
    maxRetries: 1,
    instruction:
      "Retry once as-is: the failure mode was unknown, so do not loop without new evidence.",
  },
} as const satisfies Record<WorkerFailureRetryClass, WorkerFailureRetryRule>;

export interface WorkerFailureRetryInput {
  readonly failureClass: WorkerFailureRetryClass;
  /** How many retries have already been spent across all failure classes. */
  readonly retriesUsed: number;
  /** How many retries have already been spent for this class. */
  readonly classRetriesUsed: number;
  readonly evidence: string;
}

export type WorkerFailureRetryDecision =
  | {
      readonly action: "retry";
      readonly failureClass: WorkerFailureRetryClass;
      readonly shape: WorkerFailureRetryShape;
      readonly retriesUsed: number;
      readonly classRetriesUsed: number;
      readonly instruction: string;
      readonly evidence: string;
    }
  | {
      readonly action: "park";
      readonly failureClass: WorkerFailureRetryClass;
      readonly reason: "global-bound" | "class-bound";
      readonly retriesUsed: number;
      readonly classRetriesUsed: number;
      readonly evidence: string;
    };

export function decideWorkerFailureRetry(
  input: WorkerFailureRetryInput,
): WorkerFailureRetryDecision {
  const rule = WORKER_FAILURE_RETRY_TABLE[input.failureClass];
  if (input.retriesUsed >= WORKER_FAILURE_GLOBAL_RETRY_LIMIT) {
    return {
      action: "park",
      failureClass: input.failureClass,
      reason: "global-bound",
      retriesUsed: input.retriesUsed,
      classRetriesUsed: input.classRetriesUsed,
      evidence: input.evidence,
    };
  }
  if (input.classRetriesUsed >= rule.maxRetries) {
    return {
      action: "park",
      failureClass: input.failureClass,
      reason: "class-bound",
      retriesUsed: input.retriesUsed,
      classRetriesUsed: input.classRetriesUsed,
      evidence: input.evidence,
    };
  }
  return {
    action: "retry",
    failureClass: input.failureClass,
    shape: rule.shape,
    retriesUsed: input.retriesUsed + 1,
    classRetriesUsed: input.classRetriesUsed + 1,
    instruction: rule.instruction,
    evidence: input.evidence,
  };
}

export function classifyWorkerFailure(error: unknown): WorkerFailureRetryClass {
  const text =
    error instanceof Error
      ? `${error.name}\n${error.message}\n${error.stack ?? ""}`
      : String(error);
  if (
    /\b(?:context|token|usage|budget|time|wall[- ]?clock)\s*(?:limit|cap|capped|exceeded)\b/i.test(
      text,
    )
  ) {
    return "cap-hit";
  }
  if (
    /\b(?:oom|out of memory|heap out of memory|memory budget|memorymax|systemd-oomd)\b/i.test(
      text,
    )
  ) {
    return "oom";
  }
  if (
    /\b(?:econnreset|econnrefused|etimedout|socket hang up|network|websocket|502|503|504)\b/i.test(
      text,
    )
  ) {
    return "network-drop";
  }
  if (
    /\b(?:tool error|tool_call|tool call|mcp|rate_limit_error|429|overloaded|529)\b/i.test(
      text,
    )
  ) {
    return "tool-error";
  }
  return "unknown";
}
