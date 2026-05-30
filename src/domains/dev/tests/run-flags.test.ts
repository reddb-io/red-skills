import { describe, expect, it } from "vitest";
import { parseRunFlags } from "../src/commands/run.js";

describe("parseRunFlags", () => {
  it("defaults to the all filter with no cap", () => {
    expect(parseRunFlags([])).toEqual({ filter: { kind: "all" }, iterCap: undefined, once: false, runnerFlag: undefined, request: undefined });
  });

  it("parses --prd into a prd filter", () => {
    expect(parseRunFlags(["--prd", "42"]).filter).toEqual({ kind: "prd", prd: 42 });
    expect(parseRunFlags(["--prd=7"]).filter).toEqual({ kind: "prd", prd: 7 });
  });

  it("parses --issues into an ordered number list", () => {
    expect(parseRunFlags(["--issues", "3,1,2"]).filter).toEqual({ kind: "issues", numbers: [3, 1, 2] });
    expect(parseRunFlags(["--issues=10, 20"]).filter).toEqual({ kind: "issues", numbers: [10, 20] });
  });

  it("parses -n cap, --once, --runner, --request", () => {
    const f = parseRunFlags(["-n", "0", "--once", "--runner", "codex", "--request", "do it"]);
    expect(f.iterCap).toBe(0);
    expect(f.once).toBe(true);
    expect(f.runnerFlag).toBe("codex");
    expect(f.request).toBe("do it");
  });

  it("throws when a value flag is missing its argument", () => {
    expect(() => parseRunFlags(["--prd"])).toThrow();
  });
});
