import { describe, expect, it, vi } from "vitest";
import { createSupervisorExitRecorder } from "../src/core/supervisor-exit.js";

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
