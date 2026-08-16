import { describe, expect, it } from "vitest";
import { dispose, policyKeyFor, type Disposition } from "../src/core/disposition.js";
import type { WorkerOutcome } from "../src/core/worker-outcome.js";

// dispose() is the PURE attempt-disposition composer: it turns an WorkerOutcome
// + the real attempt number + the env into ONE Disposition descriptor, composing
// recoveryReasonFor / recoveryDecision / recoveryCap / blockedLabelFor /
// envelopeStatusFor plus the standard escalation comment. It owns the TOTAL
// outcome → policy-key map — including `stalled`, which the per-issue
// recoveryReasonFor view omits.

// The full expected descriptor for every outcome, at attempt 1 (UNDER the cap
// where the cap > 1) and at the cap (escalate). `cap` is the default cap from
// recovery.ts; `null` marks a non-recoverable outcome (always escalate, no
// retry budget, no escalation comment).
interface Row {
  outcome: WorkerOutcome;
  typedLabel: string | null;
  envelopeStatus: Disposition["envelopeStatus"];
  policyKey: string | null;
  cap: number | null;
}

const ROWS: Row[] = [
  // recoverable transient classes
  { outcome: "merge-conflict", typedLabel: "blocked:merge-conflict", envelopeStatus: "merge-conflict", policyKey: "merge-conflict", cap: 3 },
  { outcome: "no-sentinel", typedLabel: "blocked:runner", envelopeStatus: "no-sentinel", policyKey: "crashed", cap: 1 },
  { outcome: "hook-aborted", typedLabel: "blocked:policy", envelopeStatus: "blocked", policyKey: "policy", cap: 1 },
  { outcome: "exhausted", typedLabel: "blocked:quota", envelopeStatus: "blocked", policyKey: "quota", cap: 3 },
  { outcome: "runner-transient", typedLabel: "blocked:runner-transient", envelopeStatus: "blocked", policyKey: "runner-transient", cap: 3 },
  // the TOTAL-map addition: stalled is recoverable through the composer (#402),
  // even though the per-issue recoveryReasonFor view returns null for it.
  { outcome: "stalled", typedLabel: "blocked:stalled", envelopeStatus: "blocked", policyKey: "stalled", cap: 3 },
  { outcome: "spin:monologue", typedLabel: "blocked:spin", envelopeStatus: "blocked", policyKey: null, cap: null },
  // non-recoverable: always escalate, no retry budget
  { outcome: "blocked", typedLabel: "blocked:spec", envelopeStatus: "blocked", policyKey: null, cap: null },
  { outcome: "feedback-failed", typedLabel: "blocked:validation", envelopeStatus: "blocked", policyKey: null, cap: null },
  { outcome: "feedback-failed-infra", typedLabel: "blocked:validation-infra", envelopeStatus: "blocked", policyKey: null, cap: null },
  { outcome: "host-config", typedLabel: "blocked:host-config", envelopeStatus: "blocked", policyKey: null, cap: null },
  { outcome: "infra", typedLabel: "blocked:infra", envelopeStatus: "blocked", policyKey: null, cap: null },
  { outcome: "done", typedLabel: null, envelopeStatus: "done", policyKey: null, cap: null },
  { outcome: "claim-lost", typedLabel: null, envelopeStatus: "blocked", policyKey: null, cap: null },
  { outcome: "review-requested", typedLabel: null, envelopeStatus: "blocked", policyKey: null, cap: null },
];

describe("policyKeyFor — TOTAL outcome → policy-key map", () => {
  for (const row of ROWS) {
    it(`${row.outcome} → ${row.policyKey ?? "null"}`, () => {
      expect(policyKeyFor(row.outcome)).toBe(row.policyKey);
    });
  }

  it("returns `stalled` for the stalled outcome (recoveryReasonFor omits it)", () => {
    expect(policyKeyFor("stalled")).toBe("stalled");
  });
});

