import { describe, expect, it } from "vitest";

import { awaitDaemonSession } from "../src/daemon.mjs";

const noSleep = () => Promise.resolve();

describe("waiting for the daemon this container supervises", () => {
  it("returns the first session the daemon serves", async () => {
    let calls = 0;
    const open = async () => {
      calls += 1;
      if (calls < 3) throw new Error("socket not up yet");
      return "session";
    };

    await expect(awaitDaemonSession({ open, sleep: noSleep, log: () => {} })).resolves.toBe("session");
    expect(calls).toBe(3);
  });

  it("stops waiting the moment the daemon it is waiting for is dead", async () => {
    const daemon = { exited: () => ({ code: 2, signal: null }) };

    await expect(awaitDaemonSession({ open: async () => "session", sleep: noSleep, daemon, log: () => {} }))
      .rejects.toThrow(/exited with 2 before it served a session/);
  });

  it("names a daemon that never started rather than a null exit code", async () => {
    const daemon = { exited: () => ({ code: null, signal: null, error: new Error("spawn ENOENT") }) };

    await expect(awaitDaemonSession({ open: async () => "session", sleep: noSleep, daemon, log: () => {} }))
      .rejects.toThrow(/exited with spawn ENOENT before it served a session/);
  });

  it("escalates at its deadline instead of polling forever", async () => {
    let clock = 0;

    await expect(awaitDaemonSession({
      open: async () => { throw new Error("connection refused"); },
      sleep: async () => { clock += 1_000; },
      now: () => clock,
      timeoutMs: 3_000,
      log: () => {},
    })).rejects.toThrow(/did not serve an ACP session within 3000ms: connection refused/);
  });
});
