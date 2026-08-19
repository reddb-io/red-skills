import { describe, expect, it } from "vitest";
import {
  RESEED_TIER_LADDER,
  RESEED_TOP_TIER,
  decideTierEscalation,
  escalateAfkModelTier,
} from "../src/core/process-issue/tier-escalation.js";
import {
  AFK_RESEED_BUDGET,
  recordReseedDraw,
  reseedDraw,
  type ReseedCause,
  type ReseedSpend,
} from "../src/core/process-issue/reseed-budget.js";
import { EMPTY_FAILURE_SIGNATURE, failureSignature } from "../src/core/failure-signature.js";
import { AFK_MODEL_TIERS } from "../src/core/config.js";

/** Spend `n` rounds on the named causes, so a test reads as a sequence of draws
 * rather than a hand-written tally. */
function spend(...draws: readonly ReseedCause[]): ReseedSpend {
  return draws.reduce<ReseedSpend>((acc, cause) => recordReseedDraw(acc, cause), {});
}

/** A sidecar line for one failing check, so the tests key off REAL signatures
 * rather than hand-written digests. */
function failing(name: string, summary?: string): string {
  return JSON.stringify({
    schema: "red.afk.validation.v1",
    name,
    status: "failed",
    ...(summary ? { summary } : {}),
  });
}

describe("Re-seed tier ladder (ADR 0129 decision 6)", () => {
  it("climbs the model-tier vocabulary in its declared order", () => {
    expect(RESEED_TIER_LADDER).toEqual(AFK_MODEL_TIERS);
    expect(escalateAfkModelTier("validate")).toBe("simple");
    expect(escalateAfkModelTier("simple")).toBe("complex");
    expect(escalateAfkModelTier("complex")).toBe("think");
  });

  it("terminates at the top tier rather than saturating on it", () => {
    expect(RESEED_TOP_TIER).toBe("think");
    expect(escalateAfkModelTier(RESEED_TOP_TIER)).toBeUndefined();
  });
});

describe("Re-seed tier escalation — the trigger is a REPEAT (#2729)", () => {
  it("raises the tier when consecutive rounds carry an identical signature", () => {
    const signature = failureSignature({ sidecar: [failing("test:apps/plugin-dev", "failing: a | b — 2 failed")] });

    expect(
      decideTierEscalation({
        tier: "simple",
        previousSignature: signature,
        signature,
        budget: AFK_RESEED_BUDGET,
      }),
    ).toEqual({ escalate: true, from: "simple", to: "complex" });
  });

  it("leaves the tier alone when the signature changed", () => {
    const previous = failureSignature({ sidecar: [failing("test:apps/plugin-dev", "failing: a | b — 2 failed")] });
    const current = failureSignature({ sidecar: [failing("lint:apps/plugin-dev")] });

    expect(previous).not.toBe(current);
    expect(
      decideTierEscalation({
        tier: "simple",
        previousSignature: previous,
        signature: current,
        budget: AFK_RESEED_BUDGET,
      }),
    ).toEqual({ escalate: false, refusal: "no-repeat" });
  });

  it("leaves the tier alone on the first failing round, which repeats nothing", () => {
    expect(
      decideTierEscalation({
        tier: "simple",
        previousSignature: EMPTY_FAILURE_SIGNATURE,
        signature: failureSignature({ sidecar: [failing("test:apps/plugin-dev")] }),
        budget: AFK_RESEED_BUDGET,
      }),
    ).toEqual({ escalate: false, refusal: "no-repeat" });
  });

  it("leaves the tier alone when a shrinking failure set only LOOKS like a repeat", () => {
    const previous = failureSignature({ sidecar: [failing("test:apps/plugin-dev"), failing("lint:apps/plugin-dev")] });
    const current = failureSignature({ sidecar: [failing("test:apps/plugin-dev")] });

    expect(
      decideTierEscalation({ tier: "simple", previousSignature: previous, signature: current, budget: AFK_RESEED_BUDGET }),
    ).toEqual({ escalate: false, refusal: "no-repeat" });
  });

  it("never reads two unidentifiable rounds as a repeat", () => {
    expect(
      decideTierEscalation({
        tier: "simple",
        previousSignature: EMPTY_FAILURE_SIGNATURE,
        signature: EMPTY_FAILURE_SIGNATURE,
        budget: AFK_RESEED_BUDGET,
      }),
    ).toEqual({ escalate: false, refusal: "no-repeat" });
  });
});

describe("Re-seed tier escalation — the ladder terminates", () => {
  it("parks a repeat on the top tier rather than escalating past it", () => {
    const signature = failureSignature({ sidecar: [failing("test:apps/plugin-dev")] });

    expect(
      decideTierEscalation({
        tier: RESEED_TOP_TIER,
        previousSignature: signature,
        signature,
        budget: AFK_RESEED_BUDGET,
      }),
    ).toEqual({ escalate: false, refusal: "ladder-top" });
  });
});

describe("Re-seed tier escalation — it draws the TIER sub-cap", () => {
  const signature = failureSignature({ sidecar: [failing("test:apps/plugin-dev")] });
  const repeat = (tier: "simple" | "complex", spent: ReseedSpend) =>
    decideTierEscalation({
      tier,
      previousSignature: signature,
      signature,
      budget: AFK_RESEED_BUDGET,
      spend: spent,
    });

  it("escalates on its own share while gate corrections are already spent", () => {
    const spent = spend("gate", "gate");

    expect(repeat("simple", spent)).toEqual({ escalate: true, from: "simple", to: "complex" });
  });

  it("leaves the gate's share whole once the escalation is drawn", () => {
    const spent = spend("tier");

    expect(spent.gate ?? 0).toBe(0);
    expect(reseedDraw(AFK_RESEED_BUDGET, "gate", spent).allowed).toBe(true);
  });

  it("refuses a second escalation on the TIER sub-cap, gate share untouched", () => {
    const spent = spend("tier");

    expect(repeat("complex", spent)).toEqual({ escalate: false, refusal: "sub-cap" });
    expect(reseedDraw(AFK_RESEED_BUDGET, "gate", spent).allowed).toBe(true);
  });

  it("refuses when the only round left is the review's reservation", () => {
    // Ceiling 4, three gate rounds spent: the tier sub-cap is untouched, but the
    // single remaining round is held for the review and invisible to the tier.
    const spent = spend("gate", "gate", "gate");

    expect(AFK_RESEED_BUDGET.subCaps.tier - (spent.tier ?? 0)).toBe(1);
    expect(repeat("simple", spent)).toEqual({ escalate: false, refusal: "reservation" });
  });
});
