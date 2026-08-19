import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_WORKER_FORMAT_TIMEOUT_MS,
  runPostWorkerFormat,
  type PostWorkerFormatExec,
} from "../src/core/post-worker-format.js";
import { KILLED_EXIT_CODE } from "../src/runtime/exec.js";

type ExecCall = { command: string; cwd: string; timeoutMs: number };
type ExecResult = { code: number; stdout: string; stderr: string; committed: boolean };

function fakeExec(
  rules: Array<{ match: (command: string) => boolean; result: Partial<ExecResult> }> = [],
): { exec: PostWorkerFormatExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: PostWorkerFormatExec = async ({ command, cwd, timeoutMs }) => {
    calls.push({ command, cwd, timeoutMs });
    for (const rule of rules) {
      if (rule.match(command)) {
        return { code: 0, stdout: "", stderr: "", committed: false, ...rule.result };
      }
    }
    return { code: 0, stdout: "", stderr: "", committed: false };
  };
  return { exec, calls };
}

function fakeClock(step = 5): () => number {
  let t = 1000;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

describe("runPostWorkerFormat", () => {
  it("is a no-op for an empty command list", async () => {
    const { exec, calls } = fakeExec();
    const result = await runPostWorkerFormat(exec, { worktree: "/wt", commands: [], now: fakeClock() });

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.log).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips blank/whitespace entries without running them", async () => {
    const { exec, calls } = fakeExec();
    await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["  ", "cargo fmt --all", ""],
      now: fakeClock(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("cargo fmt --all");
  });

  it("runs each command at the worktree root under the default timeout", async () => {
    const { exec, calls } = fakeExec();
    await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["cargo fmt --all", "gofmt -w ."],
      now: fakeClock(),
    });

    expect(calls).toEqual([
      { command: "cargo fmt --all", cwd: "/wt", timeoutMs: DEFAULT_POST_WORKER_FORMAT_TIMEOUT_MS },
      { command: "gofmt -w .", cwd: "/wt", timeoutMs: DEFAULT_POST_WORKER_FORMAT_TIMEOUT_MS },
    ]);
  });

  it("passes the caller-supplied timeoutMs to the exec", async () => {
    const { exec, calls } = fakeExec();
    await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["cargo fmt --all"],
      now: fakeClock(),
      timeoutMs: 30_000,
    });

    expect(calls[0]?.timeoutMs).toBe(30_000);
  });

  it("reports ok:true and committed:true when the exec returns committed:true", async () => {
    const { exec } = fakeExec([
      { match: (c) => c === "cargo fmt --all", result: { committed: true } },
    ]);
    const result = await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["cargo fmt --all"],
      now: fakeClock(),
    });

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
  });

  it("reports committed:true when any command in the sequence committed", async () => {
    const { exec } = fakeExec([
      { match: (c) => c === "cargo fmt --all", result: { committed: true } },
    ]);
    const result = await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["cargo fmt --all", "gofmt -w ."],
      now: fakeClock(),
    });

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.log).toHaveLength(2);
  });

  it("aborts on the first non-zero exit — ok:false, remaining commands do not run", async () => {
    const { exec, calls } = fakeExec([
      { match: (c) => c === "cargo fmt --all", result: { code: 1, stdout: "syntax error" } },
    ]);
    const result = await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["cargo fmt --all", "gofmt -w ."],
      now: fakeClock(),
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(result.log).toHaveLength(1);
    expect(result.log[0]).toContain("aborting");
  });

  it("treats KILLED_EXIT_CODE as a timed-out failure (ok:false)", async () => {
    const { exec } = fakeExec([
      { match: (c) => c === "cargo fmt --all", result: { code: KILLED_EXIT_CODE } },
    ]);
    const result = await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["cargo fmt --all"],
      now: fakeClock(),
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.log[0]).toContain("timed out after 1000ms");
  });

  it("includes duration in log lines", async () => {
    const clockSeq = [1000, 2234];
    let idx = 0;
    const { exec } = fakeExec();
    const result = await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["cargo fmt --all"],
      now: () => clockSeq[idx++] ?? 0,
    });

    expect(result.log[0]).toContain("1234ms");
  });

  it("trims whitespace from the command string before running and logging", async () => {
    const { exec, calls } = fakeExec();
    const result = await runPostWorkerFormat(exec, {
      worktree: "/wt",
      commands: ["  cargo fmt --all  "],
      now: fakeClock(),
    });

    expect(calls[0]?.command).toBe("cargo fmt --all");
    expect(result.log[0]).toContain("cargo fmt --all");
    expect(result.log[0]).not.toMatch(/\s{2,}/);
  });
});
