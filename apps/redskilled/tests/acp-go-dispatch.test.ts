import { describe, expect, it } from "vitest";

import {
  GO_DISPATCH_SCHEMA,
  REDSKILLS_ACP_METHODS,
  goDispatchParams,
} from "@reddb-io/protocol-acp";

import { briefContractStructuralRefusal } from "@reddb-io/shared/brief-contract.js";
import {
  bindAcpGoDispatch,
  buildGoTicket,
  goAcceptanceCriteria,
  goDispatchMethodDomain,
  GO_DISPATCH_LANE,
  type GoTicketSpec,
} from "../src/acp-go-dispatch.js";
import type { AcpTargetedDispatchIntent } from "../src/acp-dispatch-intent.js";

/** A tracker that records what was minted instead of reaching a forge. */
function stubTracker() {
  const minted: { ticket: number; spec: GoTicketSpec }[] = [];
  const disposed: number[] = [];
  let next = 4100;
  return {
    minted,
    disposed,
    async mint(spec: GoTicketSpec): Promise<number> {
      const ticket = next++;
      minted.push({ ticket, spec });
      return ticket;
    },
    async dispose(ticket: number): Promise<void> {
      disposed.push(ticket);
    },
  };
}

describe("_redskills/go_dispatch", () => {
  it("mints the Ticket in the go lane and answers with the admitted Worker id", async () => {
    const tracker = stubTracker();
    const admitted: AcpTargetedDispatchIntent[] = [];
    const briefs: unknown[] = [];
    const dispatch = bindAcpGoDispatch({
      tracker,
      admit: async (intent, _context, brief) => {
        admitted.push(intent);
        briefs.push(brief);
        return { worker_id: "host:W4014", session_id: "session-4014" };
      },
    });

    const answer = await dispatch({ params: { demand: "teach the daemon to dispatch /go" }, client: undefined });

    expect(answer).toEqual({
      version: 1,
      worker_id: "host:W4014",
      ticket: 4100,
      lane: GO_DISPATCH_LANE,
      session_id: "session-4014",
    });
    expect(tracker.minted).toHaveLength(1);
    expect(tracker.minted[0]!.spec.labels).toContain(GO_DISPATCH_LANE);
    expect(tracker.minted[0]!.spec.labels).not.toContain("ready-for-agent");
    // The demand rides to admission as the brief: a Worker admitted without a
    // handoff never enters its Ticket loop.
    expect(briefs[0]).toEqual({
      demand: "teach the daemon to dispatch /go",
      title: "/go: teach the daemon to dispatch /go",
    });
    expect(tracker.minted[0]!.spec.body).toContain("teach the daemon to dispatch /go");
    expect(admitted).toEqual([{
      version: 1,
      workerKind: "go",
      ticket: 4100,
      selector: { kind: "issues", numbers: [4100], lane: GO_DISPATCH_LANE },
    }]);
  });

  it("disposes the minted Ticket when admission fails, so no Ticket outlives its Worker", async () => {
    const tracker = stubTracker();
    const dispatch = bindAcpGoDispatch({
      tracker,
      admit: async () => {
        throw new Error("no host capacity");
      },
    });

    await expect(dispatch({ params: { demand: "a demand nothing can admit" }, client: undefined }))
      .rejects.toThrow(/no host capacity/);
    expect(tracker.minted.map((entry) => entry.ticket)).toEqual([4100]);
    expect(tracker.disposed).toEqual([4100]);
  });

  it("refuses an empty demand before anything is minted", async () => {
    const tracker = stubTracker();
    const dispatch = bindAcpGoDispatch({
      tracker,
      admit: async () => ({ worker_id: "never" }),
    });

    await expect(dispatch({ params: { demand: "   " }, client: undefined })).rejects.toThrow(/demand/);
    expect(tracker.minted).toEqual([]);
  });

  it("builds a disposable Ticket that names the demand and only the go lane", () => {
    const spec = buildGoTicket("rename the drain\nand keep the ledger");

    expect(spec.title).toBe("/go: rename the drain");
    expect(spec.labels).toEqual([GO_DISPATCH_LANE]);
    expect(spec.body).toContain("rename the drain");
  });

  it("publishes its schema from the protocol package and validates params against it", () => {
    expect(GO_DISPATCH_SCHEMA.method).toBe(REDSKILLS_ACP_METHODS.goDispatch);
    expect(REDSKILLS_ACP_METHODS.goDispatch).toBe("_redskills/go_dispatch");
    expect(GO_DISPATCH_SCHEMA.params.required).toEqual(["demand"]);

    expect(goDispatchParams({ demand: "ship it" })).toEqual({ demand: "ship it" });
    expect(() => goDispatchParams({})).toThrow();
    expect(() => goDispatchParams({ demand: "ship it", ticket: 7 })).toThrow();
  });

  it("registers exactly the go domain's method", () => {
    const domain = goDispatchMethodDomain({
      tracker: stubTracker(),
      admit: async () => ({ worker_id: "host:W1" }),
    });

    expect(domain.domain).toBe("go");
    expect(domain.bindings.map((binding) => binding.method)).toEqual([REDSKILLS_ACP_METHODS.goDispatch]);
  });
});

describe("the go brief carries its own acceptance criteria", () => {
  it("the Ticket body and the criteria section both state the demand and the gate", () => {
    const spec = buildGoTicket("document the link commands\nwith the existing README tone");
    expect(spec.body).toContain("## Acceptance criteria");
    expect(spec.body).toContain("- The stated demand is satisfied: document the link commands.");
    expect(spec.body).toContain("shared gate");
  });

  it("the criteria section passes the brief contract's structural door", () => {
    const handoff = `implement the thing\n\n${goAcceptanceCriteria("implement the thing").join("\n")}`;
    expect(briefContractStructuralRefusal(handoff)).toBeNull();
  });
});
