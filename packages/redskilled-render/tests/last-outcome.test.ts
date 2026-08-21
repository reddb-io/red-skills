import { describe, expect, it } from "vitest";

import { idleCell, lastOutcomeWord, REDSKILLED_LAST_OUTCOME_WORDS } from "../last-outcome.js";
import type { RedskilledRenderLastOutcome } from "../payload.js";

const NOW = "2026-08-21T12:00:00.000Z";

const ending = (fields: Partial<RedskilledRenderLastOutcome> = {}): RedskilledRenderLastOutcome => ({
  kind: "worker-death",
  ts: "2026-08-21T11:57:00.000Z",
  project_label: "red-skills",
  issue: "#4175",
  phase: "land",
  birth_outcome: "work-reported",
  ...fields,
});

describe("lastOutcomeWord", () => {
  it("names a Worker that reported done from the stage that reaches the trunk", () => {
    expect(lastOutcomeWord(ending())).toBe("landed");
  });

  it("says done, not landed, when the report came from an earlier stage", () => {
    expect(lastOutcomeWord(ending({ phase: "implement" }))).toBe("done");
  });

  it("reads the stage's own refusal mark as a park, whatever the Worker reported", () => {
    expect(lastOutcomeWord(ending({ phase: "gate!", birth_outcome: "work-reported" }))).toBe("parked");
  });

  it("lets a budget kill outrank every other reading of the same ending", () => {
    expect(lastOutcomeWord(ending({ kind: "worker-budget-kill" }))).toBe("killed");
  });

  it("separates a drained queue from a crash", () => {
    expect(lastOutcomeWord(ending({ phase: null, birth_outcome: "no-eligible-work" }))).toBe("no-work");
    expect(lastOutcomeWord(ending({ phase: null, birth_outcome: "unreported" }))).toBe("lost");
  });

  it("names nothing for an ending no declared row claims", () => {
    expect(lastOutcomeWord(ending({ phase: null, birth_outcome: null }))).toBeNull();
  });

  it("gives every declared word a reason a reader can check", () => {
    for (const row of REDSKILLED_LAST_OUTCOME_WORDS) {
      expect(row.why.length).toBeGreaterThan(20);
    }
  });
});

describe("idleCell", () => {
  it("says what just happened, and how long ago", () => {
    expect(idleCell(ending(), "red-skills", NOW)).toBe("idle·landed #4175 3m");
  });

  it("does not repeat a hash the project already published", () => {
    expect(idleCell(ending({ issue: "4175" }), "red-skills", NOW)).toBe("idle·landed #4175 3m");
  });

  it("renders plain idle on a host that has ended no Worker", () => {
    expect(idleCell(null, "red-skills", NOW)).toBe("idle");
    expect(idleCell(undefined, "red-skills", NOW)).toBe("idle");
  });

  it("keeps another project's ending off this project's line", () => {
    expect(idleCell(ending({ project_label: "other/repo" }), "red-skills", NOW)).toBe("idle");
  });

  it("drops the work item a replayed mark could not carry, and keeps the rest", () => {
    const replayed = ending({ issue: null, phase: null, birth_outcome: null, kind: "worker-budget-kill" });
    expect(idleCell(replayed, "red-skills", NOW)).toBe("idle·killed 3m");
  });

  it("keeps the word when the ending carries no readable instant", () => {
    expect(idleCell(ending({ ts: "not-an-instant" }), "red-skills", NOW)).toBe("idle·landed #4175");
  });

  it("dates the ending against the payload's instant, never a clock of its own", () => {
    expect(idleCell(ending(), "red-skills", "2026-08-21T12:12:00.000Z")).toBe("idle·landed #4175 15m");
  });
});
