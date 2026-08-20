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

  it("never overrides a heartbeat the publisher stated", () => {
    const published = coerceWorkerDisplay({ heartbeat: "3s" })!;
    const derived = displayWithDerivedHeartbeat(
      { display: published, published_at: "2026-08-20T17:00:00.000Z" },
      Date.parse("2026-08-20T17:09:00.000Z"),
    );
    expect(derived?.heartbeat).toBe("3s");
  });

  it("stays honest with no record and no clock", () => {
    expect(displayWithDerivedHeartbeat(undefined, Date.now() as never)).toBeNull();
    expect(displayWithDerivedHeartbeat({ display, published_at: "2026-08-20T17:00:00.000Z" }, null)?.heartbeat)
      .toBeNull();
  });
});
