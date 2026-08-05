import { describe, expect, it, vi } from "vitest";
import {
  handoffQueueCustody,
  sweepQueueCustody,
  type QueueCustodyState,
  type QueueCustodyStore,
} from "../src/core/queue-custodian.js";

function memoryStore(): QueueCustodyStore & { state: QueueCustodyState } {
  const store = {
    state: { version: 1 as const, prs: {} },
    async read() {
      return store.state;
    },
    async write(state: QueueCustodyState) {
      store.state = state;
    },
  };
  return store;
}

describe("Queue Custodian", () => {
  it("arms native merge intent before durably accepting custody", async () => {
    const store = memoryStore();
    const calls: string[] = [];
    const armNativeIntent = vi.fn(async () => {
      calls.push("arm-native-intent");
      return { ok: true as const };
    });

    const result = await handoffQueueCustody(
      {
        store,
        now: () => "2026-08-05T12:30:00.000Z",
        armNativeIntent,
        afterWrite: () => calls.push("custody-durable"),
      },
      {
        repo: "reddb-io/red-skills",
        prNumber: 3334,
        ownerTicket: 3333,
        branch: "afk/3333-queue-custodian",
        base: "main",
      },
    );

    expect(result).toEqual({ ok: true, prNumber: 3334, outcome: "handed-off" });
    expect(calls).toEqual(["arm-native-intent", "custody-durable"]);
    expect(store.state.prs["3334"]).toEqual({
      repo: "reddb-io/red-skills",
      prNumber: 3334,
      ownerTicket: 3333,
      branch: "afk/3333-queue-custodian",
      base: "main",
      status: "watching",
      semanticBounces: [],
      handedOffAt: "2026-08-05T12:30:00.000Z",
      updatedAt: "2026-08-05T12:30:00.000Z",
    });
  });

  it("turns a daemon-observed vanished intent into one admission-born repair Worker", async () => {
    const store = memoryStore();
    await handoffQueueCustody(
      {
        store,
        now: () => "2026-08-05T12:30:00.000Z",
        armNativeIntent: async () => ({ ok: true }),
      },
      {
        repo: "reddb-io/red-skills",
        prNumber: 3334,
        ownerTicket: 3333,
        branch: "afk/3333-queue-custodian",
        base: "main",
      },
    );
    const admitRepairWorker = vi.fn(async () => ({ admitted: true as const, workerId: "repair-1" }));

    const sweep = await sweepQueueCustody({
      store,
      now: () => "2026-08-05T12:45:00.000Z",
      observePullRequests: async () => ({
        "3334": {
          state: "OPEN",
          nativeIntent: false,
          checks: "green",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
        },
      }),
      admitRepairWorker,
    });

    expect(sweep).toEqual({ merged: [], admitted: [{ prNumber: 3334, workerId: "repair-1" }] });
    expect(admitRepairWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "repair",
        kind: "repair",
        prNumber: 3334,
        ownerTicket: 3333,
      }),
    );
    expect(store.state.prs["3334"]?.status).toBe("repairing");
  });
});
