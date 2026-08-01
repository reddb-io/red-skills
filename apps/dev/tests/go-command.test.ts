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
      // Detached by default: `/go` is the order, never the work (#3027).
      attached: false,
      dod: undefined,
      verifyCommand: undefined,
      request: undefined,
    });
  });

  it("takes a single quoted demand verbatim", () => {
    expect(parseGoArgs(["fix the flaky login test"]).demand).toBe("fix the flaky login test");
  });

  it("extracts --runner without folding it into the demand", () => {
    expect(parseGoArgs(["do it", "--runner", "codex"])).toMatchObject({ demand: "do it", runner: "codex" });
    expect(parseGoArgs(["--runner=codex", "do it"])).toMatchObject({ demand: "do it", runner: "codex" });
  });

  it("parses long-only --request without folding it into the demand", () => {
    expect(parseGoArgs(["do it", "--request", "stay strict"])).toMatchObject({
      demand: "do it",
      request: "stay strict",
    });
    expect(parseGoArgs(["--request=stay strict", "do it"])).toMatchObject({
      demand: "do it",
      request: "stay strict",
    });
  });

  it("does not bind -r to runner or request in /go", () => {
    expect(() => parseGoArgs(["-r", "claude", "do it"])).toThrow(/unknown flag/);
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

  it("parses --dod without treating it as a demand or skipping confirmation", () => {
    expect(parseGoArgs(["do it", "--dod", "tests pass and docs updated"])).toMatchObject({
      demand: "do it",
      dod: "tests pass and docs updated",
    });
    expect(parseGoArgs(["--dod=done means green gate", "do it"])).toMatchObject({
      demand: "do it",
      dod: "done means green gate",
    });
  });

  it("parses an ephemeral inline --verify command for one dispatch", () => {
    expect(parseGoArgs(["do it", "--verify", "npm run test -- go"])).toMatchObject({
      demand: "do it",
      verifyCommand: "npm run test -- go",
    });
    expect(parseGoArgs(["--verify=pnpm test", "do it"])).toMatchObject({
      demand: "do it",
      verifyCommand: "pnpm test",
    });
  });

  it("parses --tags into bare territory tag values in both flag forms", () => {
    expect(parseGoArgs(["do it", "--tags", "infra,backend"])).toMatchObject({
      demand: "do it",
      tags: ["infra", "backend"],
    });
    expect(parseGoArgs(["--tags=infra", "do it"])).toMatchObject({
      demand: "do it",
      tags: ["infra"],
    });
    expect(() => parseGoArgs(["do it", "--tags"])).toThrow(/requires a value/);
    expect(() => parseGoArgs(["do it", "--tags", ","])).toThrow(/at least one tag value/);
  });

  it("throws when --dod, --verify, or --request has no value", () => {
    expect(() => parseGoArgs(["do it", "--dod"])).toThrow(/requires a value/);
    expect(() => parseGoArgs(["do it", "--verify"])).toThrow(/requires a value/);
    expect(() => parseGoArgs(["do it", "--request"])).toThrow(/requires a value/);
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
