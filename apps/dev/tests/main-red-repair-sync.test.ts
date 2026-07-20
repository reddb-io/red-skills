import { describe, expect, it } from "vitest";
import { renderMainRedRepairBody, type MainRedRepairIssue } from "../src/core/main-red-repair.js";
import { syncMainRedRepairIssue } from "../src/core/process-issue/recovery.js";
import type { ProcessIssueDeps } from "../src/core/process-issue.js";
import type { RunFeedbackResult } from "../src/core/feedback.js";

function feedback(failures: RunFeedbackResult["baselineFailureEvidence"]): RunFeedbackResult {
  return { baselineProbeRan: true, baselineFailureEvidence: failures } as RunFeedbackResult;
}

function repair(number: number, check: string): MainRedRepairIssue {
  return {
    number,
    body: renderMainRedRepairBody({
      sha: `sha-${number}`,
      failures: [{ check, summary: "failed", outputTail: "tail" }],
    }),
  };
}

describe("syncMainRedRepairIssue", () => {
  it("closes every marked repair issue when the baseline becomes green", async () => {
    const closed: number[] = [];
    const issues = [repair(20, "test:apps/dev"), repair(21, "lint:apps/dev")];
    const deps = {
      appendIterLog() {},
      gh: {
        listMainRedRepairIssues: async () => issues,
        findMainRedRepairIssue: async () => issues[0] ?? null,
        createMainRedRepairIssue: async () => 99,
        closeMainRedRepairIssue: async (issue: number) => { closed.push(issue); },
      },
    } as unknown as ProcessIssueDeps;

    await syncMainRedRepairIssue(deps, feedback([]), "green-sha");

    expect(closed).toEqual([20, 21]);
  });

  it("reconciles a concurrent create to the lowest-numbered canonical issue", async () => {
    const closed: number[] = [];
    const comments: number[] = [];
    const matching = [repair(41, "test:apps/dev"), repair(42, "test:apps/dev")];
    let listCalls = 0;
    const deps = {
      appendIterLog() {},
      gh: {
        listMainRedRepairIssues: async () => (++listCalls === 1 ? [] : matching),
        findMainRedRepairIssue: async () => null,
        createMainRedRepairIssue: async () => 42,
        closeMainRedRepairIssue: async (issue: number) => { closed.push(issue); },
        comment: async (issue: number) => { comments.push(issue); },
      },
    } as unknown as ProcessIssueDeps;

    await syncMainRedRepairIssue(
      deps,
      feedback([{ check: "test:apps/dev", summary: "new failure", outputTail: "new tail" }]),
      "new-sha",
    );

    expect(comments).toEqual([41]);
    expect(closed).toEqual([42]);
  });
});
