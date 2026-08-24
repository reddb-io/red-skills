import { describe, expect, it, vi } from "vitest";

import { createDemandTurnRunner, type DemandTurnAdmission } from "../src/acp-demand-turn.js";
import type { ActiveWorkflowWorker } from "../src/acp-worker-lifecycle.js";
import { displayWithDerivedHeartbeat } from "../src/worker-display.js";
import { coerceWorkerDisplay } from "../src/worker-display.js";

/**
 * A native Worker publishes no heartbeat op — its turn events ARE its pulse
 * (#4181). Without this, every statusline row read `hb=?` while the turn
 * streamed, and a live Worker was indistinguishable from a hung one.
 */
describe("a demand turn stamps its Worker's pulse", () => {
  const project = { projectId: "github:1", projectLabel: "o/r", workspacePath: "/tmp/p" } as never;

  function workerStub(): ActiveWorkflowWorker {
    return {
      workerId: "W1",
      downstreamSessionId: "down-W1",
      connection: {
        agent: {
          request: vi.fn(async () => ({ stopReason: "end_turn", _meta: {} })),
          notify: vi.fn(),
        },
        close: vi.fn(),
      },
      socket: { destroy: vi.fn(), destroyed: false },
      endpoint: "/tmp/W1.sock",
      publicSessionId: "",
      notify: vi.fn(async () => {}),
      cancelled: false,
      cleaned: false,
    } as never;
  }

  it("pulses the work item at admission and each update's text line after it", async () => {
    const pulses: Array<{ workerId: string; line?: string; issue?: string }> = [];
    let seenNotify: ((method: string, params?: unknown) => Promise<void>) | null = null;
    const run = createDemandTurnRunner({
      paths: {} as never,
      startWorker: (() => { throw new Error("injected admission owns the birth"); }) as never,
      hostState: () => ({ workers: [] }),
      sessionJournal: { create: async () => {} } as never,
      admit: async (input: DemandTurnAdmission) => {
        seenNotify = input.notify as never;
        return workerStub();
      },
      pulse: (pulse) => void pulses.push(pulse),
    });

    await run({ project, prompt: "p", workItem: "4167" });

    expect(pulses[0]).toEqual({ workerId: "W1", issue: "#4167" });

    await seenNotify!("session/update", {
      sessionId: "s",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "gate round 1\n" } },
    });
    expect(pulses[1]).toEqual({ workerId: "W1", line: "gate round 1" });

    // An update with no text still bumps the pulse — liveness without content.
    await seenNotify!("session/update", { sessionId: "s", update: { sessionUpdate: "plan" } });
    expect(pulses[2]).toEqual({ workerId: "W1" });
  });

  it("carries the Worker's own measured diff off the stage it was measured at", async () => {
    // The daemon holds no checkout, so `loc=` can only be what the Worker
    // measured in its own Worktree. It rides the SAME `_meta.redskills.
    // ticketStage` object `phase` and `step` do — one fact, one route.
    const pulses: Array<Record<string, unknown>> = [];
    let seenNotify: ((method: string, params?: unknown) => Promise<void>) | null = null;
    const run = createDemandTurnRunner({
      paths: {} as never,
      startWorker: (() => { throw new Error("injected admission owns the birth"); }) as never,
      hostState: () => ({ workers: [] }),
      sessionJournal: { create: async () => {} } as never,
      admit: async (input: DemandTurnAdmission) => {
        seenNotify = input.notify as never;
        return workerStub();
      },
      pulse: (pulse) => void pulses.push(pulse as never),
    });
    await run({ project, prompt: "p", workItem: "4286" });

    const stage = (extra: Record<string, unknown>): unknown => ({
      sessionId: "s",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
      _meta: { redskills: { ticketStage: { stage: "gate", ok: true, round: 1, ...extra } } },
    });

    await seenNotify!("session/update", stage({ added: 1394, removed: 7397 }));
    expect(pulses.at(-1)).toEqual({
      workerId: "W1", phase: "gate", step: "round 1", added: 1394, removed: 7397,
    });

    // A bundle old enough to publish a stage without a diff still moves the
    // phase cell; half a pair is no pair, and neither half is stored.
    await seenNotify!("session/update", stage({}));
    expect(pulses.at(-1)).toEqual({ workerId: "W1", phase: "gate", step: "round 1" });
    await seenNotify!("session/update", stage({ added: 12 }));
    expect(pulses.at(-1)).toEqual({ workerId: "W1", phase: "gate", step: "round 1" });
    await seenNotify!("session/update", stage({ added: "12", removed: -3 }));
    expect(pulses.at(-1)).toEqual({ workerId: "W1", phase: "gate", step: "round 1" });
  });

  it("stores a measured zero and an absence differently on the display", () => {
    // `loc=0` is a Worker that has produced nothing; an ABSENT cell is a Worker
    // nobody measured. A renderer cannot tell them apart if the daemon cannot.
    expect(coerceWorkerDisplay({ phase: "claim", added: 0, removed: 0 })!.added).toBe(0);
    expect(coerceWorkerDisplay({ phase: "claim" })!.added).toBeNull();
    expect(coerceWorkerDisplay({ phase: "claim" })!.removed).toBeNull();
  });
});

describe("a display that published no heartbeat gets the age of its last pulse", () => {
  const display = coerceWorkerDisplay({ issue: "#4167" })!;

  it("derives hb from published_at at payload-build time", () => {
    const derived = displayWithDerivedHeartbeat(
      { display, published_at: "2026-08-20T17:00:00.000Z" },
      Date.parse("2026-08-20T17:00:12.000Z"),
    );
    expect(derived?.heartbeat).toBe("12s");
    expect(derived?.issue).toBe("#4167");
  });

  it("speaks minutes past the first one", () => {
    const derived = displayWithDerivedHeartbeat(
      { display, published_at: "2026-08-20T17:00:00.000Z" },
      Date.parse("2026-08-20T17:07:05.000Z"),
    );
    expect(derived?.heartbeat).toBe("7m5s");
  });

  it("keeps a freshly published heartbeat untouched", () => {
    const published = coerceWorkerDisplay({ heartbeat: "3s" })!;
    const derived = displayWithDerivedHeartbeat(
      { display: published, published_at: "2026-08-20T17:00:00.000Z" },
      Date.parse("2026-08-20T17:00:12.000Z"),
    );
    expect(derived?.heartbeat).toBe("3s");
  });

  it("dates a published heartbeat whose publication went stale", () => {
    // A project that said "3s" and then stopped publishing showed hb=3s
    // FOREVER — a wedged Worker rendered identically to a working one. The
    // string is the project's vocabulary and stays, but the row now says how
    // old the claim itself is.
    const published = coerceWorkerDisplay({ heartbeat: "3s" })!;
    const derived = displayWithDerivedHeartbeat(
      { display: published, published_at: "2026-08-20T17:00:00.000Z" },
      Date.parse("2026-08-20T17:09:00.000Z"),
    );
    expect(derived?.heartbeat).toBe("3s (published 9m0s ago)");
  });

  it("stays honest with no record and no clock", () => {
    expect(displayWithDerivedHeartbeat(undefined, Date.now() as never)).toBeNull();
    expect(displayWithDerivedHeartbeat({ display, published_at: "2026-08-20T17:00:00.000Z" }, null)?.heartbeat)
      .toBeNull();
  });
});
