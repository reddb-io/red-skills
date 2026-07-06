import { describe, expect, it } from "vitest";
import { formatCurrentBlocker } from "../src/core/blocker-state.js";
import { isRequeueComplete, planRequeue } from "../src/core/requeue.js";

const validationBlocker = {
  status: "blocked" as const,
  kind: "validation",
  summary: "Package gate failed on the new branch.",
  next: "Human must decide whether to retry with the documented guidance.",
};

const specBlocker = {
  status: "blocked" as const,
  kind: "spec",
  summary: "Requirements gap — acceptance criteria are ambiguous.",
  next: "Human must clarify the spec before work can continue.",
};

const decisionBlocker = {
  status: "blocked" as const,
  kind: "decision",
  summary: "Architectural choice required.",
  next: "Human must decide before work can proceed.",
};

const parkedBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(
  validationBlocker,
)}\n\n## Acceptance\n- [ ] Done\n`;

const specBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(
  specBlocker,
)}\n\n## Acceptance\n- [ ] Done\n`;

const decisionBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(
  decisionBlocker,
)}\n`;

const sensitivePathBlocker = {
  status: "blocked" as const,
  kind: "sensitive-path",
  summary: "Diff touches .github/workflows/ci.yml — protected path.",
  next: "Human must review the protected diff before it can land.",
};

const sensitivePathBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(
  sensitivePathBlocker,
)}\n`;

describe("requeue — label flip invariant", () => {
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
});

