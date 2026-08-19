import { describe, expect, it } from "vitest";
import {
  EMPTY_RESEED_OUTSTANDING,
  RESEED_TAIL_LINES,
  composeReseedHandoff,
  dedupeReseedFindings,
  gateReseedDirectives,
  noteReseedSignature,
  reseedHistoryLine,
  reviewReseedDirectives,
  withGateOutstanding,
  withReviewOutstanding,
  withoutGateOutstanding,
  withoutReviewOutstanding,
  type ReseedOutstanding,
} from "../src/core/process-issue/reseed-handoff.js";

const HANDOFF = ["# Issue #2728", "", "Do the thing.", ""].join("\n");

function gateRound(state: ReseedOutstanding, validation: string): ReseedOutstanding {
  return withGateOutstanding(state, { gate: "feedback", validation });
}

function reviewRound(
  state: ReseedOutstanding,
  findings: readonly { path?: string; line?: number; body: string }[],
): ReseedOutstanding {
  return withReviewOutstanding(state, { summary: "Blocking findings remain.", findings });
}

function compose(outstanding: ReseedOutstanding, round = 1, tier = "simple", repeats = 0): string {
  return composeReseedHandoff(HANDOFF, {
    tag: "afk-gate-correction",
    directives: gateReseedDirectives({ gate: "feedback", retry: round, cap: 3 }),
    history: { round, ceiling: 4, tier, repeats },
    outstanding,
  });
}

describe("Re-seed handoff — one outstanding-state section (ADR 0129, #2728)", () => {
  it("carries the gate tail and the review findings TOGETHER on a later round", () => {
    // Round 1: a blocking review. Round 2: the gate reddens while those findings
    // are still unfixed. The round-2 prompt must carry both — the three
    // appenders this replaces rebuilt from the original handoff and dropped the
    // review block entirely, leaving the round blind to its predecessor.
    const afterReview = reviewRound(EMPTY_RESEED_OUTSTANDING, [
      { path: "apps/plugin-dev/src/a.ts", line: 12, body: "The acceptance criterion is not satisfied." },
    ]);
    const afterGate = gateRound(afterReview, "FAIL apps/plugin-dev tests\n  ✗ composes the section");

    const handoff = compose(afterGate, 2);

    const section = handoff.slice(handoff.indexOf("<outstanding-state>"), handoff.indexOf("</outstanding-state>"));
    expect(section).toContain("FAIL apps/plugin-dev tests");
    expect(section).toContain("The acceptance criterion is not satisfied.");
    expect(section).toContain("apps/plugin-dev/src/a.ts:12");
    expect(handoff.match(/<outstanding-state>/g)).toHaveLength(1);
    expect(handoff).toContain("Do the thing.");
  });

  it("reports round out of ceiling, the current tier, and the repeat count on one history line", () => {
    const handoff = compose(gateRound(EMPTY_RESEED_OUTSTANDING, "boom"), 3, "complex", 2);

    const line = handoff.split("\n").find((entry) => entry.startsWith("Re-seed round")) ?? "";
    expect(line).toContain("round 3/4");
    expect(line).toContain("`complex`");
    expect(line).toContain("2");
    expect(handoff).toContain("<reseed-history>");
    expect(reseedHistoryLine({ round: 1, ceiling: 2, tier: "validate", repeats: 0 })).toBe(
      "Re-seed round 1/2 · tier `validate` · repeated failure 0.",
    );
  });

  it("stays inside the existing tail bound however many rounds accumulate", () => {
    const longTail = Array.from({ length: 400 }, (_, idx) => `line ${idx}`).join("\n");
    let state = EMPTY_RESEED_OUTSTANDING;
    const sizes: number[] = [];
    for (let round = 1; round <= 5; round += 1) {
      state = reviewRound(gateRound(state, `${longTail}\nround ${round} failed`), [
        { path: "apps/plugin-dev/src/a.ts", line: round, body: `Finding for round ${round}.`.repeat(20) },
      ]);
      sizes.push(compose(state, round).split("\n").length);
    }

    const tail = compose(state, 5);
    const validation = tail
      .slice(tail.indexOf("<validation-tail>") + "<validation-tail>\n".length, tail.indexOf("</validation-tail>"))
      .trimEnd();
    expect(validation.split("\n").length).toBeLessThanOrEqual(RESEED_TAIL_LINES);
    expect(validation).toContain("round 5 failed");
    expect(validation).not.toContain("line 0\n");
    // The prompt is composed from the ORIGINAL handoff every round, so it stays
    // flat instead of growing one correction block per round.
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(RESEED_TAIL_LINES);
  });

  it("keeps a finding raised by more than one source exactly once", () => {
    const finding = { path: "apps/plugin-dev/src/a.ts", line: 7, body: "Missing the null guard." };
    const state = reviewRound(reviewRound(EMPTY_RESEED_OUTSTANDING, [finding]), [
      { ...finding, body: "  MISSING the null   guard.  " },
      { path: "apps/plugin-dev/src/b.ts", line: 1, body: "A second, distinct finding." },
    ]);

    expect(state.review?.findings).toHaveLength(2);
    const handoff = compose(state, 2);
    expect(handoff.match(/Missing the null guard\./g)).toHaveLength(1);
    expect(handoff).toContain("A second, distinct finding.");
    expect(dedupeReseedFindings([finding, finding])).toHaveLength(1);
  });

  it("drops the half that went green — outstanding state, not an archive", () => {
    const both = gateRound(reviewRound(EMPTY_RESEED_OUTSTANDING, [{ body: "Unfixed." }]), "red gate");

    expect(compose(withoutGateOutstanding(both), 2)).not.toContain("red gate");
    expect(compose(withoutGateOutstanding(both), 2)).toContain("Unfixed.");
    expect(compose(withoutReviewOutstanding(both), 2)).not.toContain("Unfixed.");
    expect(compose(withoutReviewOutstanding(both), 2)).toContain("red gate");
  });

  it("counts a repeat only while the failure signature holds", () => {
    const first = noteReseedSignature(EMPTY_RESEED_OUTSTANDING, "v1:aaa");
    const repeat = noteReseedSignature(first, "v1:aaa");
    const changed = noteReseedSignature(repeat, "v1:bbb");

    expect(first.repeats).toBe(0);
    expect(repeat.repeats).toBe(1);
    expect(changed.repeats).toBe(0);
  });

  it("keeps the review directives and the diff the findings were raised against", () => {
    const state = withReviewOutstanding(EMPTY_RESEED_OUTSTANDING, {
      summary: "One blocking gap.",
      findings: [{ path: "apps/plugin-dev/src/a.ts", line: 3, body: "Fix this." }],
      diff: "diff --git a/apps/plugin-dev/src/a.ts b/apps/plugin-dev/src/a.ts",
    });

    const handoff = composeReseedHandoff(HANDOFF, {
      tag: "adversarial-review-correction",
      directives: reviewReseedDirectives({ retry: 1, cap: 1 }),
      history: { round: 1, ceiling: 4, tier: "complex", repeats: 0 },
      outstanding: state,
    });

    expect(handoff).toContain("<adversarial-review-correction>");
    expect(handoff).toContain("bounded correction retry 1/1");
    expect(handoff).toContain('<worktree-diff data-untrusted="true">');
    expect(handoff).toContain("diff --git");
    expect(handoff.trimEnd().endsWith("</adversarial-review-correction>")).toBe(true);
  });
});
