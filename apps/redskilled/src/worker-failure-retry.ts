import type { AcpAgentId } from "./acp-agent-catalog.js";

export type WorkerFailureRetryClass = "cap-hit" | "oom" | "network-drop" | "tool-error" | "unknown";

export type WorkerFailureRetryShape =
  | { readonly kind: "as-is" }
  | { readonly kind: "smaller-scope" }
  | { readonly kind: "different-model" };

export interface WorkerFailureRetrySpec {
  readonly class: WorkerFailureRetryClass;
  readonly shape: WorkerFailureRetryShape;
  /** Per-class bound; the global bound is enforced on top of this. */
  readonly maxRetries: number;
  readonly evidence: string;
}

export type WorkerFailureRetryDecision =
  | {
    readonly decision: "retry";
    readonly failureClass: WorkerFailureRetryClass;
    readonly retryNumber: number;
    readonly shape: WorkerFailureRetryShape;
    readonly evidence: string;
  }
  | {
    readonly decision: "park";
    readonly failureClass: WorkerFailureRetryClass;
    readonly retryNumber: number;
    readonly evidence: string;
  };

export const WORKER_FAILURE_GLOBAL_RETRY_BOUND = 2;

export const WORKER_FAILURE_RETRY_TABLE = [
  {
    class: "cap-hit",
    shape: { kind: "smaller-scope" },
    maxRetries: WORKER_FAILURE_GLOBAL_RETRY_BOUND,
    evidence: "resource cap hit; retry with a smaller task scope",
  },
  {
    class: "oom",
    shape: { kind: "smaller-scope" },
    maxRetries: WORKER_FAILURE_GLOBAL_RETRY_BOUND,
    evidence: "worker was killed by memory pressure; retry with a smaller task scope",
  },
  {
    class: "network-drop",
    shape: { kind: "as-is" },
    maxRetries: WORKER_FAILURE_GLOBAL_RETRY_BOUND,
    evidence: "transport dropped; retry the same turn unchanged",
  },
  {
    class: "tool-error",
    shape: { kind: "different-model" },
    maxRetries: WORKER_FAILURE_GLOBAL_RETRY_BOUND,
    evidence: "agent tool invocation failed; retry on a different model path",
  },
  {
    class: "unknown",
    shape: { kind: "as-is" },
    maxRetries: 1,
    evidence: "unclassified worker failure; retry once, then park with evidence",
  },
] as const satisfies readonly WorkerFailureRetrySpec[];

export const WORKER_FAILURE_RETRY_CLASSES = WORKER_FAILURE_RETRY_TABLE.map((row) => row.class);

const TABLE_BY_CLASS = new Map<WorkerFailureRetryClass, WorkerFailureRetrySpec>(
  WORKER_FAILURE_RETRY_TABLE.map((row) => [row.class, row]),
);

export function classifyWorkerFailure(error: unknown): WorkerFailureRetryClass {
  const text = failureText(error).toLowerCase();
  if (/\b(oom|out of memory|memorymax|memory max|memory budget|sigkill)\b/.test(text)) return "oom";
  if (/\b(cap hit|cap-hit|context cap|token cap|budget cap|wall-clock|wall clock|resource cap)\b/.test(text)) {
    return "cap-hit";
  }
  if (/\b(econnreset|econnrefused|etimedout|epipe|socket hang up|network|transport closed|connection lost)\b/.test(text)) {
    return "network-drop";
  }
  if (/\b(tool error|tool-call|tool call|tool invocation|method not found|requestpermission)\b/.test(text)) {
    return "tool-error";
  }
  return "unknown";
}

export function decideWorkerFailureRetry(input: {
  readonly failureClass: WorkerFailureRetryClass;
  /** Retries already consumed before this failure. */
  readonly retriesUsed: number;
}): WorkerFailureRetryDecision {
  const spec = TABLE_BY_CLASS.get(input.failureClass);
  if (spec == null) {
    return {
      decision: "park",
      failureClass: "unknown",
      retryNumber: input.retriesUsed + 1,
      evidence: `retry policy drift: no declared retry spec for ${input.failureClass}`,
    };
  }
  const retryNumber = input.retriesUsed + 1;
  const bounded = Math.min(spec.maxRetries, WORKER_FAILURE_GLOBAL_RETRY_BOUND);
  if (input.retriesUsed >= bounded) {
    return {
      decision: "park",
      failureClass: spec.class,
      retryNumber,
      evidence: `${spec.evidence}; retry bound exhausted (${input.retriesUsed}/${bounded})`,
    };
  }
  return {
    decision: "retry",
    failureClass: spec.class,
    retryNumber,
    shape: spec.shape,
    evidence: spec.evidence,
  };
}

export function retryRunnerForShape(
  declared: AcpAgentId | undefined,
  shape: WorkerFailureRetryShape | undefined,
): AcpAgentId | undefined {
  if (shape?.kind !== "different-model") return declared;
  if (declared == null || declared === "codex") return "redcode";
  return "codex";
}

function failureText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  return String(error);
}
