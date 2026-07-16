import { describe, expect, it } from "vitest";
import {
  CARD_CLOSE,
  CARD_OPEN,
  buildEnvelope,
  isHitlCard,
  parseCardCommand,
  parseCiChecks,
  postEnvelope,
  postHitlCard,
  renderCard,
  updateCardStatus,
  type PrStatus,
} from "./terminal-events.js";
import type { TrackerPort } from "./tracker/port.js";

const EMPTY_PR: PrStatus = {
  ci: "none",
  ciPassed: 0,
  ciTotal: 0,
  mergeability: "UNKNOWN",
};
const GREEN_PR: PrStatus = {
  number: 42,
  ci: "pass",
  ciPassed: 4,
  ciTotal: 4,
  mergeability: "MERGEABLE",
  headSha: "abc1234",
};

function fakeTracker(): Pick<TrackerPort, "commentOnIssue"> & {
  comments: Array<{ issue: number; body: string }>;
} {
  const comments: Array<{ issue: number; body: string }> = [];
  return {
    comments,
    async commentOnIssue(issue, body) {
      comments.push({ issue, body });
    },
  };
}

describe("castle terminal envelope v1", () => {
  it("matches the current dev envelope fixture byte-for-byte", () => {
    expect(
      buildEnvelope({
        status: "done",
        worker: "wZ2R4",
        duration: "2m5s",
        diff: "merged",
        attempt: 1,
        mergeSha: "abc1234",
        sections: [{ name: "validation", body: "tests: pass" }],
      }),
    )
      .toBe(`<details data-attempt-status="done"><summary>worker \`wZ2R4\` · status: done · duration: 2m5s · diff: merged · attempt: 1 · merge: abc1234</summary>

<details data-section="validation"><summary>validation</summary>

tests: pass

</details>

</details>
`);
  });

  it("escapes section names in the current dev v1 shape", () => {
    expect(
      buildEnvelope({
        status: "blocked",
        worker: "w",
        duration: "1s",
        diff: "+1 -0",
        attempt: 1,
        sections: [{ name: "x<y", body: "ok" }],
      }),
    ).toContain('data-section="x&lt;y"><summary>x&lt;y</summary>');
  });

  it("posts the rendered envelope through the tracker port", async () => {
    const tracker = fakeTracker();
    const body = await postEnvelope(tracker, 1908, {
      status: "done",
      worker: "wZ2R4",
      duration: "2m5s",
      diff: "merged",
      attempt: 1,
    });

    expect(tracker.comments).toEqual([{ issue: 1908, body }]);
    expect(body).toContain('data-attempt-status="done"');
  });
});

describe("castle HITL card v1", () => {
  it("matches the current dev HITL-card fixture byte-for-byte", () => {
    expect(
      renderCard({
        issueNumber: 10,
        issueTitle: "Wayfinder fidelity restoration",
        issueUrl: "https://github.com/reddb-io/red-skills/issues/10",
        pendingDecision: "Approve merge of PR #42",
        prStatus: GREEN_PR,
        updatedAt: "2026-01-01 12:00 UTC",
      }),
    ).toBe(`<!-- red:hitl-card v1 -->
## Decision card — [Wayfinder fidelity restoration (#10)](https://github.com/reddb-io/red-skills/issues/10)

> **Pending decision:** Approve merge of PR #42

### Status

<!-- red:hitl-card:status -->
| PR | CI | Mergeability | Head |
|----|----|----|------|
| #42 | ✅ 4/4 | ✅ MERGEABLE | \`abc1234\` |

_Refreshed: 2026-01-01 12:00 UTC_
<!-- /red:hitl-card:status -->

### Available actions

Post a comment with one of:

- \`/approve\` — merge the linked PR and close this issue
- \`/approve-ci\` — merge when all CI checks pass (waits if pending)
- \`/reject [reason]\` — close the PR without merging; reopen for rework
- \`/requeue <guidance>\` — send back to agent with guidance

**Or reply in plain English** — the bot maps your intent to an action.
Your instructions are processed securely; issue and PR content is treated as untrusted data.
<!-- /red:hitl-card -->`);
  });

  it("posts the rendered HITL card through the tracker port", async () => {
    const tracker = fakeTracker();
    const body = await postHitlCard(tracker, 1908, {
      issueNumber: 1908,
      pendingDecision: "Need maintainer approval",
      prStatus: EMPTY_PR,
      updatedAt: "2026-01-01 12:00 UTC",
    });

    expect(tracker.comments).toEqual([{ issue: 1908, body }]);
    expect(body.startsWith(CARD_OPEN)).toBe(true);
    expect(body.endsWith(CARD_CLOSE)).toBe(true);
  });

  it("keeps the current command parsing and status refresh behavior", () => {
    const card = renderCard({
      issueNumber: 5,
      pendingDecision: "dec",
      prStatus: EMPTY_PR,
      updatedAt: "before",
    });
    const updated = updateCardStatus(card, GREEN_PR, "after");

    expect(isHitlCard(card)).toBe(true);
    expect(updated).toContain("after");
    expect(updated).toContain("#42");
    expect(updated).not.toContain("before");
    expect(parseCardCommand("\n/requeue fix tests")).toEqual({
      action: "requeue",
      args: "fix tests",
    });
    expect(parseCiChecks([{ conclusion: "SUCCESS" }])).toEqual({
      ci: "pass",
      ciPassed: 1,
      ciTotal: 1,
    });
  });
});
