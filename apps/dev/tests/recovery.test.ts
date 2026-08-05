import { describe, expect, it } from "vitest";
import { recoveryDecision, recoveryCap } from "../src/core/recovery.js";
import { type RecoveryReason } from "../src/core/worker-outcome.js";

// recoveryDecision is a PURE policy: (reason, attemptN, env) → retry | escalate.
// Recoverable reasons retry while attemptN < cap, then escalate. Non-recoverable
// reasons (spec / validation) always escalate. Caps come from RED_AFK_RETRY_*
// env knobs; a missing or non-numeric value falls back to the default cap.

describe("recoveryDecision — recoverable reasons honour the cap", () => {
  const cases: Array<{ reason: RecoveryReason; knob: string; cap: number }> = [
    { reason: "merge-conflict", knob: "RED_AFK_RETRY_MERGE", cap: 3 },
    { reason: "crashed", knob: "RED_AFK_RETRY_CRASH", cap: 1 },
    { reason: "quota", knob: "RED_AFK_RETRY_QUOTA", cap: 3 },
    { reason: "runner-transient", knob: "RED_AFK_RETRY_RUNNER_TRANSIENT", cap: 3 },
    { reason: "policy", knob: "RED_AFK_RETRY_POLICY", cap: 1 },
  ];

  for (const { reason, cap } of cases) {
    it(`${reason}: retries while attemptN < default cap ${cap}, escalates at/over the cap`, () => {
      // under the cap → retry
      expect(recoveryDecision(reason, 1, {})).toBe(cap > 1 ? "retry" : "escalate");
      for (let n = 1; n < cap; n++) {
        expect(recoveryDecision(reason, n, {})).toBe("retry");
      }
      // at the cap → escalate
      expect(recoveryDecision(reason, cap, {})).toBe("escalate");
      // over the cap → escalate
      expect(recoveryDecision(reason, cap + 5, {})).toBe("escalate");
    });
  }
});

describe("recoveryDecision — the supervisor stalled re-claim cap (#402)", () => {
  it("retries under the default cap of 3, escalates at/over it", () => {
    expect(recoveryDecision("stalled", 1, {})).toBe("retry");
    expect(recoveryDecision("stalled", 2, {})).toBe("retry");
    expect(recoveryDecision("stalled", 3, {})).toBe("escalate");
    expect(recoveryDecision("stalled", 4, {})).toBe("escalate");
  });

  it("RED_AFK_RETRY_STALLED overrides the cap; garbage falls back to the default", () => {
    expect(recoveryDecision("stalled", 4, { RED_AFK_RETRY_STALLED: "5" })).toBe("retry");
    expect(recoveryDecision("stalled", 5, { RED_AFK_RETRY_STALLED: "5" })).toBe("escalate");
    expect(recoveryDecision("stalled", 3, { RED_AFK_RETRY_STALLED: "nope" })).toBe("escalate");
    expect(recoveryCap("stalled", {})).toBe(3);
    expect(recoveryCap("stalled", { RED_AFK_RETRY_STALLED: "8" })).toBe(8);
  });
});

describe("recoveryDecision — non-recoverable reasons always escalate", () => {
  for (const reason of ["spec", "validation"]) {
    it(`${reason} escalates at every attempt`, () => {
      expect(recoveryDecision(reason, 1, {})).toBe("escalate");
      expect(recoveryDecision(reason, 99, {})).toBe("escalate");
    });
  }
});

describe("recoveryDecision — semantic `validation` stays non-recoverable (regression)", () => {
  // AFK runner improvement: ONLY the infra-classed failure is recoverable.
  // The semantic `validation` failure (the worker's tests actually failed)
  // must still escalate at every attempt — otherwise a worker that really
  // has a broken test would loop forever.
  it("`validation` still returns null from recoveryCap (non-recoverable)", () => {
    expect(recoveryCap("validation", {})).toBeNull();
    expect(recoveryCap("validation", {})).toBeNull();
  });
  it("`validation` still escalates at every attempt", () => {
    expect(recoveryDecision("validation", 1, {})).toBe("escalate");
    expect(recoveryDecision("validation", 99, {})).toBe("escalate");
  });
});

describe("recoveryDecision — env caps override the default", () => {
  it("a numeric env knob raises the cap (merge-conflict retries to the new cap)", () => {
    const env = { RED_AFK_RETRY_MERGE: "5" };
    expect(recoveryDecision("merge-conflict", 4, env)).toBe("retry");
    expect(recoveryDecision("merge-conflict", 5, env)).toBe("escalate");
  });

  it("a numeric env knob lowers the cap to 1 (crash-style, escalate at attempt 1)", () => {
    const env = { RED_AFK_RETRY_QUOTA: "1" };
    expect(recoveryDecision("quota", 1, env)).toBe("escalate");
  });

  it("a non-numeric env value falls back to the default cap", () => {
    expect(recoveryDecision("merge-conflict", 1, { RED_AFK_RETRY_MERGE: "lots" })).toBe("retry");
    expect(recoveryDecision("merge-conflict", 3, { RED_AFK_RETRY_MERGE: "lots" })).toBe("escalate");
  });

  it("a missing env value falls back to the default cap", () => {
    expect(recoveryDecision("crashed", 1, {})).toBe("escalate"); // cap 1
    expect(recoveryDecision("quota", 2, {})).toBe("retry"); // cap 3
  });

  it("a zero / negative env value falls back to the default cap", () => {
    expect(recoveryDecision("quota", 2, { RED_AFK_RETRY_QUOTA: "0" })).toBe("retry");
    expect(recoveryDecision("quota", 2, { RED_AFK_RETRY_QUOTA: "-4" })).toBe("retry");
  });
});

describe("recoveryCap — resolves the effective cap for the escalation comment", () => {
  it("returns the default cap when the knob is unset", () => {
    expect(recoveryCap("merge-conflict", {})).toBe(3);
    expect(recoveryCap("crashed", {})).toBe(1);
    expect(recoveryCap("quota", {})).toBe(3);
    expect(recoveryCap("runner-transient", {})).toBe(3);
    expect(recoveryCap("policy", {})).toBe(1);
  });

  it("returns the env override when numeric", () => {
    expect(recoveryCap("quota", { RED_AFK_RETRY_QUOTA: "7" })).toBe(7);
  });

  it("returns null for non-recoverable reasons", () => {
    expect(recoveryCap("spec", {})).toBeNull();
    expect(recoveryCap("validation", {})).toBeNull();
    expect(recoveryCap("validation-infra", {})).toBeNull();
  });
});
