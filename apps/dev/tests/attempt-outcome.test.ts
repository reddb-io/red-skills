import { describe, expect, it } from "vitest";
import {
  blockedLabelFor,
  envelopeStatusFor,
  recoveryReasonFor,
  type AttemptOutcome,
  type RecoveryReason,
} from "../src/core/attempt-outcome.js";
import type { AttemptStatus } from "../src/core/envelope.js";

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
  { outcome: "runner-transient", label: "blocked:runner-transient", recovery: "runner-transient" },
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
      "runner-transient",
      "stalled",
      "infra",
    ];
    const covered = TABLE.map((r) => r.outcome).sort();
    expect(covered).toEqual([...ALL].sort());
    expect(TABLE.length).toBe(ALL.length);
  });

  it("recoveryReasonFor only ever returns the four recoverable policy keys (or null)", () => {
    const valid = new Set<RecoveryReason>(["quota", "runner-transient", "merge-conflict", "crashed", "policy"]);
    for (const row of TABLE) {
      const r = recoveryReasonFor(row.outcome);
      if (r !== null) expect(valid.has(r)).toBe(true);
    }
  });
});

// envelopeStatusFor is the THIRD facet of the outcome vocabulary: the terminal
// Envelope `data-attempt-status` emitted for the outcome. This EXHAUSTIVE table
// pins every member, so a drift away from the real emitFailure(common, <status>)
// call sites in process-issue breaks here. The only non-identity rows are the
// ones the lifecycle deliberately re-buckets: feedback-failed emits a `blocked`
// envelope (not a `feedback-failed` one), and the non-emitting outcomes fold into
// the generic `blocked` failure bucket.
describe("attempt-outcome — exhaustive outcome → envelope status table", () => {
  const STATUS_TABLE: Array<{ outcome: AttemptOutcome; status: AttemptStatus }> = [
    { outcome: "done", status: "done" },
    { outcome: "no-sentinel", status: "no-sentinel" },
    { outcome: "merge-conflict", status: "merge-conflict" },
    { outcome: "blocked", status: "blocked" },
    // feedback-failed emits a `blocked` envelope, NOT a `feedback-failed` one.
    { outcome: "feedback-failed", status: "blocked" },
    // non-emitting outcomes (no live emitFailure call) fold into `blocked`.
    { outcome: "hook-aborted", status: "blocked" },
    { outcome: "exhausted", status: "blocked" },
    { outcome: "runner-transient", status: "blocked" },
    { outcome: "claim-lost", status: "blocked" },
    { outcome: "stalled", status: "blocked" },
    { outcome: "infra", status: "blocked" },
  ];

  for (const row of STATUS_TABLE) {
    it(`${row.outcome} → envelope status ${row.status}`, () => {
      expect(envelopeStatusFor(row.outcome)).toBe(row.status);
    });
  }

  it("covers every AttemptOutcome member exactly once", () => {
    const ALL: AttemptOutcome[] = [
      "done",
      "blocked",
      "no-sentinel",
      "merge-conflict",
      "feedback-failed",
      "claim-lost",
      "hook-aborted",
      "exhausted",
      "runner-transient",
      "stalled",
      "infra",
    ];
    const covered = STATUS_TABLE.map((r) => r.outcome).sort();
    expect(covered).toEqual([...ALL].sort());
    expect(STATUS_TABLE.length).toBe(ALL.length);
  });
});
