import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_BASE_DRIFT_CORRECTIONS,
  EMPTY_CORRECTION_LEDGER,
  RELEASE_BUMP_SUBJECT,
  attributeGateFailure,
  baseMoved,
  chargeCorrection,
  correctionBudgetExhausted,
  describeCorrectionLedger,
  releaseBumpSubjects,
  resolveStaleBaseDriftCorrections,
  staleBaseDriftBlock,
  type BaseMovement,
} from "../src/core/stale-base-drift.js";

const RELEASE_BUMP = "chore(release): version packages";

function movement(over: Partial<BaseMovement> = {}): BaseMovement {
  return {
    startSha: "aaaaaaa",
    gateSha: "bbbbbbb",
    subjects: [RELEASE_BUMP],
    ...over,
  };
}

describe("baseMoved", () => {
  it("is false without a probe, without shas, and when the base stood still", () => {
    expect(baseMoved(undefined)).toBe(false);
    expect(baseMoved(movement({ startSha: "" }))).toBe(false);
    expect(baseMoved(movement({ gateSha: "" }))).toBe(false);
    expect(baseMoved(movement({ gateSha: "aaaaaaa" }))).toBe(false);
  });

  it("is true when the gate-time base head differs from the attempt's start sha", () => {
    expect(baseMoved(movement())).toBe(true);
  });
});

describe("releaseBumpSubjects", () => {
  it("names the release version bump among the commits the base gained", () => {
    const m = movement({ subjects: ["fix: a thing", RELEASE_BUMP, "docs: b"] });
    expect(releaseBumpSubjects(m)).toEqual([RELEASE_BUMP]);
    expect(RELEASE_BUMP_SUBJECT.test(RELEASE_BUMP)).toBe(true);
  });

  it("is empty when the base moved without a release bump", () => {
    expect(releaseBumpSubjects(movement({ subjects: ["fix: a thing"] }))).toEqual([]);
  });
});

describe("attributeGateFailure", () => {
  it("attributes a failure to the branch when the base never moved", () => {
    const attribution = attributeGateFailure({ refundsUsed: 0 });
    expect(attribution.cause).toBe("branch-fault");
    expect(attribution.reason).toContain("did not move");
    expect(attribution.movedCommits).toBe(0);
  });

  it("attributes a failure to stale-base drift when the base moved under the run", () => {
    const attribution = attributeGateFailure({ movement: movement(), refundsUsed: 0 });
    expect(attribution.cause).toBe("stale-base-drift");
    expect(attribution.releaseBumps).toEqual([RELEASE_BUMP]);
    expect(attribution.movedCommits).toBe(1);
    expect(attribution.reason).toContain("release version bump");
  });

  it("attributes a gate-declared suspect-infra failure away from the branch", () => {
    const attribution = attributeGateFailure({ suspectInfra: true, refundsUsed: 0 });
    expect(attribution.cause).toBe("suspect-infra");
    expect(attribution.reason).toContain("environment failure");
    expect(attribution.movedCommits).toBe(0);
  });

  it("makes suspect-infra share the bounded free-cycle allowance with stale-base drift", () => {
    const attribution = attributeGateFailure({
      suspectInfra: true,
      refundsUsed: DEFAULT_STALE_BASE_DRIFT_CORRECTIONS,
    });
    expect(attribution.cause).toBe("branch-fault");
    expect(attribution.reason).toContain("allowance");
  });

  it("falls back to branch-fault once the bounded stale-base allowance is spent", () => {
    const attribution = attributeGateFailure({
      movement: movement(),
      refundsUsed: DEFAULT_STALE_BASE_DRIFT_CORRECTIONS,
    });
    expect(attribution.cause).toBe("branch-fault");
    expect(attribution.reason).toContain("allowance");
  });
});

describe("resolveStaleBaseDriftCorrections", () => {
  it("reads a non-negative integer override and otherwise keeps the default", () => {
    expect(resolveStaleBaseDriftCorrections("0")).toBe(0);
    expect(resolveStaleBaseDriftCorrections("3")).toBe(3);
    expect(resolveStaleBaseDriftCorrections(undefined)).toBe(DEFAULT_STALE_BASE_DRIFT_CORRECTIONS);
    expect(resolveStaleBaseDriftCorrections("nope")).toBe(DEFAULT_STALE_BASE_DRIFT_CORRECTIONS);
    expect(resolveStaleBaseDriftCorrections("-1")).toBe(DEFAULT_STALE_BASE_DRIFT_CORRECTIONS);
  });
});

describe("correction ledger", () => {
  it("charges a branch-fault cycle to the budget and refunds a drift cycle", () => {
    let ledger = chargeCorrection(EMPTY_CORRECTION_LEDGER, "branch-fault");
    expect(ledger).toMatchObject({ charged: 1, refunded: 0 });
    ledger = chargeCorrection(ledger, "stale-base-drift");
    expect(ledger).toMatchObject({ charged: 1, refunded: 1 });
    expect(ledger.cycles).toEqual(["branch-fault", "stale-base-drift"]);
  });

  it("refunds suspect-infra from the same counter as stale-base drift", () => {
    const ledger = chargeCorrection(
      chargeCorrection(EMPTY_CORRECTION_LEDGER, "stale-base-drift"),
      "suspect-infra",
    );
    expect(ledger).toMatchObject({ charged: 0, refunded: 2 });
    expect(ledger.cycles).toEqual(["stale-base-drift", "suspect-infra"]);
  });

  it("never mutates the ledger it is handed", () => {
    const before = chargeCorrection(EMPTY_CORRECTION_LEDGER, "branch-fault");
    chargeCorrection(before, "branch-fault");
    expect(before.charged).toBe(1);
    expect(EMPTY_CORRECTION_LEDGER.charged).toBe(0);
  });

  it("exhausts on charged cycles only — refunded drift cycles never park a branch", () => {
    const drifted = chargeCorrection(chargeCorrection(EMPTY_CORRECTION_LEDGER, "stale-base-drift"), "stale-base-drift");
    expect(correctionBudgetExhausted(drifted, 1)).toBe(false);
    expect(correctionBudgetExhausted(chargeCorrection(drifted, "branch-fault"), 1)).toBe(true);
  });

  it("describes the ledger with both counters so a park says which budget ran out", () => {
    const ledger = chargeCorrection(chargeCorrection(EMPTY_CORRECTION_LEDGER, "branch-fault"), "stale-base-drift");
    const text = describeCorrectionLedger(ledger, 1);
    expect(text).toContain("1/1");
    expect(text).toContain("1 stale-base");
  });
});

describe("staleBaseDriftBlock", () => {
  it("tells the agent to merge the base and names the release bump that moved it", () => {
    const block = staleBaseDriftBlock({
      base: "main",
      movement: movement({ subjects: [RELEASE_BUMP, "fix: unrelated"] }),
      attribution: attributeGateFailure({ movement: movement(), refundsUsed: 0 }),
    }).join("\n");
    expect(block).toContain("<stale-base-drift>");
    expect(block).toContain("git merge origin/main");
    expect(block).toContain(RELEASE_BUMP);
    expect(block).toContain("did not consume");
  });
});
