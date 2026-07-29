import { describe, expect, it } from "vitest";
import {
  AFK_RESEED_BUDGET,
  GO_NO_MISTAKES_RESEED_BUDGET,
  GO_RESEED_BUDGET,
  RESEED_CAUSES,
  canDrawReseed,
  recordReseedDraw,
  reseedBudgetDefects,
  reseedDraw,
  resolveReseedBudget,
  totalReseedSpend,
  type ReseedBudget,
  type ReseedCause,
  type ReseedSpend,
} from "../src/core/process-issue/reseed-budget.js";
import { auditConfigLoad, CONFIG_DEFAULTS, DELETED_CONFIG_KEYS, getConfig } from "../src/core/config.js";
import { LABEL_GO_LANE } from "../src/core/triage-labels.js";

/** Spend `n` rounds on one cause, so the tests read as a sequence of draws
 * rather than as a hand-written tally. */
function spend(...draws: readonly ReseedCause[]): ReseedSpend {
  return draws.reduce<ReseedSpend>((acc, cause) => recordReseedDraw(acc, cause), {});
}

describe("Re-seed budget — lane resolution (ADR 0129)", () => {
  it("resolves the `/afk` ceiling of 4 with the review round reserved", () => {
    const budget = resolveReseedBudget({});

    expect(budget).toBe(AFK_RESEED_BUDGET);
    expect(budget.lane).toBe("/afk");
    expect(budget.ceiling).toBe(4);
    expect(budget.subCaps).toEqual({ gate: 3, tier: 1, review: 1 });
    expect(budget.reserved.review).toBe(1);
    expect(budget.reserved.gate).toBe(0);
    expect(budget.reserved.tier).toBe(0);
  });

  it("keeps every non-`/go` lane on the `/afk` ruler", () => {
    expect(resolveReseedBudget({ laneLabel: "lane:scout" })).toBe(AFK_RESEED_BUDGET);
    expect(resolveReseedBudget({ laneLabel: undefined, runMode: "no-mistakes" })).toBe(AFK_RESEED_BUDGET);
  });

  it("resolves `/go` to 2, widening to 3 under `--mode no-mistakes` so the reservation fits", () => {
    const plain = resolveReseedBudget({ laneLabel: LABEL_GO_LANE });
    expect(plain).toBe(GO_RESEED_BUDGET);
    expect(plain.ceiling).toBe(2);
    expect(plain.reserved.review).toBe(0);

    const hardened = resolveReseedBudget({ laneLabel: LABEL_GO_LANE, runMode: "no-mistakes" });
    expect(hardened).toBe(GO_NO_MISTAKES_RESEED_BUDGET);
    expect(hardened.ceiling).toBe(3);
    expect(hardened.reserved.review).toBe(1);
    // The widening ADDS the reserved round rather than carving it out of the
    // lane's two working rounds.
    expect(hardened.ceiling - hardened.reserved.review).toBe(plain.ceiling);
  });

  it("leaves `/go`'s other dispatch modes on the narrow ruler", () => {
    expect(resolveReseedBudget({ laneLabel: LABEL_GO_LANE, runMode: "direct-PR" })).toBe(GO_RESEED_BUDGET);
    expect(resolveReseedBudget({ laneLabel: LABEL_GO_LANE, runMode: "local-only" })).toBe(GO_RESEED_BUDGET);
  });
});

describe("Re-seed budget — the review reservation", () => {
  it("refuses a non-review cause the reserved round even when the ceiling has room", () => {
    const gateChurn = spend("gate", "gate", "gate");
    expect(totalReseedSpend(gateChurn)).toBe(3);
    // The ceiling is 4: a round is genuinely left, and it is NOT drawable.
    expect(AFK_RESEED_BUDGET.ceiling - totalReseedSpend(gateChurn)).toBe(1);

    const tier = reseedDraw(AFK_RESEED_BUDGET, "tier", gateChurn);
    expect(tier.allowed).toBe(false);
    expect(tier.refusal).toBe("reservation");
  });

  it("still fires the review round after gate churn exhausted its sub-cap", () => {
    const gateChurn = spend("gate", "gate", "gate");
    expect(canDrawReseed(AFK_RESEED_BUDGET, "gate", gateChurn)).toBe(false);
    expect(reseedDraw(AFK_RESEED_BUDGET, "gate", gateChurn).refusal).toBe("sub-cap");
    expect(canDrawReseed(AFK_RESEED_BUDGET, "review", gateChurn)).toBe(true);
  });

  it("frees the reserved round to nobody once review has spent it", () => {
    const drained = spend("gate", "gate", "gate", "review");
    expect(totalReseedSpend(drained)).toBe(AFK_RESEED_BUDGET.ceiling);
    expect(reseedDraw(AFK_RESEED_BUDGET, "tier", drained).refusal).toBe("ceiling");
    expect(reseedDraw(AFK_RESEED_BUDGET, "review", drained).refusal).toBe("sub-cap");
  });

  it("does not reserve anything on the plain `/go` lane, which runs no review", () => {
    const oneGate = spend("gate");
    expect(canDrawReseed(GO_RESEED_BUDGET, "tier", oneGate)).toBe(true);
    expect(canDrawReseed(GO_RESEED_BUDGET, "review", oneGate)).toBe(false);
  });

  it("reserves the review round on `/go --mode no-mistakes` too", () => {
    const goChurn = spend("gate", "gate");
    expect(reseedDraw(GO_NO_MISTAKES_RESEED_BUDGET, "tier", goChurn).refusal).toBe("reservation");
    expect(canDrawReseed(GO_NO_MISTAKES_RESEED_BUDGET, "review", goChurn)).toBe(true);
  });
});

