import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { gateBlockedParkWrite, gateBlockedVerdictOf, workerFailureParkWrite } from "../src/demand-park.js";
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
    expect(gateBlockedVerdictOf({
      _meta: { redskills: { ticket: { outcome: "gate-blocked", failedStage: "feedback", detail: "pnpm test: red" } } },
    })).toEqual({ failedStage: "feedback", detail: "pnpm test: red" });
    expect(gateBlockedVerdictOf({
      _meta: { redskills: { ticket: { outcome: "landed", pullRequest: 7 } } },
    })).toBeNull();
    expect(gateBlockedVerdictOf({})).toBeNull();
  });
});

describe("the park write moves the Ticket out of the executable queue", () => {
  const workspace = mkdtempSync(join(tmpdir(), "demand-park-"));

  it("computes the engine planner's atomic transition under the default vocabulary", () => {
    const composed = gateBlockedParkWrite({
      workspacePath: workspace,
      ticket: { number: 4154, labels: ["bug", "ready-for-agent"] },
      workerId: "VSq1",
      verdict: { failedStage: "feedback", detail: "pnpm test failed" },
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
    const composed = gateBlockedParkWrite({
      workspacePath: workspace,
      ticket: { number: 9, labels: ["ready-for-agent"] },
      workerId: "W2",
      verdict: { failedStage: "post_done", detail: "assert red" },
    });

    if ("refusal" in composed) throw new Error(composed.refusal);
    expect(composed.request.write).toMatchObject({
      kind: "issue-transition",
      comment: expect.stringContaining("post_done"),
    });
    expect((composed.request.write as { comment?: string }).comment).toContain("assert red");
  });

  it("parks an exhausted Worker failure retry with evidence", () => {
    const composed = workerFailureParkWrite({
      workspacePath: workspace,
      ticket: { number: 4175, labels: ["ready-for-agent"] },
      workerId: "W3",
      failureClass: "network-drop",
      evidence: "transport dropped; retry bound exhausted (2/2)",
    });

    expect(composed).toMatchObject({
      summary: "parked #4175: exhausted network-drop retry policy",
      request: {
        idempotency_key: "worker-failure-park:4175:network-drop:W3",
        write: {
          kind: "issue-transition",
          issue: 4175,
          add: expect.arrayContaining(["ready-for-human", "blocked:infra"]),
          remove: ["ready-for-agent"],
          comment: expect.stringContaining("transport dropped; retry bound exhausted"),
        },
      },
    });
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
