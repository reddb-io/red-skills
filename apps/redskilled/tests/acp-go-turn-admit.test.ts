// go_dispatch used to admit a Worker and stop: the native Worker enters its
// Ticket loop only through a prompted handoff, so every dispatched Worker sat
// idle forever with its Ticket unclaimed (observed live 2026-08-25, twice —
// worker born, session/new answered, no prompt ever sent, no child spawned).
// The admit now RUNS the unattended demand turn and answers at admission, so
// the dispatching client may hang up the moment it has its Worker id.
import { describe, expect, it, vi } from "vitest";

import { goTurnAdmit } from "../src/acp-connection-methods.js";
import type { AcpTargetedDispatchIntent } from "../src/acp-dispatch-intent.js";

const dispatch: AcpTargetedDispatchIntent = {
  version: 1,
  workerKind: "go",
  ticket: 4406,
  selector: { kind: "issues", numbers: [4406], lane: "lane:go" },
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    scopedProject: () => ({
      projectId: "github:1240684599",
      projectLabel: "reddb-io/red-skills",
      workspacePath: "/tmp/workspace",
      credentialProfile: "personal",
    }),
    hostState: () => ({
      workers: [],
      registrations: [{
        project_label: "reddb-io/red-skills",
        trunk: { remote: "origin", branch: "main" },
      }],
    }),
    ...overrides,
  } as never;
}

describe("go_dispatch admits by running the turn", () => {
  it("launches the unattended turn with the handoff and answers at admission", async () => {
    const requests: Record<string, unknown>[] = [];
    const runDemandTurn = vi.fn(async (request: Record<string, unknown>) => {
      requests.push(request);
      (request.onBorn as (id: string) => void)("host:W77");
      return await new Promise(() => undefined); // the turn outlives the answer
    });

    const admission = await goTurnAdmit(deps({ runDemandTurn }))(dispatch, { client: undefined }, {
      demand: "document the link commands",
      title: "/go: document the link commands",
    });

    expect(admission).toEqual({ worker_id: "host:W77" });
    expect(requests[0]).toMatchObject({
      workItem: "4406",
      ticket: {
        number: 4406,
        title: "/go: document the link commands",
        labels: ["lane:go"],
        base: "main",
        handoff: "document the link commands",
      },
    });
  });

  it("a turn that dies before admission rejects the dispatch, loudly", async () => {
    const failures: unknown[] = [];
    const admit = goTurnAdmit(deps({
      runDemandTurn: async () => { throw new Error("no such project"); },
      recordDispatchFailure: (failure: unknown) => failures.push(failure),
    }));

    await expect(admit(dispatch, { client: undefined }, { demand: "x", title: "t" }))
      .rejects.toThrow("no such project");
    expect(failures).toHaveLength(1);
  });

  it("a turn that dies after the answer left becomes durable evidence, not silence", async () => {
    const failures: { detail: string }[] = [];
    let failTurn!: (error: Error) => void;
    const admit = goTurnAdmit(deps({
      runDemandTurn: (request: { onBorn?: (id: string) => void }) => {
        request.onBorn?.("host:W78");
        return new Promise((_resolve, reject) => { failTurn = reject; });
      },
      recordDispatchFailure: (failure: { detail: string }) => failures.push(failure),
    }));

    await expect(admit(dispatch, { client: undefined }, { demand: "x", title: "t" }))
      .resolves.toEqual({ worker_id: "host:W78" });
    failTurn(new Error("gate wedged"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(failures[0]?.detail).toContain("Ticket #4406");
    expect(failures[0]?.detail).toContain("gate wedged");
  });
});