describe("requeue — supported kinds (validation, spec)", () => {
  it("clears the active blocker in the rewritten body instead of requiring manual editing", () => {
    const plan = planRequeue({
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation"],
      guidance: "Gate flake fixed.",
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.activeBlocker?.kind).toBe("validation");
    expect(plan.bodyChanged).toBe(true);
    expect(plan.body).not.toContain("<!-- red:blocker-state v1 -->");
    expect(plan.body).toContain("## Resolved blockers");
  });

  it("removes stale ready-for-human and every blocked:* label while adding ready-for-agent", () => {
    const plan = planRequeue({
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation", "priority:high"],
      guidance: "Gate flake fixed.",
    });
    expect(plan.removeLabels).toEqual(expect.arrayContaining(["ready-for-human", "blocked:validation"]));
    expect(plan.removeLabels).not.toContain("priority:high");
    expect(plan.addLabels).toEqual(["ready-for-agent"]);
  });

  it("accepts blocked:spec with a consistent body blocker", () => {
    const plan = planRequeue({
      body: specBody,
      labels: ["ready-for-human", "blocked:spec"],
      guidance: "Spec clarified; proceed with the documented interpretation.",
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.activeBlocker?.kind).toBe("spec");
    expect(plan.bodyChanged).toBe(true);
  });

  it("handles a blocked:spec label with no machine-readable block (label-only park)", () => {
    const plan = planRequeue({
      body: "## Summary\nSpec gap.\n",
      labels: ["ready-for-human", "blocked:spec"],
      guidance: "Spec clarified.",
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.removeLabels).toEqual(expect.arrayContaining(["ready-for-human", "blocked:spec"]));
    expect(plan.addLabels).toEqual(["ready-for-agent"]);
  });
});

describe("requeue — refusals that direct to /hitl", () => {
  it("refuses mixed blocked:* labels without mutation and sets refuseForHitl", () => {
    const plan = planRequeue({
      body: parkedBody,
      labels: ["ready-for-human", "blocked:validation", "blocked:spec"],
      guidance: "Both labels present.",
    });
    expect(plan.requeueable).toBe(false);
    expect(plan.refuseForHitl).toBe(true);
    expect(plan.reason).toMatch(/mixed blocked:\*/);
    expect(plan.bodyChanged).toBe(false);
    expect(plan.addLabels).toHaveLength(0);
    expect(plan.removeLabels).toHaveLength(0);
  });

  it("refuses a blocked:decision label without mutation and sets refuseForHitl", () => {
    const plan = planRequeue({
      body: "## Summary\nNeeds decision.\n",
      labels: ["ready-for-human", "blocked:decision"],
      guidance: "Decision made.",
    });
    expect(plan.requeueable).toBe(false);
    expect(plan.refuseForHitl).toBe(true);
    expect(plan.reason).toMatch(/not in the supported set/);
  });

  it("refuses an active body blocker of kind 'decision' with no corresponding label and sets refuseForHitl", () => {
    const plan = planRequeue({
      body: decisionBody,
      labels: ["ready-for-human"],
      guidance: "Decision made.",
    });
    expect(plan.requeueable).toBe(false);
    expect(plan.refuseForHitl).toBe(true);
    expect(plan.reason).toMatch(/not in the supported set/);
  });

  it("refuses a label/body kind mismatch (blocked:validation label but body says spec) and sets refuseForHitl", () => {
    const mismatchBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(specBlocker)}\n`;
    const plan = planRequeue({
      body: mismatchBody,
      labels: ["ready-for-human", "blocked:validation"],
      guidance: "Fixed.",
    });
    expect(plan.requeueable).toBe(false);
    expect(plan.refuseForHitl).toBe(true);
    expect(plan.reason).toMatch(/label\/body kind mismatch/);
    expect(plan.bodyChanged).toBe(false);
  });

  it("refuses a label/body kind mismatch (blocked:spec label but body says validation) and sets refuseForHitl", () => {
    const plan = planRequeue({
      body: parkedBody,
      labels: ["ready-for-human", "blocked:spec"],
      guidance: "Fixed.",
    });
    expect(plan.requeueable).toBe(false);
    expect(plan.refuseForHitl).toBe(true);
    expect(plan.reason).toMatch(/label\/body kind mismatch/);
  });
});

describe("requeue — sensitive-path is adopt-branch-only (#1171)", () => {
  it("refuses a bare requeue of a blocked:sensitive-path park (→ /hitl)", () => {
    const plan = planRequeue({
      body: sensitivePathBody,
      labels: ["ready-for-human", "blocked:sensitive-path"],
      guidance: "Reviewed the CI diff.",
      // adoptBranch omitted → bare requeue must still refuse.
    });
    expect(plan.requeueable).toBe(false);
    expect(plan.refuseForHitl).toBe(true);
    expect(plan.reason).toMatch(/adopt-branch/);
    expect(plan.bodyChanged).toBe(false);
    expect(plan.addLabels).toHaveLength(0);
    expect(plan.removeLabels).toHaveLength(0);
  });

  it("clears a blocked:sensitive-path park when --adopt-branch is set", () => {
    const plan = planRequeue({
      body: sensitivePathBody,
      labels: ["ready-for-human", "blocked:sensitive-path"],
      guidance: "Maintainer reviewed the workflow diff; land it.",
      adoptBranch: true,
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.activeBlocker?.kind).toBe("sensitive-path");
    expect(plan.bodyChanged).toBe(true);
    expect(plan.body).toContain("## Resolved blockers");
    expect(plan.removeLabels).toEqual(
      expect.arrayContaining(["ready-for-human", "blocked:sensitive-path"]),
    );
    expect(plan.addLabels).toEqual(["ready-for-agent"]);
  });

  it("refuses a body-only sensitive-path blocker on a bare requeue but clears it under --adopt-branch", () => {
    const bare = planRequeue({
      body: sensitivePathBody,
      labels: ["ready-for-human"],
      guidance: "Reviewed.",
    });
    expect(bare.requeueable).toBe(false);
    expect(bare.refuseForHitl).toBe(true);
    expect(bare.reason).toMatch(/adopt-branch/);

    const adopt = planRequeue({
      body: sensitivePathBody,
      labels: ["ready-for-human"],
      guidance: "Reviewed.",
      adoptBranch: true,
    });
    expect(adopt.requeueable).toBe(true);
    expect(adopt.activeBlocker?.kind).toBe("sensitive-path");
  });

  it("does NOT widen other unsupported kinds — decision still refuses even under --adopt-branch", () => {
    const plan = planRequeue({
      body: decisionBody,
      labels: ["ready-for-human", "blocked:decision"],
      guidance: "Decision made.",
      adoptBranch: true,
    });
    expect(plan.requeueable).toBe(false);
    expect(plan.refuseForHitl).toBe(true);
    expect(plan.reason).toMatch(/not in the supported set/);
  });
});

describe("requeue — not-parked no-op (not a /hitl refusal)", () => {
  it("refuses to requeue an issue that is not parked without setting refuseForHitl", () => {
    const plan = planRequeue({
      body: "## Summary\nNothing parked here.\n",
      labels: ["ready-for-agent"],
      guidance: "Whatever.",
    });
    expect(plan.requeueable).toBe(false);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.bodyChanged).toBe(false);
  });
});
