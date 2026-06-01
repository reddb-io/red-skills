import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/core/envelope.js";
import { extractPendingHitlDecision, type HitlDecisionIssue } from "../src/core/hitl-decision-extraction.js";

function directive(content: string): string {
  return `<details data-kind="directive">\n<summary>directive</summary>\n${content}\n</details>`;
}

function issue(input: Partial<HitlDecisionIssue>): HitlDecisionIssue {
  return {
    number: 42,
    title: "Resolve HITL blocker",
    body: "",
    comments: [],
    ...input,
  };
}

describe("extractPendingHitlDecision", () => {
  it("uses an explicit issue-body human decision section", () => {
    const result = extractPendingHitlDecision(
      issue({
        body: "## Summary\nBuild the thing.\n\n## Human decision needed\n- Choose whether `$hitl` should skip closed issues.",
      }),
    );

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "issue-body",
      prompt: "Choose whether `$hitl` should skip closed issues.",
    });
  });

  it("uses latest directive human guidance over conflicting discussion", () => {
    const result = extractPendingHitlDecision(
      issue({
        comments: [
          { author: "bob", body: "Should we keep the legacy label around?" },
          { author: "alice", body: directive("Remove the legacy label; do not preserve compatibility.") },
        ],
      }),
    );

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "human-guidance",
      prompt: "Remove the legacy label; do not preserve compatibility.",
    });
  });

  it("uses the latest blocked envelope when there is no authoritative decision section", () => {
    const envelope = buildEnvelope({
      status: "blocked",
      worker: "wTEST",
      duration: "1m0s",
      diff: "+1 -0",
      attempt: 1,
      sections: [{ name: "notes", body: "Need maintainer to choose whether retries should be capped." }],
    });

    const result = extractPendingHitlDecision(issue({ comments: [{ body: envelope }] }));

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "envelope",
    });
    expect(result.prompt).toContain("Need maintainer to choose whether retries should be capped.");
  });

  it("uses a decision-like thread discussion when it is the only hint", () => {
    const result = extractPendingHitlDecision(
      issue({ comments: [{ author: "bob", body: "Which API should this command expose?" }] }),
    );

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "thread-discussion",
      prompt: "Which API should this command expose?",
    });
  });

  it("returns ambiguous when non-authoritative hints conflict", () => {
    const envelope = buildEnvelope({
      status: "blocked",
      worker: "wTEST",
      duration: "1m0s",
      diff: "+1 -0",
      attempt: 1,
      sections: [{ name: "notes", body: "Need a decision about the queue ordering." }],
    });

    const result = extractPendingHitlDecision(
      issue({ comments: [{ body: envelope }, { author: "bob", body: "Should the selector use a shortlist?" }] }),
    );

    expect(result).toMatchObject({
      kind: "ambiguous",
      prompt: "State the pending human decision for #42: Resolve HITL blocker",
    });
    if (result.kind === "ambiguous") {
      expect(result.reasons).toContain("Multiple non-authoritative decision hints were found.");
    }
  });

  it("returns ambiguous when no pending decision can be found", () => {
    const result = extractPendingHitlDecision(issue({ body: "## Summary\nNo decision here.", comments: [] }));

    expect(result).toMatchObject({
      kind: "ambiguous",
      prompt: "State the pending human decision for #42: Resolve HITL blocker",
    });
  });
});
