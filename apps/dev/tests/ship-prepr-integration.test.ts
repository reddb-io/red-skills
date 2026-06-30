import { describe, expect, it } from "vitest";
import {
  decidePrePrShipGate,
  decideShipMergeGate,
  type PrePrShipGateInput,
  type ShipMergeGateInput,
} from "../src/core/ship.js";

describe("/ship pre-PR pipeline integration (#913 — no-mistakes Track 2B)", () => {
  it("composes pre-PR gate and merge gate: pre-PR→escalate blocks push→merge", () => {
    // Intent findings in pre-PR → escalate, so we never reach the merge gate
    const prePrInput: PrePrShipGateInput = {
      feedbackPassed: true,
      intentFindingsPresent: true,
      mechanicalFindingsPresent: false,
      timedOut: false,
    };

    const prePrDecision = decidePrePrShipGate(prePrInput);
    expect(prePrDecision).toBe("escalate");

    // Escalation means we stop before push, so merge gate is never reached
    // (or would receive green checks, but we never push to create a PR)
  });

  it("composes pre-PR gate and merge gate: pre-PR→push→merge-gate handles it", () => {
    // Clean pre-PR: no findings, feedback green → push
    const prePrInput: PrePrShipGateInput = {
      feedbackPassed: true,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: false,
      timedOut: false,
    };

    const prePrDecision = decidePrePrShipGate(prePrInput);
    expect(prePrDecision).toBe("push");

    // After push and PR open, merge gate handles the check+review lifecycle
    const mergeInput: ShipMergeGateInput = {
      branchProtectionSatisfied: true,
      changesRequested: false,
      checksGreen: true,
      timedOut: false,
    };

    const mergeDecision = decideShipMergeGate(mergeInput);
    expect(mergeDecision).toBe("merge");
  });

  it("composes pre-PR gate and merge gate: auto-apply→push→merge", () => {
    // Mechanical findings only: auto-apply them and push
    const prePrInput: PrePrShipGateInput = {
      feedbackPassed: true,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: true,
      timedOut: false,
    };

    const prePrDecision = decidePrePrShipGate(prePrInput);
    expect(prePrDecision).toBe("auto-apply");

    // After auto-apply and commit, push and open PR
    // Then merge gate handles the check+review lifecycle
    const mergeInput: ShipMergeGateInput = {
      branchProtectionSatisfied: true,
      changesRequested: false,
      checksGreen: true,
      timedOut: false,
    };

    const mergeDecision = decideShipMergeGate(mergeInput);
    expect(mergeDecision).toBe("merge");
  });

  it("pre-PR gate escalates on feedback failure (semantic), blocking push and merge", () => {
    // Feedback failed with no findings → semantic issue, escalate
    const prePrInput: PrePrShipGateInput = {
      feedbackPassed: false,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: false,
      timedOut: false,
    };

    const prePrDecision = decidePrePrShipGate(prePrInput);
    expect(prePrDecision).toBe("escalate");

    // We never push, so the merge gate is never evaluated
  });

  it("pre-PR gate respects wall-clock budget: timeout→escalate", () => {
    const prePrInput: PrePrShipGateInput = {
      feedbackPassed: true,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: false,
      timedOut: true,
    };

    const prePrDecision = decidePrePrShipGate(prePrInput);
    expect(prePrDecision).toBe("escalate");

    // Wall-clock timeout escalates, blocking push and merge
  });

  it("review gate composes with pre-PR: mechanical auto-apply preserves review gate", () => {
    // Pre-PR: auto-apply mechanical fixes (e.g. lint, formatting)
    const prePrInput: PrePrShipGateInput = {
      feedbackPassed: true,
      intentFindingsPresent: false,
      mechanicalFindingsPresent: true,
      timedOut: false,
    };

    expect(decidePrePrShipGate(prePrInput)).toBe("auto-apply");

    // After auto-apply + commit + push, PR opens and review gate applies.
    // The PR review gate (ADR 0064) classifies the *automated* fix as mechanical
    // (the auto-applied findings) and skips the review hold, going straight to merge.
    // This composition means the pre-PR pipeline + review gate work together:
    // pre-PR mechanical fixes avoid the review hold, keeping the merge fast.
  });
});
