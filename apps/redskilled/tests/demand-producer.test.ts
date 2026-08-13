// The per-project runtime is a producer of demand, not a manager of processes:
// it asks for N Workers, lives with being granted fewer, serves several
// selectors from one ordered priority, and owns the breaker the daemon's death
// reports drive.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeAllDemandProducers,
  createDemandProducer,
  DemandProducerBusyError,
  DemandProducerConflictError,
  deathReportFromHostEvent,
  planProjectDemand,
  type DemandSelector,
} from "../src/demand-producer.js";
import {
  breakerCooldownMs,
  closedBreaker,
  isSelectorParked,
  PROJECT_BREAKER_DEFAULTS,
  recordWorkerDeath,
  recordWorkerSurvival,
  selectorParkReason,
  type ProjectBreakerState,
} from "../src/project-breaker.js";
import type { RedskilledAdmissionVerdict } from "../src/admission.js";
import type { RedskilledHostEvent } from "../src/event-lane.js";
import { RedskilledAdmissionError, type RedskilledWorkerSpec } from "../src/worker-launch.js";
import type { RedskilledWorkerStarted } from "../src/protocol.js";

afterEach(() => {
  closeAllDemandProducers();
});

function selector(id: string, desired: number): DemandSelector {
  return {
    selector_id: id,
    desired,
    spec: ({ index, runner }) => ({
      project_label: "acme/widgets",
      workspace_path: `/tmp/acme/${id}-${index}`,
      command: "/bin/true",
      args: runner == null ? [] : ["--runner", runner],
    }),
  };
}

const ADMITTED: RedskilledAdmissionVerdict = {
  version: 1,
  admitted: true,
  verdict: "admitted",
  reason: "redskilled admitted this Worker",
  ceiling: { memory_bytes: null, worker_count: null, source: "declared" },
  consumption: { worker_count: 0, memory_bytes: 0, unaccounted_workers: [] },
  requested_memory_bytes: null,
  projected_worker_count: 1,
  projected_memory_bytes: 0,
};

/** A daemon that grants the first `grants` requests and refuses the rest. */
function grantingDaemon(grants: number): {
  start: (spec: RedskilledWorkerSpec) => Promise<RedskilledWorkerStarted>;
  seen: RedskilledWorkerSpec[];
} {
  const seen: RedskilledWorkerSpec[] = [];
  let served = 0;
  return {
    seen,
    start: async (spec) => {
      seen.push(spec);
      if (served >= grants) {
        throw new RedskilledAdmissionError(
          "redskilled refused this Worker: it would be Worker 4 past a host ceiling of 3 Worker(s)",
        );
      }
      served += 1;
      return {
        worker: {
          worker_id: `w-${served}`,
          project_label: spec.project_label,
          pid: 1000 + served,
          started_at: "2026-07-29T00:00:00.000Z",
          workspace_path: spec.workspace_path,
          isolated: true,
          warnings: [],
        },
        admission: ADMITTED,
        warnings: [],
      };
    },
  };
}

describe("planProjectDemand", () => {
  it("serves several selectors from one ordered priority, highest first", () => {
    const plan = planProjectDemand({
      selectors: [selector("blocked-repair", 1), selector("ready-for-agent", 3), selector("go", 2)],
      live: 0,
      target: 3,
      breaker: {},
      nowMs: 0,
      runner: "claude",
    });
    expect(plan.requests.map((request) => request.selector_id)).toEqual([
      "blocked-repair",
      "ready-for-agent",
      "ready-for-agent",
    ]);
    // The lowest-priority selector wanted two and got none: priority is an
    // order over one budget, not a share of it.
    expect(plan.requests).toHaveLength(3);
  });

  it("asks for nothing beyond the room left by the Workers already live", () => {
    const plan = planProjectDemand({
      selectors: [selector("ready-for-agent", 5)],
      live: 3,
      target: 4,
      breaker: {},
      nowMs: 0,
      runner: null,
    });
    expect(plan.requests).toHaveLength(1);
  });

  it("skips a parked selector and names why, without skipping the ones behind it", () => {
    let breaker: ProjectBreakerState = {};
    for (let i = 0; i < PROJECT_BREAKER_DEFAULTS.deathsToPark; i += 1) {
      breaker = recordWorkerDeath(breaker, {
        worker_id: `w-${i}`,
        selector_id: "ready-for-agent",
        kind: "worker-death",
        lived_ms: 900,
        at_ms: 10_000,
        detail: "exit 1",
      });
    }
    const plan = planProjectDemand({
      selectors: [selector("ready-for-agent", 2), selector("go", 1)],
      live: 0,
      target: 3,
      breaker,
      nowMs: 10_000,
      runner: null,
    });
    expect(plan.requests.map((request) => request.selector_id)).toEqual(["go"]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.selector_id).toBe("ready-for-agent");
    expect(plan.skipped[0]?.reason).toMatch(/parked/i);
  });

  it("passes the runner directive into every spec it builds", () => {
    const plan = planProjectDemand({
      selectors: [selector("ready-for-agent", 2)],
      live: 0,
      target: 2,
      breaker: {},
      nowMs: 0,
      runner: "codex",
    });
    expect(plan.requests.map((request) => request.spec.args)).toEqual([
      ["--runner", "codex"],
      ["--runner", "codex"],
    ]);
  });
});

