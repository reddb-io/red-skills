// Interactive work stops queueing behind autonomous work — and it buys that
// with a held-back birth, never with a killed Worker. These tests pin both
// halves: the interactive dispatch is served ahead of a full queue, and nothing
// in flight is terminated to make room for it.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeAllDemandProducers,
  createDemandProducer,
  planProjectDemand,
  type DemandSelector,
} from "../src/demand-producer.js";
import {
  expireLapsedReservations,
  INTERACTIVE_RESERVATION_TTL_MS,
  isReservationHeld,
  NO_INTERACTIVE_RESERVATIONS,
  releaseInteractiveSlot,
  reservedSlotCount,
  reserveInteractiveSlot,
} from "../src/interactive-reservation.js";
import type { RedskilledAdmissionVerdict } from "../src/admission.js";
import type { RedskilledWorkerSpec } from "../src/worker-launch.js";
import type { RedskilledWorkerStarted } from "../src/protocol.js";

afterEach(() => {
  closeAllDemandProducers();
});

function selector(id: string, desired: number, interactive = false): DemandSelector {
  return {
    selector_id: id,
    desired,
    interactive,
    spec: ({ index }) => ({
      project_label: "acme/widgets",
      workspace_path: `/tmp/acme/${id}-${index}`,
      command: "/bin/true",
      args: [],
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

/** A host that grants everything it is asked for, and records what that was. */
function generousHost(): {
  start: (spec: RedskilledWorkerSpec) => Promise<RedskilledWorkerStarted>;
  seen: RedskilledWorkerSpec[];
} {
  const seen: RedskilledWorkerSpec[] = [];
  let served = 0;
  return {
    seen,
    start: async (spec) => {
      seen.push(spec);
      served += 1;
      return {
        worker: {
          worker_id: `w-${served}`,
          project_label: spec.project_label,
          pid: 1000 + served,
          started_at: new Date(served * 1000).toISOString(),
          workspace_path: spec.workspace_path,
        },
        admission: ADMITTED,
        warnings: [],
      } as unknown as RedskilledWorkerStarted;
    },
  };
}

describe("interactive reservation state", () => {
  it("holds a slot until the request is withdrawn", () => {
    let state = reserveInteractiveSlot(NO_INTERACTIVE_RESERVATIONS, { reservation_id: "go-1", at_ms: 0 });
    expect(reservedSlotCount(state, 0)).toBe(1);
    expect(isReservationHeld(state, "go-1", 0)).toBe(true);

    state = releaseInteractiveSlot(state, "go-1");
    expect(reservedSlotCount(state, 0)).toBe(0);
    expect(isReservationHeld(state, "go-1", 0)).toBe(false);
  });

  it("is idempotent and does not let a renewal extend the hold", () => {
    const first = reserveInteractiveSlot(NO_INTERACTIVE_RESERVATIONS, { reservation_id: "go-1", at_ms: 0 });
    const renewed = reserveInteractiveSlot(first, { reservation_id: "go-1", at_ms: 4_000 });
    expect(renewed).toBe(first);
    expect(reservedSlotCount(renewed, INTERACTIVE_RESERVATION_TTL_MS)).toBe(0);
  });

  it("lapses a hold whose caller never came back, so a slot is never held forever", () => {
    const state = reserveInteractiveSlot(NO_INTERACTIVE_RESERVATIONS, { reservation_id: "go-1", at_ms: 0 });
    expect(reservedSlotCount(state, INTERACTIVE_RESERVATION_TTL_MS - 1)).toBe(1);
    expect(reservedSlotCount(state, INTERACTIVE_RESERVATION_TTL_MS)).toBe(0);
    expect(expireLapsedReservations(state, INTERACTIVE_RESERVATION_TTL_MS).reservations).toEqual([]);
  });

  it("treats withdrawing an unheld id as a no-op, because withdrawal races the lapse", () => {
    expect(releaseInteractiveSlot(NO_INTERACTIVE_RESERVATIONS, "never-held")).toBe(NO_INTERACTIVE_RESERVATIONS);
  });
});

describe("planning under a reservation", () => {
  it("withholds the last slot from autonomous demand", () => {
    const plan = planProjectDemand({
      selectors: [selector("afk", 4)],
      live: 2,
      target: 3,
      breaker: {},
      nowMs: 0,
      runner: null,
      reserved: 1,
    });
    expect(plan.requests).toHaveLength(0);
    expect(plan.held_back.map((held) => held.selector_id)).toEqual(["afk"]);
    expect(plan.held_back[0]?.reason).toContain("no live Worker was terminated");
  });

  it("serves the interactive dispatch out of the slot it reserved", () => {
    const plan = planProjectDemand({
      selectors: [selector("go", 1, true), selector("afk", 4)],
      live: 2,
      target: 3,
      breaker: {},
      nowMs: 0,
      runner: null,
      reserved: 1,
    });
    expect(plan.requests.map((request) => request.selector_id)).toEqual(["go"]);
    // The reservation was spent, not double-counted: with no room left there is
    // nothing to hold back and nothing to report.
    expect(plan.held_back).toEqual([]);
  });

  it("leaves autonomous demand whole once the reservation is withdrawn", () => {
    const plan = planProjectDemand({
      selectors: [selector("afk", 4)],
      live: 0,
      target: 3,
      breaker: {},
      nowMs: 0,
      runner: null,
      reserved: 0,
    });
    expect(plan.requests).toHaveLength(3);
    expect(plan.held_back).toEqual([]);
  });

  it("holds back only the reserved slots, not the whole budget", () => {
    const plan = planProjectDemand({
      selectors: [selector("afk", 4)],
      live: 0,
      target: 3,
      breaker: {},
      nowMs: 0,
      runner: null,
      reserved: 1,
    });
    expect(plan.requests.map((request) => request.index)).toEqual([0, 1]);
    expect(plan.held_back.map((held) => held.selector_id)).toEqual(["afk"]);
  });

  it("never asks for a negative number of Workers when the reservation exceeds the room", () => {
    const plan = planProjectDemand({
      selectors: [selector("afk", 4)],
      live: 3,
      target: 3,
      breaker: {},
      nowMs: 0,
      runner: null,
      reserved: 5,
    });
    expect(plan.requests).toEqual([]);
  });
});

describe("a producer serving an interactive dispatch", () => {
  it("gives the next free slot to the interactive selector, ahead of the queue", async () => {
    const host = generousHost();
    let live = 3;
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("go", 1, true), selector("afk", 10)],
      startWorker: host.start,
      liveWorkers: () => live,
      resolveElasticTarget: () => 3,
      clock: () => 0,
    });

    // A full machine with days of queued autonomous work.
    producer.reserveInteractive({ reservation_id: "go-1", reason: "one-off dispatch" });
    const full = await producer.produce();
    expect(full.granted).toEqual([]);
    expect(full.reserved).toBe(1);
    expect(host.seen).toHaveLength(0);

    // A Worker finishes on its own; the freed slot goes to the interactive work.
    live = 2;
    const served = await producer.produce();
    expect(served.granted.map((worker) => worker.selector_id)).toEqual(["go"]);
    expect(host.seen).toHaveLength(1);
  });

  it("returns the slot to autonomous demand when the request is withdrawn", async () => {
    const host = generousHost();
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("afk", 10)],
      startWorker: host.start,
      liveWorkers: () => 2,
      resolveElasticTarget: () => 3,
      clock: () => 0,
    });

    producer.reserveInteractive({ reservation_id: "go-1" });
    expect((await producer.produce()).granted).toEqual([]);

    producer.releaseInteractive("go-1");
    const after = await producer.produce();
    expect(after.reserved).toBe(0);
    expect(after.granted.map((worker) => worker.selector_id)).toEqual(["afk"]);
  });

  it("releases a hold whose caller never withdrew, so the queue always resumes", async () => {
    const host = generousHost();
    let nowMs = 0;
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("afk", 10)],
      startWorker: host.start,
      liveWorkers: () => 2,
      resolveElasticTarget: () => 3,
      reservationTtlMs: 60_000,
      clock: () => nowMs,
    });

    producer.reserveInteractive({ reservation_id: "go-1" });
    expect((await producer.produce()).granted).toEqual([]);

    nowMs = 60_000;
    const after = await producer.produce();
    expect(after.reserved).toBe(0);
    expect(after.granted.map((worker) => worker.selector_id)).toEqual(["afk"]);
    expect(producer.reservations().reservations).toEqual([]);
  });

  it("tells its host which selector yielded the slot and why", async () => {
    const host = generousHost();
    const events: string[] = [];
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("afk", 10)],
      startWorker: host.start,
      liveWorkers: () => 1,
      resolveElasticTarget: () => 3,
      onLifecycle: (event) => {
        if (event.event === "selector-held-back") events.push(`${event.selector_id}: ${event.detail}`);
      },
      clock: () => 0,
    });

    producer.reserveInteractive({ reservation_id: "go-1" });
    await producer.produce();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("afk: 1 slot(s) held back for an interactive dispatch");
  });
});

