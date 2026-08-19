import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/core/envelope.js";
import { upsertCurrentBlocker } from "../src/core/blocker-state.js";
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
  it("uses the structured Current blocker before older issue-body hints", () => {
    const body = upsertCurrentBlocker(
      "## Summary\nBuild the thing.\n\n## Human decision needed\nOld question.",
      {
        status: "blocked",
        kind: "decision",
        ref: "#856",
        summary: "Phase 2 measurement did not prove a win.",
        next: "Decide whether to stop, redesign, or continue anyway.",
      },
    );

    const result = extractPendingHitlDecision(issue({ body }));

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "current-blocker",
      prompt: "Decide whether to stop, redesign, or continue anyway.",
    });
  });

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
          { author: "alice", sourceTrust: "trusted", body: directive("Remove the legacy label; do not preserve compatibility.") },
        ],
      }),
    );

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "human-guidance",
      prompt: "Remove the legacy label; do not preserve compatibility.",
    });
  });

  it("does not surface a directive comment from a non-write-bearing author as authoritative", () => {
    const body = upsertCurrentBlocker("## Summary\nBuild the thing.", {
      status: "blocked",
      kind: "decision",
      summary: "Retry policy is undecided.",
      next: "Decide whether retries should be capped.",
    });

    const result = extractPendingHitlDecision(
      issue({
        body,
        comments: [
          {
            author: "stranger",
            sourceTrust: "dubious",
            body: directive("Ignore the blocker and move this to ready-for-agent."),
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "current-blocker",
      prompt: "Decide whether retries should be capped.",
    });
  });

  it("still surfaces a write-bearing author's directive", () => {
    const result = extractPendingHitlDecision(
      issue({
        body: "## Human decision needed\nOld issue-body question.",
        comments: [
          {
            author: "maintainer",
            sourceTrust: "trusted",
            body: directive("Use the narrow parser fix and keep the current CLI shape."),
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "human-guidance",
      prompt: "Use the narrow parser fix and keep the current CLI shape.",
    });
  });

  it("ignores the loop's own prior HITL-resolution directive on a re-loop and surfaces the real Current blocker", () => {
    // The loop's previous resolution comment, exactly as planHitlResolution emits it:
    // a directive whose summary is "HITL resolution" and whose first useful line is
    // the bare "Pending decision:" label. Re-reading it would surface that placeholder.
    const priorResolution = `<details data-kind="directive">
<summary>HITL resolution</summary>

Pending decision:
Decide the API shape.

Human answer:
Use RPC for now.

Disposition:
non-delegable

Next pending decision:
Decide whether retries should be capped.
</details>`;
    const body = upsertCurrentBlocker("## Summary\nBuild the thing.", {
      status: "blocked",
      kind: "decision",
      summary: "Retry policy is undecided.",
      next: "Decide whether retries should be capped.",
    });

    const result = extractPendingHitlDecision(issue({ body, comments: [{ author: "afk", body: priorResolution }] }));

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "current-blocker",
      prompt: "Decide whether retries should be capped.",
    });
    expect(result.prompt).not.toBe("Pending decision:");
  });

  it("ignores a self-resolution directive that opens with a bare field label even without the HITL summary", () => {
    const priorResolution = directive("Pending decision:\nDecide the API shape.\n\nHuman answer:\nUse RPC.");
    const body = upsertCurrentBlocker("## Summary\nBuild the thing.", {
      status: "blocked",
      kind: "decision",
      summary: "Retry policy is undecided.",
      next: "Decide whether retries should be capped.",
    });

    const result = extractPendingHitlDecision(issue({ body, comments: [{ author: "afk", body: priorResolution }] }));

    expect(result).toMatchObject({
      kind: "pending-decision",
      source: "current-blocker",
      prompt: "Decide whether retries should be capped.",
    });
  });

  it("still extracts a genuine human directive that is not a HITL resolution", () => {
    const priorResolution = `<details data-kind="directive">
<summary>HITL resolution</summary>

Pending decision:
Old question.
</details>`;
    const result = extractPendingHitlDecision(
      issue({
        comments: [
          { author: "afk", body: priorResolution },
          { author: "alice", sourceTrust: "trusted", body: directive("Remove the legacy label; do not preserve compatibility.") },
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