describe("the producer requests Workers and lives with a smaller grant", () => {
  it("reports the shortfall and the host's reason when granted fewer than asked", async () => {
    const daemon = grantingDaemon(2);
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 4)],
      startWorker: daemon.start,
      sampleQueueDepth: () => 9,
      resolveElasticTarget: () => 4,
      clock: () => 0,
    });

    const result = await producer.produce();

    expect(result.requested).toBe(4);
    expect(result.granted).toHaveLength(2);
    expect(result.shortfall).toBe(2);
    expect(result.refusal).toMatch(/past a host ceiling/);
    // A refusal ends the tick: the host just said it is full, so the remaining
    // requests would be asked only to be refused.
    expect(daemon.seen).toHaveLength(3);
  });

  it("grants everything asked for when the host has the room", async () => {
    const daemon = grantingDaemon(10);
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 2)],
      startWorker: daemon.start,
      resolveElasticTarget: () => 2,
    });

    const result = await producer.produce();

    expect(result.granted).toHaveLength(2);
    expect(result.shortfall).toBe(0);
    expect(result.refusal).toBeNull();
  });

  it("keeps the work knowledge: mirror, queue depth, target, runner, claims and hooks", async () => {
    const daemon = grantingDaemon(1);
    const order: string[] = [];
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 1)],
      startWorker: daemon.start,
      refreshTrunkMirror: () => {
        order.push("mirror");
      },
      reconcileClaims: (deaths) => {
        order.push(`claims:${deaths.length}`);
      },
      sampleQueueDepth: () => {
        order.push("queue");
        return 7;
      },
      resolveElasticTarget: (depth) => {
        order.push(`target:${depth}`);
        return 1;
      },
      resolveRunnerDirective: () => {
        order.push("runner");
        return "codex";
      },
      onLifecycle: (event) => {
        order.push(`hook:${event.event}`);
      },
    });

    producer.reportDeath({
      worker_id: "w-old",
      selector_id: "ready-for-agent",
      kind: "worker-death",
      lived_ms: 600_000,
      at_ms: 1,
      detail: "exit 0",
    });
    const result = await producer.produce();

    expect(order).toEqual([
      "mirror",
      "claims:1",
      "queue",
      "target:7",
      "runner",
      "hook:worker-granted",
      "hook:tick-complete",
    ]);
    expect(result.queue_depth).toBe(7);
    expect(result.runner).toBe("codex");
    expect(daemon.seen[0]?.args).toEqual(["--runner", "codex"]);
  });

  it("fails closed on an unreachable host: nothing granted, and the reason kept", async () => {
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 2)],
      startWorker: async () => {
        throw new Error("redskilled daemon is unreachable, so no Worker was started");
      },
      resolveElasticTarget: () => 2,
    });

    const result = await producer.produce();

    expect(result.granted).toEqual([]);
    expect(result.shortfall).toBe(2);
    expect(result.refusal).toMatch(/unreachable/);
  });
});

