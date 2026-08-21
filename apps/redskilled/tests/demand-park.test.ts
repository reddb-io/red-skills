import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parkTerminalTurn, parkVerdictOf, parkWrite } from "../src/demand-park.js";
import { planHostDemand } from "../src/demand-loop.js";
import { createDemandTurnRunner, type DemandTurnAdmission, type DemandTurnRecord } from "../src/acp-demand-turn.js";
import type { ActiveWorkflowWorker } from "../src/acp-worker-lifecycle.js";
import { validateWriteRequest } from "../src/github-outbox.js";
import { createRedskilledGithubWriteUpstream } from "../src/github-write.js";

/**
 * A gate-blocked verdict that changes nothing on the tracker leaves the Ticket
 * at the head of the ready queue, so every freed slot re-births a Worker for
 * the same item (#4160: 34 claim comments on two issues in one morning). The
 * park is what makes the queue advance.
 */
describe("the gate-blocked verdict is read from the turn's ticket meta", () => {
  it("answers only for gate-blocked", () => {
    expect(parkVerdictOf({
      _meta: { redskills: { ticket: { outcome: "gate-blocked", failedStage: "feedback", detail: "pnpm test: red" } } },
    })).toEqual({ kind: "gate-blocked", failedStage: "feedback", detail: "pnpm test: red" });
    expect(parkVerdictOf({
      _meta: { redskills: { ticket: { outcome: "landed", pullRequest: 7 } } },
    })).toBeNull();
    expect(parkVerdictOf({})).toBeNull();
  });
});

describe("the park write moves the Ticket out of the executable queue", () => {
  const workspace = mkdtempSync(join(tmpdir(), "demand-park-"));

  it("computes the engine planner's atomic transition under the default vocabulary", () => {
    const composed = parkWrite({
      workspacePath: workspace,
      ticket: { number: 4154, labels: ["bug", "ready-for-agent"] },
      workerId: "VSq1",
      verdict: { kind: "gate-blocked", failedStage: "feedback", detail: "pnpm test failed" },
    });

    expect(composed).toMatchObject({
      summary: expect.stringContaining("parked #4154"),
      request: {
        idempotency_key: "park:4154:VSq1",
        write: {
          kind: "issue-transition",
          issue: 4154,
          add: expect.arrayContaining(["ready-for-human", "blocked:validation"]),
          remove: ["ready-for-agent"],
          comment: expect.stringContaining("/retake 4154"),
        },
      },
    });
  });

  it("carries the failed stage and the gate detail into the comment", () => {
    const composed = parkWrite({
      workspacePath: workspace,
      ticket: { number: 9, labels: ["ready-for-agent"] },
      workerId: "W2",
      verdict: { kind: "gate-blocked", failedStage: "post_done", detail: "assert red" },
    });

    if ("refusal" in composed) throw new Error(composed.refusal);
    expect(composed.request.write).toMatchObject({
      kind: "issue-transition",
      comment: expect.stringContaining("post_done"),
    });
    expect((composed.request.write as { comment?: string }).comment).toContain("assert red");
  });
});

describe("the outbox validates an issue transition like every other write", () => {
  it("passes a well-formed transition through", () => {
    expect(validateWriteRequest({
      idempotency_key: "park:4154:W1",
      write: { kind: "issue-transition", issue: 4154, add: ["ready-for-human"], remove: ["ready-for-agent"] },
    })).toMatchObject({ write: { kind: "issue-transition", issue: 4154 } });
  });

  it("refuses a transition that names no issue or moves no label", () => {
    expect(() => validateWriteRequest({
      idempotency_key: "k",
      write: { kind: "issue-transition", issue: 0, add: ["x"], remove: [] } as never,
    })).toThrow(/positive Issue number/);
    expect(() => validateWriteRequest({
      idempotency_key: "k",
      write: { kind: "issue-transition", issue: 5, add: [], remove: [] } as never,
    })).toThrow(/at least one label/);
  });
});

describe("the upstream applies the transition as label calls plus one marked comment", () => {
  it("adds, removes (tolerating an already-absent label), and comments once", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), ...(init?.body == null ? {} : { body: JSON.parse(String(init.body)) }) });
      if (method === "DELETE" && String(url).endsWith("ready-for-agent")) {
        return new Response("{}", { status: 404 });
      }
      if (method === "GET") return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const upstream = createRedskilledGithubWriteUpstream({ fetchImpl: fetchImpl as never });

    const answer = await upstream({
      project: { projectId: "github:1", projectLabel: "o/r", workspacePath: "/tmp", credentialProfile: "personal" },
      credential: { secret: "t" } as never,
      idempotencyKey: "park:4154:W1",
      write: {
        kind: "issue-transition",
        issue: 4154,
        add: ["ready-for-human", "blocked:validation"],
        remove: ["ready-for-agent", "running"],
        comment: "parked",
      },
    });

    expect(answer).toEqual({
      issue: 4154,
      added: ["ready-for-human", "blocked:validation"],
      removed: ["ready-for-agent", "running"],
      commented: true,
    });
    expect(calls.map((call) => `${call.method} ${call.url.split("/repos/")[1]}`)).toEqual([
      "POST o/r/issues/4154/labels",
      "DELETE o/r/issues/4154/labels/ready-for-agent",
      "DELETE o/r/issues/4154/labels/running",
      "GET o/r/issues/4154/comments?per_page=100",
      "POST o/r/issues/4154/comments",
    ]);
  });
});

