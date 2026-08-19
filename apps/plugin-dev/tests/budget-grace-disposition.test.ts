import { describe, expect, it } from "vitest";
import { extractPendingHitlDecision } from "../src/core/hitl-decision-extraction.js";
import { formatCurrentBlocker, upsertCurrentBlocker } from "../src/core/blocker-state.js";
import { blockerForFailure } from "../src/core/process-issue/terminal.js";
import { isRequeueComplete, planRequeue } from "../src/core/requeue.js";

describe("Budget grace disposition", () => {
  it("records the extension decision and clears it through the ordinary human requeue door", () => {
    const blocker = blockerForFailure("budget-exceeded", {
      log: "Worker checkpointed recoverable local work before its Budget grace expired.",
    });
    expect(blocker).toMatchObject({ status: "blocked", kind: "budget" });
    const body = upsertCurrentBlocker("## Summary\nContinue bounded work.", blocker!);

    expect(extractPendingHitlDecision({ number: 3842, title: "Budget grace", body, comments: [] })).toMatchObject({
      kind: "pending-decision",
      source: "current-blocker",
      prompt: expect.stringContaining("larger budget"),
    });
    expect(isRequeueComplete(body, ["ready-for-agent"])).toBe(false);

    const requeue = planRequeue({
      authority: "human",
      body,
      labels: ["ready-for-human", "blocked:budget"],
      guidance: "Extend the next Worker's budget and continue from the published checkpoint.",
    });

    expect(requeue.requeueable).toBe(true);
    expect(requeue.body).not.toContain(formatCurrentBlocker(blocker!));
    expect(requeue.body).not.toContain("<!-- red:blocker-state v1 -->");
    expect(requeue.removeLabels).toEqual(expect.arrayContaining(["ready-for-human", "blocked:budget"]));
    expect(requeue.addLabels).toEqual(["ready-for-agent"]);
    expect(isRequeueComplete(requeue.body, ["ready-for-agent"])).toBe(true);
  });
});
