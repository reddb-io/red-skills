import { describe, expect, it } from "vitest";
import { parseCurrentBlocker, upsertCurrentBlocker } from "../src/core/blocker-state.js";
import { planHitlResolution, type HitlResolutionInput } from "../src/core/hitl-resolution-plan.js";

const decision: HitlResolutionInput["decision"] = {
  kind: "pending-decision",
  source: "issue-body",
  prompt: "Choose whether `$hitl` should update the brief.",
  evidence: "## Human decision needed\nChoose whether `$hitl` should update the brief.",
};

function base(overrides: Partial<HitlResolutionInput>): HitlResolutionInput {
  return {
    issue: {
      number: 42,
      title: "Resolve HITL blocker",
      body: "## Summary\nExisting summary.\n",
    },
    decision,
    answer: "Yes, update the brief when the issue becomes delegable.",
    disposition: {
      kind: "delegable",
      agentBrief: "Implement the agreed behavior with tests.",
    },
    ...overrides,
  };
}

describe("planHitlResolution", () => {
  it("plans directive comment, brief update, and label transition for delegable issues", () => {
    const plan = planHitlResolution(base({}));

    expect(plan.commentBody).toContain('<details data-kind="directive">');
    expect(plan.commentBody).toContain("Pending decision:");
    expect(plan.commentBody).toContain("Human answer:");
    expect(plan.commentBody).toContain("Disposition:\ndelegable");
    expect(plan.bodyUpdate).toContain("## Agent brief");
    expect(plan.bodyUpdate).toContain("<!-- red:agent-brief v1 -->");
    expect(plan.bodyUpdate).toContain("Implement the agreed behavior with tests.");
    expect(plan.bodyUpdate).toContain("<!-- /red:agent-brief -->");
    expect(plan.addLabels).toEqual(["ready-for-agent"]);
    expect(plan.removeLabels).toEqual(["ready-for-human"]);
  });

  it("sheds stale blocked:* labels when a delegable resolution moves the issue back to ready-for-agent", () => {
    const plan = planHitlResolution(
      base({
        issue: {
          number: 42,
          title: "Resolve HITL blocker",
          body: "## Summary\nExisting summary.\n",
          labels: ["ready-for-human", "blocked:spec", "blocked:validation", "priority:high"],
        },
      }),
    );

    expect(plan.addLabels).toEqual(["ready-for-agent"]);
    expect(plan.removeLabels).toEqual(["ready-for-human", "blocked:spec", "blocked:validation"]);
    expect(plan.removeLabels).not.toContain("priority:high");
  });

  it("does not invent blocked:* removals when the issue carries none", () => {
    const plan = planHitlResolution(
      base({
        issue: {
          number: 42,
          title: "Resolve HITL blocker",
          body: "## Summary\nExisting summary.\n",
          labels: ["ready-for-human"],
        },
      }),
    );

    expect(plan.removeLabels).toEqual(["ready-for-human"]);
  });

  it("clears Current blocker and records it when the answer makes the issue delegable", () => {
    const body = upsertCurrentBlocker("## Summary\nExisting summary.\n", {
      status: "blocked",
      kind: "decision",
      summary: "Choose the API shape.",
      next: "Pick REST or RPC.",
    });
    const plan = planHitlResolution(
      base({
        issue: { number: 42, title: "Resolve HITL blocker", body },
        answer: "Use RPC.",
      }),
    );

    expect(parseCurrentBlocker(plan.bodyUpdate ?? "")).toBeNull();
    expect(plan.bodyUpdate).toContain("## Current blocker\n\nNone");
    expect(plan.bodyUpdate).toContain("## Resolved blockers");
    expect(plan.bodyUpdate).toContain("- [x] Choose the API shape. - Use RPC.");
  });

  it("replaces a stale Agent brief instead of duplicating it", () => {
    const plan = planHitlResolution(
      base({
        issue: {
          number: 42,
          title: "Resolve HITL blocker",
          body: "## Summary\nExisting summary.\n\n## Agent brief\nOld brief.\n\n## Acceptance\n- [ ] Keep this.",
        },
        disposition: {
          kind: "delegable",
          agentBrief: "New brief.",
        },
      }),
    );

    expect(plan.bodyUpdate).toContain("## Agent brief");
    expect(plan.bodyUpdate).toContain("<!-- red:agent-brief v1 -->");
    expect(plan.bodyUpdate).toContain("New brief.");
    expect(plan.bodyUpdate).not.toContain("Old brief.");
    expect(plan.bodyUpdate?.match(/## Agent brief/g)).toHaveLength(1);
  });

  it("keeps ready-for-human and records the next pending decision for non-delegable issues", () => {
    const plan = planHitlResolution(
      base({
        disposition: {
          kind: "non-delegable",
          nextPendingDecision: "Decide which API shape the command should expose.",
        },
      }),
    );

    expect(plan.bodyUpdate).toContain("## Current blocker");
    expect(parseCurrentBlocker(plan.bodyUpdate ?? "")).toEqual({
      status: "blocked",
      kind: "decision",
      summary: "Choose whether `$hitl` should update the brief.",
      next: "Decide which API shape the command should expose.",
    });
    expect(plan.addLabels).toEqual(["ready-for-human"]);
    expect(plan.removeLabels).toEqual([]);
    expect(plan.commentBody).toContain("Disposition:\nnon-delegable");
    expect(plan.commentBody).toContain("Next pending decision:\nDecide which API shape the command should expose.");
  });

  it("records ambiguous extraction context in the directive comment", () => {
    const plan = planHitlResolution(
      base({
        decision: {
          kind: "ambiguous",
          prompt: "State the pending human decision for #42: Resolve HITL blocker",
          reasons: ["No explicit pending decision was found."],
          evidence: [],
        },
      }),
    );

    expect(plan.commentBody).toContain("State the pending human decision for #42: Resolve HITL blocker");
    expect(plan.commentBody).toContain("Ambiguity: No explicit pending decision was found.");
  });
});
