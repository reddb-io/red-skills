import { describe, expect, it } from "vitest";
import {
  BRIEF_CONTRACT_REFUSAL_PREFIX,
  briefContractRefusal,
  briefContractStructuralRefusal,
  lintExecutableAcceptanceCriteria,
} from "./brief-contract.js";

const EXECUTABLE_BRIEF = `## What to build

Wire the lint into the promotion path.

## Acceptance criteria

- [ ] Running \`pnpm -C packages/shared test\` passes.
- [ ] The refusal output contains the offending item verbatim.
`;

const VAGUE_BRIEF = `## What to build

Make the retry logic better.

## Acceptance criteria

- [ ] It should feel snappier.
`;

describe("lintExecutableAcceptanceCriteria", () => {
  it("passes a brief whose checklist items name artifacts", () => {
    const result = lintExecutableAcceptanceCriteria(EXECUTABLE_BRIEF);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
  });

  it("names the first un-checkable item verbatim", () => {
    const result = lintExecutableAcceptanceCriteria(VAGUE_BRIEF);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      "acceptance criteria item is not machine-checkable: It should feel snappier.",
    );
  });

  it("separates a missing section from an empty one", () => {
    expect(lintExecutableAcceptanceCriteria("## What to build\n\nSomething.").reason)
      .toBe("missing acceptance-criteria section");
    expect(lintExecutableAcceptanceCriteria("## Acceptance criteria\n\nProse, no checklist.").reason)
      .toBe("acceptance-criteria section has no checklist items");
  });
});

describe("briefContractRefusal", () => {
  it("is null when the brief satisfies the contract", () => {
    expect(briefContractRefusal(EXECUTABLE_BRIEF)).toBeNull();
  });

  it("carries the lint finding verbatim behind the one shared prefix", () => {
    const refusal = briefContractRefusal(VAGUE_BRIEF);
    expect(refusal).toContain(BRIEF_CONTRACT_REFUSAL_PREFIX);
    expect(refusal).toContain("It should feel snappier.");
  });

  it("spells one refusal for every door, so an operator greps one string", () => {
    expect(briefContractRefusal("no criteria here")).toBe(
      `${BRIEF_CONTRACT_REFUSAL_PREFIX}: missing acceptance-criteria section`,
    );
  });
});

describe("briefContractStructuralRefusal", () => {
  it("is null for an executable brief", () => {
    expect(briefContractStructuralRefusal(EXECUTABLE_BRIEF)).toBeNull();
  });

  it("is null for a vague brief — the execution doors do not judge wording", () => {
    expect(briefContractStructuralRefusal(VAGUE_BRIEF)).toBeNull();
  });

  it("refuses a brief with no acceptance-criteria section", () => {
    expect(briefContractStructuralRefusal("## What to build\n\nSomething.")).toBe(
      `${BRIEF_CONTRACT_REFUSAL_PREFIX}: missing acceptance-criteria section`,
    );
  });

  it("refuses a section that lists nothing", () => {
    expect(briefContractStructuralRefusal("## Acceptance criteria\n\nProse, no checklist.")).toBe(
      `${BRIEF_CONTRACT_REFUSAL_PREFIX}: acceptance-criteria section has no checklist items`,
    );
  });
});
