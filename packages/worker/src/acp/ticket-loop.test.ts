// The Ticket loop's contract, stage by stage (issue #4020).
//
// The end-to-end proof lives in `ticket-loop-end-to-end.test.ts`, across a real
// ACP connection with a real child process. These are the decisions that arc
// makes and a live run only exercises ONE branch of: the lane refusal that must
// happen before the claim, the re-seed budget's last round, and the two
// outcomes that must never reach the remote.
import { describe, expect, it, vi } from "vitest";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";
import {
  runTicketLoop,
  TICKET_LOOP_STAGES,
  type TicketGateRun,
  type TicketLoopDeps,
  type TicketLoopRecord,
  type TicketLoopTicket,
} from "./ticket-loop.js";
import type { WorkerPublisher } from "./publish-request.js";

// The brief a Worker may take: the preflight (#4139) refuses one that states no
// executable acceptance criteria, so every fixture that expects to reach the
// claim has to carry them.
const EXECUTABLE_BRIEF = `Implement the slice.

## Acceptance criteria

- [ ] Running \`pnpm -C packages/worker test\` passes.
`;

const TICKET: TicketLoopTicket = {
  number: 4020,
  title: "The ACP Worker runs the whole Ticket loop end-to-end",
  labels: ["ready-for-agent"],
  base: "main",
  handoff: EXECUTABLE_BRIEF,
};

const PUBLICATION = { branch: "afk/4020-ticket-loop", commit: "a".repeat(40) };

function publisher(overrides: Partial<WorkerPublisher> = {}): WorkerPublisher {
  return {
    publishTurn: async () => ({
      status: "requested",
      publication: PUBLICATION,
      receipt: {},
    }),
    ...overrides,
  };
}

function deps(overrides: Partial<TicketLoopDeps> = {}): TicketLoopDeps {
  return {
    ticket: TICKET,
    workerId: "host:VSk6WPt",
    sessionId: "public-session",
    request: async (method) =>
      method === REDSKILLS_ACP_METHODS.land
        ? { version: 1, pull_request: 4321 }
        : { version: 1 },
    implement: async () => ({ stopReason: "end_turn" }),
    gate: async (): Promise<TicketGateRun> => ({
      stages: [{ stage: "feedback", ok: true }],
    }),
    publisher: publisher(),
    now: () => new Date("2026-08-19T12:00:00.000Z"),
    ...overrides,
  };
}

function stages(records: readonly TicketLoopRecord[]): string[] {
  return records.map((record) => record.stage);
}

describe("the Ticket loop's declared arc", () => {
  it("names its stages in the order one Ticket travels through them", () => {
    expect(TICKET_LOOP_STAGES).toEqual([
      "claim",
      "implement",
      "gate",
      "publish",
      "land",
    ]);
  });

  it("claims through the parent, implements, gates, publishes and lands", async () => {
    const requests: { method: string; params: unknown }[] = [];
    const result = await runTicketLoop(
      deps({
        request: async (method, params) => {
          requests.push({ method, params });
          return method === REDSKILLS_ACP_METHODS.land
            ? { version: 1, pull_request: 77 }
            : { version: 1 };
        },
      }),
    );

    expect(result.outcome).toBe("landed");
    if (result.outcome !== "landed") return;
    expect(result.pullRequest).toBe(77);
    expect(result.rounds).toBe(1);
    expect(stages(result.records)).toEqual([
      "claim",
      "implement",
      "gate",
      "publish",
      "land",
    ]);

    // The claim is a WRITE the parent performs; the Worker holds no credential.
    expect(requests[0]!.method).toBe(REDSKILLS_ACP_METHODS.githubWrite);
    const claim = requests[0]!.params as {
      write: { issue: number; body: string };
    };
    expect(claim.write.issue).toBe(4020);
    expect(claim.write.body).toContain("worker=host:VSk6WPt");

    const land = requests[1]!.params as {
      owner_ticket: number;
      base: string;
      body: string;
      commit: string;
    };
    expect(requests[1]!.method).toBe(REDSKILLS_ACP_METHODS.land);
    expect(land.owner_ticket).toBe(4020);
    expect(land.base).toBe("main");
    expect(land.body).toContain("Refs #4020");
    // #4130: the land names the exact commit its publish validated.
    expect(land.commit).toBe(result.publication.commit);
  });
});

