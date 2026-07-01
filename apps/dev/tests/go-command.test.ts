import { describe, expect, it } from "vitest";
import { parseGoArgs } from "../src/commands/go.js";

describe("parseGoArgs", () => {
  it("joins the demand tokens and leaves the runner unset by default", () => {
    expect(parseGoArgs(["fix", "the", "flaky", "test"])).toEqual({
      demand: "fix the flaky test",
      runner: undefined,
      scout: false,
    });
  });

  it("takes a single quoted demand verbatim", () => {
    expect(parseGoArgs(["fix the flaky login test"]).demand).toBe("fix the flaky login test");
  });

  it("extracts --runner / -r without folding it into the demand", () => {
    expect(parseGoArgs(["do it", "--runner", "codex"])).toEqual({ demand: "do it", runner: "codex", scout: false });
    expect(parseGoArgs(["-r", "claude", "do it"])).toEqual({ demand: "do it", runner: "claude", scout: false });
    expect(parseGoArgs(["--runner=codex", "do it"])).toEqual({ demand: "do it", runner: "codex", scout: false });
  });

  it("passes a dashed demand through after --", () => {
    expect(parseGoArgs(["--", "--literal", "demand"]).demand).toBe("--literal demand");
  });

  it("throws when --runner has no value", () => {
    expect(() => parseGoArgs(["do it", "--runner"])).toThrow(/requires a value/);
  });

  it("yields an empty demand for an empty arg list", () => {
    expect(parseGoArgs([]).demand).toBe("");
  });
});
