import { describe, expect, it } from "vitest";
import {
  blockedLabelFor,
  recoveryReasonFor,
  type AttemptOutcome,
  type RecoveryReason,
} from "../src/core/attempt-outcome.js";

// attempt-outcome is the SINGLE OWNER of the AFK outcome vocabulary. This is an
// EXHAUSTIVE table: every `AttemptOutcome` value → its expected `blockedLabelFor`
// label and its expected `recoveryReasonFor` policy key. Pinning the full union
// here makes the 3-enum-desync bug class impossible — any new outcome or any
// drifted mapping breaks this table.

interface Row {
  outcome: AttemptOutcome;
  label: string | null;
  recovery: RecoveryReason | null;
}

// One row PER AttemptOutcome member. If a member is added without a row, the
// `covers every AttemptOutcome member` assertion below fails.
const TABLE: Row[] = [
  // recoverable: carry both a typed label and a recovery policy key
  { outcome: "exhausted", label: "blocked:quota", recovery: "quota" },
  { outcome: "no-sentinel", label: "blocked:crashed", recovery: "crashed" },
  { outcome: "hook-aborted", label: "blocked:policy", recovery: "policy" },
  { outcome: "merge-conflict", label: "blocked:merge-conflict", recovery: "merge-conflict" },
  // typed label, but NOT auto-recoverable (route straight to a human)
  { outcome: "blocked", label: "blocked:spec", recovery: null },
  { outcome: "feedback-failed", label: "blocked:validation", recovery: null },
  { outcome: "stalled", label: "blocked:stalled", recovery: null },
  { outcome: "infra", label: "blocked:infra", recovery: null },
  // no typed label, no recovery (success / abandoned)
  { outcome: "done", label: null, recovery: null },
  { outcome: "claim-lost", label: null, recovery: null },
];

describe("attempt-outcome — exhaustive outcome → (label, recovery) table", () => {
  for (const row of TABLE) {
    it(`${row.outcome} → label ${row.label} · recovery ${row.recovery}`, () => {
      expect(blockedLabelFor(row.outcome)).toBe(row.label);
      expect(recoveryReasonFor(row.outcome)).toBe(row.recovery);
    });
  }

  it("covers every AttemptOutcome member exactly once", () => {
    // The full union, spelled out independently of the table so a missing or
    // duplicated row is caught.
    const ALL: AttemptOutcome[] = [
      "done",
      "blocked",
      "no-sentinel",
      "merge-conflict",
      "feedback-failed",
      "claim-lost",
      "hook-aborted",
      "exhausted",
      "stalled",
      "infra",
    ];
    const covered = TABLE.map((r) => r.outcome).sort();
    expect(covered).toEqual([...ALL].sort());
    expect(TABLE.length).toBe(ALL.length);
  });

  it("recoveryReasonFor only ever returns the four recoverable policy keys (or null)", () => {
    const valid = new Set<RecoveryReason>(["quota", "merge-conflict", "crashed", "policy"]);
    for (const row of TABLE) {
      const r = recoveryReasonFor(row.outcome);
      if (r !== null) expect(valid.has(r)).toBe(true);
    }
  });
});
