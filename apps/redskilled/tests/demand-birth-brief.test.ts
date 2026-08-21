import { describe, expect, it } from "vitest";

import {
  demandBriefVerdict,
  describeDemandBriefGap,
  queueBriefing,
  refuseUnbriefableBirth,
  unbriefableBirthRefusal,
} from "../src/demand-birth-brief.js";

/**
 * A birth the daemon cannot brief is a birth it does not perform.
 *
 * #4292: a prompt-only turn for an item-scoped birth echoes and dies, the item
 * stays queued, and the planner asks again on the next tick — 58 Workers in a
 * quarter of an hour, each paying a worktree clone and a host slot.
 */
const registration = { trunk: { branch: "main" } };
const ticket = { id: "518", title: "the tokens drift between themes", labels: ["bug", "ready-for-agent"] };
const birth = { project_label: "reddb-io/design-system", work_item: "518" };
const listed = [{ project_label: "reddb-io/design-system", briefing: "listed" as const, tickets: [ticket] }];

describe("which fact stops a birth being briefed", () => {
  it("briefs when the poll listed the item and the registration states a trunk", () => {
    expect(demandBriefVerdict(registration, ticket)).toEqual({ briefed: true });
    expect(unbriefableBirthRefusal(registration, birth, listed)).toBeNull();
  });

  it("names the count-only poll, which counted a depth it holds no Ticket for", () => {
    const counted = [{ project_label: "reddb-io/design-system", briefing: "count-only" as const }];

    expect(demandBriefVerdict(registration, undefined, counted[0])).toEqual({
      briefed: false,
      gap: "count-only-poll",
    });
    expect(unbriefableBirthRefusal(registration, birth, counted)).toBe(
      "the daemon cannot brief a Worker for item 518: the last queue poll counted this project without listing " +
        "it, so it holds no Ticket to hand over, so a birth would echo its prompt and die with the item still queued",
    );
  });

  it("names the absent Ticket when a listing poll listed some other item", () => {
    const other = [{ project_label: "reddb-io/design-system", briefing: "listed" as const, tickets: [{ ...ticket, id: "7" }] }];

    expect(unbriefableBirthRefusal(registration, birth, other)).toContain("listed no Ticket for that item");
  });

  it("names the empty title, which the Worker's own handoff would refuse", () => {
    const empty = [{ ...listed[0]!, tickets: [{ ...ticket, title: "" }] }];

    expect(demandBriefVerdict(registration, { ...ticket, title: "" })).toEqual({ briefed: false, gap: "empty-title" });
    expect(unbriefableBirthRefusal(registration, birth, empty)).toContain("carries an empty title");
  });

  it("names the missing trunk branch, which is what the live loop was short of", () => {
    expect(demandBriefVerdict({}, ticket)).toEqual({ briefed: false, gap: "no-trunk-branch" });
    expect(demandBriefVerdict(undefined, ticket)).toEqual({ briefed: false, gap: "no-trunk-branch" });
    expect(unbriefableBirthRefusal({}, birth, listed)).toBe(
      "the daemon cannot brief a Worker for item 518: this project's registration states no trunk branch, so a " +
        "birth would echo its prompt and die with the item still queued",
    );
  });

  it("names an unusable number rather than briefing a Ticket nobody can open", () => {
    expect(demandBriefVerdict(registration, { ...ticket, id: "not-a-number" }).gap).toBe("unusable-number");
    expect(demandBriefVerdict(registration, { ...ticket, id: "0" }).gap).toBe("unusable-number");
    expect(describeDemandBriefGap("unusable-number")).toContain("no usable number");
  });

  it("throws the same refusal where the demand loop already catches one", () => {
    expect(() => refuseUnbriefableBirth(registration, birth, listed)).not.toThrow();
    expect(() => refuseUnbriefableBirth({}, birth, listed)).toThrow(/states no trunk branch/);
  });

  it("leaves a prompt-only birth alone — a registration with no work item births as it always did", () => {
    expect(unbriefableBirthRefusal(undefined, { project_label: "reddb-io/design-system" }, [])).toBeNull();
    expect(unbriefableBirthRefusal({}, { project_label: "reddb-io/design-system" }, [])).toBeNull();
  });

  it("finds the briefing the last poll kept for that item, and nothing for another", () => {
    expect(queueBriefing(listed, "reddb-io/design-system", "518")).toEqual(ticket);
    expect(queueBriefing(listed, "reddb-io/design-system", "9")).toBeUndefined();
    expect(queueBriefing(listed, "reddb-io/red-skills", "518")).toBeUndefined();
    expect(queueBriefing(listed, "reddb-io/design-system", undefined)).toBeUndefined();
  });
});
