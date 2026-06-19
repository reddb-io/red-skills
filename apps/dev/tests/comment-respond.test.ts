import { describe, expect, it } from "vitest";
import {
  actionPushesCode,
  decideRespondAction,
  MUTATION_VERB,
  parseDevVerb,
  type CommenterTrust,
  type RespondAction,
} from "../src/core/comment-respond.js";

const TRUSTED: CommenterTrust = { trusted: true };
const UNTRUSTED: CommenterTrust = { trusted: false, reason: "not a repository maintainer" };

describe("parseDevVerb — the /dev summon grammar", () => {
  it("parses a fix verb and its multi-line instruction", () => {
    const parsed = parseDevVerb("/dev fix tighten the null guard\nin the parser");
    expect(parsed).toEqual({ verb: "fix", instruction: "tighten the null guard\nin the parser" });
  });

  it("parses an advisory verb with an empty instruction", () => {
    expect(parseDevVerb("/dev explain")).toEqual({ verb: "explain", instruction: "" });
  });

  it("recognises the summon only on the first non-blank line, ignoring leading blanks", () => {
    expect(parseDevVerb("\n\n   /dev review please")).toEqual({ verb: "review", instruction: "please" });
  });

  it("is case-insensitive on the /dev prefix and the verb", () => {
    expect(parseDevVerb("/DEV Fix do the thing")).toEqual({ verb: "fix", instruction: "do the thing" });
  });

  it("returns null for an unknown verb", () => {
    expect(parseDevVerb("/dev frobnicate the widget")).toBeNull();
  });

  it("returns null when there is no /dev prefix", () => {
    expect(parseDevVerb("just a normal human comment about fix")).toBeNull();
  });

  it("returns null for a blank body", () => {
    expect(parseDevVerb("   \n\t\n")).toBeNull();
  });

  it("does not treat a mid-line /dev as a summon", () => {
    expect(parseDevVerb("please run /dev fix for me")).toBeNull();
  });
});

describe("decideRespondAction — tiered mutation routing", () => {
  it("trusted /dev fix routes to the mutation path (the one push surface)", () => {
    const action = decideRespondAction("/dev fix patch the bug", TRUSTED);
    expect(action).toEqual({ kind: "mutate", instruction: "patch the bug" });
    expect(actionPushesCode(action)).toBe(true);
  });

  it("untrusted /dev fix is refused with no push", () => {
    const action = decideRespondAction("/dev fix patch the bug", UNTRUSTED);
    expect(action.kind).toBe("refuse");
    if (action.kind === "refuse") {
      expect(action.reason).toContain("not a repository maintainer");
    }
    expect(actionPushesCode(action)).toBe(false);
  });

  it("trusted advisory verbs never push", () => {
    for (const verb of ["explain", "review", "triage"] as const) {
      const action = decideRespondAction(`/dev ${verb} something`, TRUSTED);
      expect(action.kind).toBe("advisory");
      expect(actionPushesCode(action)).toBe(false);
    }
  });

  it("untrusted advisory verbs are refused, not pushed", () => {
    const action = decideRespondAction("/dev review the diff", UNTRUSTED);
    expect(action.kind).toBe("refuse");
    expect(actionPushesCode(action)).toBe(false);
  });

  it("a non-/dev comment is ignored — never pushes", () => {
    const action = decideRespondAction("nice work on this PR!", TRUSTED);
    expect(action).toEqual({ kind: "ignore" });
    expect(actionPushesCode(action)).toBe(false);
  });

  it("an unknown verb is ignored even from a trusted commenter", () => {
    const action = decideRespondAction("/dev deploy to prod", TRUSTED);
    expect(action).toEqual({ kind: "ignore" });
  });

  it("mutate is the ONLY action kind that reports as code-pushing", () => {
    const samples: RespondAction[] = [
      { kind: "ignore" },
      { kind: "refuse", reason: "x" },
      { kind: "advisory", verb: "explain", instruction: "" },
      { kind: "mutate", instruction: "y" },
    ];
    expect(samples.filter(actionPushesCode)).toEqual([{ kind: "mutate", instruction: "y" }]);
  });

  it("the mutation verb constant is `fix`", () => {
    expect(MUTATION_VERB).toBe("fix");
  });
});
