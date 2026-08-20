import { describe, expect, it, vi } from "vitest";

import {
  createDemandTurnRunner,
  demandTurnForBirth,
  describeTurnOutcome,
  queueBriefing,
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
  opened: Array<{ sessionId: string }> = [],
) {
  return {
    records,
    opened,
    run: createDemandTurnRunner({
      paths: {} as never,
      startWorker: (() => {
        throw new Error("an injected admission owns the birth in this test");
      }) as never,
      hostState: () => ({ workers: [] }),
      sessionJournal: {
        create: async (sessionId: string) => void opened.push({ sessionId }),
      } as never,
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

    expect(result).toMatchObject({ workerId: "W1", outcome: "no-workflow-outcome (end_turn)" });
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
        // The stop reason rides along: a turn that ended in under a second is
        // only legible when the record says which sentence ended it.
        detail: "no-workflow-outcome (end_turn)",
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

  it("opens its own durable session before admitting — the journal refuses a turn nobody opened", async () => {
    const opened: Array<{ sessionId: string }> = [];
    const { run } = runner(async () => workerStub({ stopReason: "end_turn" }), [], opened);

    await run({ project, prompt: "go", workItem: "4118" });

    expect(opened).toHaveLength(1);
    expect(opened[0]?.sessionId).toContain("github:1");
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

describe("what one birth owes its Worker", () => {
  it("says nothing for a project that stated no prompt — it births as it always did", () => {
    expect(demandTurnForBirth(undefined, { workspace_path: "/tmp/w", index: 0 }, "W1")).toBeNull();
    expect(demandTurnForBirth({}, { workspace_path: "/tmp/w", index: 0 }, "W1")).toBeNull();
  });

  it("writes this birth's facts into the project's prompt", () => {
    expect(demandTurnForBirth(
      { prompt: "claim {{work_item}} as {{worker_id}} in {{workspace_path}}" },
      { workspace_path: "/tmp/w", index: 2, work_item: "4100" },
      "W7",
    )).toEqual({
      workspacePath: "/tmp/w",
      prompt: "claim 4100 as W7 in /tmp/w",
      workItem: "4100",
    });
  });

  it("refuses a prompt naming a fact this birth does not have, before anything is spawned", () => {
    expect(() => demandTurnForBirth(
      { prompt: "claim {{work_item}}" },
      { workspace_path: "/tmp/w", index: 0 },
      "W1",
    )).toThrow(/work_item/);
  });
});

describe("the birth briefs its Worker with a Ticket", () => {
  const briefing = { id: "4118", title: "worker-container invokes a deleted binary", labels: ["bug", "ready-for-agent"] };
  const registration = { prompt: "Work issue #{{work_item}} to a merged PR", trunk: { branch: "main" } };
  const birth = { workspace_path: "/tmp/w", index: 0, work_item: "4118" };

  it("states the handoff the Worker's Ticket loop is entered through", () => {
    const turn = demandTurnForBirth(registration, birth, "W7", briefing);

    expect(turn?.ticket).toEqual({
      number: 4118,
      title: "worker-container invokes a deleted binary",
      labels: ["bug", "ready-for-agent"],
      base: "main",
      // The prompt IS the briefing: one sentence, with the daemon's fact in it.
      handoff: "Work issue #4118 to a merged PR",
      worker_id: "W7",
    });
  });

  it("states no handoff when a fact it requires is missing, rather than briefing a refusal", () => {
    // A Worker refuses an empty title or a Ticket with no trunk; a refusal the
    // daemon could have avoided is a Worker born to fail.
    expect(demandTurnForBirth(registration, birth, "W7", { ...briefing, title: "" })?.ticket).toBeUndefined();
    expect(demandTurnForBirth({ prompt: registration.prompt }, birth, "W7", briefing)?.ticket).toBeUndefined();
    expect(demandTurnForBirth(registration, birth, "W7")?.ticket).toBeUndefined();
  });

  it("finds the briefing the last poll kept for that item, and nothing for another", () => {
    const projects = [{ project_label: "a/b", tickets: [briefing] }];

    expect(queueBriefing(projects, "a/b", "4118")).toEqual(briefing);
    expect(queueBriefing(projects, "a/b", "4119")).toBeUndefined();
    expect(queueBriefing(projects, "c/d", "4118")).toBeUndefined();
    expect(queueBriefing(projects, "a/b", undefined)).toBeUndefined();
  });
});

describe("what a turn's answer says happened", () => {
  it("reads a Ticket verdict, with the stage and the reason the Worker wrote down", () => {
    expect(describeTurnOutcome({
      stopReason: "end_turn",
      _meta: { redskills: { ticket: { outcome: "refused", stage: "claim", detail: "the lane implies scout" } } },
    } as never)).toBe("refused at claim: the lane implies scout");

    expect(describeTurnOutcome({
      stopReason: "end_turn",
      _meta: { redskills: { ticket: { outcome: "gate-blocked", failedStage: "typecheck", detail: "2 errors" } } },
    } as never)).toBe("gate-blocked at typecheck: 2 errors");

    expect(describeTurnOutcome({
      stopReason: "end_turn",
      _meta: { redskills: { ticket: { outcome: "landed" }, workflowOutcome: "completion" } },
    } as never)).toBe("landed");
  });

  it("falls back to the stop reason for an ordinary prompt turn that states no verdict", () => {
    expect(describeTurnOutcome({ stopReason: "end_turn", _meta: {} } as never))
      .toBe("no-workflow-outcome (end_turn)");
  });
});