/** The runner parks after the verdict is recorded, and records what the park did. */
describe("a completed gate-blocked turn is parked by the runner", () => {
  const project = {
    projectId: "github:1",
    projectLabel: "o/r",
    workspacePath: "/tmp/project",
  } as never;

  function workerStub(response: unknown): ActiveWorkflowWorker {
    const prompted = vi.fn(async () => response);
    return {
      workerId: "W1",
      downstreamSessionId: "down-W1",
      connection: { agent: { request: prompted, notify: vi.fn() }, close: vi.fn() },
      socket: { destroy: vi.fn(), destroyed: false },
      endpoint: "/tmp/W1.sock",
      publicSessionId: "",
      notify: vi.fn(async () => {}),
      cancelled: false,
      cleaned: false,
    } as never;
  }

  function runnerWith(park: NonNullable<Parameters<typeof createDemandTurnRunner>[0]["park"]>, response: unknown) {
    const records: DemandTurnRecord[] = [];
    const run = createDemandTurnRunner({
      paths: {} as never,
      startWorker: (() => { throw new Error("injected admission owns the birth"); }) as never,
      hostState: () => ({ workers: [] }),
      sessionJournal: { create: async () => {} } as never,
      admit: async (_input: DemandTurnAdmission) => workerStub(response),
      record: (line) => void records.push(line),
      park,
    });
    return { run, records };
  }

  const gateBlocked = {
    result: {
      stopReason: "end_turn",
      _meta: { redskills: { ticket: { outcome: "gate-blocked", failedStage: "feedback", rounds: 1 } } },
    },
  };

  it("passes the turn's project and ticket to the park and records its summary", async () => {
    const park = vi.fn(async () => "parked #4154: +[ready-for-human, blocked:validation] -[ready-for-agent]");
    const { run, records } = runnerWith(park, gateBlocked);

    await run({ project, prompt: "p", workItem: "4154", ticket: { number: 4154, labels: ["ready-for-agent"] } });

    expect(park).toHaveBeenCalledWith(project, { number: 4154, labels: ["ready-for-agent"] }, expect.anything(), "W1");
    expect(records.map((record) => record.event)).toContain("demand-park");
  });

  it("records a park that failed instead of losing the turn", async () => {
    const park = vi.fn(async () => { throw new Error("gateway offline"); });
    const { run, records } = runnerWith(park, gateBlocked);

    await run({ project, prompt: "p", ticket: { number: 4154, labels: [] } });

    const failed = records.find((record) => record.event === "demand-park-failed");
    expect(failed?.detail).toContain("gateway offline");
  });

  it("does not park a turn that carried no ticket", async () => {
    const park = vi.fn(async () => null);
    const { run } = runnerWith(park, gateBlocked);

    await run({ project, prompt: "p" });

    expect(park).not.toHaveBeenCalled();
  });
});

/**
 * #4296: the same grinder, reached by a different road.
 *
 * A brief the contract refuses is not a gate that blocked — nothing was
 * claimed, gated or committed — but it costs the queue the same way, and it
 * costs it FOREVER, because the next birth reads the identical brief and
 * refuses identically. The park is what makes the second tick find nothing.
 */
describe("a Ticket whose brief the contract refused is parked as a spec block", () => {
  const workspace = mkdtempSync(join(tmpdir(), "demand-park-brief-"));
  const REFUSAL =
    "brief contract refused: acceptance criteria item is not machine-checkable: " +
    "The decision is recorded on this ticket with its reasoning.";

  it("reads the refusal off the turn, and passes every other refusal by", () => {
    expect(parkVerdictOf({
      _meta: { redskills: { ticket: { outcome: "refused", stage: "brief", detail: REFUSAL } } },
    })).toEqual({ kind: "brief-refused", detail: REFUSAL });
    // The loop's own refusals are worth retrying, so they are not parks.
    expect(parkVerdictOf({
      _meta: { redskills: { ticket: { outcome: "refused", stage: "claim", detail: "forge 502" } } },
    })).toBeNull();
    expect(parkVerdictOf({
      _meta: { redskills: { ticket: { outcome: "refused", stage: "land", detail: "rejected" } } },
    })).toBeNull();
    // A bundle that names the stage but says nothing is not a readable refusal.
    expect(parkVerdictOf({
      _meta: { redskills: { ticket: { outcome: "refused", stage: "brief" } } },
    })).toBeNull();
  });

  it("parks under the spec reason and quotes the contract's sentence", () => {
    const composed = parkWrite({
      workspacePath: workspace,
      ticket: { number: 518, labels: ["ready-for-agent"] },
      workerId: "W7",
      verdict: { kind: "brief-refused", detail: REFUSAL },
    });

    if ("refusal" in composed) throw new Error(composed.refusal);
    expect(composed.request.write).toMatchObject({
      kind: "issue-transition",
      issue: 518,
      add: expect.arrayContaining(["ready-for-human", "blocked:spec"]),
      remove: ["ready-for-agent"],
    });
    const comment = (composed.request.write as { comment?: string }).comment ?? "";
    expect(comment).toContain("brief cannot be executed as written");
    expect(comment).toContain("not machine-checkable");
    expect(comment).toContain("/retake 518");
    // The gate's blame does not follow a Ticket nothing gated.
    expect(comment).not.toContain("local gate");
  });
});