describe("dispose — full descriptor per outcome × {under cap, at cap}", () => {
  for (const row of ROWS) {
    const recoverable = row.cap !== null;

    it(`${row.outcome}: under cap`, () => {
      // attempt 1 is under the cap only when cap > 1; for cap-1 reasons (crashed,
      // policy) and non-recoverable reasons attempt 1 already escalates.
      const underCap = recoverable && row.cap! > 1;
      const disp = dispose(row.outcome, 1, {});

      expect(disp.typedLabel).toBe(row.typedLabel);
      expect(disp.envelopeStatus).toBe(row.envelopeStatus);
      expect(disp.cap).toBe(row.cap);

      if (underCap) {
        expect(disp.decision).toBe("retry");
        expect(disp.removeLabels).toEqual(["running"]);
        expect(disp.addLabels).toEqual(["ready-for-agent"]);
        expect(disp.escalationComment).toBeNull();
      } else {
        expect(disp.decision).toBe("escalate");
        expect(disp.removeLabels).toEqual(["running"]);
        expect(disp.addLabels).toEqual(
          row.typedLabel !== null ? ["ready-for-human", row.typedLabel] : ["ready-for-human"],
        );
        // A recoverable reason whose budget just ran out announces the page; a
        // never-recoverable reason escalates silently (no retry-budget comment).
        if (recoverable) {
          expect(disp.escalationComment).toBe(
            `🤖 /afk escalating to ready-for-human: ${row.typedLabel} retry budget exhausted (attempt 1/${row.cap}).`,
          );
        } else {
          expect(disp.escalationComment).toBeNull();
        }
      }
    });

    it(`${row.outcome}: at cap → escalate`, () => {
      const attemptN = row.cap ?? 1;
      const disp = dispose(row.outcome, attemptN, {});

      expect(disp.decision).toBe("escalate");
      expect(disp.typedLabel).toBe(row.typedLabel);
      expect(disp.envelopeStatus).toBe(row.envelopeStatus);
      expect(disp.cap).toBe(row.cap);
      expect(disp.removeLabels).toEqual(["running"]);
      expect(disp.addLabels).toEqual(
        row.typedLabel !== null ? ["ready-for-human", row.typedLabel] : ["ready-for-human"],
      );
      if (recoverable) {
        expect(disp.escalationComment).toBe(
          `🤖 /afk escalating to ready-for-human: ${row.typedLabel} retry budget exhausted (attempt ${attemptN}/${row.cap}).`,
        );
      } else {
        expect(disp.escalationComment).toBeNull();
      }
    });
  }

  it("stalled: retries under the cap, then escalates at the cap (no literal-string bypass)", () => {
    // attempt 1, 2 → retry CLEAN; attempt 3 (== default cap) → escalate carrying
    // blocked:stalled + the budget-exhausted page comment. This is the exact
    // bounded re-claim the supervisor reaper relies on, now through the composer.
    expect(dispose("stalled", 1, {}).decision).toBe("retry");
    expect(dispose("stalled", 2, {}).decision).toBe("retry");

    const atCap = dispose("stalled", 3, {});
    expect(atCap.decision).toBe("escalate");
    expect(atCap.addLabels).toEqual(["ready-for-human", "blocked:stalled"]);
    expect(atCap.escalationComment).toBe(
      "🤖 /afk escalating to ready-for-human: blocked:stalled retry budget exhausted (attempt 3/3).",
    );
  });

  it("per-issue view (stalledRecoverable:false) escalates stalled at attempt 1 (reaper owns the re-claim)", () => {
    // The per-issue lifecycle never auto-retries stalled — routeRecovery passes
    // this view so the bounded re-claim stays the reaper's job. Every NON-stalled
    // outcome is unaffected by the option.
    const disp = dispose("stalled", 1, {}, { stalledRecoverable: false });
    expect(disp.decision).toBe("escalate");
    expect(disp.addLabels).toEqual(["ready-for-human", "blocked:stalled"]);
    // No retry budget in the per-issue view → escalates silently (no page comment).
    expect(disp.cap).toBeNull();
    expect(disp.escalationComment).toBeNull();

    // A non-stalled recoverable outcome is identical under either view.
    expect(dispose("exhausted", 1, {}, { stalledRecoverable: false })).toEqual(
      dispose("exhausted", 1, {}),
    );
  });

  it("honours a RED_AFK_RETRY_* env knob override for the cap", () => {
    const env = { RED_AFK_RETRY_STALLED: "1" };
    // cap lowered to 1 → attempt 1 already escalates.
    const disp = dispose("stalled", 1, env);
    expect(disp.cap).toBe(1);
    expect(disp.decision).toBe("escalate");
  });
});