describe("soft preemption is soft, and the policy is the project's", () => {
  const producerSource = readFileSync(new URL("../src/demand-producer.ts", import.meta.url), "utf8");
  const reservationSource = readFileSync(new URL("../src/interactive-reservation.ts", import.meta.url), "utf8");

  it("gives the project no way to terminate a live Worker for a reservation", () => {
    // The producer's only host seam is `startWorker`. A stop/kill/signal seam
    // would let impatience destroy work in flight, which is the exact bargain
    // soft preemption refuses.
    for (const source of [producerSource, reservationSource]) {
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/stopWorker|killWorker|terminateWorker|SIGTERM|SIGKILL|process\.kill/);
    }
  });

  it("does not shrink the live Worker count when a reservation is taken", async () => {
    const host = generousHost();
    const producer = createDemandProducer({
      projectLabel: "acme/widgets",
      selectors: [selector("afk", 10)],
      startWorker: host.start,
      liveWorkers: () => 3,
      resolveElasticTarget: () => 3,
      clock: () => 0,
    });

    producer.reserveInteractive({ reservation_id: "go-1" });
    const result = await producer.produce();
    expect(result.live).toBe(3);
    expect(result.granted).toEqual([]);
    expect(result.requested).toBe(0);
    // The host was never contacted at all: the reservation is an unasked birth.
    expect(host.seen).toEqual([]);
  });

  it("keeps lane semantics out of the host-owned reservation policy", () => {
    for (const file of ["daemon.ts", "admission.ts", "worker-launch.ts", "protocol.ts", "client.ts"]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source, `${file} must not interpret project lane vocabulary`).not.toMatch(
        /lane:go|lane:scout|ready-for-agent/,
      );
    }
  });
});
