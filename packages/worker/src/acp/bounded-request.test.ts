import { describe, expect, it, vi } from "vitest";

import { WORKER_REQUEST_DEADLINE_MS } from "./native-worker.js";

/**
 * A Worker waiting on the daemon has a deadline, or it is a Worker doing
 * nothing.
 *
 * Five Workers sat alive for eleven minutes each on a pending claim: no branch,
 * no narration, no claim comment, and every liveness surface calling them
 * healthy. The deadline is what turns that into a refusal somebody can read.
 */
describe("the Worker's ask is bounded", () => {
  it("states a deadline generous enough for a slow forge and short enough to end", () => {
    expect(WORKER_REQUEST_DEADLINE_MS).toBeGreaterThanOrEqual(30_000);
    expect(WORKER_REQUEST_DEADLINE_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it("is the shape a hung claim needs: the pending ask ends, naming the method", async () => {
    // The helper is private to the module; this pins the contract it implements
    // so a later edit cannot quietly drop the bound back to an open await.
    const source = await import("node:fs/promises")
      .then((fs) => fs.readFile(new URL("./native-worker.ts", import.meta.url), "utf8"));

    expect(source).toContain("boundedRequest(parent)");
    expect(source).not.toMatch(/request: \(method, (write|request)\) => parent\.request\(/);
    expect(source).toContain("the daemon did not answer ${method}");
  });

  it("does not bound the child agent's own turn, which is meant to be long", async () => {
    const source = await import("node:fs/promises")
      .then((fs) => fs.readFile(new URL("./native-worker.ts", import.meta.url), "utf8"));
    const implement = source.slice(source.indexOf("implement: async (handoff)"));

    expect(implement.slice(0, 400)).not.toContain("WORKER_REQUEST_DEADLINE_MS");
    expect(vi.isMockFunction(vi.fn())).toBe(true);
  });
});
