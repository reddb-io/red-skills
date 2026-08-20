import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A busy Worker whose client left is finished or it is leaked.
 *
 * The close loop reaps idle Workers and used to SKIP busy ones — so a turn
 * that never completed (an answer notified to a dead upstream, a child that
 * never ends) held a host slot forever. Measured live: Workers alive 56
 * minutes for clients gone 55 of them, while other projects were refused with
 * "past a host ceiling of 5 Worker(s)".
 */
const SOURCE = readFileSync(
  join(import.meta.dirname, "..", "src", "acp-control-plane.ts"),
  "utf8",
);

describe("a detached turn ends", () => {
  it("cancels a busy client-less prompt turn instead of skipping it forever", () => {
    expect(SOURCE).toContain("worker.cancelled = true;");
    expect(SOURCE).toContain("methods.agent.session.cancel");
    // The old shape — skip busy sessions with a bare continue — must not return.
    expect(SOURCE).not.toMatch(/if \(busy\.has\(sessionId\) \|\| v2Turns\.has\(sessionId\)\) continue;/);
  });

  it("bounds the cancellation, because an unbounded cancel is the same eternal wait", () => {
    expect(SOURCE).toContain("DETACHED_TURN_GRACE_MS");
    expect(SOURCE).toContain('"detached-turn-deadline"');
  });

  it("spares a dispatched Ticket turn — its PR is useful with nobody watching (#3885)", () => {
    expect(SOURCE).toContain("if (worker.dispatch == null) {");
  });
});
