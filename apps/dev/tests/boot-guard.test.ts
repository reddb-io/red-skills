import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { probeFleetSupervisor, checkBootGuard, isNamespacedDispatch } from "../src/commands/run.js";

function tmpPidFile(suffix: string): string {
  return join(tmpdir(), `afk-boot-guard-test-${suffix}.pid`);
}

function makeStdout(): { write: (s: string) => boolean; output: string } {
  const out = { write: (s: string) => { out.output += s; return true; }, output: "" };
  return out;
}

describe("probeFleetSupervisor (#1027)", () => {
  it("returns live:false when the pid file does not exist", async () => {
    const result = await probeFleetSupervisor(tmpPidFile("no-file"));
    expect(result.live).toBe(false);
  });

  it("returns live:false when the pid file contains a non-numeric value", async () => {
    const f = tmpPidFile("bad-content");
    await writeFile(f, "not-a-pid", "utf8");
    try {
      const result = await probeFleetSupervisor(f);
      expect(result.live).toBe(false);
    } finally {
      await rm(f, { force: true });
    }
  });

  it("returns live:false when the pid is not live (fake probe returns false)", async () => {
    const f = tmpPidFile("dead-pid");
    await writeFile(f, "99999", "utf8");
    try {
      const result = await probeFleetSupervisor(f, () => false);
      expect(result.live).toBe(false);
    } finally {
      await rm(f, { force: true });
    }
  });

  it("returns { live: true, pid } when the pid is live (fake probe returns true)", async () => {
    const f = tmpPidFile("live-pid");
    await writeFile(f, "12345", "utf8");
    try {
      const result = await probeFleetSupervisor(f, () => true);
      expect(result).toEqual({ live: true, pid: 12345 });
    } finally {
      await rm(f, { force: true });
    }
  });
});

describe("checkBootGuard (#1027)", () => {
  it("returns 'clear' when no supervisor pid file exists", async () => {
    const stdout = makeStdout();
    const result = await checkBootGuard(tmpPidFile("guard-no-file"), false, stdout as unknown as NodeJS.WritableStream);
    expect(result).toBe("clear");
    expect(stdout.output).toBe("");
  });

  it("returns 'refused' and prints monitor/stop hints when a live supervisor is detected", async () => {
    const f = tmpPidFile("guard-live");
    await writeFile(f, "55555", "utf8");
    try {
      const stdout = makeStdout();
      const result = await checkBootGuard(f, false, stdout as unknown as NodeJS.WritableStream, () => true);
      expect(result).toBe("refused");
      expect(stdout.output).toContain("fleet supervisor is already running");
      expect(stdout.output).toContain("pid=55555");
      expect(stdout.output).toContain("afk stop");
      expect(stdout.output).toContain("--force");
    } finally {
      await rm(f, { force: true });
    }
  });

  it("returns 'forced' and prints a warning when --force is passed with a live supervisor", async () => {
    const f = tmpPidFile("guard-force");
    await writeFile(f, "77777", "utf8");
    try {
      const stdout = makeStdout();
      const result = await checkBootGuard(f, true, stdout as unknown as NodeJS.WritableStream, () => true);
      expect(result).toBe("forced");
      expect(stdout.output).toContain("--force");
      expect(stdout.output).toContain("pid=77777");
      expect(stdout.output).toContain("collision risk");
    } finally {
      await rm(f, { force: true });
    }
  });

  it("returns 'clear' when the pid file exists but the pid is dead", async () => {
    const f = tmpPidFile("guard-dead");
    await writeFile(f, "44444", "utf8");
    try {
      const stdout = makeStdout();
      const result = await checkBootGuard(f, false, stdout as unknown as NodeJS.WritableStream, () => false);
      expect(result).toBe("clear");
      expect(stdout.output).toBe("");
    } finally {
      await rm(f, { force: true });
    }
  });

  it("returns 'clear' without probing when exempt (a /go|/scout dispatch), even with a LIVE supervisor (#1087)", async () => {
    const f = tmpPidFile("guard-exempt");
    await writeFile(f, "88888", "utf8");
    try {
      const stdout = makeStdout();
      // checkLivePid always reports live; exempt must skip the check entirely.
      const result = await checkBootGuard(f, false, stdout as unknown as NodeJS.WritableStream, () => true, true);
      expect(result).toBe("clear");
      expect(stdout.output).toBe("");
    } finally {
      await rm(f, { force: true });
    }
  });

  it("still REFUSES a live supervisor when NOT exempt (bare /afk run regression, #1087)", async () => {
    const f = tmpPidFile("guard-not-exempt");
    await writeFile(f, "99998", "utf8");
    try {
      const stdout = makeStdout();
      const result = await checkBootGuard(f, false, stdout as unknown as NodeJS.WritableStream, () => true, false);
      expect(result).toBe("refused");
      expect(stdout.output).toContain("fleet supervisor is already running");
    } finally {
      await rm(f, { force: true });
    }
  });
});

describe("isNamespacedDispatch (#1087)", () => {
  it("is true for a /go dispatch (origin=go)", () => {
    expect(isNamespacedDispatch({ origin: "go" }, {})).toBe(true);
  });

  it("is true for a --scout dispatch (origin=scout)", () => {
    expect(isNamespacedDispatch({ origin: "scout" }, {})).toBe(true);
  });

  it("is true when the lane is lane:go or lane:scout", () => {
    expect(isNamespacedDispatch({ lane: "lane:go" }, {})).toBe(true);
    expect(isNamespacedDispatch({ lane: "lane:scout" }, {})).toBe(true);
  });

  it("is true when RED_AFK_WORKERS_NAMESPACE is go-workers or scout-workers", () => {
    expect(isNamespacedDispatch({}, { RED_AFK_WORKERS_NAMESPACE: "go-workers" })).toBe(true);
    expect(isNamespacedDispatch({}, { RED_AFK_WORKERS_NAMESPACE: "scout-workers" })).toBe(true);
  });

  it("is false for a bare /afk run (origin=afk, workers/ namespace)", () => {
    expect(isNamespacedDispatch({ origin: "afk", lane: "ready-for-agent" }, { RED_AFK_WORKERS_NAMESPACE: "workers" })).toBe(false);
  });

  it("is false when no dispatch signal is present", () => {
    expect(isNamespacedDispatch({}, {})).toBe(false);
  });
});
