// The register renders in exactly one shape, and states which half of it goes
// on which channel (#4141).
import { describe, expect, it } from "vitest";
import {
  formatStandingOrdersBody,
  formatStandingOrdersBrief,
  type StandingOrder,
} from "../src/standing-orders.js";

const order = (n: number, text: string): StandingOrder => ({
  version: 1,
  n,
  text,
  ts: "2026-08-21T00:00:00.000Z",
});

const ORDERS = [
  order(1, "Never hand-edit the generated manifests."),
  order(2, "Land through the daemon."),
];

describe("the register's two renderings", () => {
  it("numbers the body without tagging it, for the Ticket's own field", () => {
    expect(formatStandingOrdersBody(ORDERS)).toBe(
      "1. Never hand-edit the generated manifests.\n2. Land through the daemon.",
    );
  });

  it("tags the same body for the channels that carry only a prompt", () => {
    expect(formatStandingOrdersBrief(ORDERS)).toBe(
      "<standing-orders>\n1. Never hand-edit the generated manifests.\n2. Land through the daemon.\n</standing-orders>",
    );
  });

  it("says nothing at all for a project whose register is empty", () => {
    expect(formatStandingOrdersBody([])).toBe("");
    expect(formatStandingOrdersBrief([])).toBe("");
  });

  it("keeps the operator's numbering, which append-only ownership already fixed", () => {
    // The register never renumbers, so a renderer that re-derived the ordinal
    // from the array index would silently rewrite history after a manual edit.
    expect(formatStandingOrdersBody([order(7, "Seventh order.")])).toBe("7. Seventh order.");
  });
});
