import { describe, expect, it } from "vitest";
import {
  CARD_OPEN,
  CARD_CLOSE,
  CARD_STATUS_OPEN,
  CARD_STATUS_CLOSE,
  renderCard,
  updateCardStatus,
  isHitlCard,
  parseCardCommand,
  classifyNaturalLanguage,
  evaluateHitlCardActionRate,
  HITL_CARD_ACTION_MARKER,
  HITL_CARD_STAND_DOWN_MARKER,
  parseCiChecks,
  shouldIgnoreHitlCardComment,
  type PrStatus,
} from "../src/core/hitl-card.js";

const EMPTY_PR: PrStatus = { ci: "none", ciPassed: 0, ciTotal: 0, mergeability: "UNKNOWN" };
const GREEN_PR: PrStatus = { number: 42, ci: "pass", ciPassed: 4, ciTotal: 4, mergeability: "MERGEABLE", headSha: "abc1234" };

// ---------- renderCard ----------

describe("renderCard", () => {
  it("wraps output in open/close markers", () => {
    const card = renderCard({ issueNumber: 10, pendingDecision: "Merge PR #42?", prStatus: GREEN_PR, updatedAt: "2026-01-01 12:00 UTC" });
    expect(card.startsWith(CARD_OPEN)).toBe(true);
    expect(card.endsWith(CARD_CLOSE)).toBe(true);
  });

  it("includes the pending decision", () => {
    const card = renderCard({ issueNumber: 10, pendingDecision: "Approve merge of PR #42", prStatus: GREEN_PR, updatedAt: "2026-01-01 12:00 UTC" });
    expect(card).toContain("Approve merge of PR #42");
  });

  it("renders the card issue as title+number link when metadata is present", () => {
    const card = renderCard({
      issueNumber: 10,
      issueTitle: "Wayfinder fidelity restoration",
      issueUrl: "https://github.com/reddb-io/red-skills/issues/10",
      pendingDecision: "test",
      prStatus: GREEN_PR,
      updatedAt: "2026-01-01 12:00 UTC",
    });
    expect(card).toContain(
      "## Decision card — [Wayfinder fidelity restoration (#10)](https://github.com/reddb-io/red-skills/issues/10)",
    );
  });

  it("falls back to the bare issue number when card metadata is missing", () => {
    const card = renderCard({ issueNumber: 10, pendingDecision: "test", prStatus: GREEN_PR, updatedAt: "2026-01-01 12:00 UTC" });
    expect(card).toContain("## Decision card — #10");
  });

  it("includes status section markers", () => {
    const card = renderCard({ issueNumber: 10, pendingDecision: "test", prStatus: GREEN_PR, updatedAt: "2026-01-01 12:00 UTC" });
    expect(card).toContain(CARD_STATUS_OPEN);
    expect(card).toContain(CARD_STATUS_CLOSE);
  });

  it("shows PR number and head SHA in status table", () => {
    const card = renderCard({ issueNumber: 10, pendingDecision: "test", prStatus: GREEN_PR, updatedAt: "2026-01-01 12:00 UTC" });
    expect(card).toContain("#42");
    expect(card).toContain("`abc1234`");
  });

  it("shows MERGEABLE check emoji", () => {
    const card = renderCard({ issueNumber: 10, pendingDecision: "test", prStatus: GREEN_PR, updatedAt: "2026-01-01 12:00 UTC" });
    expect(card).toContain("✅ MERGEABLE");
  });

  it("shows CONFLICTING check emoji", () => {
    const conflicting: PrStatus = { ...GREEN_PR, mergeability: "CONFLICTING" };
    const card = renderCard({ issueNumber: 10, pendingDecision: "test", prStatus: conflicting, updatedAt: "2026-01-01 12:00 UTC" });
    expect(card).toContain("❌ CONFLICTING");
  });

  it("shows em-dash when no PR", () => {
    const card = renderCard({ issueNumber: 10, pendingDecision: "test", prStatus: EMPTY_PR, updatedAt: "2026-01-01 12:00 UTC" });
    // PR cell, CI cell, head cell all —
    expect(card.match(/—/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("includes all four slash-command options", () => {
    const card = renderCard({ issueNumber: 10, pendingDecision: "test", prStatus: EMPTY_PR, updatedAt: "2026-01-01 12:00 UTC" });
    expect(card).toContain("/approve");
    expect(card).toContain("/approve-ci");
    expect(card).toContain("/reject");
    expect(card).toContain("/requeue");
  });
});

// ---------- updateCardStatus ----------

describe("updateCardStatus", () => {
  it("replaces the status section with updated data", () => {
    const original = renderCard({ issueNumber: 5, pendingDecision: "dec", prStatus: EMPTY_PR, updatedAt: "before" });
    const updated = updateCardStatus(original, GREEN_PR, "after");
    expect(updated).toContain("after");
    expect(updated).toContain("#42");
    expect(updated).not.toContain("before");
  });

  it("leaves content outside the status markers unchanged", () => {
    const original = renderCard({ issueNumber: 5, pendingDecision: "my decision text", prStatus: EMPTY_PR, updatedAt: "before" });
    const updated = updateCardStatus(original, GREEN_PR, "after");
    expect(updated).toContain("my decision text");
    expect(updated.startsWith(CARD_OPEN)).toBe(true);
    expect(updated.endsWith(CARD_CLOSE)).toBe(true);
  });

  it("is idempotent — calling twice with same status produces the same output", () => {
    const original = renderCard({ issueNumber: 5, pendingDecision: "dec", prStatus: EMPTY_PR, updatedAt: "before" });
    const once = updateCardStatus(original, GREEN_PR, "now");
    const twice = updateCardStatus(once, GREEN_PR, "now");
    expect(once).toBe(twice);
  });

  it("returns the original body when no status markers are found", () => {
    const body = "some arbitrary comment without markers";
    expect(updateCardStatus(body, GREEN_PR, "now")).toBe(body);
  });
});

// ---------- isHitlCard ----------

describe("isHitlCard", () => {
  it("returns true for a rendered card", () => {
    const card = renderCard({ issueNumber: 1, pendingDecision: "x", prStatus: EMPTY_PR, updatedAt: "now" });
    expect(isHitlCard(card)).toBe(true);
  });

  it("returns false for a regular comment", () => {
    expect(isHitlCard("just a regular comment")).toBe(false);
  });

  it("returns false for an envelope comment", () => {
    expect(isHitlCard('<details data-attempt-status="blocked">...</details>')).toBe(false);
  });
});

// ---------- parseCardCommand ----------

describe("parseCardCommand", () => {
  it("parses /approve", () => {
    expect(parseCardCommand("/approve")).toEqual({ action: "approve", args: "" });
  });

  it("parses /approve-ci (before /approve prefix)", () => {
    expect(parseCardCommand("/approve-ci")).toEqual({ action: "approve-ci", args: "" });
  });

  it("parses /reject without reason", () => {
    expect(parseCardCommand("/reject")).toEqual({ action: "reject", args: "" });
  });

  it("parses /reject with reason", () => {
    expect(parseCardCommand("/reject too many lint errors")).toEqual({ action: "reject", args: "too many lint errors" });
  });

  it("parses /requeue with guidance", () => {
    expect(parseCardCommand("/requeue fix the type errors in src/foo.ts")).toEqual({
      action: "requeue",
      args: "fix the type errors in src/foo.ts",
    });
  });

  it("is case-insensitive on the slash verb", () => {
    expect(parseCardCommand("/APPROVE")?.action).toBe("approve");
    expect(parseCardCommand("/Reject")?.action).toBe("reject");
  });

  it("ignores content after the first non-blank line", () => {
    const body = "/approve\nThis issue has a PR with content:\n/reject me please";
    expect(parseCardCommand(body)).toEqual({ action: "approve", args: "" });
  });

  it("skips leading blank lines", () => {
    expect(parseCardCommand("\n\n/requeue try again")).toEqual({ action: "requeue", args: "try again" });
  });

  it("returns undefined for unrecognised commands", () => {
    expect(parseCardCommand("/merge")).toBeUndefined();
    expect(parseCardCommand("just a comment")).toBeUndefined();
    expect(parseCardCommand("")).toBeUndefined();
  });

  it("returns undefined for a blank body", () => {
    expect(parseCardCommand("   \n  ")).toBeUndefined();
  });
});

// ---------- self-reaction + runaway guards ----------

describe("HITL card comment guards", () => {
  it("ignores a bot-authored /requeue-shaped refusal before intent parsing", () => {
    expect(shouldIgnoreHitlCardComment({
      author: "github-actions[bot]",
      authorType: "Bot",
      body: "/requeue Cannot requeue: blocked:infra is not in the supported set",
      allowedAuthors: ["maintainer"],
    })).toBe(true);
  });

  it("ignores an unallowlisted PAT-backed User before parsing a plain refusal", () => {
    expect(shouldIgnoreHitlCardComment({
      author: "release-maintainer",
      authorType: "User",
      body: "/requeue Cannot requeue: blocked:infra is not supported",
      allowedAuthors: ["maintainer"],
    })).toBe(true);
  });

  it("ignores the card's bot-marker reply even when its author is allowlisted", () => {
    expect(shouldIgnoreHitlCardComment({
      author: "maintainer",
      authorType: "User",
      body: "🤖 **requeue**: Cannot requeue: use /hitl",
      allowedAuthors: ["maintainer"],
    })).toBe(true);
  });

  it("allows a human maintainer directive", () => {
    expect(shouldIgnoreHitlCardComment({
      author: "maintainer",
      authorType: "User",
      body: "/requeue retry after the runner recovered",
      allowedAuthors: ["maintainer"],
    })).toBe(false);
  });

  it("caps actions at three per issue in ten minutes and requests one stand-down comment", () => {
    const now = new Date("2026-07-22T08:00:00Z");
    const comments = [0, 1, 2].map((minute) => ({
      body: `${HITL_CARD_ACTION_MARKER}\naction ${minute}`,
      createdAt: `2026-07-22T07:5${minute}:00Z`,
      author: "github-actions[bot]",
      authorType: "Bot",
    }));

    expect(evaluateHitlCardActionRate(comments, now, [
      { login: "github-actions[bot]", type: "Bot" },
    ])).toEqual({
      actionCount: 3,
      limited: true,
      shouldPostStandDown: true,
    });
  });

  it("does not count pasted or quoted markers from non-card identities", () => {
    const now = new Date("2026-07-22T08:00:00Z");
    const comments = [
      {
        body: `${HITL_CARD_ACTION_MARKER}\npasted by a human`,
        createdAt: "2026-07-22T07:55:00Z",
        author: "contributor",
        authorType: "User",
      },
      {
        body: `quoted receipt: ${HITL_CARD_ACTION_MARKER}`,
        createdAt: "2026-07-22T07:56:00Z",
        author: "github-actions[bot]",
        authorType: "Bot",
      },
      {
        body: "<summary>HITL card: requeue</summary>",
        createdAt: "2026-07-22T07:57:00Z",
        author: "github-actions[bot]",
        authorType: "Bot",
      },
    ];

    expect(evaluateHitlCardActionRate(comments, now, [
      { login: "github-actions[bot]", type: "Bot" },
    ])).toEqual({
      actionCount: 0,
      limited: false,
      shouldPostStandDown: false,
    });
  });

  it("does not post a second stand-down comment in the same window", () => {
    const now = new Date("2026-07-22T08:00:00Z");
    const comments = [0, 1, 2].map((minute) => ({
      body: `${HITL_CARD_ACTION_MARKER}\naction ${minute}`,
      createdAt: `2026-07-22T07:5${minute}:00Z`,
      author: "github-actions[bot]",
      authorType: "Bot",
    }));
    comments.push({
      body: `${HITL_CARD_STAND_DOWN_MARKER}\n🤖 HITL card loop suspected; standing down.`,
      createdAt: "2026-07-22T07:59:00Z",
      author: "github-actions[bot]",
      authorType: "Bot",
    });

    expect(evaluateHitlCardActionRate(comments, now, [
      { login: "github-actions[bot]", type: "Bot" },
    ])).toMatchObject({
      limited: true,
      shouldPostStandDown: false,
    });
  });
});

// ---------- classifyNaturalLanguage ----------

describe("classifyNaturalLanguage", () => {
  it("maps 'LGTM' to approve", () => {
    expect(classifyNaturalLanguage("LGTM, looks good to me")?.action).toBe("approve");
  });

  it("maps 'yes, merge it' to approve", () => {
    expect(classifyNaturalLanguage("yes, merge it")?.action).toBe("approve");
  });

  it("maps 'reject this' to reject", () => {
    expect(classifyNaturalLanguage("please reject this change")?.action).toBe("reject");
  });

  it("maps 'requeue with another pass' to requeue", () => {
    const cmd = classifyNaturalLanguage("needs another pass before merging");
    expect(cmd?.action).toBe("requeue");
  });

  it("returns undefined when intent is ambiguous (multiple keywords)", () => {
    expect(classifyNaturalLanguage("approve or reject?")).toBeUndefined();
  });

  it("returns undefined for unrelated text", () => {
    expect(classifyNaturalLanguage("what is the status of this PR?")).toBeUndefined();
  });

  it("preserves the full body as args for requeue", () => {
    const guidance = "try again with a different approach";
    const cmd = classifyNaturalLanguage(guidance);
    expect(cmd?.args).toBe(guidance);
  });
});

// ---------- parseCiChecks ----------

describe("parseCiChecks", () => {
  it("returns none for empty checks", () => {
    expect(parseCiChecks([])).toEqual({ ci: "none", ciPassed: 0, ciTotal: 0 });
  });

  it("returns pass when all checks succeed", () => {
    const checks = [{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" }];
    expect(parseCiChecks(checks)).toEqual({ ci: "pass", ciPassed: 3, ciTotal: 3 });
  });

  it("returns fail when any check fails", () => {
    const checks = [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }];
    expect(parseCiChecks(checks)).toEqual({ ci: "fail", ciPassed: 1, ciTotal: 2 });
  });

  it("returns pending when checks are in progress", () => {
    const checks = [{ conclusion: "SUCCESS" }, { conclusion: null }];
    expect(parseCiChecks(checks)).toEqual({ ci: "pending", ciPassed: 1, ciTotal: 2 });
  });

  it("prioritises fail over pending", () => {
    const checks = [{ conclusion: "FAILURE" }, { conclusion: null }];
    expect(parseCiChecks(checks)).toEqual({ ci: "fail", ciPassed: 0, ciTotal: 2 });
  });
});
