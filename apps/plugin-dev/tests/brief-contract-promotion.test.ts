import { describe, expect, it } from "vitest";
import {
  BRIEF_CONTRACT_EXEMPT_LABELS,
  planBriefGatedTriageTransition,
} from "../src/core/brief-contract-promotion.js";
import { ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER } from "../src/core/executable-acceptance.js";

const EXECUTABLE_BODY = `## What to build

Wire the brief contract into the promotion path.

## Acceptance criteria

- [ ] Running \`pnpm -C apps/plugin-dev test\` passes.
`;

const VAGUE_BODY = `## What to build

Make the retry logic better.

## Acceptance criteria

- [ ] It should feel snappier.
`;

describe("planBriefGatedTriageTransition", () => {
  it("refuses to promote a vague brief and quotes the lint finding", () => {
    const plan = planBriefGatedTriageTransition({
      decision: "ready-for-agent",
      body: VAGUE_BODY,
      labels: ["needs-triage"],
    });

    expect(plan.outcome).toBe("refused");
    expect(plan.refusal).toContain("It should feel snappier.");
    expect(plan.items).toEqual(["It should feel snappier."]);
  });

  it("never lets `ready-for-agent` onto a refused issue", () => {
    const plan = planBriefGatedTriageTransition({
      decision: "ready-for-agent",
      body: VAGUE_BODY,
    });

    expect(plan.transition.add).not.toContain("ready-for-agent");
    expect(plan.transition.add).toContain("needs-triage");
    expect(plan.transition.remove).toContain("ready-for-agent");
    expect(plan.transition.close).toBe(false);
  });

  it("plans the recipe comment, so the refusal tells a human how to fix it", () => {
    const plan = planBriefGatedTriageTransition({
      decision: "ready-for-agent",
      body: VAGUE_BODY,
    });

    expect(plan.recipeComment?.action).toBe("create");
    expect(plan.recipeComment?.body).toContain(ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER);
    expect(plan.recipeComment?.body).toContain("It should feel snappier.");
  });

  it("adopts an existing recipe comment instead of posting a second one", () => {
    const first = planBriefGatedTriageTransition({ decision: "ready-for-agent", body: VAGUE_BODY });
    const again = planBriefGatedTriageTransition({
      decision: "ready-for-agent",
      body: VAGUE_BODY,
      comments: [{ id: 9, body: first.recipeComment!.body, sourceTrust: "automation" }],
    });

    expect(again.recipeComment).toEqual({ action: "none", id: 9, body: first.recipeComment!.body });
  });

  it("promotes a brief that carries executable acceptance criteria", () => {
    const plan = planBriefGatedTriageTransition({
      decision: "ready-for-agent",
      body: EXECUTABLE_BODY,
      labels: ["needs-triage"],
    });

    expect(plan.outcome).toBe("applied");
    expect(plan.refusal).toBeNull();
    expect(plan.recipeComment).toBeNull();
    expect(plan.transition.add).toContain("ready-for-agent");
  });

  it("judges only promotion — the other three decisions pass through", () => {
    for (const decision of ["needs-info", "ready-for-human", "wontfix"] as const) {
      const plan = planBriefGatedTriageTransition({ decision, body: VAGUE_BODY });
      expect(plan.outcome).toBe("applied");
      expect(plan.refusal).toBeNull();
    }
  });

  it("exempts a Spec, whose Tickets carry the executable criteria", () => {
    expect(BRIEF_CONTRACT_EXEMPT_LABELS).toContain("type:spec");
    const plan = planBriefGatedTriageTransition({
      decision: "ready-for-agent",
      body: VAGUE_BODY,
      labels: ["needs-triage", "type:spec"],
    });

    expect(plan.outcome).toBe("applied");
    expect(plan.transition.add).toContain("ready-for-agent");
  });
});
