import { describe, expect, it } from "vitest";
import {
  BACKPRESSURE_REVIEW_HEADER,
  DEFAULT_BACKPRESSURE_TIMEOUT_MS,
  renderBackpressureReviewBody,
  runBackpressure,
  type BackpressureCheck,
  type BackpressureExec,
} from "../src/core/backpressure.js";
import { KILLED_EXIT_CODE } from "../src/runtime/exec.js";
import { VALIDATION_SCHEMA, type ExecResult, type ValidationRecord } from "../src/core/feedback.js";

/**
 * Fake backpressure exec recording every (command, cwd, timeoutMs) and replying
 * from a per-call matcher. Default reply is success with empty output, so a test
 * only overrides the commands whose exit code drives a failure.
 */
function fakeExec(
  rules: Array<{ match: (command: string) => boolean; result: Partial<ExecResult> }> = [],
): { exec: BackpressureExec; calls: Array<{ command: string; cwd: string; timeoutMs: number }> } {
  const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
  const exec: BackpressureExec = async ({ command, cwd, timeoutMs }) => {
    calls.push({ command, cwd, timeoutMs });
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
    // Declaration order, each at the worktree root, under the default bound.
    expect(calls).toEqual([
      { command: "npm run test", cwd: "/wt", timeoutMs: DEFAULT_BACKPRESSURE_TIMEOUT_MS },
      { command: "npm run lint", cwd: "/wt", timeoutMs: DEFAULT_BACKPRESSURE_TIMEOUT_MS },
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
      exitCode: 0,
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
    expect(calls).toEqual([
      { command: "npm run test", cwd: "/wt", timeoutMs: DEFAULT_BACKPRESSURE_TIMEOUT_MS },
    ]);
    expect(result.checks.map((c) => c.name)).toEqual(["backpressure:npm run test"]);
  });

  it("trims surrounding whitespace from the command before running + naming", async () => {
    const { exec, calls } = fakeExec();
    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["  npm run test  "],
      now: fakeClock(),
    });

    expect(calls).toEqual([
      { command: "npm run test", cwd: "/wt", timeoutMs: DEFAULT_BACKPRESSURE_TIMEOUT_MS },
    ]);
    expect(result.checks[0]?.name).toBe("backpressure:npm run test");
    expect(result.checks[0]?.record.command).toBe("npm run test");
  });

  it("runs each command under the caller's bounded timeout when supplied (PRD #567)", async () => {
    const { exec, calls } = fakeExec();
    await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["sleep 999"],
      now: fakeClock(),
      timeoutMs: 250,
    });

    // The explicit bound is threaded to the exec edge so the `sh -c` child is
    // killed at the deadline instead of hanging the worker.
    expect(calls).toEqual([{ command: "sleep 999", cwd: "/wt", timeoutMs: 250 }]);
  });

  it("blocks the merge as a timed-out validation failure when a command is killed (PRD #567)", async () => {
    // The exec edge reports KILLED_EXIT_CODE for a command killed at the bound;
    // backpressure must read that as a FAILED block, never silently pass.
    const { exec } = fakeExec([
      { match: (c) => c === "sleep 999", result: { code: KILLED_EXIT_CODE, stdout: "", stderr: "" } },
    ]);
    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["npm run test", "sleep 999"],
      now: fakeClock(),
      timeoutMs: 250,
    });

    // A hung post-DONE command surfaces as a validation block, not a hang.
    expect(result.ok).toBe(false);
    const hung = result.checks.find((c) => c.name === "backpressure:sleep 999");
    expect(hung?.status).toBe("failed");
    // Explicit timed-out summary (not the generic `command exited non-zero`).
    expect(hung?.record.summary).toBe("command timed out after 250ms");
    // The earlier command still passed — only the hung one blocks.
    expect(result.checks.find((c) => c.name === "backpressure:npm run test")?.status).toBe("passed");
  });

  it("distinguishes a CPU stall reap from the ordinary wall-time deadline (#3280)", async () => {
    const { exec } = fakeExec([
      {
        match: (command) => command === "pnpm test",
        result: {
          code: KILLED_EXIT_CODE,
          stderr: "validation child stalled: 0ms CPU over 30000ms",
          infraEvidence: {
            kind: "stall",
            wallTimeMs: 1_230_000,
            sampleWindowMs: 30_000,
            cpuDeltaMs: 0,
          },
        },
      },
    ]);

    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["pnpm test"],
      now: fakeClock(1_230_000),
    });

    expect(result.checks[0]?.record).toMatchObject({
      status: "failed",
      infra: "stall",
      summary: "validation child stalled: 0ms CPU over 30000ms",
    });
  });
});

describe("renderBackpressureReviewBody (#1279)", () => {
  /** Build a minimal {@link BackpressureCheck} for the rendering tests. */
  function check(command: string, status: "passed" | "failed", summary?: string): BackpressureCheck {
    return {
      name: `backpressure:${command}`,
      command,
      status,
      record: { schema: "red.afk.validation.v1", name: `backpressure:${command}`, status, summary },
    };
  }

  it("renders NOTHING (null) for an empty check list — an empty ledger is never a review", () => {
    expect(renderBackpressureReviewBody([])).toBeNull();
  });

  it("aggregates mixed pass/fail into ONE body with the correct per-check lines", () => {
    const body = renderBackpressureReviewBody([
      check("npm run test", "passed"),
      check("npm run lint", "failed", "lint broke here"),
      check("npm run build", "passed"),
    ]);

    // Header states, in-band, that the ledger is non-blocking observability.
    expect(body).not.toBeNull();
    const lines = (body as string).split("\n");
    expect(lines[0]).toBe(BACKPRESSURE_REVIEW_HEADER);
    expect(BACKPRESSURE_REVIEW_HEADER).toContain("non-blocking");
    expect(BACKPRESSURE_REVIEW_HEADER).toContain("unchanged");
    // Both positive and negative checks are included, one line each, in order.
    expect(lines).toContain("✅ backpressure:npm run test");
    expect(lines).toContain("❌ backpressure:npm run lint → lint broke here");
    expect(lines).toContain("✅ backpressure:npm run build");
    // ONE aggregated body — a single COMMENT review, never one per check.
    expect(lines.filter((l) => l.startsWith("✅") || l.startsWith("❌"))).toHaveLength(3);
    // Never carries approve/request-changes gate semantics.
    expect(body).not.toMatch(/APPROVE|REQUEST_CHANGES/);
  });

  it("falls back to a generic summary when a failed check carries none", () => {
    const body = renderBackpressureReviewBody([check("flaky", "failed")]);
    expect(body).toContain("❌ backpressure:flaky → command failed");
  });

  it("flows straight from runBackpressure output — passed-only ledger has no ❌ line", async () => {
    const { exec } = fakeExec();
    const result = await runBackpressure(exec, {
      worktree: "/wt",
      commands: ["npm run test", "npm run lint"],
      now: fakeClock(),
    });
    const body = renderBackpressureReviewBody(result.checks);
    expect(body).toContain("✅ backpressure:npm run test");
    expect(body).toContain("✅ backpressure:npm run lint");
    expect(body).not.toContain("❌");
  });
});
