// The harvest deadline (#4170, Spec #4164): a declared budget stops the taking
// and spends the rest landing what is in flight.
//
// Every test here injects the clock and the budget, because the property under
// test is a comparison between two numbers and nothing else — a suite that
// waited for real time would be testing the machine's patience instead.
import { describe, expect, it } from "vitest";

import {
  decideHarvest,
  EMPTY_HARVEST_TALLY,
  foldHarvestOutcome,
  foldProjectHarvest,
  harvestReport,
  harvestWatchOf,
  REDSKILLED_DEFAULT_HARVEST_FRACTION,
  requireHarvestDeclaration,
} from "../src/harvest-deadline.js";
import { planHostDemand, type RedskilledDemandProject } from "../src/demand-loop.js";
import { buildProjectRegistration } from "../src/project-registration.js";

const REGISTERED_AT = "2026-08-21T00:00:00.000Z";
const STARTED_AT_MS = Date.parse(REGISTERED_AT);
const BUDGET_MS = 3_600_000;
/** 0.7 of the budget: the instant admission stops and the harvest begins. */
const HARVEST_AT_MS = STARTED_AT_MS + BUDGET_MS * REDSKILLED_DEFAULT_HARVEST_FRACTION;

function project(overrides: Partial<RedskilledDemandProject> = {}): RedskilledDemandProject {
  return {
    project_label: "acme/widgets",
    selector: "repo:acme/widgets label:ready-for-agent",
    argv: ["redskilled", "acp-worker"],
    workspace_path: "/tmp/acme",
    target: 2,
    ...overrides,
  };
}

describe("decideHarvest — what a declared budget does to admission", () => {
  it("stays completely inert when the operator declared no budget", () => {
    const decision = decideHarvest(undefined, HARVEST_AT_MS + BUDGET_MS);

    expect(decision.state).toBe("inert");
    expect(decision.admits).toBe(true);
    expect(decision.harvestAtMs).toBeNull();
    expect(decision.deadlineAtMs).toBeNull();
    expect(decision.detail).toContain("no drain budget was declared");
  });

  it("admits while the drain is below the harvest fraction", () => {
    const decision = decideHarvest({ budget_ms: BUDGET_MS, startedAtMs: STARTED_AT_MS }, HARVEST_AT_MS - 1);

    expect(decision.state).toBe("admitting");
    expect(decision.admits).toBe(true);
    expect(decision.harvestAtMs).toBe(HARVEST_AT_MS);
    expect(decision.deadlineAtMs).toBe(STARTED_AT_MS + BUDGET_MS);
  });

  it("harvests from the fraction onward, the instant itself included", () => {
    const at = decideHarvest({ budget_ms: BUDGET_MS, startedAtMs: STARTED_AT_MS }, HARVEST_AT_MS);
    const past = decideHarvest({ budget_ms: BUDGET_MS, startedAtMs: STARTED_AT_MS }, HARVEST_AT_MS + 60_000);

    expect(at.state).toBe("harvesting");
    expect(at.admits).toBe(false);
    expect(past.admits).toBe(false);
    // The refusal states both instants, because "why is nothing being born" and
    // "how long do the live Workers have" are asked in the same breath.
    expect(past.detail).toContain(new Date(HARVEST_AT_MS).toISOString());
    expect(past.detail).toContain(new Date(STARTED_AT_MS + BUDGET_MS).toISOString());
  });

  it("honours a stricter fraction the operator declared", () => {
    const watch = { budget_ms: BUDGET_MS, harvest_fraction: 0.5, startedAtMs: STARTED_AT_MS };

    expect(decideHarvest(watch, STARTED_AT_MS + BUDGET_MS * 0.5 - 1).admits).toBe(true);
    expect(decideHarvest(watch, STARTED_AT_MS + BUDGET_MS * 0.5).admits).toBe(false);
  });

  it("treats an unreadable budget start as no budget rather than as an expired one", () => {
    expect(decideHarvest({ budget_ms: BUDGET_MS, startedAtMs: Number.NaN }, HARVEST_AT_MS).state).toBe("inert");
    expect(harvestWatchOf({ budget_ms: BUDGET_MS, registered_at: "not an instant" })).toBeUndefined();
    expect(harvestWatchOf({ registered_at: REGISTERED_AT })).toBeUndefined();
  });
});

