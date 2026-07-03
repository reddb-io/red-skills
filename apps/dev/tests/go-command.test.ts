import { describe, expect, it } from "vitest";
import { parseGoArgs } from "../src/commands/go.js";

describe("parseGoArgs", () => {
  it("joins the demand tokens and defaults runner unset, mode direct-PR, yolo off", () => {
    expect(parseGoArgs(["fix", "the", "flaky", "test"])).toEqual({
      demand: "fix the flaky test",
      runner: undefined,
      mode: "direct-PR",
      yolo: false,
      scout: false,
    });
  });

  it("takes a single quoted demand verbatim", () => {
    expect(parseGoArgs(["fix the flaky login test"]).demand).toBe("fix the flaky login test");
  });

  it("extracts --runner / -r without folding it into the demand", () => {
    expect(parseGoArgs(["do it", "--runner", "codex"])).toMatchObject({ demand: "do it", runner: "codex" });
    expect(parseGoArgs(["-r", "claude", "do it"])).toMatchObject({ demand: "do it", runner: "claude" });
    expect(parseGoArgs(["--runner=codex", "do it"])).toMatchObject({ demand: "do it", runner: "codex" });
  });

  it("passes a dashed demand through after --", () => {
    expect(parseGoArgs(["--", "--literal", "demand"]).demand).toBe("--literal demand");
  });

  // #1045: an unknown `--flag` must error, never fold into the demand. The
  // original papercut minted a junk issue when `--resume 1043` was swallowed as
  // demand text; now it fails loudly, and a literal dashed demand still works via
  // the `--` separator.
  it("throws on an unknown --flag instead of folding it into the demand (#1045)", () => {
    expect(() => parseGoArgs(["--resume", "1043"])).toThrow(/unknown flag/);
    expect(() => parseGoArgs(["do it", "--frobnicate"])).toThrow(/unknown flag/);
    // …but a genuinely dashed demand still passes through after the `--` separator.
    expect(parseGoArgs(["--", "--resume", "1043"]).demand).toBe("--resume 1043");
  });

  it("throws when --runner has no value", () => {
    expect(() => parseGoArgs(["do it", "--runner"])).toThrow(/requires a value/);
  });

  it("yields an empty demand for an empty arg list", () => {
    expect(parseGoArgs([]).demand).toBe("");
  });

  it("selects the dispatch mode via --mode / --mode= without folding it into the demand", () => {
    expect(parseGoArgs(["do it", "--mode", "no-mistakes"])).toMatchObject({
      demand: "do it",
      mode: "no-mistakes",
    });
    expect(parseGoArgs(["--mode=local-only", "do it"])).toMatchObject({
      demand: "do it",
      mode: "local-only",
    });
  });

  it("throws on an unknown --mode and when --mode has no value", () => {
    expect(() => parseGoArgs(["do it", "--mode", "bogus"])).toThrow(/invalid --mode/);
    expect(() => parseGoArgs(["do it", "--mode"])).toThrow(/requires a value/);
  });

  it("bumps autonomy with the opt-in +yolo token without folding it into the demand", () => {
    const parsed = parseGoArgs(["do it", "+yolo"]);
    expect(parsed).toMatchObject({ demand: "do it", yolo: true });
    expect(parseGoArgs(["do it"]).yolo).toBe(false);
  });

  it("passes +yolo through literally as demand after --", () => {
    const parsed = parseGoArgs(["--", "keep", "+yolo"]);
    expect(parsed.demand).toBe("keep +yolo");
    expect(parsed.yolo).toBe(false);
  });
});
