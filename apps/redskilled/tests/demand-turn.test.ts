import { describe, expect, it, vi } from "vitest";

import {
  createDemandTurnRunner,
  DEMAND_TURN_PERMISSION_REFUSAL,
  type DemandTurnAdmission,
  type DemandTurnRecord,
} from "../src/acp-demand-turn.js";
import type { ActiveWorkflowWorker } from "../src/acp-worker-lifecycle.js";

/**
 * A birth nobody speaks to does nothing.
 *
 * The unattended turn runs the same admission and the same turn a client
 * drives, with no client on the other end: its own session map, its own
 * synthetic session id, and a record where a notification would have gone.
 */
const project = {
  projectId: "github:1",
  projectLabel: "reddb-io/red-skills",
  workspacePath: "/tmp/project",
} as never;

function workerStub(response: unknown, workerId = "W1"): ActiveWorkflowWorker & { prompted: ReturnType<typeof vi.fn> } {
  const prompted = vi.fn(async () => response);
  return {
    workerId,
    downstreamSessionId: `down-${workerId}`,
    connection: { agent: { request: prompted, notify: vi.fn() }, close: vi.fn() },
    socket: { destroy: vi.fn(), destroyed: false, readable: true, writable: true, readableEnded: false, writableEnded: false },
    endpoint: `/tmp/${workerId}.sock`,
    publicSessionId: "",
    notify: vi.fn(async () => {}),
    cancelled: false,
    cleaned: false,
    prompted,
  } as never;
}

function runner(
  admit: (input: DemandTurnAdmission) => Promise<ActiveWorkflowWorker>,
  records: DemandTurnRecord[] = [],
) {
  return {
    records,
    run: createDemandTurnRunner({
      paths: {} as never,
      startWorker: (() => {
        throw new Error("an injected admission owns the birth in this test");
      }) as never,
      hostState: () => ({ workers: [] }),
      sessionJournal: {} as never,
      admit,
      record: (line) => records.push(line),
    }),
  };
}

describe("the daemon's unattended turn", () => {
  it("serves the project's prompt to the Worker it admitted", async () => {
    const worker = workerStub({ stopReason: "end_turn" });
    const { run } = runner(async () => worker);

    const result = await run({ project, prompt: "work item 4100", workItem: "4100" });

    expect(result).toMatchObject({ workerId: "W1", outcome: "end_turn" });
    expect(worker.prompted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: [{ type: "text", text: "work item 4100" }] }),
    );
  });

  it("marks the turn unattended and names the item, so a reader can tell it apart", async () => {
    const worker = workerStub({ stopReason: "end_turn" });
    const { run } = runner(async () => worker);

    await run({ project, prompt: "go", workItem: "4100" });

    expect(worker.prompted.mock.calls[0]?.[1]).toMatchObject({
      _meta: { redskills: { unattended: true, workItem: "4100" } },
    });
  });

  it("records the outcome where a client would have been notified", async () => {
    const { run, records } = runner(async () => workerStub({ stopReason: "end_turn" }));

    await run({ project, prompt: "go", workItem: "4100" });

    expect(records).toEqual([
      expect.objectContaining({
        event: "demand-turn-completed",
        project_label: "reddb-io/red-skills",
        work_item: "4100",
        worker_id: "W1",
      }),
    ]);
  });

  it("records a refusal rather than losing it, and rethrows", async () => {
    const { run, records } = runner(async () => {
      throw new Error("the host refused this birth");
    });

    await expect(run({ project, prompt: "go" })).rejects.toThrow(/the host refused this birth/);
    expect(records).toEqual([
      expect.objectContaining({ event: "demand-turn-refused", detail: "the host refused this birth" }),
    ]);
  });

  it("gives every turn its own session id, so two are never one session replaced", async () => {
    const seen: string[] = [];
    const { run } = runner(async (input) => {
      seen.push(input.sessionId);
      return workerStub({ stopReason: "end_turn" });
    });

    await run({ project, prompt: "one" });
    await run({ project, prompt: "two" });

    expect(new Set(seen).size).toBe(2);
    expect(seen.every((id) => id.includes("github:1"))).toBe(true);
  });

  it("refuses permission on nobody's behalf, and says why", async () => {
    let answered: unknown;
    const { run } = runner(async (input) => {
      answered = await input.permission({
        sessionId: input.sessionId,
        toolCall: { kind: "execute", title: "push" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ],
      } as never);
      return workerStub({ stopReason: "end_turn" });
    });

    await run({ project, prompt: "go" });

    expect(answered).toMatchObject({
      outcome: { outcome: "selected", optionId: "no" },
      _meta: { redskills: { permissionResolution: "unattended-refused", reason: DEMAND_TURN_PERMISSION_REFUSAL } },
    });
    expect(DEMAND_TURN_PERMISSION_REFUSAL).toMatch(/hitl/i);
  });
});
