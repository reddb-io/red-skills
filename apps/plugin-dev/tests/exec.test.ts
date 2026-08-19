import { describe, expect, it } from "vitest";
import { KILLED_EXIT_CODE, MAXBUFFER_EXIT_CODE, execTool } from "../src/runtime/exec.js";

describe("execTool", () => {
  it("captures the real exit code + streams of a finished command", async () => {
    const r = await execTool("sh", ["-c", "printf out; printf err 1>&2; exit 3"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("err");
  });

  it("streams complete stdout lines while preserving the captured stdout (#2480)", async () => {
    const lines: string[] = [];
    const r = await execTool("sh", ["-c", "printf 'first\\nsecond\\n'"], {
      onStdoutLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(["first", "second"]);
    expect(r.stdout).toBe("first\nsecond\n");
  });

  it("publishes the spawned child pid before waiting for its exit (#3182)", async () => {
    const spawned: number[] = [];
    const running = execTool("sh", ["-c", "sleep 0.1"], {
      onSpawn: (pid: number) => spawned.push(pid),
    } as never);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toBeGreaterThan(0);
    await expect(running).resolves.toMatchObject({ code: 0 });
  });

  it("resolves a missing binary as 127 instead of rejecting", async () => {
    const r = await execTool("definitely-no-such-binary-xyz", []);
    expect(r.code).toBe(127);
    // The spawn error message is surfaced on stderr (ENOENT etc.).
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("reports a command killed by the timeout as a non-zero failure, never code 0 (PRD #567)", async () => {
    // The classic bug: Node leaves error.code === null for a timeout-killed
    // child, so the old `typeof code === 'number' ? code : 0` fallthrough read
    // the kill as success (code 0). It must read as a failure instead.
    const r = await execTool("sh", ["-c", "sleep 5"], { timeoutMs: 150 });
    expect(r.code).not.toBe(0);
    expect(r.code).toBe(KILLED_EXIT_CODE);
  });

  it.skipIf(process.platform !== "linux")(
    "kills a CPU-idle validation child within one sampling window after its normal envelope (#3280)",
    async () => {
      const started = Date.now();
      const r = await execTool("sh", ["-c", "sleep 60"], {
        stallDetection: {
          minWallTimeMs: 100,
          sampleIntervalMs: 100,
          idleCpuThresholdMs: 1,
        },
      });

      expect(Date.now() - started).toBeLessThan(1_500);
      expect(r.code).toBe(KILLED_EXIT_CODE);
      expect(r.infraEvidence).toMatchObject({
        kind: "stall",
        cpuDeltaMs: 0,
      });
      expect(r.infraEvidence?.kind).toBe("stall");
      if (r.infraEvidence?.kind !== "stall") throw new Error("expected stall evidence");
      expect(r.infraEvidence.sampleWindowMs).toBeGreaterThanOrEqual(100);
      expect(r.infraEvidence!.wallTimeMs).toBeGreaterThanOrEqual(200);
      expect(r.stderr).toContain("validation child stalled");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "leaves a slow CPU-active validation child alive (#3280)",
    async () => {
      const r = await execTool(
        process.execPath,
        ["-e", "const end = Date.now() + 450; while (Date.now() < end) {}"],
        {
          stallDetection: {
            minWallTimeMs: 100,
            sampleIntervalMs: 100,
            idleCpuThresholdMs: 1,
          },
        },
      );

      expect(r.code).toBe(0);
      expect(r.infraEvidence).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")("reaps fork children when a gate parent times out", async () => {
    const r = await execTool(
      "sh",
      ["-c", 'sh -c \'trap "" TERM; while :; do sleep 1; done\' </dev/null >/dev/null 2>&1 & child=$!; printf "%s\\n" "$child"; wait'],
      { timeoutMs: 150 },
    );
    const childPid = Number(r.stdout.trim());

    try {
      expect(r.code).toBe(KILLED_EXIT_CODE);
      expect(Number.isInteger(childPid)).toBe(true);
      await expect.poll(() => {
        try {
          process.kill(childPid, 0);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 2_000 }).toBe(false);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // The expected path already reaped it.
      }
    }
  });

  it("reports a signal-killed command as a non-zero failure (PRD #567)", async () => {
    // A process that kills itself with a signal also leaves error.code null with
    // a non-null error.signal — likewise a failure, not success.
    const r = await execTool("sh", ["-c", "kill -TERM $$"]);
    expect(r.code).not.toBe(0);
    expect(r.code).toBe(KILLED_EXIT_CODE);
  });

  // AFK runner improvement: a command whose OUTPUT exceeds the capture ceiling
  // gets a DISTINCT exit code + a stable `maxBuffer length exceeded` marker, so
  // the Verdict records it as an environment cause instead of charging the
  // branch for a green-but-verbose suite.
  it("reports a maxBuffer overflow as MAXBUFFER_EXIT_CODE with a stable marker, not a generic 127", async () => {
    // Emit more than the tiny maxBuffer can hold (the command itself exits 0).
    const r = await execTool("sh", ["-c", "yes x | head -c 5000; exit 0"], { maxBuffer: 256 });
    expect(r.code).toBe(MAXBUFFER_EXIT_CODE);
    expect(r.code).not.toBe(127); // not mistaken for a missing-binary spawn error
    expect(r.code).not.toBe(0); // the overflow is surfaced as a failure to the gate
    expect(r.stderr).toContain("maxBuffer length exceeded");
  });
});
