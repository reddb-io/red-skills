import { describe, expect, it } from "vitest";
import { runBackpressure, type BackpressureExec } from "../src/core/backpressure.js";
import { VALIDATION_SCHEMA, type ExecResult, type ValidationRecord } from "../src/core/feedback.js";

/**
 * Fake backpressure exec recording every (command, cwd) and replying from a
 * per-call matcher. Default reply is success with empty output, so a test only
 * overrides the commands whose exit code drives a failure.
 */
function fakeExec(
  rules: Array<{ match: (command: string) => boolean; result: Partial<ExecResult> }> = [],
): { exec: BackpressureExec; calls: Array<{ command: string; cwd: string }> } {
  const calls: Array<{ command: string; cwd: string }> = [];
  const exec: BackpressureExec = async ({ command, cwd }) => {
    calls.push({ command, cwd });
    for (const rule of rules) {
      if (rule.match(command)) return { code: 0, stdout: "", stderr: "", ...rule.result };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

/** A monotonic injected clock that ticks 5ms per read. */
function fakeClock(step = 5): () => number {
  let t = 1000;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

describe("runBackpressure", () => {
  it("runs each command in order against the worktree, passing", async () => {
    const { exec, calls } = fakeExec();
    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["npm run test", "npm run lint"],
      now: fakeClock(),
    });

    expect(result.ok).toBe(true);
    // Declaration order, each at the worktree root.
    expect(calls).toEqual([
      { command: "npm run test", cwd: "/wt" },
      { command: "npm run lint", cwd: "/wt" },
    ]);
    expect(result.checks.map((c) => c.name)).toEqual([
      "backpressure:npm run test",
      "backpressure:npm run lint",
    ]);
    expect(result.checks.every((c) => c.status === "passed")).toBe(true);
  });

  it("blocks the merge (ok:false) when any command fails, recording all", async () => {
    const { exec } = fakeExec([
      { match: (c) => c === "npm run lint", result: { code: 1, stdout: "lint broke\nhere\n" } },
    ]);
    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["npm run test", "npm run lint", "npm run build"],
      now: fakeClock(),
    });

    expect(result.ok).toBe(false);
    // Every command still ran (full picture for the operator).
    expect(result.checks.map((c) => c.name)).toEqual([
      "backpressure:npm run test",
      "backpressure:npm run lint",
      "backpressure:npm run build",
    ]);
    const lint = result.checks.find((c) => c.name === "backpressure:npm run lint");
    expect(lint?.status).toBe("failed");
    expect(lint?.record.summary).toBe("lint broke here");
    expect(result.checks.find((c) => c.name === "backpressure:npm run test")?.status).toBe("passed");
  });

  it("produces the exact red.afk.validation.v1 sidecar record shape", async () => {
    const { exec } = fakeExec();
    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["npm run test"],
      // start=1000, end=2234 → durationMs 1234.
      now: (() => {
        const seq = [1000, 2234];
        let i = 0;
        return () => seq[i++] ?? 0;
      })(),
    });

    const expected: ValidationRecord = {
      schema: VALIDATION_SCHEMA,
      name: "backpressure:npm run test",
      status: "passed",
      command: "npm run test",
      durationMs: 1234,
      summary: "command exited 0",
    };
    expect(result.checks[0]?.record).toEqual(expected);
    // The sidecar line is the compact JSON of the record, schema-first.
    expect(result.sidecar).toEqual([JSON.stringify(expected)]);
  });

  it("is a no-op for an empty command list", async () => {
    const { exec, calls } = fakeExec();
    const result = await runBackpressure(exec, { worktree: "/wt", commands: [], now: fakeClock() });

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([]);
    expect(result.sidecar).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips blank/whitespace entries without recording them", async () => {
    const { exec, calls } = fakeExec();
    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["  ", "npm run test", ""],
      now: fakeClock(),
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ command: "npm run test", cwd: "/wt" }]);
    expect(result.checks.map((c) => c.name)).toEqual(["backpressure:npm run test"]);
  });

  it("trims surrounding whitespace from the command before running + naming", async () => {
    const { exec, calls } = fakeExec();
    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["  npm run test  "],
      now: fakeClock(),
    });

    expect(calls).toEqual([{ command: "npm run test", cwd: "/wt" }]);
    expect(result.checks[0]?.name).toBe("backpressure:npm run test");
    expect(result.checks[0]?.record.command).toBe("npm run test");
  });
});
