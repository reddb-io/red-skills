import { describe, expect, it } from "vitest";
import { parseGoArgs } from "../src/commands/go.js";

describe("parseGoArgs --scout flag", () => {
  it("parses --scout and joins the question tokens as the demand", () => {
    const result = parseGoArgs(["--scout", "what", "does", "dispatch", "do?"]);
    expect(result.scout).toBe(true);
    expect(result.demand).toBe("what does dispatch do?");
    expect(result.runner).toBeUndefined();
  });

  it("--scout is false / absent by default", () => {
    expect(parseGoArgs(["fix the bug"]).scout).toBe(false);
  });

  it("combines --scout with --runner", () => {
    const result = parseGoArgs(["--scout", "question", "--runner", "claude"]);
    expect(result.scout).toBe(true);
    expect(result.demand).toBe("question");
    expect(result.runner).toBe("claude");
  });

  it("passes a dashed question through after --", () => {
    const result = parseGoArgs(["--scout", "--", "--literal", "question"]);
    expect(result.scout).toBe(true);
    expect(result.demand).toBe("--literal question");
  });

  it("does not fold --scout into the demand", () => {
    const result = parseGoArgs(["--scout", "investigate the routing"]);
    expect(result.demand).toBe("investigate the routing");
    expect(result.demand).not.toContain("--scout");
  });

  it("yields empty demand with scout flag alone", () => {
    const result = parseGoArgs(["--scout"]);
    expect(result.scout).toBe(true);
    expect(result.demand).toBe("");
  });
});