describe("the brief contract, enforced at the preflight", () => {
  it("withdraws from a vague brief before any claim marker is created", async () => {
    const request = vi.fn(async () => ({ version: 1 }));
    const implement = vi.fn(async () => ({ stopReason: "end_turn" as const }));
    const result = await runTicketLoop(
      deps({
        ticket: { ...TICKET, handoff: "Make the retry logic better." },
        request,
        implement,
      }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.stage).toBe("claim");
    expect(result.detail).toContain("brief contract refused");
    expect(result.detail).toContain("missing acceptance-criteria section");
    // The whole point of a PREflight: withdrawing costs nothing, while owning a
    // Ticket nobody can finish costs the queue an entry until a sweep concedes.
    expect(request).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
    expect(stages(result.records)).toEqual(["claim"]);
  });

  it("quotes the un-checkable item so the refusal names what to fix", async () => {
    const result = await runTicketLoop(
      deps({
        ticket: {
          ...TICKET,
          handoff: "Fix it.\n\n## Acceptance criteria\n\n- [ ] It should feel snappier.\n",
        },
        request: vi.fn(async () => ({ version: 1 })),
      }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.detail).toContain("It should feel snappier.");
  });

  it("refuses the lane before the brief, so a scout Ticket says so first", async () => {
    const result = await runTicketLoop(
      deps({
        ticket: { ...TICKET, labels: ["lane:scout"], handoff: "Make it better." },
        request: vi.fn(async () => ({ version: 1 })),
      }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.detail).toContain("run_mode=scout");
  });
});

describe("the lane-to-mode contract, enforced at the claim", () => {
  it("refuses a scout-lane Ticket a plain Worker would have pushed", async () => {
    const request = vi.fn(async () => ({ version: 1 }));
    const implement = vi.fn(async () => ({ stopReason: "end_turn" as const }));
    const result = await runTicketLoop(
      deps({
        ticket: { ...TICKET, labels: ["ready-for-agent", "lane:scout"] },
        request,
        implement,
      }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.stage).toBe("claim");
    expect(result.detail).toContain("run_mode=scout");
    // Refused BEFORE the claim: a Ticket this Worker may not honour is one
    // another Worker must still be able to take.
    expect(request).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
  });

  it("admits the same Ticket to a Worker that holds the mode", async () => {
    const result = await runTicketLoop(
      deps({
        ticket: { ...TICKET, labels: ["lane:scout"] },
        runMode: "scout",
      }),
    );
    expect(result.outcome).toBe("landed");
  });
});

describe("re-seeding in place, within the budget", () => {
  it("re-instructs the same implementer with what the gate refused", async () => {
    const handoffs: string[] = [];
    let round = 0;
    const result = await runTicketLoop(
      deps({
        reseedBudget: 2,
        implement: async (handoff) => {
          handoffs.push(handoff);
          return { stopReason: "end_turn" };
        },
        gate: async (): Promise<TicketGateRun> => {
          round += 1;
          return round < 3
            ? {
                stages: [{ stage: "feedback", ok: false }],
                detail: "pnpm typecheck exited 2",
              }
            : {
                stages: [
                  { stage: "feedback", ok: true },
                  { stage: "review", ok: true },
                ],
              };
        },
      }),
    );

    expect(result.outcome).toBe("landed");
    if (result.outcome !== "landed") return;
    expect(result.rounds).toBe(3);
    expect(handoffs[0]).toBe(TICKET.handoff);
    expect(handoffs[1]).toContain("feedback stage blocked round 1");
    expect(handoffs[1]).toContain("pnpm typecheck exited 2");
    expect(handoffs[2]).toContain("round 2");
  });

  it("stops at the gate's verdict when the rounds are spent, and publishes nothing", async () => {
    const publishTurn = vi.fn(async () => null);
    const result = await runTicketLoop(
      deps({
        reseedBudget: 1,
        gate: async (): Promise<TicketGateRun> => ({
          stages: [
            { stage: "feedback", ok: true },
            { stage: "backpressure", ok: false },
          ],
          detail: "the operator's command exited 1",
        }),
        publisher: publisher({ publishTurn }),
      }),
    );

    expect(result.outcome).toBe("gate-blocked");
    if (result.outcome !== "gate-blocked") return;
    expect(result.failedStage).toBe("backpressure");
    expect(result.rounds).toBe(2);
    expect(publishTurn).not.toHaveBeenCalled();
  });

  it("names the EARLIEST blocking stage, whatever order the gate reported", async () => {
    const result = await runTicketLoop(
      deps({
        gate: async (): Promise<TicketGateRun> => ({
          stages: [
            { stage: "review", ok: false },
            { stage: "feedback", ok: false },
          ],
        }),
      }),
    );
    expect(result.outcome).toBe("gate-blocked");
    if (result.outcome !== "gate-blocked") return;
    expect(result.failedStage).toBe("feedback");
  });

  it("treats a skipped stage as no blocker at all", async () => {
    const result = await runTicketLoop(
      deps({
        gate: async (): Promise<TicketGateRun> => ({
          stages: [
            { stage: "feedback", ok: true },
            { stage: "review", ok: false, skipped: true },
          ],
        }),
      }),
    );
    expect(result.outcome).toBe("landed");
  });
});

describe("failure-mode retry policy", () => {
  it("retries implementer failures by declared shape, then parks with evidence instead of a third retry", async () => {
    const implement = vi.fn(async () => {
      throw new Error("ECONNRESET while reading the child stream");
    });
    const gate = vi.fn(async (): Promise<TicketGateRun> => ({
      stages: [{ stage: "feedback", ok: true }],
    }));
    const publishTurn = vi.fn(async () => null);

    const result = await runTicketLoop(
      deps({
        implement,
        gate,
        publisher: publisher({ publishTurn }),
      }),
    );

    expect(result.outcome).toBe("gate-blocked");
    if (result.outcome !== "gate-blocked") return;
    expect(result.failedStage).toBe("feedback");
    expect(result.rounds).toBe(3);
    expect(result.detail).toContain("global two-retry bound exhausted");
    expect(result.detail).toContain("ECONNRESET");
    expect(implement).toHaveBeenCalledTimes(3);
    expect(gate).not.toHaveBeenCalled();
    expect(publishTurn).not.toHaveBeenCalled();
    expect(result.records.map((record) => record.detail)).toEqual([
      undefined,
      expect.stringContaining("retry 1/2 as as-is"),
      expect.stringContaining("retry 2/2 as as-is"),
      expect.stringContaining("parking with evidence"),
    ]);
  });

  it("unknown failures get exactly one retry even below the global bound", async () => {
    const implement = vi.fn(async () => {
      throw new Error("child disappeared without a classified symptom");
    });

    const result = await runTicketLoop(
      deps({
        implement,
        classifyFailure: () => "unknown",
      }),
    );

    expect(result.outcome).toBe("gate-blocked");
    if (result.outcome !== "gate-blocked") return;
    expect(result.rounds).toBe(2);
    expect(result.detail).toContain("unknown retry bound exhausted");
    expect(implement).toHaveBeenCalledTimes(2);
  });
});

describe("the outcomes that reach no remote", () => {
  it("publishes nothing for a cancelled round", async () => {
    const publishTurn = vi.fn(async () => null);
    const result = await runTicketLoop(
      deps({
        implement: async () => ({ stopReason: "cancelled" }),
        publisher: publisher({ publishTurn }),
      }),
    );

    expect(result.outcome).toBe("cancelled");
    expect(publishTurn).not.toHaveBeenCalled();
    expect(stages(result.records)).toEqual(["claim", "implement"]);
  });

  it("lands nothing when the Worktree committed nothing", async () => {
    const request = vi.fn(async (method: string, _params: unknown) => ({
      version: 1,
      pull_request: 1,
      method,
    }));
    const result = await runTicketLoop(
      deps({
        request,
        publisher: publisher({ publishTurn: async () => null }),
      }),
    );

    expect(result.outcome).toBe("nothing-to-publish");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(REDSKILLS_ACP_METHODS.githubWrite);
  });

  it("returns the parent's refusal instead of throwing it", async () => {
    const result = await runTicketLoop(
      deps({
        publisher: publisher({
          publishTurn: async () => ({
            status: "refused",
            publication: PUBLICATION,
            detail: "no credential profile",
          }),
        }),
      }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.stage).toBe("publish");
    expect(result.detail).toBe("no credential profile");
  });

  it("refuses a landing answer that named no pull request", async () => {
    const result = await runTicketLoop(
      deps({
        request: async () => ({ version: 1 }),
      }),
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.stage).toBe("land");
    expect(result.detail).toContain("no pull request");
  });
});
