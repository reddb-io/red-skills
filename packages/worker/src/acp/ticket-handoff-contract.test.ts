// The native ticket-handoff decoder's refusals (Ticket #4139).
//
// The decoder's whole answer is "a handoff" or "nothing", so a refusal is only
// ever observable as `undefined`. That makes it exactly the kind of behaviour a
// test has to pin field by field: nothing in the type system distinguishes "no
// Ticket on this turn" from "a Ticket this Worker must not take".
import { describe, expect, it } from "vitest";
import { ticketHandoffFromMeta } from "@reddb-io/protocol-acp";

const EXECUTABLE_BRIEF = `Implement the slice.

## Acceptance criteria

- [ ] Running \`pnpm -C packages/worker test\` passes.
`;

const BASE = {
  number: 4139,
  title: "Brief contract fail-closed",
  labels: ["ready-for-agent"],
  base: "main",
  handoff: EXECUTABLE_BRIEF,
  worker_id: "host:VSk6WPt",
};

const meta = (ticket: Record<string, unknown>): unknown => ({ redskills: { ticket } });

describe("ticketHandoffFromMeta", () => {
  it("decodes a handoff whose brief carries executable acceptance criteria", () => {
    expect(ticketHandoffFromMeta(meta(BASE))).toEqual(BASE);
  });

  it("refuses a handoff whose brief states no executable acceptance criteria", () => {
    expect(ticketHandoffFromMeta(meta({ ...BASE, handoff: "Implement the slice." })))
      .toBeUndefined();
  });

  it("refuses a brief whose criteria are present but not machine-checkable", () => {
    const vague = "Fix it.\n\n## Acceptance criteria\n\n- [ ] It should feel snappier.\n";
    expect(ticketHandoffFromMeta(meta({ ...BASE, handoff: vague }))).toBeUndefined();
  });

  it("refuses a missing required field the same way it refuses a vague brief", () => {
    expect(ticketHandoffFromMeta(meta({ ...BASE, number: 0 }))).toBeUndefined();
    expect(ticketHandoffFromMeta(meta({ ...BASE, number: 1.5 }))).toBeUndefined();
    expect(ticketHandoffFromMeta(meta({ ...BASE, title: "" }))).toBeUndefined();
    expect(ticketHandoffFromMeta(meta({ ...BASE, base: "" }))).toBeUndefined();
    expect(ticketHandoffFromMeta(meta({ ...BASE, handoff: "" }))).toBeUndefined();
    expect(ticketHandoffFromMeta(meta({ ...BASE, worker_id: "" }))).toBeUndefined();
    expect(ticketHandoffFromMeta(meta({ ...BASE, labels: "ready-for-agent" }))).toBeUndefined();
  });

  it("still answers `undefined` for a turn that carries no Ticket at all", () => {
    expect(ticketHandoffFromMeta(undefined)).toBeUndefined();
    expect(ticketHandoffFromMeta({})).toBeUndefined();
    expect(ticketHandoffFromMeta({ redskills: { ticket: "not-an-object" } })).toBeUndefined();
  });

  it("drops a malformed refinement rather than refusing the Ticket for it", () => {
    expect(ticketHandoffFromMeta(meta({ ...BASE, validation_commands: ["pnpm typecheck"] }))
      ?.validation_commands).toEqual(["pnpm typecheck"]);
    expect(ticketHandoffFromMeta(meta({ ...BASE, validation_commands: [7] }))
      ?.validation_commands).toBeUndefined();
    expect(ticketHandoffFromMeta(meta({ ...BASE, reseed_budget: -3 }))?.reseed_budget).toBe(0);
    expect(ticketHandoffFromMeta(meta({ ...BASE, runner: 7 }))?.runner).toBeUndefined();
  });
});

// Ticket #4141: standing orders travel as their OWN field, so the Worker can
// render them as the authoritative block the exit protocol names instead of
// receiving them spliced into a brief it cannot tell them apart from.
describe("ticketHandoffFromMeta standing orders", () => {
  const ORDERS = "1. Never hand-edit the generated manifests.\n2. Land through the daemon.";

  it("round-trips the operator's orders verbatim, beside the brief and not inside it", () => {
    const decoded = ticketHandoffFromMeta(meta({ ...BASE, standing_orders: ORDERS }));

    expect(decoded).toEqual({ ...BASE, standing_orders: ORDERS });
    expect(decoded?.handoff).toBe(EXECUTABLE_BRIEF);
  });

  it("refuses a malformed value the way it refuses every other refinement — by dropping it", () => {
    // The orders are DROPPED, never the Ticket: an operator's typo in their own
    // directives should cost the directives, not strand the work with no
    // channel to say why.
    for (const bad of [7, ["an order"], {}, null, "", "   \n "]) {
      const decoded = ticketHandoffFromMeta(meta({ ...BASE, standing_orders: bad }));
      expect(decoded).toEqual(BASE);
      expect(decoded?.standing_orders).toBeUndefined();
    }
  });

  it("states no orders at all for the Ticket that carries none", () => {
    expect(ticketHandoffFromMeta(meta(BASE))?.standing_orders).toBeUndefined();
  });
});