describe("requireHarvestDeclaration — shape, never meaning", () => {
  it("keeps a stated budget and defaults nothing when none is stated", () => {
    expect(requireHarvestDeclaration({ budget_ms: BUDGET_MS }, "acme/widgets")).toEqual({ budget_ms: BUDGET_MS });
    expect(requireHarvestDeclaration({}, "acme/widgets")).toEqual({});
  });

  it("refuses a budget that is not a positive number", () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => requireHarvestDeclaration({ budget_ms: budget }, "acme/widgets")).toThrow(/positive drain budget/);
    }
  });

  it("refuses a fraction outside (0, 1], and one stated without a budget", () => {
    for (const fraction of [0, -0.5, 1.5, Number.NaN]) {
      expect(() => requireHarvestDeclaration({ budget_ms: BUDGET_MS, harvest_fraction: fraction }, "acme/widgets"))
        .toThrow(/harvest fraction/);
    }
    expect(() => requireHarvestDeclaration({ harvest_fraction: 0.5 }, "acme/widgets")).toThrow(/without a budget/);
  });
});

describe("the registration carries the declaration the operator stated", () => {
  const request = {
    project_label: "acme/widgets",
    selector: "repo:acme/widgets label:ready-for-agent",
    argv: ["redskilled", "acp-worker"],
    workspace_path: "/tmp/acme",
    target: 2,
  };

  it("holds a declared budget and arms a watch from its own registered_at", () => {
    const held = buildProjectRegistration({ ...request, budget_ms: BUDGET_MS }, { now: REGISTERED_AT });

    expect(held.budget_ms).toBe(BUDGET_MS);
    expect(held.registered_at).toBe(REGISTERED_AT);
    expect(harvestWatchOf(held)).toEqual({ budget_ms: BUDGET_MS, startedAtMs: STARTED_AT_MS });
  });

  it("holds no budget field at all when none was declared", () => {
    const held = buildProjectRegistration(request, { now: REGISTERED_AT });

    expect("budget_ms" in held).toBe(false);
    expect(harvestWatchOf(held)).toBeUndefined();
  });

  it("refuses a non-positive budget at registration", () => {
    expect(() => buildProjectRegistration({ ...request, budget_ms: 0 }, { now: REGISTERED_AT }))
      .toThrow(/positive drain budget/);
  });
});

describe("planHostDemand — the deadline gates births and nothing else", () => {
  const queue = { "acme/widgets": 9 };

  it("admits normally below the harvest fraction", () => {
    const plan = planHostDemand({
      projects: [project({ harvest: { budget_ms: BUDGET_MS, startedAtMs: STARTED_AT_MS } })],
      queue,
      live: {},
      nowMs: HARVEST_AT_MS - 1,
    });

    expect(plan.births).toHaveLength(2);
    expect(plan.intents[0]?.outcome).toBe("asking");
  });

  it("refuses every new claim past the fraction while the live Workers stay counted", () => {
    const plan = planHostDemand({
      projects: [project({ harvest: { budget_ms: BUDGET_MS, startedAtMs: STARTED_AT_MS } })],
      queue,
      // One Worker is mid-flight; the deadline must not touch it. Its landing is
      // exactly what the last third of the budget is being spent on.
      live: { "acme/widgets": 1 },
      nowMs: HARVEST_AT_MS,
    });

    expect(plan.births).toEqual([]);
    expect(plan.intents[0]).toMatchObject({
      outcome: "harvest-deadline",
      wanted: 0,
      live: 1,
      queue_depth: 9,
    });
    expect(plan.intents[0]?.detail).toContain("work already in flight keeps landing");
  });

  it("stays inert for a project that declared no budget, however late it is", () => {
    const plan = planHostDemand({
      projects: [project()],
      queue,
      live: {},
      nowMs: STARTED_AT_MS + BUDGET_MS * 100,
    });

    expect(plan.births).toHaveLength(2);
    expect(plan.intents[0]?.outcome).toBe("asking");
  });

  it("refuses the harvesting project without refusing its neighbour", () => {
    const plan = planHostDemand({
      projects: [
        project({ harvest: { budget_ms: BUDGET_MS, startedAtMs: STARTED_AT_MS } }),
        project({ project_label: "acme/gadgets", workspace_path: "/tmp/gadgets" }),
      ],
      queue: { ...queue, "acme/gadgets": 4 },
      live: {},
      nowMs: HARVEST_AT_MS,
    });

    // Sorted by label, which is the one fact about a project the planner reads.
    expect(plan.intents.map((intent) => intent.outcome)).toEqual(["asking", "harvest-deadline"]);
    expect(plan.births.every((birth) => birth.project_label === "acme/gadgets")).toBe(true);
  });
});