/**
 * The whole point of the park, stated as the loop it ends: tick, refuse, park,
 * tick again — and the second tick has nothing to birth for.
 */
describe("two demand ticks over one refused item produce one park and one birth", () => {
  it("drains the queue by one instead of re-birthing forever", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "demand-park-loop-"));
    const REFUSAL = "brief contract refused: acceptance criteria item is not machine-checkable: prose.";
    // The tracker, in the only part of it this loop reads: one issue's labels.
    const labels = new Set(["ready-for-agent"]);
    const applied: unknown[] = [];

    const project = {
      projectId: "github:1",
      projectLabel: "o/r",
      workspacePath: workspace,
    } as never;

    // The park executor the control plane wires, over a gateway that applies
    // the transition to the label set the next tick will read.
    const park = parkTerminalTurn({
      credentialForProject: async () => ({ profile: "personal", credential: {} }),
      gateway: {
        forProject: () => ({
          write: async (params: { readonly write: { readonly add: readonly string[]; readonly remove: readonly string[] } }) => {
            applied.push(params);
            for (const label of params.write.remove) labels.delete(label);
            for (const label of params.write.add) labels.add(label);
            return {};
          },
        }),
      },
    } as never);

    const records: DemandTurnRecord[] = [];
    const prompted: string[] = [];
    const run = createDemandTurnRunner({
      paths: {} as never,
      startWorker: (() => { throw new Error("injected admission owns the birth"); }) as never,
      hostState: () => ({ workers: [] }),
      sessionJournal: { create: async () => {} } as never,
      admit: async (_input: DemandTurnAdmission) => {
        prompted.push("birth");
        return {
          workerId: `W${prompted.length}`,
          downstreamSessionId: "down",
          connection: {
            agent: {
              // The turn's answer, exactly as the transport hands it back.
              request: async () => ({
                stopReason: "end_turn",
                _meta: { redskills: { ticket: { outcome: "refused", stage: "brief", detail: REFUSAL } } },
              }),
              notify: vi.fn(),
            },
            close: vi.fn(),
          },
          socket: { destroy: vi.fn(), destroyed: false },
          endpoint: "/tmp/W.sock",
          publicSessionId: "",
          notify: vi.fn(async () => {}),
          cancelled: false,
          cleaned: false,
        } as never;
      },
      record: (line) => void records.push(line),
      park,
    });

    // What the planner can see about this project, recomputed from the tracker.
    const tick = () => {
      const ready = labels.has("ready-for-agent");
      return planHostDemand({
        projects: [{
          project_label: "o/r",
          target: 1,
          workspace_path: workspace,
          argv: [],
          items: ready ? ["518"] : [],
        } as never],
        queue: { "o/r": ready ? 1 : 0 },
        live: { "o/r": 0 },
        nowMs: 0,
      });
    };

    const first = tick();
    expect(first.births).toHaveLength(1);
    expect(first.births[0]?.work_item).toBe("518");
    await run({
      project,
      prompt: "p",
      workItem: "518",
      ticket: { number: 518, labels: [...labels] },
    });

    // One park, and the Ticket left the executable queue carrying the reason.
    expect(applied).toHaveLength(1);
    expect(labels.has("ready-for-agent")).toBe(false);
    expect(labels.has("blocked:spec")).toBe(true);
    expect(records.filter((record) => record.event === "demand-park")).toHaveLength(1);
    expect(records.find((record) => record.event === "demand-turn-completed")?.detail)
      .toContain("refused at brief");

    // The second tick over the same project has nothing to birth for, so the
    // ~15s re-birth that burned ~60 Workers on one item cannot re-form.
    const second = tick();
    expect(second.births).toHaveLength(0);
    expect(second.intents[0]?.outcome).toBe("queue-drained");
    expect(prompted).toHaveLength(1);
  });
});
