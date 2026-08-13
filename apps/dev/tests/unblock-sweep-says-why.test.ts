// The sweep's silence used to be unreadable (#3801): a dependency gate stayed
// shut with every blocker closed, and `promoted: []` was the entire answer — so
// telling "no candidate carried the label" from "a blocker still reads open"
// from "the transition was refused" meant re-running the core by hand.
//
// Each case below is one of those silences, now spoken.
import { describe, expect, it } from "vitest";
import { executeUnblockSweep, type UnblockSweepGh } from "../src/core/boot-sweep.js";

function recordingGh(): UnblockSweepGh & { edits: number[] } {
  const edits: number[] = [];
  return {
    edits,
    async editLabels(issue) {
      edits.push(issue);
    },
    async comment() {},
  };
}

describe("the unblock sweep says why it did not promote", () => {
  it("names the blockers that are not confirmed closed", async () => {
    const report = await executeUnblockSweep(
      [{ number: 3801, body: "", labels: ["blocked:dependency", "req:3800", "req:3799"] }],
      async (issue) => (issue === 3800 ? "CLOSED" : "OPEN"),
      recordingGh(),
    );

    expect(report.promoted).toEqual([]);
    // The number an operator checks against the tracker, not a bare "held".
    expect(report.outcomes).toEqual([
      { issue: 3801, outcome: "held", reason: "blocker(s) not confirmed closed: #3799" },
    ]);
  });

  it("says a candidate declares nothing to wait for, rather than dropping it", async () => {
    const report = await executeUnblockSweep(
      [{ number: 42, body: "no blocked-by section here", labels: ["blocked:dependency"] }],
      async () => "CLOSED",
      recordingGh(),
    );

    expect(report.promoted).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({ issue: 42, outcome: "held" });
    expect(report.outcomes[0]?.reason).toMatch(/nothing declares what it waits for/);
  });

  it("says a listed candidate carries no dependency label at all", async () => {
    const report = await executeUnblockSweep(
      [{ number: 7, body: "", labels: ["ready-for-agent"] }],
      async () => "CLOSED",
      recordingGh(),
    );

    expect(report.outcomes).toEqual([
      { issue: 7, outcome: "held", reason: "listed as a candidate but carries no blocked:dependency label" },
    ]);
  });

  it("still promotes, and says which lane it routed to", async () => {
    const gh = recordingGh();
    const report = await executeUnblockSweep(
      [{ number: 3801, body: "", labels: ["blocked:dependency", "req:3800"] }],
      async () => "CLOSED",
      gh,
    );

    expect(report.promoted).toEqual([3801]);
    expect(gh.edits).toEqual([3801]);
    expect(report.outcomes).toEqual([
      { issue: 3801, outcome: "promoted", reason: "every blocker closed; routed to the agent lane" },
    ]);
  });
});
