// boot-breaker.test.ts — crashloop circuit breaker (#2527, ADR 0122 amendment).
//
// N consecutive identical boot-death signatures trip the breaker: the
// supervisor stops feeding the respawn loop, the resident healer is invoked
// immediately, and a loud alert record is emitted. A different signature or one
// successful boot resets the run; the boot probe refuses to proceed while the
// breaker is open.

import { describe, expect, it, vi } from "vitest";
import {
  BOOT_BREAKER_DEFAULT_THRESHOLD,
  bootDeathSignature,
  isBreakerOpen,
  recordBootDeath,
  type BootBreakerLedger,
  type BootBreakerStore,
} from "../src/core/supervisor/boot-breaker.js";
import {
  runSupervisor,
  initSupervisorState,
  SUPERVISOR_DEFAULTS,
  type SupervisorConfig,
  type SupervisorDeps,
} from "../src/core/supervisor.js";
import { BootHaltError } from "../src/core/boot.js";
import { renderFleetBlock } from "../src/core/statusline.js";
import type { ProcessSnapshotEntry } from "../src/core/reaper-signal.js";
import type { LivenessVerdict } from "@reddb-io/red-castle";

const NOW = 1_000_000;

function probeHalt(evidence: string): BootHaltError {
  return new BootHaltError("operational-probe", {
    id: "claim-hygiene",
    name: "Claim hygiene",
    verdict: "red",
    evidence,
    canonicalFix: "release the ghost claim",
  });
}

function memoryStore(initial: BootBreakerLedger | null = null): {
  store: BootBreakerStore;
  current: () => BootBreakerLedger | null;
} {
  let ledger = initial;
  return {
    store: {
      read: async () => ledger,
      write: async (next) => {
        ledger = next;
      },
    },
    current: () => ledger,
  };
}

describe("recordBootDeath — pure consecutive-signature breaker", () => {
  it("trips exactly on the Nth consecutive identical signature, not before, not again", () => {
    const sig = "operational-probe|claim-hygiene|#2521 marker w8DI1";
    const first = recordBootDeath(null, sig, NOW);
    expect(first.tripped).toBe(false);
    expect(first.ledger.count).toBe(1);
    const second = recordBootDeath(first.ledger, sig, NOW + 10);
    expect(second.tripped).toBe(false);
    const third = recordBootDeath(second.ledger, sig, NOW + 20);
    expect(third.tripped).toBe(true);
    expect(third.ledger.count).toBe(BOOT_BREAKER_DEFAULT_THRESHOLD);
    expect(third.ledger.trippedAtEpoch).toBe(NOW + 20);
    // A 4th identical death keeps counting but must not re-fire the trip
    // (healer + alert already ran).
    const fourth = recordBootDeath(third.ledger, sig, NOW + 30);
    expect(fourth.tripped).toBe(false);
    expect(fourth.ledger.count).toBe(4);
    expect(isBreakerOpen(fourth.ledger)).toBe(true);
  });

  it("a different signature resets the consecutive run", () => {
    const a = recordBootDeath(null, "sig-A", NOW);
    const b = recordBootDeath(a.ledger, "sig-A", NOW + 1);
    const c = recordBootDeath(b.ledger, "sig-B", NOW + 2);
    expect(c.ledger.count).toBe(1);
    expect(c.tripped).toBe(false);
    expect(isBreakerOpen(c.ledger)).toBe(false);
  });

  it("bootDeathSignature is byte-identical for identical probe deaths and differs across refs", () => {
    const one = bootDeathSignature(probeHalt("#2521 held by dead marker w8DI1"));
    const two = bootDeathSignature(probeHalt("#2521 held by dead marker w8DI1"));
    const other = bootDeathSignature(probeHalt("#2174 held by dead marker wPB6V"));
    expect(one).toBe(two);
    expect(one).not.toBe(other);
  });
});

// ---------- runSupervisor integration ----------

function makeDeps(bootSweeps: () => Promise<void>, breaker: SupervisorDeps["bootBreaker"]): {
  deps: SupervisorDeps;
  spawnSlot: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  events: Array<{ kind: string; payload?: Record<string, unknown> }>;
} {
  const spawnSlot = vi.fn(async () => ({ pid: 2001, spawnEpoch: NOW }));
  const log = vi.fn();
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const deps: SupervisorDeps = {
    proc: {
      spawnSlot,
      isAlive: vi.fn(() => true),
      killTree: vi.fn(async () => {}),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => []),
      sleep: vi.fn((_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 0))),
      lastExitCode: vi.fn(() => null as number | null),
    },
    fs: {
      workerLivenessVerdict: vi.fn((): LivenessVerdict | null => null),
      resolveIterDir: vi.fn(() => null),
      teardownIterDir: vi.fn(async () => {}),
      parkedSlotWork: vi.fn(() => ({ workers: [], supervisorLogPath: ".red/tmp/afk-supervisor.log" })),
      removeDir: vi.fn(async () => {}),
    },
    gh: {
      comment: vi.fn(async () => {}),
      editLabels: vi.fn(async () => {}),
      ensureRunnerErrorLabel: vi.fn(async () => {}),
      ensureLabel: vi.fn(async () => {}),
      readyQueueDepth: vi.fn(async () => 0),
    },
    now: vi.fn(() => NOW),
    log,
    bootSweeps: vi.fn(bootSweeps),
    emitSupervisorEvent: vi.fn((record) => {
      events.push(record as { kind: string; payload?: Record<string, unknown> });
    }),
    bootBreaker: breaker,
  };
  return { deps, spawnSlot, log, events };
}

function config(over: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return { ...SUPERVISOR_DEFAULTS, ...over };
}

describe("runSupervisor — boot breaker wiring (#2527)", () => {
  it("three seeded identical boot deaths: no spawn, healer invoked once, alert emitted", async () => {
    const { store, current } = memoryStore();
    const heal = vi.fn(async () => "curator sweep ran");
    const halt = () => Promise.reject(probeHalt("#2521 held by dead marker w8DI1"));

    for (let boot = 0; boot < 3; boot += 1) {
      const { deps, spawnSlot, log, events } = makeDeps(halt, { store, heal });
      await runSupervisor(initSupervisorState(2), deps, config({ target: 2 }), () => true);
      expect(spawnSlot).not.toHaveBeenCalled();
      if (boot < 2) {
        expect(heal).not.toHaveBeenCalled();
      } else {
        expect(heal).toHaveBeenCalledTimes(1);
        expect(log.mock.calls.some(([line]) => String(line).includes("boot breaker TRIPPED"))).toBe(true);
        const breakerEvents = events.filter((e) => e.kind === "supervisor.breaker");
        expect(breakerEvents).toHaveLength(1);
        expect(breakerEvents[0]!.payload).toMatchObject({
          status: "tripped",
          count: 3,
          heal_outcome: "curator sweep ran",
        });
      }
    }
    expect(isBreakerOpen(current())).toBe(true);
  });

  it("one successful boot resets the breaker ledger", async () => {
    const seeded = recordBootDeath(null, "sig-A", NOW).ledger;
    const { store, current } = memoryStore(seeded);
    const { deps } = makeDeps(async () => {}, { store });

    await runSupervisor(initSupervisorState(1), deps, config({ target: 1 }), () => true);

    expect(current()).toBeNull();
  });
});
