// The daemon protects the machine from itself. Two live failures drove this:
// a wedged-but-alive process (2026-08-25, project-control deadlock) that
// Restart=always never fires for, and a multi-day leak that killed a host
// before any generous unit ceiling killed the daemon. Both end in ONE loud
// deliberate exit; the supervisor owns the comeback.
import { describe, expect, it, vi } from "vitest";

import {
  createRedskilledSelfGuard,
  REDSKILLED_SELF_GUARD_EXIT_RSS,
  REDSKILLED_SELF_GUARD_EXIT_UNRESPONSIVE,
} from "../src/daemon/self-guard.js";

describe("the redskilled self-guard", () => {
  it("a healthy daemon never trips either verdict", async () => {
    const onFatal = vi.fn();
    const guard = createRedskilledSelfGuard({
      socketPath: "/nowhere",
      probe: async () => undefined,
      rss: () => 400 * 1_048_576,
      missLimit: 2,
      onFatal,
    });

    for (let i = 0; i < 10; i += 1) await guard.tick();
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("sustained ping misses end in one unresponsive exit — a wedge is not health", async () => {
    const onFatal = vi.fn();
    const guard = createRedskilledSelfGuard({
      socketPath: "/nowhere",
      probe: async () => { throw new Error("op socket did not answer"); },
      rss: () => 100 * 1_048_576,
      missLimit: 3,
      onFatal,
    });

    await guard.tick();
    await guard.tick();
    expect(onFatal).not.toHaveBeenCalled();
    await guard.tick();
    await guard.tick();

    expect(onFatal).toHaveBeenCalledTimes(1);
    const verdict = onFatal.mock.calls[0]?.[0];
    expect(verdict).toMatchObject({ kind: "unresponsive", exitCode: REDSKILLED_SELF_GUARD_EXIT_UNRESPONSIVE });
    expect(verdict.detail).toContain("3 consecutive self-pings failed");
  });

  it("a recovering daemon resets the miss streak — jitter is not a wedge", async () => {
    const onFatal = vi.fn();
    let fail = true;
    const guard = createRedskilledSelfGuard({
      socketPath: "/nowhere",
      probe: async () => { if (fail) throw new Error("busy"); },
      rss: () => 100 * 1_048_576,
      missLimit: 3,
      onFatal,
    });

    await guard.tick();
    await guard.tick();
    fail = false;
    await guard.tick();
    fail = true;
    await guard.tick();
    await guard.tick();

    expect(onFatal).not.toHaveBeenCalled();
  });

  it("an RSS past the ceiling exits deliberately — shedding a leak beats losing the machine", async () => {
    const onFatal = vi.fn();
    const guard = createRedskilledSelfGuard({
      socketPath: "/nowhere",
      probe: async () => undefined,
      rss: () => 2_000 * 1_048_576,
      rssLimitBytes: 1_536 * 1_048_576,
      onFatal,
    });

    await guard.tick();
    await guard.tick();

    expect(onFatal).toHaveBeenCalledTimes(1);
    const verdict = onFatal.mock.calls[0]?.[0];
    expect(verdict).toMatchObject({ kind: "rss-ceiling", exitCode: REDSKILLED_SELF_GUARD_EXIT_RSS });
    expect(verdict.detail).toContain("2000MiB");
  });
});
