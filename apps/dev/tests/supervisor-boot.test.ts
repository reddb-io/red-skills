// supervisor-boot.test.ts — the fleet supervisor owns the boot (#623).
//
// runSupervisor runs the injected `bootSweeps` ONCE, before the initial fleet
// spawn, and never again for the rest of its lifetime (a worker death + respawn
// inside the tick loop must not re-trigger the sweeps). A bootSweeps throw is
// caught and logged; the fleet still spawns. Kept in its own small file so it
// runs without the environmental heap pressure of the full supervisor suite.

import { describe, expect, it, vi } from "vitest";
import {
  runSupervisor,
  initSupervisorState,
  SUPERVISOR_DEFAULTS,
  type SupervisorConfig,
  type SupervisorDeps,
} from "../src/core/supervisor.js";
import type { ProcessSnapshotEntry } from "../src/core/reaper-signal.js";
import type { LivenessVerdict } from "@reddb-io/red-castle";

const NOW = 1_000_000;

function config(over: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return { ...SUPERVISOR_DEFAULTS, ...over };
}

interface DepsOverrides {
  isAlive?: () => boolean;
  lastExitCode?: () => number | null;
  readyQueueDepth?: () => Promise<number>;
  bootSweeps?: (() => Promise<void>) | undefined;
}

/** A minimal real-shaped SupervisorDeps with every closure spied. The `sleep`
 * resolves on a macrotask (setTimeout 0) — NOT immediately — so guardedTick's
 * race lets the real tick win and `stopped` propagates (avoids the #446 spin). */
function makeDeps(over: DepsOverrides = {}): {
  deps: SupervisorDeps;
  spawnSlot: ReturnType<typeof vi.fn>;
  bootSweeps: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  order: string[];
} {
  let nextPid = 2000;
  const order: string[] = [];
  const hasBoot = !("bootSweeps" in over) || over.bootSweeps !== undefined;
  const bootSweeps = vi.fn(
    over.bootSweeps ??
      (async () => {
        order.push("boot");
      }),
  );
  const spawnSlot = vi.fn(async () => {
    order.push("spawn");
    return { pid: ++nextPid, spawnEpoch: NOW };
  });
  const log = vi.fn();
  const deps: SupervisorDeps = {
    proc: {
      spawnSlot,
      isAlive: vi.fn(over.isAlive ?? (() => true)),
      killTree: vi.fn(async () => {}),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => []),
      sleep: vi.fn((_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 0))),
      lastExitCode: vi.fn(over.lastExitCode ?? (() => null as number | null)),
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
      readyQueueDepth: vi.fn(over.readyQueueDepth ?? (async () => 0)),
    },
    now: vi.fn(() => NOW),
    log,
    ...(hasBoot ? { bootSweeps } : {}),
  };
  return { deps, spawnSlot, bootSweeps, log, order };
}

describe("runSupervisor — supervisor owns the boot (#623)", () => {
  it("runs bootSweeps exactly once, before the initial fleet spawn", async () => {
    const { deps, spawnSlot, bootSweeps, order } = makeDeps();
    const state = initSupervisorState(2);

    await runSupervisor(state, deps, config({ target: 2 }), () => true);

    expect(bootSweeps).toHaveBeenCalledTimes(1);
    expect(spawnSlot).toHaveBeenCalledTimes(2);
    // The single boot strictly precedes every spawn.
    expect(order).toEqual(["boot", "spawn", "spawn"]);
  });

  it("does not re-run bootSweeps when a worker dies and the slot respawns", async () => {
    // Slot worker pid is reported dead from tick 1 onward → handleDeadSlot
    // respawns it (clean queue has work). bootSweeps must NOT fire again.
    const { deps, spawnSlot, bootSweeps } = makeDeps({
      isAlive: vi.fn(() => false),
      lastExitCode: vi.fn(() => 0), // clean exit + queue>0 → respawn, not park.
      readyQueueDepth: vi.fn(async () => 3),
    });
    const state = initSupervisorState(1);

    // Stop on the 2nd probe: tick 1 respawns the dead slot, then stop.
    let probes = 0;
    const stop = () => ++probes >= 2;

    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 15 }), stop);

    // Boot ran once for the whole lifetime; the slot spawned initial + respawn.
    expect(bootSweeps).toHaveBeenCalledTimes(1);
    expect(spawnSlot.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("spawns the fleet even when bootSweeps throws (best-effort, logged)", async () => {
    const { deps, spawnSlot, log } = makeDeps({
      bootSweeps: vi.fn(async () => {
        throw new Error("gh down");
      }),
    });
    const state = initSupervisorState(1);

    await runSupervisor(state, deps, config({ target: 1 }), () => true);

    expect(spawnSlot).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((c) => String(c[0]).includes("boot sweeps failed"))).toBe(true);
  });

  it("spawns normally when no bootSweeps is wired (back-compat)", async () => {
    const { deps, spawnSlot, bootSweeps } = makeDeps({ bootSweeps: undefined });
    const state = initSupervisorState(1);

    await runSupervisor(state, deps, config({ target: 1 }), () => true);

    expect(bootSweeps).not.toHaveBeenCalled();
    expect(spawnSlot).toHaveBeenCalledTimes(1);
  });
});
