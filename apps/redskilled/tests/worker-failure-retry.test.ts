import { describe, expect, it } from "vitest";

import { WORKER_FAILURE_RETRY_CONSUMER_CLASSES } from "../src/acp-demand-turn.js";
import {
  classifyWorkerFailure,
  decideWorkerFailureRetry,
  retryRunnerForShape,
  WORKER_FAILURE_GLOBAL_RETRY_BOUND,
  WORKER_FAILURE_RETRY_CLASSES,
  WORKER_FAILURE_RETRY_TABLE,
  type WorkerFailureRetryClass,
} from "../src/worker-failure-retry.js";

describe("declared Worker failure retry table", () => {
  it("covers every declared failure class with the required retry shape", () => {
    expect(WORKER_FAILURE_RETRY_TABLE).toEqual([
      expect.objectContaining({ class: "cap-hit", shape: { kind: "smaller-scope" }, maxRetries: 2 }),
      expect.objectContaining({ class: "oom", shape: { kind: "smaller-scope" }, maxRetries: 2 }),
      expect.objectContaining({ class: "network-drop", shape: { kind: "as-is" }, maxRetries: 2 }),
      expect.objectContaining({ class: "tool-error", shape: { kind: "different-model" }, maxRetries: 2 }),
      expect.objectContaining({ class: "unknown", shape: { kind: "as-is" }, maxRetries: 1 }),
    ]);
    expect(WORKER_FAILURE_GLOBAL_RETRY_BOUND).toBe(2);
  });

  it("is consumed in both directions: no declared class lacks a branch and no branch lacks a class", () => {
    expect([...WORKER_FAILURE_RETRY_CONSUMER_CLASSES].sort()).toEqual([...WORKER_FAILURE_RETRY_CLASSES].sort());
  });

  it("decides each declared retry shape from the table", () => {
    const expected: Record<WorkerFailureRetryClass, string> = {
      "cap-hit": "smaller-scope",
      oom: "smaller-scope",
      "network-drop": "as-is",
      "tool-error": "different-model",
      unknown: "as-is",
    };
    for (const row of WORKER_FAILURE_RETRY_TABLE) {
      const decision = decideWorkerFailureRetry({ failureClass: row.class, retriesUsed: 0 });
      expect(decision).toMatchObject({
        decision: "retry",
        failureClass: row.class,
        retryNumber: 1,
        shape: { kind: expected[row.class] },
      });
    }
  });

  it("proves a third retry never happens under the global two-retry bound", () => {
    expect(decideWorkerFailureRetry({ failureClass: "network-drop", retriesUsed: 0 }).decision).toBe("retry");
    expect(decideWorkerFailureRetry({ failureClass: "network-drop", retriesUsed: 1 }).decision).toBe("retry");
    expect(decideWorkerFailureRetry({ failureClass: "network-drop", retriesUsed: 2 })).toMatchObject({
      decision: "park",
      failureClass: "network-drop",
      retryNumber: 3,
    });
  });

  it("keeps unknown failures to one retry even though the global bound is two", () => {
    expect(decideWorkerFailureRetry({ failureClass: "unknown", retriesUsed: 0 }).decision).toBe("retry");
    expect(decideWorkerFailureRetry({ failureClass: "unknown", retriesUsed: 1 })).toMatchObject({
      decision: "park",
      failureClass: "unknown",
      retryNumber: 2,
    });
  });
});

describe("Worker failure classification", () => {
  it("recognizes every declared class from ordinary failure text", () => {
    expect(classifyWorkerFailure(new Error("context cap hit"))).toBe("cap-hit");
    expect(classifyWorkerFailure(new Error("OOM: out of memory"))).toBe("oom");
    expect(classifyWorkerFailure(new Error("ECONNRESET socket hang up"))).toBe("network-drop");
    expect(classifyWorkerFailure(new Error("tool invocation failed"))).toBe("tool-error");
    expect(classifyWorkerFailure(new Error("mystery"))).toBe("unknown");
  });

  it("tool-error retries on a different model path", () => {
    expect(retryRunnerForShape("codex", { kind: "different-model" })).toBe("redcode");
    expect(retryRunnerForShape("redcode", { kind: "different-model" })).toBe("codex");
    expect(retryRunnerForShape("codex", { kind: "as-is" })).toBe("codex");
  });
});
