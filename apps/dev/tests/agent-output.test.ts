import { describe, it, expect } from "vitest";
import {
  AGENT_OUTPUT_TAG,
  AGENT_OUTPUT_OPEN,
  AGENT_OUTPUT_CLOSE,
  AgentOutputSchema,
  parseAgentOutput,
  type AgentOutput,
} from "../src/core/agent-output.js";

const valid: AgentOutput = {
  success: true,
  summary: "Implemented the structured-output completion adapter for claude.",
  key_changes_made: ["Added agent-output.ts", "Wired interpretCompletion"],
  key_learnings: ["The Claude CLI has no --json-schema flag"],
  should_fully_stop: false,
};

const block = (payload: unknown, body = "") =>
  `${body}\n${AGENT_OUTPUT_OPEN}${JSON.stringify(payload)}${AGENT_OUTPUT_CLOSE}\n`;

describe("AGENT_OUTPUT tag constants", () => {
  it("derive the open/close delimiters from the tag name", () => {
    expect(AGENT_OUTPUT_TAG).toBe("agent-output");
    expect(AGENT_OUTPUT_OPEN).toBe("<agent-output>");
    expect(AGENT_OUTPUT_CLOSE).toBe("</agent-output>");
  });
});

describe("AgentOutputSchema", () => {
  it("accepts the full AgentOutput shape (ADR 0082 §1)", () => {
    expect(AgentOutputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a payload missing a required field", () => {
    const { should_fully_stop, ...partial } = valid;
    expect(AgentOutputSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects wrong-typed fields (success must be a boolean)", () => {
    expect(
      AgentOutputSchema.safeParse({ ...valid, success: "yes" }).success,
    ).toBe(false);
  });
});

describe("parseAgentOutput", () => {
  it("extracts and validates a well-formed structured block", () => {
    expect(parseAgentOutput(block(valid, "some work log"))).toEqual(valid);
  });

  it("unwraps a fenced ```json block", () => {
    const fenced = `${AGENT_OUTPUT_OPEN}\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n${AGENT_OUTPUT_CLOSE}`;
    expect(parseAgentOutput(fenced)).toEqual(valid);
  });

  it("returns the LAST block when the agent self-corrects", () => {
    const first = { ...valid, success: false, summary: "draft" };
    const stdout = block(first, "first attempt") + block(valid, "revised");
    expect(parseAgentOutput(stdout)).toEqual(valid);
  });

  it("returns undefined when the tag is absent (falls back to sentinel)", () => {
    expect(parseAgentOutput("just a <promise>DONE</promise> line")).toBeUndefined();
  });

  it("returns undefined on invalid JSON (never throws)", () => {
    expect(
      parseAgentOutput(`${AGENT_OUTPUT_OPEN}{not json}${AGENT_OUTPUT_CLOSE}`),
    ).toBeUndefined();
  });

  it("returns undefined when JSON fails schema validation", () => {
    expect(
      parseAgentOutput(block({ success: true })),
    ).toBeUndefined();
  });
});
