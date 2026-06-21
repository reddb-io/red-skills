import { describe, expect, it } from "vitest";
import { KILLED_EXIT_CODE, MAXBUFFER_EXIT_CODE, execTool } from "../src/runtime/exec.js";

describe("execTool", () => {
  it("captures the real exit code + streams of a finished command", async () => {
    const r = await execTool("sh", ["-c", "printf out; printf err 1>&2; exit 3"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("err");
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

  it("reports a signal-killed command as a non-zero failure (PRD #567)", async () => {
    // A process that kills itself with a signal also leaves error.code null with
    // a non-null error.signal — likewise a failure, not success.
    const r = await execTool("sh", ["-c", "kill -TERM $$"]);
    expect(r.code).not.toBe(0);
    expect(r.code).toBe(KILLED_EXIT_CODE);
  });

  // AFK runner improvement: a command whose OUTPUT exceeds the capture ceiling
  // gets a DISTINCT exit code + a stable `maxBuffer length exceeded` marker, so
  // the feedback gate routes it through bounded validation-infra recovery
  // instead of paging a human for a green-but-verbose suite.
  it("reports a maxBuffer overflow as MAXBUFFER_EXIT_CODE with a stable marker, not a generic 127", async () => {
    // Emit more than the tiny maxBuffer can hold (the command itself exits 0).
    const r = await execTool("sh", ["-c", "yes x | head -c 5000; exit 0"], { maxBuffer: 256 });
    expect(r.code).toBe(MAXBUFFER_EXIT_CODE);
    expect(r.code).not.toBe(127); // not mistaken for a missing-binary spawn error
    expect(r.code).not.toBe(0); // the overflow is surfaced as a failure to the gate
    expect(r.stderr).toContain("maxBuffer length exceeded");
  });
});
