// The birth circuit breaker (issue #3107). A project whose Workers die in boot
// stops being asked for another, because a boot that fails deterministically
// fails identically every time and each birth spends host-shared GitHub quota.
//
// Measured before this existed: 108 births and 108 deaths in one hour for one
// project, average lifetime 13 seconds.
import { describe, expect, it } from "vitest";
import {
  birthHaltMap,
  describeBirthLatch,
  EMPTY_BIRTH_HEALTH,
  foldWorkerDeath,
  planHostDemand,
  REDSKILLED_BIRTH_HALT_MS,
  REDSKILLED_SHORT_LIFE_MS,
  REDSKILLED_SHORT_LIFE_STREAK,
  type RedskilledDemandProject,
} from "../src/demand-loop.js";
import { workerTerminalOutcome } from "../src/daemon/birth-outcome.js";

const NOW_MS = Date.parse("2026-08-02T23:00:00.000Z");

function project(label: string, overrides: Partial<RedskilledDemandProject> = {}): RedskilledDemandProject {
  return {
    project_label: label,
    selector: `repo:${label} label:ready-for-agent`,
    argv: ["red-skills-dev", "run", "--once"],
    workspace_path: `/tmp/${label}`,
    target: 2,
    ...overrides,
  };
}

/** Kill `n` Workers in a row after `lifetimeMs` each, from a clean record. */
function streak(n: number, lifetimeMs: number, nowMs = NOW_MS) {
  let health = EMPTY_BIRTH_HEALTH;
  for (let i = 0; i < n; i += 1) health = foldWorkerDeath(health, lifetimeMs, nowMs);
  return health;
}

describe("foldWorkerDeath", () => {
  it("does not halt before the streak completes", () => {
    const health = streak(REDSKILLED_SHORT_LIFE_STREAK - 1, 13_000);
    expect(health.shortLifeStreak).toBe(REDSKILLED_SHORT_LIFE_STREAK - 1);
    expect(health.haltUntilMs).toBeNull();
  });

  it("halts on the death that completes the streak", () => {
    const health = streak(REDSKILLED_SHORT_LIFE_STREAK, 13_000);
    expect(health.haltUntilMs).toBe(NOW_MS + REDSKILLED_BIRTH_HALT_MS);
  });

  it("clears the streak outright when a Worker survives", () => {
    // The question is "can a Worker boot here NOW"; one that did is a complete
    // answer, so failures from before it must not be carried forward.
    const nearly = streak(REDSKILLED_SHORT_LIFE_STREAK - 1, 13_000);
    const recovered = foldWorkerDeath(nearly, REDSKILLED_SHORT_LIFE_MS + 1, NOW_MS);
    expect(recovered).toEqual(EMPTY_BIRTH_HEALTH);
  });

  it("re-arms immediately when the probe after the window dies short too", () => {
    const halted = streak(REDSKILLED_SHORT_LIFE_STREAK, 13_000);
    const later = NOW_MS + REDSKILLED_BIRTH_HALT_MS + 1;
    const again = foldWorkerDeath(halted, 13_000, later);
    expect(again.haltUntilMs).toBe(later + REDSKILLED_BIRTH_HALT_MS);
  });

  it("treats a lifetime exactly at the threshold as long enough", () => {
    expect(foldWorkerDeath(EMPTY_BIRTH_HEALTH, REDSKILLED_SHORT_LIFE_MS, NOW_MS)).toEqual(EMPTY_BIRTH_HEALTH);
  });
});

