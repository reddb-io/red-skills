import { describe, expect, it } from "vitest";
import { recommendHitlIssue, selectHitlQueue, type HitlCandidate } from "../src/core/hitl-selection.js";

function issue(input: Partial<HitlCandidate> & Pick<HitlCandidate, "number">): HitlCandidate {
  return {
    title: `Issue ${input.number}`,
    body: "",
    labels: ["ready-for-human"],
    ...input,
  };
}

describe("HITL queue selection", () => {
  it("selects ready-for-human issues and excludes Specs", () => {
    const queue = selectHitlQueue([
      issue({ number: 1, labels: ["ready-for-human", "type:spec"] }),
      issue({ number: 2, labels: ["ready-for-agent"] }),
      issue({ number: 3, labels: ["ready-for-human"] }),
    ]);

    expect(queue.map((candidate) => candidate.number)).toEqual([3]);
  });

  it("sorts urgent, then high, then ordinary; oldest first inside each band", () => {
    const queue = selectHitlQueue([
      issue({ number: 4, createdAt: "2026-01-04T00:00:00Z" }),
      issue({ number: 2, labels: ["ready-for-human", "priority:high"], createdAt: "2026-01-02T00:00:00Z" }),
      issue({ number: 5, labels: ["ready-for-human", "priority:urgent"], createdAt: "2026-01-05T00:00:00Z" }),
      issue({ number: 1, labels: ["ready-for-human", "priority:urgent"], createdAt: "2026-01-01T00:00:00Z" }),
      issue({ number: 3, labels: ["ready-for-human", "priority:high"], createdAt: "2026-01-03T00:00:00Z" }),
    ]);

    expect(queue.map((candidate) => candidate.number)).toEqual([1, 5, 2, 3, 4]);
  });

  it("falls back to issue number ordering when createdAt is absent or invalid", () => {
    const queue = selectHitlQueue([
      issue({ number: 12, createdAt: "not-a-date" }),
      issue({ number: 10 }),
      issue({ number: 11, createdAt: null }),
    ]);

    expect(queue.map((candidate) => candidate.number)).toEqual([10, 11, 12]);
  });

  it("recommends the first non-skipped candidate", () => {
    const candidates = [
      issue({ number: 1, labels: ["ready-for-human", "priority:urgent"] }),
      issue({ number: 2, labels: ["ready-for-human", "priority:high"] }),
      issue({ number: 3 }),
    ];

    expect(recommendHitlIssue(candidates)?.number).toBe(1);
    expect(recommendHitlIssue(candidates, { skipped: [1] })?.number).toBe(2);
    expect(recommendHitlIssue(candidates, { skipped: [1, 2, 3] })).toBeNull();
  });

  it("returns an empty queue when there is no live HITL work", () => {
    expect(
      selectHitlQueue([
        issue({ number: 1, labels: ["ready-for-agent"] }),
        issue({ number: 2, labels: ["ready-for-human", "type:spec"] }),
      ]),
    ).toEqual([]);
  });
});
