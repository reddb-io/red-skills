import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TICKET_LOOP_FAILURE_RETRY_CLASSES,
  retryInstructionForFailureClass,
} from "./ticket-loop.js";
import {
  classifyWorkerFailure,
  decideWorkerFailureRetry,
  WORKER_FAILURE_GLOBAL_RETRY_LIMIT,
  WORKER_FAILURE_RETRY_CLASSES,
  WORKER_FAILURE_RETRY_TABLE,
  type WorkerFailureRetryClass,
  type WorkerFailureRetryShape,
} from "./retry-policy.js";

const RETRY_ROWS: Array<{
  clazz: WorkerFailureRetryClass;
  evidence: string;
  shape: WorkerFailureRetryShape;
  retries: number;
  instruction: RegExp;
}> = [
  {
    clazz: "cap-hit",
    evidence: "context limit exceeded",
    shape: "smaller-scope",
    retries: 2,
    instruction: /smaller scope/i,
  },
  {
    clazz: "oom",
    evidence: "JavaScript heap out of memory",
    shape: "smaller-scope",
    retries: 2,
    instruction: /working set/i,
  },
  {
    clazz: "network-drop",
    evidence: "ECONNRESET socket hang up",
    shape: "as-is",
    retries: 2,
    instruction: /as-is/i,
  },
  {
    clazz: "tool-error",
    evidence: "tool call failed with MCP error",
    shape: "different-model",
    retries: 2,
    instruction: /different model/i,
  },
  {
    clazz: "unknown",
    evidence: "child exited 17",
    shape: "as-is",
    retries: 1,
    instruction: /once as-is/i,
  },
];

describe("declared Worker failure retry table", () => {
  for (const row of RETRY_ROWS) {
    it(`${row.clazz} retries with ${row.shape}`, () => {
      expect(classifyWorkerFailure(new Error(row.evidence))).toBe(row.clazz);
      expect(WORKER_FAILURE_RETRY_TABLE[row.clazz]).toMatchObject({
        shape: row.shape,
        maxRetries: row.retries,
      });

      const decision = decideWorkerFailureRetry({
        failureClass: row.clazz,
        retriesUsed: 0,
        classRetriesUsed: 0,
        evidence: row.evidence,
      });

      expect(decision).toMatchObject({
        action: "retry",
        failureClass: row.clazz,
        shape: row.shape,
        retriesUsed: 1,
        classRetriesUsed: 1,
        evidence: row.evidence,
      });
      expect(decision.action === "retry" ? decision.instruction : "").toMatch(
        row.instruction,
      );
    });
  }

  it("parks instead of allowing a third retry under the global bound", () => {
    const decision = decideWorkerFailureRetry({
      failureClass: "network-drop",
      retriesUsed: WORKER_FAILURE_GLOBAL_RETRY_LIMIT,
      classRetriesUsed: 0,
      evidence: "ECONNRESET after two retries",
    });

    expect(decision).toEqual({
      action: "park",
      failureClass: "network-drop",
      reason: "global-bound",
      retriesUsed: 2,
      classRetriesUsed: 0,
      evidence: "ECONNRESET after two retries",
    });
  });

  it("parks unknown failures after their one declared retry", () => {
    expect(
      decideWorkerFailureRetry({
        failureClass: "unknown",
        retriesUsed: 1,
        classRetriesUsed: 1,
        evidence: "child exited 17 again",
      }),
    ).toMatchObject({ action: "park", reason: "class-bound" });
  });
});

describe("retry table to Ticket loop consumer ratchet", () => {
  it("the live consumer declares exactly the table's failure classes", () => {
    expect([...TICKET_LOOP_FAILURE_RETRY_CLASSES].sort()).toEqual(
      [...WORKER_FAILURE_RETRY_CLASSES].sort(),
    );
  });

  it("every consumed branch is backed by one declared table row", () => {
    const branches = retryConsumerBranches();
    expect(branches.sort()).toEqual([...WORKER_FAILURE_RETRY_CLASSES].sort());
    for (const clazz of WORKER_FAILURE_RETRY_CLASSES) {
      expect(retryInstructionForFailureClass(clazz)).toBe(
        WORKER_FAILURE_RETRY_TABLE[clazz].instruction,
      );
    }
  });
});

function retryConsumerBranches(): WorkerFailureRetryClass[] {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "ticket-loop.ts"),
    "utf8",
  );
  const match =
    /function ticketLoopRetryClass[\s\S]*?switch \(clazz\) \{(?<body>[\s\S]*?)\n\}/.exec(
      source,
    );
  if (match?.groups?.body == null)
    throw new Error("ticketLoopRetryClass switch not found");
  return [...match.groups.body.matchAll(/case "([^"]+)":/g)].map(
    (branch) => branch[1] as WorkerFailureRetryClass,
  );
}