// The 2026-08-19 incident: the queue emptied while four Tickets were
// quarantined, so the Workers already running found nothing to do, said so and
// exited 0 seconds after birth. The breaker read three clean exits as three
// losses and then refused every birth that would have consumed the queue once
// it was repaired.
describe("a Worker that reported no eligible work", () => {
  it("does not increment the streak", () => {
    const health = foldWorkerDeath(EMPTY_BIRTH_HEALTH, 4_000, NOW_MS, "no-eligible-work");
    expect(health.shortLifeStreak).toBe(0);
    expect(health.haltUntilMs).toBeNull();
  });

  it("leaves the breaker closed after three in a row", () => {
    let health = EMPTY_BIRTH_HEALTH;
    for (let i = 0; i < REDSKILLED_SHORT_LIFE_STREAK; i += 1) {
      health = foldWorkerDeath(health, 4_000, NOW_MS, "no-eligible-work");
    }
    expect(health).toEqual(EMPTY_BIRTH_HEALTH);
    expect(birthHaltMap({ drained: health }, NOW_MS)).toEqual({});
  });

  it("clears a streak the losses before it built", () => {
    // Proof the chain works, delivered in seconds. Carrying forward failures
    // from before it would halt a project that has already recovered — the same
    // reason a long life clears the streak outright.
    const nearly = streak(REDSKILLED_SHORT_LIFE_STREAK - 1, 13_000);
    expect(foldWorkerDeath(nearly, 4_000, NOW_MS, "no-eligible-work")).toEqual(EMPTY_BIRTH_HEALTH);
  });

  it("closes a latched breaker when the half-open probe reports it", () => {
    const halted = streak(REDSKILLED_SHORT_LIFE_STREAK, 13_000);
    const probed = { ...halted, probeWorkerId: "w9" };
    expect(foldWorkerDeath(probed, 4_000, NOW_MS + 1, "no-eligible-work")).toEqual(EMPTY_BIRTH_HEALTH);
  });

  it("still halts a project whose Workers die unreported — the original job", () => {
    const health = streak(REDSKILLED_SHORT_LIFE_STREAK, 13_000);
    expect(health.haltUntilMs).toBe(NOW_MS + REDSKILLED_BIRTH_HALT_MS);
    expect(health.lossOutcome).toBe("unreported");
  });
});

describe("workerTerminalOutcome", () => {
  it("reads the Worker protocol's own sentinel out of a clean exit", () => {
    expect(workerTerminalOutcome({ exitCode: 0, signal: null, tail: "<promise>NO MORE TASKS</promise>" }))
      .toBe("no-eligible-work");
    expect(workerTerminalOutcome({ exitCode: 0, signal: null, tail: "x <promise>DONE</promise>" }))
      .toBe("work-reported");
  });

  it("is unreported when nothing terminal was said", () => {
    expect(workerTerminalOutcome({ exitCode: 0, signal: null, tail: "booting" })).toBe("unreported");
    expect(workerTerminalOutcome({ exitCode: 0, signal: null, tail: null })).toBe("unreported");
  });

  it("takes the exit status over the claim", () => {
    // A Worker that printed its sentinel and then crashed on the way out did
    // not end cleanly, whatever the last line says.
    expect(workerTerminalOutcome({ exitCode: 1, signal: null, tail: "<promise>NO MORE TASKS</promise>" }))
      .toBe("unreported");
    expect(workerTerminalOutcome({ exitCode: 0, signal: "SIGKILL", tail: "<promise>DONE</promise>" }))
      .toBe("unreported");
  });
});

describe("the refusal an operator reads", () => {
  it("names the outcome class that armed the latch", () => {
    const health = streak(REDSKILLED_SHORT_LIFE_STREAK, 13_000);
    const plan = planHostDemand({
      projects: [project("looping")],
      queue: { looping: 5 },
      live: { looping: 0 },
      nowMs: NOW_MS,
      birthHealth: { looping: health },
    });
    const detail = plan.intents[0]?.detail ?? "";
    expect(detail).toContain("unreported");
    expect(detail).toContain("died before reporting any terminal outcome");
    expect(describeBirthLatch("looping", health, NOW_MS)?.reason).toContain("unreported");
  });

  it("says the class is unstated when the caller passed only a halt instant", () => {
    const plan = planHostDemand({
      projects: [project("looping")],
      queue: { looping: 5 },
      live: { looping: 0 },
      nowMs: NOW_MS,
      birthHaltUntilMs: { looping: NOW_MS + REDSKILLED_BIRTH_HALT_MS },
    });
    expect(plan.intents[0]?.detail).toContain("unstated");
  });
});

