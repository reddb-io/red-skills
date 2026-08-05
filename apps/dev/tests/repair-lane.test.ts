import { describe, expect, it, vi } from "vitest";
import {
  REPAIR_KIND,
  REPAIR_ORIGIN,
  healQueueEjection,
  sweepRepairLane,
  type QueueFailure,
  type RepairCandidate,
  type RepairLaneDeps,
} from "../src/core/repair-lane.js";

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    prNumber: 3291,
    ownerTicket: 3284,
    branch: "afk/3284-validation-moments",
    base: "main",
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
    queued: false,
    ...overrides,
  };
}

function deps(overrides: Partial<RepairLaneDeps> = {}): RepairLaneDeps {
  return {
    stampWorker: vi.fn(async () => undefined),
    mergeBase: vi.fn(async () => ({ ok: true })),
    runGenerator: vi.fn(async () => ({ ok: true })),
    pushBranch: vi.fn(async () => ({ ok: true })),
    enqueue: vi.fn(async () => ({ ok: true })),
    waitForQueue: vi.fn(async () => ({ outcome: "accepted" as const })),
    attachQueueFailure: vi.fn(async () => undefined),
    escalateOwner: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("repair lane worker", () => {
  it("heals a stale generated mirror end-to-end without re-seeding the owning Worker", async () => {
    const state = { baseVersion: 1, mirrorVersion: 1, queued: false };
    const calls: string[] = [];
    const d = deps({
      stampWorker: vi.fn(async (stamp) => {
        calls.push(`stamp:${stamp.origin}/${stamp.kind}`);
      }),
      mergeBase: vi.fn(async () => {
        calls.push("merge-base");
        state.baseVersion = 2;
        return { ok: true };
      }),
      runGenerator: vi.fn(async (command) => {
        calls.push(`generate:${command}`);
        state.mirrorVersion = state.baseVersion;
        return { ok: true };
      }),
      pushBranch: vi.fn(async () => {
        calls.push("push");
        return { ok: true };
      }),
      enqueue: vi.fn(async () => {
        calls.push("enqueue");
        state.queued = true;
        return { ok: true };
      }),
      waitForQueue: vi.fn(async () => {
        calls.push("confirm");
        return state.queued && state.mirrorVersion === state.baseVersion
          ? { outcome: "accepted" as const }
          : {
              outcome: "semantic-failure" as const,
              failure: { summary: "generated mirror is stale" },
            };
      }),
    });

    const result = await healQueueEjection(
      d,
      candidate(),
      ["pnpm pi:manifests"],
    );

    expect(result).toEqual({ outcome: "requeued", prNumber: 3291 });
    expect(calls).toEqual([
      "stamp:repair/repair",
      "merge-base",
      "generate:pnpm pi:manifests",
      "push",
      "enqueue",
      "confirm",
    ]);
    expect(d.attachQueueFailure).not.toHaveBeenCalled();
    expect(d.escalateOwner).not.toHaveBeenCalled();
    expect(REPAIR_ORIGIN).toBe("repair");
    expect(REPAIR_KIND).toBe("repair");
  });

  it("attaches a semantic queue failure and escalates it to the owning Ticket", async () => {
    const failure: QueueFailure = {
      summary: "test: release manifest disagrees with package versions",
      check: "test",
      detailsUrl: "https://example.test/checks/17",
    };
    const d = deps({
      waitForQueue: vi.fn(async () => ({ outcome: "semantic-failure" as const, failure })),
    });

    const result = await healQueueEjection(d, candidate(), ["pnpm pi:manifests"]);

    expect(result).toEqual({
      outcome: "escalated",
      prNumber: 3291,
      ownerTicket: 3284,
      failure,
    });
    expect(d.attachQueueFailure).toHaveBeenCalledWith(3284, 3291, failure);
    expect(d.escalateOwner).toHaveBeenCalledWith(3284, 3291, failure);
  });

  it("enqueues an unqueued mergeable PR during the periodic sweep", async () => {
    const d = deps();

    const results = await sweepRepairLane(d, [
      candidate({ prNumber: 4001, mergeStateStatus: "CLEAN", queued: false }),
      candidate({ prNumber: 4002, mergeStateStatus: "CLEAN", queued: true }),
      candidate({ prNumber: 4003, mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }),
    ]);

    expect(results).toEqual([{ outcome: "requeued", prNumber: 4001 }]);
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    expect(d.enqueue).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 4001 }));
    expect(d.mergeBase).not.toHaveBeenCalled();
    expect(d.runGenerator).not.toHaveBeenCalled();
    expect(d.stampWorker).toHaveBeenCalledWith({
      origin: "repair",
      kind: "repair",
      prNumber: 4001,
      ownerTicket: 3284,
    });
  });
});
