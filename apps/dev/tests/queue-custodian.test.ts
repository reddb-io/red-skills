import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doLanding } from "../src/core/landing.js";
import { harness } from "./landing.test-support.js";
import { readsPull } from "./support/gh-rest-fixtures.js";
import {
  harness as processHarness,
  processIssue,
} from "./process-issue.test-helpers.js";
import {
  createFileQueueCustodyStore,
  handoffQueueCustody,
  repairQueueCustody,
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
  it("ends Landing at custody hand-off without a merge-poll tail", async () => {
    const store = memoryStore();
    const landing = harness({
      locked: false,
      openPr: true,
      nativeMergeQueue: true,
      queueOutcome: "pending",
    });
    landing.deps.queueCustody = (identity, armNativeIntent) => handoffQueueCustody(
      {
        store,
        now: () => "2026-08-05T12:30:00.000Z",
        armNativeIntent,
      },
      identity,
    );

    const result = await doLanding(landing.deps, landing.input, landing.hooks);

    expect(result).toEqual({
      ok: true,
      locked: false,
      custody: { prNumber: 42, outcome: "handed-off" },
    });
    expect(landing.mergeCalls.some((argv) => argv.includes("--auto"))).toBe(true);
    expect(landing.mergeCalls.filter((argv) => readsPull(argv))).toHaveLength(0);
    expect(landing.firedHooks).toEqual(["pre_merge"]);
    expect(store.state.prs["42"]).toMatchObject({ ownerTicket: 9, status: "watching" });
  });

  it("makes native custody the terminal hand-off regardless of legacy slot-release settings", async () => {
    const store = memoryStore();
    const landing = harness({ locked: false, openPr: true, nativeMergeQueue: true });
    landing.deps.landingWait = "none";
    landing.deps.queueCustody = (identity, armNativeIntent) => handoffQueueCustody(
      { store, now: () => "2026-08-05T12:30:00.000Z", armNativeIntent },
      identity,
    );

    const result = await doLanding(landing.deps, landing.input, landing.hooks);

    expect(result).toMatchObject({
      ok: true,
      custody: { prNumber: 42, outcome: "handed-off" },
    });
    expect(result.ok && result.deferred).toBeUndefined();
  });

  it("terminates the owning Worker without closing the Ticket at custody hand-off", async () => {
    const store = memoryStore();
    const { deps, input, trace } = processHarness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      queueOutcome: "pending",
    });
    Object.assign(deps, {
      nativeMergeQueue: true,
      queueCustody: (identity: Parameters<typeof handoffQueueCustody>[1], armNativeIntent: () => Promise<{ ok: boolean; reason?: string }>) =>
        handoffQueueCustody(
          { store, now: () => "2026-08-05T12:30:00.000Z", armNativeIntent },
          identity,
        ),
    });

    const result = await processIssue(deps, input);

    expect(result).toMatchObject({ outcome: "done", swept: false });
    expect(trace.released).toEqual([9]);
    expect(trace.closed).toEqual([]);
    expect(store.state.prs["42"]).toMatchObject({ ownerTicket: 9, status: "watching" });
  });

  it("reloads custody from its durable AFK state lane", async () => {
    const root = await mkdtemp(join(tmpdir(), "queue-custody-"));
    try {
      const path = join(root, ".red", "state", "afk", "queue-custody.toon");
      const store = createFileQueueCustodyStore(path);
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

      expect((await createFileQueueCustodyStore(path).read()).prs["3334"]).toMatchObject({
        status: "watching",
        ownerTicket: 3333,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
        afterWrite: () => {
          calls.push("custody-durable");
        },
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

  it("requeues one semantic bounce with adoption, then parks the second with history", async () => {
    const store = memoryStore();
    const identity = {
      repo: "reddb-io/red-skills",
      prNumber: 3334,
      ownerTicket: 3333,
      branch: "afk/3333-queue-custodian",
      base: "main",
    };
    let instant = "2026-08-05T13:00:00.000Z";
    const readyForAgent = vi.fn(async () => undefined);
    const readyForHuman = vi.fn(async () => undefined);
    const adoptBranch = vi.fn(async () => undefined);
    const summary = "required check integration rejected the merged tree";
    const repairDeps = {
      stampWorker: vi.fn(async () => undefined),
      mergeBase: vi.fn(async () => ({ ok: true })),
      runGenerator: vi.fn(async () => ({ ok: true })),
      pushBranch: vi.fn(async () => ({ ok: true })),
      enqueue: vi.fn(async () => ({ ok: true })),
      waitForQueue: vi.fn(async () => ({
        outcome: "semantic-failure" as const,
        failure: { summary, check: "integration" },
      })),
    };
    const handoff = () => handoffQueueCustody(
      { store, now: () => instant, armNativeIntent: async () => ({ ok: true }) },
      identity,
    );
    const admit = () => sweepQueueCustody({
      store,
      now: () => instant,
      observePullRequests: async () => ({
        "3334": {
          state: "OPEN" as const,
          nativeIntent: false,
          checks: "failing" as const,
          mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE",
        },
      }),
      admitRepairWorker: async () => ({ admitted: true, workerId: `repair-${instant}` }),
    });

    await handoff();
    await admit();
    const first = await repairQueueCustody(
      { store, now: () => instant, repair: repairDeps, adoptBranch, readyForAgent, readyForHuman },
      { ...identity, mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", queued: false },
      [],
    );

    expect(first).toMatchObject({ outcome: "ready-for-agent", bounce: 1 });
    expect(adoptBranch).toHaveBeenCalledWith(3333, "afk/3333-queue-custodian");
    expect(readyForAgent).toHaveBeenCalledWith(
      3333,
      expect.objectContaining({ prNumber: 3334, failure: expect.objectContaining({ summary }) }),
    );
    expect(readyForHuman).not.toHaveBeenCalled();

    instant = "2026-08-05T14:00:00.000Z";
    await handoff();
    await admit();
    const second = await repairQueueCustody(
      { store, now: () => instant, repair: repairDeps, adoptBranch, readyForAgent, readyForHuman },
      { ...identity, mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", queued: false },
      [],
    );

    expect(second).toMatchObject({ outcome: "ready-for-human", bounce: 2 });
    expect(readyForHuman).toHaveBeenCalledWith(
      3333,
      expect.objectContaining({
        prNumber: 3334,
        history: [
          expect.objectContaining({ summary, observedAt: "2026-08-05T13:00:00.000Z" }),
          expect.objectContaining({ summary, observedAt: "2026-08-05T14:00:00.000Z" }),
        ],
      }),
    );
    expect(store.state.prs["3334"]?.status).toBe("human");
  });
});
