// The native ticket-handoff decoder's refusals (Ticket #4139, #4296).
//
// `ticketHandoffFromMeta` answers "a handoff" or "nothing", so its refusals are
// only ever observable as `undefined`. That makes them exactly the kind of
// behaviour a test has to pin field by field: nothing in the type system
// distinguishes "no Ticket on this turn" from "a Ticket this Worker must not
// take". Since #4296 the underlying decision DOES distinguish them, and the two
// halves are pinned together here — a structural refusal is still an absence,
// and a refused brief is a refusal carrying its reason.
import { describe, expect, it } from "vitest";
import { decodeTicketHandoff, ticketHandoffFromMeta } from "@reddb-io/protocol-acp";

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

  it("accepts a brief whose criteria are present but vague — the wire door is structural", () => {
    // The machine-checkable judgement belongs to triage promotion; at the wire
    // it refused 41 of 42 live briefs and turned drains into birth-and-refuse
    // loops. The decoder now asks only that criteria EXIST.
    const vague = "Fix it.\n\n## Acceptance criteria\n\n- [ ] It should feel snappier.\n";
    expect(ticketHandoffFromMeta(meta({ ...BASE, handoff: vague }))).toBeDefined();
  });

  it("still refuses a brief whose criteria section lists nothing", () => {
    const empty = "Fix it.\n\n## Acceptance criteria\n\nProse, no checklist.\n";
    expect(ticketHandoffFromMeta(meta({ ...BASE, handoff: empty }))).toBeUndefined();
    const decision = decodeTicketHandoff(meta({ ...BASE, handoff: empty }));
    expect(decision.kind).toBe("refused");
    expect(decision.kind === "refused" && decision.reason).toContain("brief contract refused");
  });

  it("refuses a missing required field as an absence, not as a stated refusal", () => {
    // Structural refusals stay ABSENT, deliberately: an ordinary prompt turn's
    // unrelated `_meta` must never be read as a Ticket somebody got wrong.
    expect(decodeTicketHandoff(meta({ ...BASE, number: 0 })).kind).toBe("absent");
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
    expect(ticketHandoffFromMeta(meta({ ...BASE, preclaimed: true }))?.preclaimed).toBe(true);
    expect(ticketHandoffFromMeta(meta({ ...BASE, preclaimed: "yes" }))?.preclaimed).toBeUndefined();
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
