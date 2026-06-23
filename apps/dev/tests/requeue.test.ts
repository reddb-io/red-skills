import { describe, expect, it } from "vitest";
import { formatCurrentBlocker } from "../src/core/blocker-state.js";
import { isRequeueComplete, planRequeue } from "../src/core/requeue.js";

const validationBlocker = {
  status: "blocked" as const,
  kind: "validation",
  summary: "Package gate failed on the new branch.",
  next: "Human must decide whether to retry with the documented guidance.",
};

const parkedBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(
  validationBlocker,
)}\n\n## Acceptance\n- [ ] Done\n`;

describe("requeue", () => {
  it("treats a label flip alone as an INCOMPLETE requeue while an active blocker remains", () => {
    // The exact no-op loop the issue describes: labels say ready-for-agent, but
    // the body still carries the active validation blocker, so AFK preflight
    // would re-park it. This must NOT be considered a successful requeue.
    expect(isRequeueComplete(parkedBody, ["ready-for-agent"])).toBe(false);
  });

  it("considers the issue requeued only once the active blocker is cleared", () => {
    const plan = planRequeue({
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
      guidance: "Retry with the documented guidance; the gate flake is fixed.",
    });
    expect(isRequeueComplete(plan.body, ["ready-for-agent"])).toBe(true);
  });

  it("clears the active blocker in the rewritten body instead of requiring manual editing", () => {
    const plan = planRequeue({
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
      guidance: "Gate flake fixed.",
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.activeBlocker?.kind).toBe("validation");
    expect(plan.bodyChanged).toBe(true);
    expect(plan.body).not.toContain("<!-- red:blocker-state v1 -->");
    expect(plan.body).toContain("## Resolved blockers");
  });

  it("removes stale ready-for-human and every blocked:* label while adding ready-for-agent", () => {
    const plan = planRequeue({
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation", "priority:high"],
    });
    expect(plan.removeLabels).toEqual(expect.arrayContaining(["ready-for-human", "blocked:validation"]));
    expect(plan.removeLabels).not.toContain("priority:high");
    expect(plan.addLabels).toEqual(["ready-for-agent"]);
  });

  it("refuses to requeue an issue that is not parked (no blocker, no blocked label)", () => {
    const plan = planRequeue({ body: "## Summary\nNothing parked here.\n", labels: ["ready-for-agent"] });
    expect(plan.requeueable).toBe(false);
    expect(plan.bodyChanged).toBe(false);
  });

  it("handles a blocked:spec label with no machine-readable block (label-only park)", () => {
    const plan = planRequeue({ body: "## Summary\nSpec gap.\n", labels: ["ready-for-human", "blocked:spec"] });
    expect(plan.requeueable).toBe(true);
    expect(plan.removeLabels).toEqual(expect.arrayContaining(["ready-for-human", "blocked:spec"]));
    expect(plan.addLabels).toEqual(["ready-for-agent"]);
  });
});
