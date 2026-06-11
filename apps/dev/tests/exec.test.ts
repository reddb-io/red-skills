import { describe, expect, it } from "vitest";
import { KILLED_EXIT_CODE, execTool } from "../src/runtime/exec.js";

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
});
