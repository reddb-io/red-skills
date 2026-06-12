import { describe, expect, it } from "vitest";
import { evaluateGoalPredicate, type GoalVerdict } from "../src/core/goal-predicate.js";

// The goal predicate (ADR 0057) is the SINGLE OWNER of the closed-issue → outcome
// mapping. This table pins every branch of the pure decision so a drift in the
// mapping (foreign close → claim-lost, own-merge close → done) breaks here, and so
// the uncertainty contract (open / unknown → never terminate) is impossible to
// regress silently.
describe("evaluateGoalPredicate", () => {
  interface Row {
    name: string;
    closed: boolean | undefined;
    ownMerge?: boolean;
    expected: GoalVerdict;
  }
  const TABLE: Row[] = [
    // CLOSED carrying THIS attempt's own merge → the work is already landed → done.
    { name: "closed by own merge → done", closed: true, ownMerge: true, expected: "done" },
    // CLOSED by someone else → another lander won the race → claim-lost.
    { name: "closed by a foreign lander → claim-lost", closed: true, ownMerge: false, expected: "claim-lost" },
    // CLOSED with no own-merge signal at all → treat as foreign (never claim credit).
    { name: "closed, own-merge unknown → claim-lost", closed: true, expected: "claim-lost" },
    // Still OPEN → the goal is not yet reflected in the world → keep running.
    { name: "open issue → continue", closed: false, ownMerge: false, expected: "continue" },
    { name: "open issue, own-merge irrelevant → continue", closed: false, ownMerge: true, expected: "continue" },
    // gh / network read failed → uncertainty → NEVER terminate on it.
    { name: "unknown state (read failed) → continue", closed: undefined, expected: "continue" },
  ];

  for (const row of TABLE) {
    it(row.name, () => {
      expect(evaluateGoalPredicate({ closed: row.closed, ownMerge: row.ownMerge })).toBe(row.expected);
    });
  }

  it("only a definite CLOSED (true) ever terminates", () => {
    // Exhaustive over the boolean|undefined state domain: nothing but `true`
    // produces a terminating verdict, so a flaky read can never kill an attempt.
    for (const closed of [false, undefined] as const) {
      expect(evaluateGoalPredicate({ closed, ownMerge: true })).toBe("continue");
      expect(evaluateGoalPredicate({ closed, ownMerge: false })).toBe("continue");
    }
  });
});