describe("exactly one producer per project", () => {
  it("refuses a second producer for the same project rather than racing it", () => {
    createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 1)],
      startWorker: grantingDaemon(1).start,
    });
    expect(() =>
      createDemandProducer({
        projectLabel: "acme/widgets",
        selectors: [selector("go", 1)],
        startWorker: grantingDaemon(1).start,
      }),
    ).toThrow(DemandProducerConflictError);
  });

  it("admits a second producer once the first one is closed", () => {
    const first = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 1)],
      startWorker: grantingDaemon(1).start,
    });
    first.close();
    expect(() =>
      createDemandProducer({
        projectLabel: "acme/widgets",
        selectors: [selector("go", 1)],
        startWorker: grantingDaemon(1).start,
      }),
    ).not.toThrow();
  });

  it("lets a different project have its own producer", () => {
    createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 1)],
      startWorker: grantingDaemon(1).start,
    });
    expect(() =>
      createDemandProducer({
        projectLabel: "acme/gadgets",
        selectors: [selector("ready-for-agent", 1)],
        startWorker: grantingDaemon(1).start,
      }),
    ).not.toThrow();
  });

  it("refuses a tick that overlaps the tick already in flight", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const daemon = grantingDaemon(2);
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 1)],
      startWorker: async (spec) => {
        await gate;
        return await daemon.start(spec);
      },
      resolveElasticTarget: () => 1,
    });

    const inFlight = producer.produce();
    await expect(producer.produce()).rejects.toBeInstanceOf(DemandProducerBusyError);
    release();
    await expect(inFlight).resolves.toMatchObject({ shortfall: 0 });
  });
});

describe("a death reported by the daemon drives the project's breaker", () => {
  it("parks the selector after repeated fast deaths, and reopens after the cooldown", () => {
    const config = PROJECT_BREAKER_DEFAULTS;
    let breaker: ProjectBreakerState = {};
    for (let i = 0; i < config.deathsToPark; i += 1) {
      breaker = recordWorkerDeath(breaker, {
        worker_id: `w-${i}`,
        selector_id: "ready-for-agent",
        kind: "worker-death",
        lived_ms: 500,
        at_ms: 1_000,
        detail: "exit 1",
      });
    }
    expect(isSelectorParked(breaker, "ready-for-agent", 1_000)).toBe(true);
    expect(selectorParkReason(breaker, "ready-for-agent", 1_000)).toMatch(/3 fast deaths/);
    expect(isSelectorParked(breaker, "ready-for-agent", 1_000 + config.cooldownBaseMs)).toBe(false);
  });

  it("re-parks a probe that fast-dies, with the cooldown doubled", () => {
    const config = PROJECT_BREAKER_DEFAULTS;
    let breaker: ProjectBreakerState = {};
    for (let i = 0; i < config.deathsToPark; i += 1) {
      breaker = recordWorkerDeath(breaker, {
        worker_id: `w-${i}`,
        selector_id: "go",
        kind: "worker-death",
        lived_ms: 500,
        at_ms: 0,
        detail: "exit 1",
      });
    }
    const probeAt = config.cooldownBaseMs;
    breaker = recordWorkerDeath(breaker, {
      worker_id: "probe",
      selector_id: "go",
      kind: "worker-death",
      lived_ms: 500,
      at_ms: probeAt,
      detail: "exit 1",
    });
    expect(isSelectorParked(breaker, "go", probeAt + config.cooldownBaseMs)).toBe(true);
    expect(isSelectorParked(breaker, "go", probeAt + breakerCooldownMs(1, config))).toBe(false);
  });

  it("closes the circuit on a Worker that lived, and on a survival report", () => {
    let breaker: ProjectBreakerState = {};
    breaker = recordWorkerDeath(breaker, {
      worker_id: "w-1",
      selector_id: "go",
      kind: "worker-death",
      lived_ms: 500,
      at_ms: 0,
      detail: "exit 1",
    });
    breaker = recordWorkerDeath(breaker, {
      worker_id: "w-2",
      selector_id: "go",
      kind: "worker-death",
      lived_ms: PROJECT_BREAKER_DEFAULTS.fastDeathMs + 1,
      at_ms: 1,
      detail: "exit 0",
    });
    expect(breaker.go?.consecutive_fast_deaths).toBe(0);
    expect(isSelectorParked(breaker, "go", 1)).toBe(false);

    breaker = recordWorkerDeath(breaker, {
      worker_id: "w-3",
      selector_id: "go",
      kind: "worker-death",
      lived_ms: 10,
      at_ms: 2,
      detail: "exit 1",
    });
    expect(recordWorkerSurvival(breaker, "go").go).toEqual(closedBreaker("go"));
  });

  it("counts a budget kill the host reported, naming it as the cause", () => {
    let breaker: ProjectBreakerState = {};
    for (let i = 0; i < PROJECT_BREAKER_DEFAULTS.deathsToPark; i += 1) {
      breaker = recordWorkerDeath(breaker, {
        worker_id: `w-${i}`,
        selector_id: "go",
        kind: "worker-budget-kill",
        lived_ms: 400,
        at_ms: 0,
        detail: "MemoryMax=2G exceeded",
      });
    }
    expect(selectorParkReason(breaker, "go", 0)).toMatch(/MemoryMax=2G exceeded/);
  });

  it("drives the producer's own breaker from a death the daemon reported", async () => {
    const daemon = grantingDaemon(10);
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("ready-for-agent", 1), selector("go", 1)],
      startWorker: daemon.start,
      resolveElasticTarget: () => 2,
      clock: () => 0,
    });

    for (let i = 0; i < PROJECT_BREAKER_DEFAULTS.deathsToPark; i += 1) {
      producer.reportDeath({
        worker_id: `w-${i}`,
        selector_id: "ready-for-agent",
        kind: "worker-death",
        lived_ms: 300,
        at_ms: 0,
        detail: "exit 1",
      });
    }
    const result = await producer.produce();

    expect(result.granted.map((grant) => grant.selector_id)).toEqual(["go"]);
    expect(result.skipped.map((skip) => skip.selector_id)).toEqual(["ready-for-agent"]);
  });

  it("reads a death report straight off the host event the daemon appended", () => {
    const event: RedskilledHostEvent = {
      version: 1,
      ts: "2026-07-29T00:00:10.000Z",
      kind: "worker-death",
      event: "worker-death",
      worker_id: "w-1",
      project_label: "acme/widgets",
      pid: 4242,
      workspace_path: "/tmp/acme/w-1",
      log_path: null,
      isolated: true,
      unit: "redskilled-w-1.service",
      memory_high: null,
      memory_max: null,
      cpu_weight: null,
      admission_verdict: null,
      phase: null,
      step: null,
      base_head_sha: null,
      base_commits_ahead: null,
      heal_kind: null,
      detail: "exit 1",
      exit_code: 1,
      signal: null,
      systemd_result: null,
      memory_peak_bytes: null,
      memory_swap_peak_bytes: null,
      reason: null,
    };
    expect(
      deathReportFromHostEvent(event, { selector_id: "ready-for-agent", started_at: "2026-07-29T00:00:00.000Z" }),
    ).toEqual({
      worker_id: "w-1",
      selector_id: "ready-for-agent",
      kind: "worker-death",
      lived_ms: 10_000,
      at_ms: Date.parse("2026-07-29T00:00:10.000Z"),
      detail: "exit 1",
      exit_code: 1,
    });
  });
});

