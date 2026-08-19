import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER,
  lintExecutableAcceptanceCriteria,
  planAcceptanceCriteriaRecipeCommentUpdate,
  renderAcceptanceCriteriaRecipeComment,
} from "../src/core/executable-acceptance.js";

describe("lintExecutableAcceptanceCriteria", () => {
  it("accepts an executable ticket with command-pinned acceptance criteria", () => {
    const result = lintExecutableAcceptanceCriteria(`## What to build

Wire the lint.

## Acceptance criteria

- [ ] Running \`pnpm --filter @reddb-io/dev test -- executable-acceptance\` passes.
- [ ] The bad fixture remains \`needs-triage\` and receives exactly one recipe comment.
`);

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
  });

  it("rejects a ready-for-agent candidate with no acceptance criteria section", () => {
    const result = lintExecutableAcceptanceCriteria(`## What to build

Make the agent better.
`);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing acceptance-criteria section");
  });

  it("rejects vague checklist items that have no verifiable artifact", () => {
    const result = lintExecutableAcceptanceCriteria(`## Acceptance criteria

- [ ] The implementation is clean and intuitive.
- [ ] The docs are nicer.
`);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("acceptance criteria item is not machine-checkable: The implementation is clean and intuitive.");
  });

  it("rejects generic verb-only criteria without a test, command, fixture, or pinned behavior", () => {
    for (const item of [
      "The implementation passes review.",
      "The UI renders nicely.",
      "The code updates correctly.",
    ]) {
      const result = lintExecutableAcceptanceCriteria(`## Acceptance criteria

- [ ] ${item}
`);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe(`acceptance criteria item is not machine-checkable: ${item}`);
    }
  });

  it("accepts pinned observable behavior even when no shell command is named", () => {
    const result = lintExecutableAcceptanceCriteria(`## Acceptance criteria

- [ ] A ticket without the section stays labeled \`needs-triage\` instead of receiving \`ready-for-agent\`.
- [ ] Re-running triage leaves only one comment containing the lint recipe.
`);

    expect(result.ok).toBe(true);
  });

  it("renders the idempotent recipe comment with a template", () => {
    const comment = renderAcceptanceCriteriaRecipeComment({
      ok: false,
      reason: "missing acceptance-criteria section",
      items: [],
    });

    expect(comment).toContain(ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER);
    expect(comment).toContain("missing acceptance-criteria section");
    expect(comment).toContain("## Acceptance criteria");
    expect(comment).toContain("pnpm --filter");
  });

  it("updates a trusted stale recipe comment when the lint reason changes", () => {
    const stale = renderAcceptanceCriteriaRecipeComment({
      ok: false,
      reason: "missing acceptance-criteria section",
      items: [],
    });
    const plan = planAcceptanceCriteriaRecipeCommentUpdate(
      [{ id: 123, body: stale, sourceTrust: "trusted" }],
      {
        ok: false,
        reason: "acceptance criteria item is not machine-checkable: The UI renders nicely.",
        items: ["The UI renders nicely."],
      },
    );

    expect(plan.action).toBe("update");
    expect(plan.id).toBe(123);
    expect(plan.body).toContain("The UI renders nicely.");
  });

  it("ignores copied recipe markers from dubious commenters", () => {
    const plan = planAcceptanceCriteriaRecipeCommentUpdate(
      [{ id: 123, body: ACCEPTANCE_CRITERIA_RECIPE_COMMENT_MARKER, sourceTrust: "dubious" }],
      { ok: false, reason: "missing acceptance-criteria section", items: [] },
    );

    expect(plan.action).toBe("create");
  });
});
