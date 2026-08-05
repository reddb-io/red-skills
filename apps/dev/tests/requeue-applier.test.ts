import { describe, expect, it, vi } from "vitest";
import { formatCurrentBlocker } from "../src/core/blocker-state.js";
import { applyRequeue } from "../src/core/requeue.js";

const pushFailedBody = `## Current blocker\n\n${formatCurrentBlocker({
  status: "blocked",
  kind: "push-failed",
  summary: "The worker push failed after validation passed.",
  next: "Restore remote access, then requeue.",
})}\n`;

function makeDeps() {
  const order: string[] = [];
  return {
    order,
    deps: {
      verifyBaseFreshness: vi.fn(async (_body: string) => { order.push("freshness"); return { ok: true, evidence: "fresh" }; }),
      releaseClaims: vi.fn(async (_issue: number) => { order.push("claims"); return ["wOLD"]; }),
      editBody: vi.fn(async (_issue: number, _body: string) => { order.push("body"); }),
      comment: vi.fn(async (_issue: number, _body: string) => { order.push("directive"); }),
      editLabels: vi.fn(async (_issue: number, _remove: string[], _add: string[]) => { order.push("labels"); }),
    },
  };
}

describe("applyRequeue — the one Park door", () => {
  it("refuses push-failed under machine authority without side effects", async () => {
    const fixture = makeDeps();
    const result = await applyRequeue(fixture.deps, {
      issue: 3334,
      authority: "machine",
      body: pushFailedBody,
      labels: ["ready-for-human", "blocked:push-failed"],
      guidance: "Remote access restored.",
    });

    expect(result.applied).toBe(false);
    expect(result.plan.reason).toContain("machine authority");
    expect(fixture.order).toEqual([]);
  });

  it("passes push-failed under human authority with freshness, claim sweep, directive, and transition", async () => {
    const fixture = makeDeps();
    const result = await applyRequeue(fixture.deps, {
      issue: 3334,
      authority: "human",
      body: pushFailedBody,
      labels: ["ready-for-human", "blocked:push-failed"],
      guidance: "Remote access restored.",
    });

    expect(result.applied).toBe(true);
    expect(fixture.order).toEqual(["freshness", "claims", "body", "directive", "labels"]);
    expect(fixture.deps.comment.mock.calls[0]![1]).toContain('data-kind="directive"');
    expect(fixture.deps.editLabels).toHaveBeenCalledWith(
      3334,
      expect.arrayContaining(["ready-for-human", "blocked:push-failed"]),
      ["ready-for-agent"],
    );
  });
});