describe("the seam holds in both directions", () => {
  it("leaves no slot, spawn, reap or respawn path in the per-project producer", () => {
    for (const file of ["demand-producer.ts", "project-breaker.ts"]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} must hold no process management`).not.toMatch(
        /\bslots?\b|\bspawn\w*\(|\brespawn|\breap\b|\bkillTree\b|\bprocess\.kill\b|child_process/i,
      );
    }
  });

  it("keeps the selector/work-policy breaker out of the daemon's half", () => {
    for (const file of ["daemon/lifecycle.ts", "protocol.ts", "host-state.ts", "admission.ts", "event-lane.ts"]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} must hold no selector circuit policy`).not.toMatch(
        /project-breaker|ProjectBreaker|SelectorBreaker|selectorPark|selector_id|selectorId/,
      );
    }
  });

  it("holds back after a refusal the host itself made, and keys nothing to a selector", () => {
    // ADR 0130 Amendment 4 moved the demand loop into the daemon, so the hold
    // that follows a refusal moved with it — the host refuses on its OWN ceiling,
    // and re-asking into a full machine is the busy loop the hold exists to
    // prevent. What must NOT follow it is the breaker: a policy keyed to which
    // selector's Workers keep dying is work knowledge, and the daemon has none.
    const code = readFileSync(new URL("../src/daemon/lifecycle.ts", import.meta.url), "utf8")
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/demandBackoff/);
    expect(code, "the daemon lifecycle must key no policy to a selector").not.toMatch(/selector_id|selectorId/);
  });
});
