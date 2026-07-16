import { describe, expect, it } from "vitest";
import {
  AGENT_OUTPUT_TAG,
  agentOutput,
  agentOutputSchema,
  extractAgentOutput,
  type AgentOutput,
} from "./AgentOutput.js";

const valid: AgentOutput = {
  success: true,
  summary: "Implemented the AgentOutput schema.",
  key_changes_made: ["Added AgentOutput.ts", "Exported from index"],
  key_learnings: ["run() output is single-iteration only"],
  should_fully_stop: true,
};

const tag = (body: string) =>
  `<${AGENT_OUTPUT_TAG}>${body}</${AGENT_OUTPUT_TAG}>`;

describe("agentOutputSchema", () => {
  it("accepts the minimal contract shape", () => {
    expect(agentOutputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a missing field", () => {
    const { should_fully_stop, ...partial } = valid;
    void should_fully_stop;
    expect(agentOutputSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects a wrong field type", () => {
    expect(
      agentOutputSchema.safeParse({ ...valid, success: "yes" }).success,
    ).toBe(false);
    expect(
      agentOutputSchema.safeParse({ ...valid, key_changes_made: "one" })
        .success,
    ).toBe(false);
  });
});

describe("agentOutput definition", () => {
  it("binds the tag and schema for run()'s Output.object path", () => {
    expect(agentOutput._tag).toBe("object");
    expect(agentOutput.tag).toBe(AGENT_OUTPUT_TAG);
    expect(agentOutput.schema).toBe(agentOutputSchema);
  });
});

describe("extractAgentOutput", () => {
  it("extracts and validates a well-formed tag", () => {
    const res = extractAgentOutput(
      `work log...\n${tag(JSON.stringify(valid))}\n<promise>DONE</promise>`,
    );
    expect(res).toEqual({ ok: true, value: valid });
  });

  it("unwraps a Markdown JSON fence", () => {
    const body = "```json\n" + JSON.stringify(valid) + "\n```";
    const res = extractAgentOutput(tag(body));
    expect(res.ok && res.value).toEqual(valid);
  });

  it("takes the LAST tag when several are present", () => {
    const first = { ...valid, summary: "first" };
    const second = { ...valid, summary: "second" };
    const res = extractAgentOutput(
      `${tag(JSON.stringify(first))}\n${tag(JSON.stringify(second))}`,
    );
    expect(res.ok && res.value.summary).toBe("second");
  });

  it("reports missing when the tag is absent", () => {
    expect(
      extractAgentOutput("just a plain DONE\n<promise>DONE</promise>"),
    ).toEqual({ ok: false, reason: "missing" });
  });

  it("reports invalid-json for an unparseable body", () => {
    const res = extractAgentOutput(tag("{not json"));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe("invalid-json");
  });

  it("reports schema for a parseable body that fails the schema", () => {
    const res = extractAgentOutput(tag(JSON.stringify({ success: true })));
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe("schema");
  });
});
