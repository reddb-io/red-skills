import { describe, expect, it, vi } from "vitest";
import type {
  SingletonLease,
  SingletonLeaseAcquireResult,
  SingletonLeaseOwner,
  SingletonLeaseStore,
} from "@reddb-io/red-castle/engine";
import {
  RESIDENT_UNBLOCK_INTERVAL_MS,
  UNBLOCK_SWEEP_SINGLETON,
  startResidentUnblockSweep,
  type ResidentUnblockTimers,
} from "../src/resident-unblock.js";
import { listUnblockCandidates } from "../src/runtime/gh/sweeps.js";
import type { GhContext } from "../src/runtime/gh/common.js";
import { runUnblockPass, type UnblockPassIo } from "../src/runtime/unblock-pass.js";

const LEASE: SingletonLease = {
  pid: 4242,
  start_time: "start",
  acquired_at: "2026-08-01T00:00:00.000Z",
  renewed_at: "2026-08-01T00:00:00.000Z",
};

function leaseStore(
  acquire: SingletonLeaseAcquireResult = { acquired: true, reaped: false, lease: LEASE },
): SingletonLeaseStore & { released: string[] } {
  const released: string[] = [];
  return {
    released,
    read: async () => LEASE,
    acquire: async () => acquire,
    renew: async () => LEASE,
    release: async (name: string, _owner: SingletonLeaseOwner) => {
      released.push(name);
      return true;
    },
  };
}

/** A hand-driven interval: the belt's tick is invoked explicitly, so no test
 * waits on wall-clock time to prove the schedule. */
function manualTimers(): ResidentUnblockTimers & { fire(): void; cleared: number } {
  const state = {
    callback: undefined as (() => void) | undefined,
    cleared: 0,
    fire() {
      state.callback?.();
    },
    setInterval(callback: () => void) {
      state.callback = callback;
      return "timer";
    },
    clearInterval() {
      state.cleared += 1;
    },
  };
  return state as unknown as ResidentUnblockTimers & { fire(): void; cleared: number };
}

describe("Unblock pass (#3014)", () => {
  // THE ACCEPTANCE CASE. No daemon, no `/afk` boot, no worker: a human closed
  // the last `req:*` blocker in the GitHub UI, so nothing ran the close cascade.
  // The dependent must still lose `blocked:dependency` through the pass the
  // resident can reach.
  it("drops blocked:dependency once the last blocker is closed", async () => {
    const edits: Array<{ issue: number; remove: string[]; add: string[] }> = [];
    const comments: Array<{ issue: number; body: string }> = [];
    const io: UnblockPassIo = {
      listCandidates: async () => ({
        outcome: "rows",
        rows: [
          { number: 17, body: "", labels: ["blocked:dependency", "req:5", "type:ticket"] },
        ],
      }),
      issueClosed: async (issue) => issue === 5,
      editLabels: async (issue, remove, add) => {
        edits.push({ issue, remove, add });
      },
      comment: async (issue, body) => {
        comments.push({ issue, body });
      },
      hitlTypes: () => [],
    };

    await expect(runUnblockPass(io)).resolves.toMatchObject({ promoted: [17] });
    expect(edits).toHaveLength(1);
    expect(edits[0]!.issue).toBe(17);
    expect(edits[0]!.remove).toContain("blocked:dependency");
    expect(edits[0]!.remove).toContain("req:5");
    expect(edits[0]!.add).toContain("ready-for-agent");
    expect(comments[0]!.body).toContain("#5");
  });

  // The conservative direction is unchanged: one still-open blocker keeps the
  // dependent blocked, so a session-time belt can never promote work early.
  it("leaves a dependent blocked while any blocker is still open", async () => {
    const edits: number[] = [];
    const io: UnblockPassIo = {
      listCandidates: async () => ({
        outcome: "rows",
        rows: [
          { number: 19, body: "", labels: ["blocked:dependency", "req:5", "req:6"] },
        ],
      }),
      issueClosed: async (issue) => issue === 5,
      editLabels: async (issue) => {
        edits.push(issue);
      },
      comment: async () => undefined,
      hitlTypes: () => [],
    };

    await expect(runUnblockPass(io)).resolves.toMatchObject({ promoted: [] });
    expect(edits).toEqual([]);
  });

  // What makes the pass affordable at every session boot: a repo with nothing
  // blocked costs the candidate listing and NO per-blocker round-trip.
  it("costs one listing and no blocker lookup when nothing is blocked", async () => {
    const issueClosed = vi.fn(async () => true);
    const io: UnblockPassIo = {
      listCandidates: async () => ({ outcome: "rows", rows: [] }),
      issueClosed,
      editLabels: async () => undefined,
      comment: async () => undefined,
      hitlTypes: () => [],
    };

    await expect(runUnblockPass(io)).resolves.toMatchObject({ promoted: [] });
    expect(issueClosed).not.toHaveBeenCalled();
  });

  // A human-authority close has no Worker terminal event to drive the close
  // cascade, so this pass is the safety net. If its live candidate listing
  // fails, that must remain observably different from a successful empty read.
  it("surfaces a failed live candidate listing instead of claiming nothing is blocked", async () => {
    const issueClosed = vi.fn(async () => true);
    const gh = {
      repo: "reddb-io/red-skills",
      cwd: "/nowhere",
      github: {
        conditionalPaginate: async () => {
          throw new Error("HttpError: 503 Service Unavailable");
        },
        conditionalRest: async () => {
          throw new Error("the candidate listing must paginate");
        },
      },
    } as unknown as GhContext;
    const io: UnblockPassIo = {
      listCandidates: () => listUnblockCandidates(gh),
      issueClosed,
      editLabels: async () => undefined,
      comment: async () => undefined,
      hitlTypes: () => [],
    };

    await expect(runUnblockPass(io)).resolves.toEqual({
      promoted: [],
      outcomes: [
        {
          outcome: "failed",
          surface: "candidate-list",
          reason: "HttpError: 503 Service Unavailable",
        },
      ],
    });
    expect(issueClosed).not.toHaveBeenCalled();
  });
});

