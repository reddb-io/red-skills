import { describe, expect, it } from "vitest";
import type { Exec, PackageLayout } from "../src/core/feedback.js";
import { runPrePrPipeline, isPrePrPipelineActive, type PrePrPipelineInput } from "../src/core/pre-pr-pipeline.js";
import { LABEL_GO_LANE } from "../src/core/go.js";

describe("no-mistakes pre-PR pipeline (#913)", () => {
  function makeMockExec(results: Record<string, { code: number; stdout: string; stderr: string }>): Exec {
    return async (args: string[]) => {
      const key = args.join(" ");
      return results[key] ?? { code: 0, stdout: "", stderr: "" };
    };
  }

  function makeMockLayout(): PackageLayout {
    return {
      hasPackage: (scope: string) => scope === "." || scope === "apps/plugin-dev" || scope === "packages/shared",
      hasScript: (scope: string, script: string) => {
        const scripts = {
          ".": ["test", "typecheck", "lint", "build"],
          "apps/plugin-dev": ["test", "typecheck", "lint", "build"],
          "packages/shared": ["test", "lint"],
        };
        return (scripts[scope as keyof typeof scripts] ?? []).includes(script);
      },
    };
  }

  it("runs the pipeline and returns success when feedback is green", async () => {
    const input: PrePrPipelineInput = {
      workingDir: "/repo/.red/tmp/work-ship-abc",
      exec: makeMockExec({}),
      layout: makeMockLayout(),
      now: () => Date.now(),
      wallClockBudgetMs: 5 * 60 * 1000,
    };

    const result = await runPrePrPipeline(input);
    expect(result.passed).toBe(true);
    expect(result.mechanicalApplied).toBe(0);
    expect(result.intentEscalated).toBe(0);
  });

  it("the pipeline runs in the worktree without disturbing the primary checkout", async () => {
    let execCalls: string[] = [];
    const trackingExec: Exec = async (args: string[]) => {
      execCalls.push(args.join(" "));
      return { code: 0, stdout: "", stderr: "" };
    };

    const input: PrePrPipelineInput = {
      workingDir: "/repo/.red/tmp/work-ship-abc",
      exec: trackingExec,
      layout: makeMockLayout(),
      now: () => Date.now(),
      wallClockBudgetMs: 5 * 60 * 1000,
    };

    await runPrePrPipeline(input);
    // The pipeline should never escape the worktree (all execs are -C <worktree>)
    // For now, the stub implementation doesn't run any execs, but the real one will.
  });

  it("applies mechanical findings (lint, format, docs) automatically", async () => {
    // When the pipeline detects mechanical findings (e.g. lint violations, formatting),
    // it should auto-apply them and commit.
    const input: PrePrPipelineInput = {
      workingDir: "/repo/.red/tmp/work-ship-abc",
      exec: makeMockExec({
        "pnpm -C /repo/.red/tmp/work-ship-abc lint": { code: 1, stdout: "", stderr: "lint errors" },
      }),
      layout: makeMockLayout(),
      now: () => Date.now(),
      wallClockBudgetMs: 5 * 60 * 1000,
    };

    // The implementation will be filled in the next step.
    const result = await runPrePrPipeline(input);
    // Eventually: expect(result.mechanicalApplied).toBeGreaterThan(0);
  });

  it("escalates intent findings (logic, type, semantics) for human decision", async () => {
    // When the pipeline detects intent-changing findings, it must stop and
    // escalate to the user for approve/fix/skip decision.
    const input: PrePrPipelineInput = {
      workingDir: "/repo/.red/tmp/work-ship-abc",
      exec: makeMockExec({}),
      layout: makeMockLayout(),
      now: () => Date.now(),
      wallClockBudgetMs: 5 * 60 * 1000,
    };

    // The implementation will be filled in the next step.
    const result = await runPrePrPipeline(input);
    // Eventually: expect(result.intentEscalated).toBeGreaterThan(0) when intent findings present
  });

  it("aborts when the wall-clock budget is exceeded", async () => {
    let callCount = 0;
    const slowExec: Exec = async () => {
      callCount++;
      return { code: 0, stdout: "", stderr: "" };
    };

    const startTime = Date.now();
    const input: PrePrPipelineInput = {
      workingDir: "/repo/.red/tmp/work-ship-abc",
      exec: slowExec,
      layout: makeMockLayout(),
      now: () => startTime + 10 * 60 * 1000, // 10 minutes elapsed
      wallClockBudgetMs: 5 * 60 * 1000, // 5 minute budget
    };

    // The implementation will check the budget and abort.
    const result = await runPrePrPipeline(input);
    // Eventually: expect(result.passed).toBe(false); expect(result.reason).toMatch(/budget|timeout/i);
  });
});

describe("isPrePrPipelineActive — /go pre-PR seam (#2211)", () => {
  it("active for /go --mode no-mistakes (lane:go + runMode=no-mistakes)", () => {
    expect(isPrePrPipelineActive("no-mistakes", LABEL_GO_LANE)).toBe(true);
  });

  it("inactive for /go default direct-PR (lane:go, runMode undefined)", () => {
    expect(isPrePrPipelineActive(undefined, LABEL_GO_LANE)).toBe(false);
  });

  it("inactive for /go --mode direct-PR (explicit)", () => {
    expect(isPrePrPipelineActive("direct-PR", LABEL_GO_LANE)).toBe(false);
  });

  it("inactive for /afk (no lane label — gates on review.enabled independently)", () => {
    expect(isPrePrPipelineActive(undefined, undefined)).toBe(false);
  });

  it("inactive when no-mistakes mode is set outside the /go lane", () => {
    expect(isPrePrPipelineActive("no-mistakes", undefined)).toBe(false);
  });
});