describe("Re-seed budget — the ceiling binds the sub-caps", () => {
  it("stops the sub-caps drawing more rounds than the ceiling, whatever the mix", () => {
    for (const budget of [AFK_RESEED_BUDGET, GO_RESEED_BUDGET, GO_NO_MISTAKES_RESEED_BUDGET]) {
      const declared = RESEED_CAUSES.reduce((sum, cause) => sum + budget.subCaps[cause], 0);
      let tally: ReseedSpend = {};
      let drawn = 0;
      // Draw greedily, forever, in every cause order — the ceiling is the only
      // thing that can end the loop.
      while (RESEED_CAUSES.some((cause) => canDrawReseed(budget, cause, tally))) {
        const cause = RESEED_CAUSES.find((c) => canDrawReseed(budget, c, tally))!;
        tally = recordReseedDraw(tally, cause);
        drawn += 1;
        expect(drawn).toBeLessThanOrEqual(budget.ceiling);
      }
      expect(drawn).toBe(budget.ceiling);
      expect(totalReseedSpend(tally)).toBeLessThanOrEqual(budget.ceiling);
      // The declared shares deliberately sum ABOVE the ceiling on the lanes that
      // reserve a review round; the ceiling is what actually binds.
      expect(declared).toBeGreaterThanOrEqual(budget.ceiling);
    }
  });

  it("names `ceiling` — not `sub-cap` — when the whole budget is gone", () => {
    const drained = spend("gate", "gate", "review");
    expect(totalReseedSpend(drained)).toBe(GO_NO_MISTAKES_RESEED_BUDGET.ceiling);
    expect(reseedDraw(GO_NO_MISTAKES_RESEED_BUDGET, "tier", drained).refusal).toBe("ceiling");
  });

  it("reports every shipped profile as coherent", () => {
    for (const budget of [AFK_RESEED_BUDGET, GO_RESEED_BUDGET, GO_NO_MISTAKES_RESEED_BUDGET]) {
      expect(reseedBudgetDefects(budget)).toEqual([]);
    }
  });

  it("names a profile whose reservations cannot fit under its ceiling", () => {
    const incoherent: ReseedBudget = {
      lane: "/go",
      ceiling: 1,
      subCaps: { gate: 1, tier: 1, review: 1 },
      reserved: { gate: 1, tier: 0, review: 1 },
    };
    expect(reseedBudgetDefects(incoherent)).toEqual(["reservations (2) exceed the ceiling (1)"]);
  });

  it("names a reservation larger than the cause's own share", () => {
    const incoherent: ReseedBudget = {
      lane: "/afk",
      ceiling: 4,
      subCaps: { gate: 3, tier: 1, review: 0 },
      reserved: { gate: 0, tier: 0, review: 1 },
    };
    expect(reseedBudgetDefects(incoherent)).toEqual(["`review` reserves 1 beyond its sub-cap of 0"]);
  });
});

describe("Re-seed budget — the retired stall-convergence key (ADR 0117 tombstone)", () => {
  const OPTED_IN_WITH_STALL =
    "plugins:\n  dev:\n    enabled: true\n    afk:\n      stallConvergenceBudget: 5\n";

  it("reports the stall-convergence key as retired and never reads it back", () => {
    const warnings: string[] = [];
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => OPTED_IN_WITH_STALL,
      warn: (m) => warnings.push(m),
    });

    expect(audit.retiredKeys).toEqual(["plugins.dev.afk.stallConvergenceBudget"]);
    expect(warnings.join("\n")).toContain("RETIRED");
    expect(getConfig(audit.values, "afk.stallConvergenceBudget")).toBe("");
  });

  it("tombstones the legacy top-level spelling too", () => {
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () => "plugins:\n  dev:\n    enabled: true\nafk:\n  stallConvergenceBudget: 5\n",
      warn: () => {},
    });

    expect(audit.retiredKeys).toEqual(["afk.stallConvergenceBudget"]);
    expect(getConfig(audit.values, "afk.stallConvergenceBudget")).toBe("");
  });

  it("both spellings are tombstoned and neither keeps a live default", () => {
    for (const key of ["afk.stallConvergenceBudget", "plugins.dev.afk.stallConvergenceBudget"]) {
      expect(DELETED_CONFIG_KEYS.has(key)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)).toBe(false);
    }
  });

  it("the lane-scoped replacement carries the `/afk` gate sub-cap as its default", () => {
    expect(CONFIG_DEFAULTS["dev.reseed.afk.gate_budget"]).toBe(String(AFK_RESEED_BUDGET.subCaps.gate));
  });

  it("resolves the replacement key from an opted-in file", () => {
    const audit = auditConfigLoad("/x/.red/config.yaml", {
      read: () =>
        "plugins:\n  dev:\n    enabled: true\n    reseed:\n      afk:\n        gate_budget: 5\n",
      warn: () => {},
    });

    expect(audit.retiredKeys).toEqual([]);
    expect(getConfig(audit.values, "dev.reseed.afk.gate_budget")).toBe("5");
  });
});
