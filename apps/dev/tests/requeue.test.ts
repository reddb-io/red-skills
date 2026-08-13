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

const infraBlocker = {
  status: "blocked" as const,
  kind: "infra",
  summary: "The runner could not create its worktree.",
  next: "Retry after the transient infrastructure fault clears.",
};

const validationInfraBlocker = {
  status: "blocked" as const,
  kind: "validation-infra",
  summary: "The validation environment exhausted its retry budget.",
  next: "Retry after the validation infrastructure recovers.",
};

const baseStaleBlocker = {
  status: "blocked" as const,
  kind: "base-stale",
  summary: "The worker could not refresh its base.",
  next: "Refresh the local base from origin, then requeue.",
};

const pushFailedBlocker = {
  status: "blocked" as const,
  kind: "push-failed",
  summary: "The worker push failed after validation passed.",
  next: "Restore remote access, then requeue.",
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

const infraBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(
  infraBlocker,
)}\n`;

const validationInfraBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(
  validationInfraBlocker,
)}\n`;

const baseStaleBody = `## Summary\nDo the thing.\n\n## Current blocker\n\n${formatCurrentBlocker(
  baseStaleBlocker,
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

describe("requeue — supported kinds (validation, validation-infra, spec, infra, base-stale)", () => {
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

  it("requeues a manual-landing validation park without stripping the landing mode", () => {
    const plan = planRequeue({
      body: parkedBody,
      labels: ["ready-for-human", "landing:manual", "blocked:validation"],
      guidance: "Validation failure fixed; rerun the agent.",
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.activeBlocker?.kind).toBe("validation");
    expect(plan.bodyChanged).toBe(true);
    expect(plan.body).not.toContain("<!-- red:blocker-state v1 -->");
    expect(plan.body).toContain("## Resolved blockers");
    expect(plan.removeLabels).toEqual(expect.arrayContaining(["ready-for-human", "blocked:validation"]));
    expect(plan.removeLabels).not.toContain("landing:manual");
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

  it("requeues a transient blocked:infra park through the standard tool", () => {
    const plan = planRequeue({
      body: infraBody,
      labels: ["ready-for-human", "blocked:infra"],
      guidance: "Runner recovered; retry the worktree setup.",
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.activeBlocker?.kind).toBe("infra");
    expect(plan.removeLabels).toEqual(expect.arrayContaining(["ready-for-human", "blocked:infra"]));
    expect(plan.addLabels).toEqual(["ready-for-agent"]);
  });

  it("requeues a guided blocked:validation-infra park through the standard tool", () => {
    const plan = planRequeue({
      body: validationInfraBody,
      labels: ["ready-for-human", "blocked:validation-infra"],
      guidance: "Validation infrastructure recovered; retry the declared gate.",
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.activeBlocker?.kind).toBe("validation-infra");
    expect(plan.removeLabels).toEqual(
      expect.arrayContaining(["ready-for-human", "blocked:validation-infra"]),
    );
    expect(plan.addLabels).toEqual(["ready-for-agent"]);
  });

  it("plans a freshness-gated blocked:base-stale requeue without requiring /hitl", () => {
    const plan = planRequeue({
      body: baseStaleBody,
      labels: ["ready-for-human", "blocked:base-stale"],
      guidance: "Base freshness verified.",
    });
    expect(plan.requeueable).toBe(true);
    expect(plan.refuseForHitl).toBe(false);
    expect(plan.activeBlocker?.kind).toBe("base-stale");
    expect(plan.removeLabels).toEqual(
      expect.arrayContaining(["ready-for-human", "blocked:base-stale"]),
    );
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

describe("requeue — unsupported kinds refuse even under --adopt-branch", () => {
  it("decision kind refuses even under --adopt-branch (not in the supported set)", () => {
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

describe("requeue — one-door authority matrix", () => {
  const pushFailedBody = `## Current blocker\n\n${formatCurrentBlocker(pushFailedBlocker)}\n`;

  it("refuses a non-mechanical park under machine authority", () => {
    const plan = planRequeue({
      authority: "machine",
      body: pushFailedBody,
      labels: ["ready-for-human", "blocked:push-failed"],
      guidance: "Remote access is restored.",
    });

    expect(plan.requeueable).toBe(false);
    expect(plan.reason).toContain("machine authority");
  });

  it("accepts the same push-failed park under human authority", () => {
    const plan = planRequeue({
      authority: "human",
      body: pushFailedBody,
      labels: ["ready-for-human", "blocked:push-failed"],
      guidance: "Remote access is restored.",
    });

    expect(plan.requeueable).toBe(true);
    expect(plan.activeBlocker?.kind).toBe("push-failed");
    expect(plan.body).toContain("## Resolved blockers");
    expect(plan.removeLabels).toEqual(
      expect.arrayContaining(["ready-for-human", "blocked:push-failed"]),
    );
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
