import { describe, expect, it } from "vitest";
import {
  detectDrift,
  companionFingerprint,
  buildCorrectionNote,
  planCompanionCorrection,
  DEFAULT_COMPANION_THRESHOLDS,
  type CompanionVitals,
  type CompanionThresholds,
} from "../src/core/companion.js";

const T: CompanionThresholds = DEFAULT_COMPANION_THRESHOLDS;
const healthy: CompanionVitals = { iteration: 2, locAdded: 120, locRemoved: 30, waiting: 1 };

describe("detectDrift (#921)", () => {
  it("a productive worker (real diff) never drifts, even at high iteration", () => {
    const v = { ...healthy, iteration: 99, waiting: 99 };
    expect(detectDrift(v, T).drifting).toBe(false);
  });

  it("iteration-churn: high iteration + flat diff", () => {
    const v: CompanionVitals = { iteration: T.iterationChurn, locAdded: 0, locRemoved: 0, waiting: 0 };
    const verdict = detectDrift(v, T);
    expect(verdict.drifting).toBe(true);
    expect(verdict.primary).toBe("iteration-churn");
  });

  it("stuck-waiting: many waiting windows + flat diff", () => {
    const v: CompanionVitals = { iteration: 1, locAdded: 0, locRemoved: 0, waiting: T.waitingWindows };
    expect(detectDrift(v, T).signals).toContain("stuck-waiting");
  });

  it("scope-creep: huge churn dominates (priority over churn)", () => {
    const v: CompanionVitals = {
      iteration: T.iterationChurn,
      locAdded: T.diffDriftLoc,
      locRemoved: 0,
      waiting: 0,
    };
    const verdict = detectDrift(v, T);
    // locAdded is well above the progress floor, so churn/stuck do NOT fire; only
    // scope-creep does — and it is primary.
    expect(verdict.primary).toBe("scope-creep");
    expect(verdict.signals).toEqual(["scope-creep"]);
  });

  it("just-below thresholds do not fire", () => {
    const v: CompanionVitals = {
      iteration: T.iterationChurn - 1,
      locAdded: 0,
      locRemoved: 0,
      waiting: T.waitingWindows - 1,
    };
    expect(detectDrift(v, T).drifting).toBe(false);
  });
});

describe("companionFingerprint (#921)", () => {
  it("is stable for identical inputs and varies by issue/attempt/signal", () => {
    const a = companionFingerprint(42, 2, "iteration-churn");
    expect(companionFingerprint(42, 2, "iteration-churn")).toBe(a);
    expect(companionFingerprint(42, 3, "iteration-churn")).not.toBe(a);
    expect(companionFingerprint(43, 2, "iteration-churn")).not.toBe(a);
    expect(companionFingerprint(42, 2, "scope-creep")).not.toBe(a);
  });
});

describe("buildCorrectionNote (#921)", () => {
  it("returns a non-empty directive per signal", () => {
    for (const signal of ["scope-creep", "iteration-churn", "stuck-waiting"] as const) {
      const note = buildCorrectionNote({ drifting: true, signals: [signal], primary: signal });
      expect(note.length).toBeGreaterThan(20);
    }
  });
});

describe("planCompanionCorrection (#921)", () => {
  const churnVitals: CompanionVitals = { iteration: T.iterationChurn, locAdded: 0, locRemoved: 0, waiting: 0 };
  const base = { issue: 7, attempt: 1, vitals: churnVitals, thresholds: T, cap: 2 };

  it("returns null when the worker is not drifting (monitor stays read-only)", () => {
    expect(planCompanionCorrection({ ...base, vitals: healthy, seenFingerprints: new Set() })).toBeNull();
  });

  it("returns a bounded correction on first drift", () => {
    const plan = planCompanionCorrection({ ...base, seenFingerprints: new Set() });
    expect(plan?.kind).toBe("correct");
    expect(plan?.signal).toBe("iteration-churn");
    if (plan?.kind === "correct") expect(plan.note.length).toBeGreaterThan(0);
  });

  it("is idempotent — the same (issue, attempt, signal) fingerprint is skipped", () => {
    const fp = companionFingerprint(base.issue, base.attempt, "iteration-churn");
    expect(planCompanionCorrection({ ...base, seenFingerprints: new Set([fp]) })).toBeNull();
  });

  it("a fresh attempt gets a fresh correction despite a prior one", () => {
    const fpA1 = companionFingerprint(base.issue, 1, "iteration-churn");
    const plan = planCompanionCorrection({ ...base, attempt: 2, cap: 5, seenFingerprints: new Set([fpA1]) });
    expect(plan?.kind).toBe("correct");
  });

  it("escalates to a human once the per-issue budget is spent", () => {
    const plan = planCompanionCorrection({ ...base, attempt: 2, cap: 2, seenFingerprints: new Set() });
    expect(plan?.kind).toBe("escalate");
  });
});
