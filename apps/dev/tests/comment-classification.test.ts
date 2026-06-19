import { describe, expect, it } from "vitest";
import type { Comment } from "../src/core/comment-classification.js";
import {
  classifyComment,
  countBlockedSinceGuidance,
  extractDirectives,
  isBootStamp,
  isDirectiveCarrier,
  isEnvelope,
  isHeartbeatGlyph,
  isHumanGuidance,
  isPromotionAudit,
  parseDevDirective,
  threadLacksDirectiveMarker,
} from "../src/core/comment-classification.js";

// ---------- fixtures (mirrors comment-classifier.test.sh) ----------

const envelopeBody =
  '<details data-attempt-status="blocked"><summary>worker `w1` · status: blocked · duration: 0m30s</summary>\n\nbody\n</details>';
const bootStampBody =
  "🤖 /afk started at `2026-05-19T10:00:00-03:00` on runner `claude` (worker `wT`).";
const promotionBody = "🤖 /afk promoted to ready-for-agent.";
const heartbeatBody = ":three:";
const markerOnlyBody = '<details data-kind="directive">\nrelax the second acceptance criterion\n</details>';
const markerMixedBody =
  'Thanks for the patience. Please retry with:\n\n<details data-kind="directive">\nuse the v2 endpoint, not v1\n</details>\n\nshout if it is still stuck.';
const malformedNoCloseBody = 'here you go:\n\n<details data-kind="directive">\nthis marker never closes';
const plainNarrativeBody = "i wonder whether the API surface should change here\n\njust thinking out loud";

describe("comment predicates", () => {
  it("isEnvelope: starts with data-attempt-status and has a close", () => {
    expect(isEnvelope(envelopeBody)).toBe(true);
    expect(isEnvelope(markerOnlyBody)).toBe(false);
    expect(isEnvelope('<details data-attempt-status="done">no close here')).toBe(false);
  });

  it("isBootStamp / isPromotionAudit", () => {
    expect(isBootStamp(bootStampBody)).toBe(true);
    expect(isBootStamp(promotionBody)).toBe(false);
    expect(isPromotionAudit(promotionBody)).toBe(true);
    expect(isPromotionAudit(bootStampBody)).toBe(false);
  });

  it("isHeartbeatGlyph: glyph after stripping all whitespace", () => {
    expect(isHeartbeatGlyph(":three:")).toBe(true);
    expect(isHeartbeatGlyph("  :six:\n")).toBe(true);
    expect(isHeartbeatGlyph(":seven:")).toBe(false);
    expect(isHeartbeatGlyph("x:one:")).toBe(false);
  });

  it("isHumanGuidance: not blank, envelope, or noise", () => {
    expect(isHumanGuidance(plainNarrativeBody)).toBe(true);
    expect(isHumanGuidance(markerMixedBody)).toBe(true);
    expect(isHumanGuidance("")).toBe(false);
    expect(isHumanGuidance("   \n\t")).toBe(false);
    expect(isHumanGuidance(envelopeBody)).toBe(false);
    expect(isHumanGuidance(bootStampBody)).toBe(false);
    expect(isHumanGuidance(promotionBody)).toBe(false);
    expect(isHumanGuidance(heartbeatBody)).toBe(false);
  });

  it("isDirectiveCarrier: substring open + later close, not noise", () => {
    expect(isDirectiveCarrier(markerOnlyBody)).toBe(true);
    expect(isDirectiveCarrier(markerMixedBody)).toBe(true);
    expect(isDirectiveCarrier(malformedNoCloseBody)).toBe(false);
    expect(isDirectiveCarrier(plainNarrativeBody)).toBe(false);
    // envelope embedding a directive marker is still not a directive carrier
    expect(
      isDirectiveCarrier(
        '<details data-attempt-status="blocked"><summary>s</summary>\n<details data-kind="directive">\nx\n</details>\n</details>',
      ),
    ).toBe(false);
  });
});

describe("classifyComment", () => {
  it("envelope body", () => {
    expect(classifyComment({ body: envelopeBody })).toBe("envelope");
  });
  it("boot stamp body", () => {
    expect(classifyComment({ body: bootStampBody })).toBe("boot-stamp");
  });
  it("promotion audit body", () => {
    expect(classifyComment({ body: promotionBody })).toBe("promotion-audit");
  });
  it("heartbeat glyph body", () => {
    expect(classifyComment({ body: heartbeatBody })).toBe("heartbeat-glyph");
  });
  it("marker-only body → directive", () => {
    expect(classifyComment({ body: markerOnlyBody })).toBe("directive");
  });
  it("mixed marker+narrative → directive", () => {
    expect(classifyComment({ body: markerMixedBody })).toBe("directive");
  });
  it("malformed marker body → discussion", () => {
    expect(classifyComment({ body: malformedNoCloseBody })).toBe("discussion");
  });
  it("blank body → discussion", () => {
    expect(classifyComment({ body: "" })).toBe("discussion");
  });
  it("whitespace-only body → discussion", () => {
    expect(classifyComment({ body: "   \n\t\n" })).toBe("discussion");
  });
  it("plain narrative body → discussion", () => {
    expect(classifyComment({ body: plainNarrativeBody })).toBe("discussion");
  });

  it("precedence: envelope wins over embedded directive marker", () => {
    const body =
      '<details data-attempt-status="blocked"><summary>s</summary>\n<details data-kind="directive">\nx\n</details>\n</details>';
    expect(classifyComment({ body })).toBe("envelope");
  });

  it("precedence: boot stamp before directive detection", () => {
    // a boot stamp that also embeds a (malformed) marker stays boot-stamp
    expect(classifyComment({ body: bootStampBody })).toBe("boot-stamp");
  });
});