describe("the tally — what a drain brought back, folded from the outcome class", () => {
  it("counts a reported terminal outcome as harvested and an unreported end as stranded", () => {
    expect(foldHarvestOutcome(EMPTY_HARVEST_TALLY, "work-reported")).toEqual({ harvested: 1, stranded: 0 });
    expect(foldHarvestOutcome(EMPTY_HARVEST_TALLY, "unreported")).toEqual({ harvested: 0, stranded: 1 });
    // Nothing was taken, so nothing was lost: a Worker that found no eligible
    // work is neither yield nor waste.
    expect(foldHarvestOutcome(EMPTY_HARVEST_TALLY, "no-eligible-work")).toEqual(EMPTY_HARVEST_TALLY);
  });

  it("folds per project, in place, from nothing", () => {
    const tallies: Record<string, { harvested: number; stranded: number }> = {};
    foldProjectHarvest(tallies, "acme/widgets", "work-reported");
    foldProjectHarvest(tallies, "acme/widgets", "work-reported");
    foldProjectHarvest(tallies, "acme/widgets", "unreported");
    foldProjectHarvest(tallies, "acme/gadgets", "no-eligible-work");

    expect(tallies["acme/widgets"]).toEqual({ harvested: 2, stranded: 1 });
    expect(tallies["acme/gadgets"]).toEqual(EMPTY_HARVEST_TALLY);
  });
});

describe("harvestReport — the drain summary names harvested and stranded", () => {
  it("adds the work the deadline leaves behind once the harvest has begun", () => {
    const report = harvestReport({
      registeredAt: REGISTERED_AT,
      declaration: { budget_ms: BUDGET_MS },
      tally: { harvested: 3, stranded: 1 },
      live: 2,
      queueDepth: 4,
      observedAt: new Date(HARVEST_AT_MS).toISOString(),
    });

    expect(report.state).toBe("harvesting");
    expect(report.harvested).toBe(3);
    // One Worker lost earlier, two still holding work the budget will not let
    // them finish, four items nobody will now claim.
    expect(report.stranded).toBe(7);
    expect(report.harvest_at).toBe(new Date(HARVEST_AT_MS).toISOString());
    expect(report.deadline_at).toBe(new Date(STARTED_AT_MS + BUDGET_MS).toISOString());
    expect(report.harvest_fraction).toBe(REDSKILLED_DEFAULT_HARVEST_FRACTION);
  });

  it("counts only what was already lost while the drain is still admitting", () => {
    const report = harvestReport({
      registeredAt: REGISTERED_AT,
      declaration: { budget_ms: BUDGET_MS },
      tally: { harvested: 3, stranded: 1 },
      live: 2,
      queueDepth: 4,
      observedAt: new Date(HARVEST_AT_MS - 1).toISOString(),
    });

    expect(report.state).toBe("admitting");
    expect(report.stranded).toBe(1);
  });

  it("reports an inert policy with the counts the drain still earned", () => {
    const report = harvestReport({
      registeredAt: REGISTERED_AT,
      declaration: {},
      tally: { harvested: 5, stranded: 0 },
      live: 2,
      queueDepth: 4,
      observedAt: new Date(STARTED_AT_MS + BUDGET_MS * 10).toISOString(),
    });

    expect(report).toMatchObject({
      state: "inert",
      budget_ms: null,
      harvest_fraction: null,
      harvest_at: null,
      deadline_at: null,
      harvested: 5,
      stranded: 0,
    });
  });

  it("is inert for a project the daemon holds no registration for", () => {
    const report = harvestReport({ live: 0, queueDepth: null, observedAt: REGISTERED_AT });

    expect(report.state).toBe("inert");
    expect(report.harvested).toBe(0);
    expect(report.stranded).toBe(0);
  });
});