describe("resident Unblock belt (#3014)", () => {
  // The session-boot clearer: starting the belt sweeps immediately, which is the
  // whole point on a repo where the only thing that ever wakes is a live session.
  it("sweeps once at start without waiting for the interval", async () => {
    const pass = vi.fn(async () => ({ promoted: [17], outcomes: [] }));
    const timers = manualTimers();

    const belt = await startResidentUnblockSweep({
      root: process.cwd(),
      pass,
      leases: leaseStore(),
      owner: { pid: 4242, startTime: "start" },
      timers,
    });

    expect(belt).not.toBeNull();
    await belt!.sweep();
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it("re-sweeps on every interval tick", async () => {
    const pass = vi.fn(async () => ({ promoted: [], outcomes: [] }));
    const timers = manualTimers();

    const belt = await startResidentUnblockSweep({
      pass,
      leases: leaseStore(),
      owner: { pid: 4242, startTime: "start" },
      timers,
      intervalMs: RESIDENT_UNBLOCK_INTERVAL_MS,
    });
    await belt!.sweep();
    timers.fire();
    await belt!.sweep();

    expect(pass).toHaveBeenCalledTimes(2);
  });

  // The regression this module exists for: a pass that throws must cost ITSELF
  // and nothing else. Coupling the sweep to a suite whose earlier steps halt is
  // exactly how the promote path was starved on the reporting repo.
  it("keeps its schedule after a failing pass", async () => {
    const notices: string[] = [];
    let calls = 0;
    const pass = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("tracker unavailable");
      return { promoted: [17], outcomes: [] };
    });
    const timers = manualTimers();

    const belt = await startResidentUnblockSweep({
      pass,
      leases: leaseStore(),
      owner: { pid: 4242, startTime: "start" },
      timers,
      notice: (line) => notices.push(line),
    });
    await belt!.sweep();

    expect(notices[0]).toContain("tracker unavailable");
    await expect(belt!.sweep()).resolves.toMatchObject({ promoted: [17] });
  });

  // Several stdio hosts for one repo must not each sweep the same tracker.
  it("stands down when another live host owns the singleton", async () => {
    const pass = vi.fn(async () => ({ promoted: [], outcomes: [] }));

    const belt = await startResidentUnblockSweep({
      pass,
      leases: leaseStore({ acquired: false, lease: LEASE }),
      owner: { pid: 4242, startTime: "start" },
      timers: manualTimers(),
    });

    expect(belt).toBeNull();
    expect(pass).not.toHaveBeenCalled();
  });

  it("clears its timer and releases the singleton on stop", async () => {
    const timers = manualTimers();
    const leases = leaseStore();

    const belt = await startResidentUnblockSweep({
      pass: async () => ({ promoted: [], outcomes: [] }),
      leases,
      owner: { pid: 4242, startTime: "start" },
      timers,
    });
    await belt!.stop();

    expect(timers.cleared).toBe(1);
    expect(leases.released).toEqual([UNBLOCK_SWEEP_SINGLETON]);
  });
});