describe("extractDirectives", () => {
  it("zero markers → empty list", () => {
    expect(extractDirectives(plainNarrativeBody)).toEqual([]);
  });

  it("one marker → one element, verbatim content", () => {
    expect(extractDirectives(markerMixedBody)).toEqual(["use the v2 endpoint, not v1"]);
  });

  it("two markers → two elements in document order", () => {
    const two =
      'first:\n<details data-kind="directive">\nalpha\n</details>\nthen:\n<details data-kind="directive">\nbeta\n</details>\ndone';
    expect(extractDirectives(two)).toEqual(["alpha", "beta"]);
  });

  it("no closing tag → 0 elements", () => {
    expect(extractDirectives(malformedNoCloseBody)).toEqual([]);
  });

  it("attributed close → not a valid close → 0 elements", () => {
    expect(extractDirectives('<details data-kind="directive">\nbody\n</details foo>')).toEqual([]);
  });

  it("opened never closed → 0 elements", () => {
    expect(extractDirectives('<details data-kind="directive">\nunterminated')).toEqual([]);
  });

  it("nested <details> → 1 element, verbatim incl inner block", () => {
    const nested =
      '<details data-kind="directive">\ndo this, e.g.:\n<details>\n<summary>example</summary>\nsnippet\n</details>\nthen stop\n</details>';
    expect(extractDirectives(nested)).toEqual([
      "do this, e.g.:\n<details>\n<summary>example</summary>\nsnippet\n</details>\nthen stop",
    ]);
  });

  it("literal </details> inside a fence does not terminate the parse", () => {
    const fenced =
      '<details data-kind="directive">\nrun this:\n```\necho "</details>"\n```\nand report back\n</details>';
    expect(extractDirectives(fenced)).toEqual(['run this:\n```\necho "</details>"\n```\nand report back']);
  });

  it("CRLF: trailing \\r stripped from tags and content", () => {
    const crlf = '<details data-kind="directive">\r\nwindows line endings\r\n</details>\r\n';
    expect(extractDirectives(crlf)).toEqual(["windows line endings"]);
  });
});

describe("thread helpers", () => {
  const env = (status: string): Comment => ({
    body: `<details data-attempt-status="${status}"><summary>s</summary>\nbody\n</details>`,
  });
  const directive: Comment = { body: markerOnlyBody };
  const noise: Comment = { body: bootStampBody };
  const discussion: Comment = { body: plainNarrativeBody };

  it("countBlockedSinceGuidance: counts trailing blocked envelopes", () => {
    expect(countBlockedSinceGuidance([env("blocked"), env("blocked")])).toBe(2);
  });

  it("countBlockedSinceGuidance: noise/discussion skipped without reset", () => {
    expect(countBlockedSinceGuidance([env("blocked"), noise, discussion, env("blocked")])).toBe(2);
  });

  it("countBlockedSinceGuidance: directive carrier breaks the run", () => {
    expect(countBlockedSinceGuidance([env("blocked"), directive, env("blocked")])).toBe(1);
  });

  it("countBlockedSinceGuidance: non-blocked envelope breaks the run", () => {
    expect(countBlockedSinceGuidance([env("blocked"), env("done"), env("blocked")])).toBe(1);
  });

  it("countBlockedSinceGuidance: empty thread → 0", () => {
    expect(countBlockedSinceGuidance([])).toBe(0);
  });

  it("threadLacksDirectiveMarker: true when no directive carrier present", () => {
    expect(threadLacksDirectiveMarker([env("blocked"), noise, discussion])).toBe(true);
  });

  it("threadLacksDirectiveMarker: false when a directive carrier exists", () => {
    expect(threadLacksDirectiveMarker([discussion, directive])).toBe(false);
  });
});

// ---------- `/dev` slash-verb summon grammar (issue #750) ----------

describe("parseDevDirective — `/dev` summon grammar", () => {
  it("parses `/dev <verb>` with lowercased verb and trailing args", () => {
    expect(parseDevDirective("/dev explain why CI is red")).toEqual({
      summon: "slash",
      verb: "explain",
      args: "why CI is red",
    });
  });

  it("is case-insensitive on the verb and tolerates leading blank lines", () => {
    expect(parseDevDirective("\n\n  /dev REVIEW  ")).toEqual({
      summon: "slash",
      verb: "review",
      args: "",
    });
  });

  it("ignores a comment with no `/dev` verb and no @mention (returns undefined)", () => {
    expect(parseDevDirective(plainNarrativeBody)).toBeUndefined();
    expect(parseDevDirective("please fix the flaky test")).toBeUndefined();
    expect(parseDevDirective("")).toBeUndefined();
    // a `/dev` that is not the first token is NOT a summon
    expect(parseDevDirective("run /dev explain later")).toBeUndefined();
  });

  it("returns an empty verb for a bare `/dev` (router rejects it)", () => {
    expect(parseDevDirective("/dev")).toEqual({ summon: "slash", verb: "", args: "" });
  });

  it("parses an @mention summon (with and without an inner `/dev`)", () => {
    const opts = { mentions: ["red-dev"] };
    expect(parseDevDirective("@red-dev explain this diff", opts)).toEqual({
      summon: "mention",
      verb: "explain",
      args: "this diff",
    });
    expect(parseDevDirective("@red-dev /dev review", opts)).toEqual({
      summon: "mention",
      verb: "review",
      args: "",
    });
  });

  it("ignores an @mention of an unknown handle", () => {
    expect(parseDevDirective("@someone-else explain this", { mentions: ["red-dev"] })).toBeUndefined();
    // no mentions configured → a bare @mention is not a summon
    expect(parseDevDirective("@red-dev explain this")).toBeUndefined();
  });
});