describe("birthHaltMap", () => {
  it("drops an expired halt rather than reporting a past instant", () => {
    const health = { looping: streak(REDSKILLED_SHORT_LIFE_STREAK, 13_000) };
    expect(birthHaltMap(health, NOW_MS)).toHaveProperty("looping");
    expect(birthHaltMap(health, NOW_MS + REDSKILLED_BIRTH_HALT_MS + 1)).toEqual({});
  });
});

describe("planHostDemand with a halted project", () => {
  const queue = { looping: 5, healthy: 5 };
  const live = { looping: 0, healthy: 0 };

  it("asks for nothing and says why", () => {
    const plan = planHostDemand({
      projects: [project("looping")],
      queue: { looping: 5 },
      live: { looping: 0 },
      nowMs: NOW_MS,
      birthHaltUntilMs: { looping: NOW_MS + REDSKILLED_BIRTH_HALT_MS },
    });
    expect(plan.births).toHaveLength(0);
    const intent = plan.intents.find((i) => i.project_label === "looping");
    expect(intent?.outcome).toBe("birth-halted");
    expect(intent?.wanted).toBe(0);
    expect(intent?.detail).toContain("in a row");
  });

  it("holds back ONLY the looping project — a neighbour still gets Workers", () => {
    // The whole reason the breaker is per project: a host-wide backoff would
    // punish the healthy repo for its neighbour's broken tree, which is exactly
    // the cross-project damage this exists to stop.
    const plan = planHostDemand({
      projects: [project("looping"), project("healthy")],
      queue,
      live,
      nowMs: NOW_MS,
      birthHaltUntilMs: { looping: NOW_MS + REDSKILLED_BIRTH_HALT_MS },
    });
    expect(plan.births.every((b) => b.project_label === "healthy")).toBe(true);
    expect(plan.births.length).toBeGreaterThan(0);
  });

  it("asks again once the halt expires", () => {
    const plan = planHostDemand({
      projects: [project("looping")],
      queue: { looping: 5 },
      live: { looping: 0 },
      nowMs: NOW_MS + REDSKILLED_BIRTH_HALT_MS + 1,
      birthHaltUntilMs: { looping: NOW_MS + REDSKILLED_BIRTH_HALT_MS },
    });
    expect(plan.births.length).toBeGreaterThan(0);
  });

  it("reports the halt even when no poll has counted the queue", () => {
    // Reporting "nobody counted yet" for a project whose Workers die in boot
    // names the wrong problem to whoever reads it.
    const plan = planHostDemand({
      projects: [project("looping")],
      queue: {},
      live: { looping: 0 },
      nowMs: NOW_MS,
      birthHaltUntilMs: { looping: NOW_MS + REDSKILLED_BIRTH_HALT_MS },
    });
    expect(plan.intents[0]?.outcome).toBe("birth-halted");
  });

  it("is inert when no project is halted", () => {
    const plan = planHostDemand({ projects: [project("healthy")], queue, live, nowMs: NOW_MS });
    expect(plan.intents[0]?.outcome).toBe("asking");
  });
});

describe("the loop this closes", () => {
  it("stops after the streak instead of birthing forever", () => {
    // Replays the observed shape: births at ~15s intervals, each Worker dead in
    // 13s. Without the breaker this never terminates.
    let health = EMPTY_BIRTH_HEALTH;
    let births = 0;
    let nowMs = NOW_MS;
    for (let tick = 0; tick < 200; tick += 1) {
      const halted = birthHaltMap({ looping: health }, nowMs).looping != null;
      if (!halted) {
        births += 1;
        nowMs += 13_000;
        health = foldWorkerDeath(health, 13_000, nowMs);
      }
      nowMs += 2_000;
    }
    expect(births).toBe(REDSKILLED_SHORT_LIFE_STREAK);
  });
});
