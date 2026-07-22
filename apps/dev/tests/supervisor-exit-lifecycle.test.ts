import { describe, expect, it, vi } from "vitest";
import { createSupervisorExitRecorder } from "../src/core/supervisor-exit.js";
import { runSupervisorWatchdogLoop } from "../src/core/watchdog.js";
import { isSupervisorIdentityLive } from "../src/runtime/supervisor-state.js";

describe("fleet supervisor terminal lifecycle (#2442)", () => {
  it("writes exactly one terminal lane record naming the received signal", async () => {
    const append = vi.fn(async () => {});
    const appendSync = vi.fn();
    const recorder = createSupervisorExitRecorder({
      supervisorId: "s4242",
      append,
      appendSync,
    });

    await recorder.record("signal", { signal: "SIGTERM" });
    recorder.recordSync("process-exit", { code: 143 });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith({
      kind: "supervisor.exit",
      supervisor_id: "s4242",
      payload: { reason: "signal", signal: "SIGTERM" },
    });
    expect(appendSync).not.toHaveBeenCalled();
  });
});

describe("fleet supervisor steady-state self-heal (#2442)", () => {
  it("detects a killed supervisor and respawns it within one fleet poll window", async () => {
    let supervisorAlive = true;
    let respawns = 0;
    const sleep = vi.fn(async () => {
      supervisorAlive = false;
    });
    const pass = vi.fn(async () => {
      if (!supervisorAlive) {
        supervisorAlive = true;
        respawns += 1;
      }
    });

    await runSupervisorWatchdogLoop({
      pollMs: 15_000,
      pass,
      shouldStop: () => respawns === 1,
      sleep,
    });

    expect(pass).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(respawns).toBe(1);
  });

  it("rejects a live recycled pid whose start-time differs from this repo's pin", () => {
    expect(
      isSupervisorIdentityLive(
        { pid: 4242, startTime: "repo-a-start" },
        () => true,
        () => "sibling-or-recycled-start",
      ),
    ).toBe(false);
  });
});
