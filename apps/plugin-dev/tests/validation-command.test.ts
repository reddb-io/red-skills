// validation-command.test.ts — the gate's command-composition layer (#3041).
//
// The incident this pins: worker wO0AR recorded
// `pnpm -C afk/3027-…/apps/plugin-dev typecheck` failing with exitCode 1 after 0 ms,
// which is a command that never ran being reported as the branch's validation
// verdict. Three claims are tested here, one per way that record lied.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  composeValidationCommand,
  isSuspectInfraFailure,
  recordedValidationCommand,
  renderValidationCommand,
  resolveValidationTarget,
  suspectInfraSummary,
  targetMissingSummary,
  SUITE_MIN_PLAUSIBLE_MS,
  SUSPECT_INFRA_MARKER,
  VALIDATION_TARGET_MISSING_MARKER,
} from "../src/core/validation-command.js";

/** Directory probe over a fixed set of existing dirs — no disk touched. */
function fakeDirs(dirs: readonly string[]): (dir: string) => boolean {
  const set = new Set(dirs.map((d) => resolve(d)));
  return (dir) => set.has(resolve(dir));
}

describe("target resolution", () => {
  it("anchors a relative checkout token to the root, never the process cwd", () => {
    const target = resolveValidationTarget(".red/tmp/worktrees/rebase/slug-0", {
      root: "/repo",
      kind: "checkout",
      isDirectory: fakeDirs(["/repo/.red/tmp/worktrees/rebase/slug-0"]),
    });

    expect(target.kind).toBe("checkout");
    expect(target.root).toBe(resolve("/repo/.red/tmp/worktrees/rebase/slug-0"));
    expect(target.missing).toBe(false);
  });

  it("normalises an absolute checkout token and keeps it absolute", () => {
    const target = resolveValidationTarget("/repo/./worktree", {
      root: "/repo",
      kind: "checkout",
      isDirectory: fakeDirs(["/repo/worktree"]),
    });

    expect(target.root).toBe(resolve("/repo/worktree"));
    expect(target.missing).toBe(false);
  });

  it("marks a DECLARED checkout whose directory is gone as missing", () => {
    const target = resolveValidationTarget("afk/3027-dispatch/worktree", {
      root: "/repo",
      kind: "checkout",
      isDirectory: fakeDirs([]),
    });

    expect(target.kind).toBe("checkout");
    expect(target.missing).toBe(true);
    expect(target.probed[0]).toBe(resolve("/repo/afk/3027-dispatch/worktree"));
    expect(targetMissingSummary(target)).toContain(VALIDATION_TARGET_MISSING_MARKER);
  });

  it("leaves a declared branch token verbatim and never calls it missing", () => {
    const target = resolveValidationTarget("afk/3027-dispatch-survives", {
      root: "/repo",
      kind: "branch",
      isDirectory: fakeDirs([]),
    });

    expect(target.kind).toBe("branch");
    expect(target.root).toBe("afk/3027-dispatch-survives");
    expect(target.missing).toBe(false);
  });

  it("without a probe, resolves a declared checkout absolutely but never calls it missing", () => {
    // No probe, no proof: the gate still fixes the record (absolute `-C`) but
    // makes no claim about a disk it was never given the means to read.
    const target = resolveValidationTarget(".red/tmp/worktrees/rebase/slug-0", {
      root: "/repo",
      kind: "checkout",
    });

    expect(target.kind).toBe("checkout");
    expect(target.root).toBe(resolve("/repo/.red/tmp/worktrees/rebase/slug-0"));
    expect(target.missing).toBe(false);
  });

  it("without a probe, an undeclared token stays a branch the executor materialises", () => {
    const target = resolveValidationTarget("afk/3027-dispatch", { root: "/repo" });

    expect(target.kind).toBe("branch");
    expect(target.root).toBe("afk/3027-dispatch");
  });

  it("auto-detection downgrades an unknown token to a branch rather than refusing", () => {
    // Absent a declaration there is no proof the token was meant to be a
    // directory — refusing here would refuse every AFK worker run.
    const target = resolveValidationTarget("afk/3027-dispatch", {
      root: "/repo",
      isDirectory: fakeDirs([]),
    });

    expect(target.kind).toBe("branch");
    expect(target.missing).toBe(false);
  });
});

describe("command composition", () => {
  it("records an ABSOLUTE -C path for every checkout scope", () => {
    const target = resolveValidationTarget("wt", {
      root: "/repo",
      kind: "checkout",
      isDirectory: fakeDirs(["/repo/wt"]),
    });

    const scoped = composeValidationCommand({ target, scope: "apps/plugin-dev", script: "typecheck" });
    const root = composeValidationCommand({ target, scope: ".", script: "test" });

    expect(scoped.dir).toBe(resolve("/repo/wt/apps/plugin-dev"));
    expect(scoped.args).toEqual(["pnpm", "-C", resolve("/repo/wt/apps/plugin-dev"), "typecheck"]);
    expect(scoped.command).toBe(`pnpm -C ${resolve("/repo/wt/apps/plugin-dev")} typecheck`);
    expect(root.dir).toBe(resolve("/repo/wt"));
  });

  it("appends quarantine excludes after `--` in both the argv and the record", () => {
    const target = resolveValidationTarget("wt", {
      root: "/repo",
      kind: "checkout",
      isDirectory: fakeDirs(["/repo/wt"]),
    });

    const composed = composeValidationCommand({
      target,
      scope: "apps/plugin-dev",
      script: "test",
      extraArgs: ["--exclude", "**/flaky.test.ts"],
    });

    expect(composed.args.slice(-3)).toEqual(["--", "--exclude", "**/flaky.test.ts"]);
    expect(composed.command).toContain("-- --exclude **/flaky.test.ts");
  });

  it("concatenates a branch token so the executor can peel the scope back off", () => {
    const target = resolveValidationTarget("afk/3027-dispatch", { root: "/repo", kind: "branch" });
    const composed = composeValidationCommand({ target, scope: "apps/plugin-dev", script: "typecheck" });

    expect(composed.dir).toBe("afk/3027-dispatch/apps/plugin-dev");
  });

  it("records the directory the executor really ran in, not the branch token", () => {
    const target = resolveValidationTarget("afk/3027-dispatch", { root: "/repo", kind: "branch" });
    const composed = composeValidationCommand({ target, scope: "apps/plugin-dev", script: "typecheck" });

    const recorded = recordedValidationCommand(
      composed,
      "typecheck",
      [],
      "/repo/.red/tmp/feedback/afk-3027-dispatch/apps/plugin-dev",
    );

    expect(recorded).toBe(
      "pnpm -C /repo/.red/tmp/feedback/afk-3027-dispatch/apps/plugin-dev typecheck",
    );
    // No rewrite reported → the composed command stands, unchanged.
    expect(recordedValidationCommand(composed, "typecheck", [])).toBe(composed.command);
  });

  it("renders the same shape whether the command is composed or re-rendered", () => {
    expect(renderValidationCommand("/repo/apps/plugin-dev", "lint")).toBe("pnpm -C /repo/apps/plugin-dev lint");
  });
});

describe("suspect-infra duration", () => {
  it("flags a sub-second FAILURE of a suite command", () => {
    expect(isSuspectInfraFailure({ status: "failed", durationMs: 0 })).toBe(true);
    expect(isSuspectInfraFailure({ status: "failed", durationMs: SUITE_MIN_PLAUSIBLE_MS - 1 })).toBe(true);
  });

  it("keeps fast compiler diagnostics on changed branch files as branch faults (#3648)", () => {
    expect(isSuspectInfraFailure({
      status: "failed",
      durationMs: 44,
      output: "apps/plugin-dev/src/render.ts(19,7): error TS2322: Type 'RemoteCounters' is not assignable",
      branchFiles: ["apps/plugin-dev/src/render.ts"],
    })).toBe(false);
    expect(isSuspectInfraFailure({
      status: "failed",
      durationMs: 44,
      output: "error[E0308]: mismatched types\n  --> crates/toon/src/parser.rs:19:7",
      branchFiles: ["crates/toon/src/parser.rs"],
    })).toBe(false);
  });

  it("lets structured branch evidence outrank a turbo-cached sub-second duration (#3773)", () => {
    expect(isSuspectInfraFailure({
      status: "failed",
      durationMs: 26,
      output: "apps/plugin-dev/src/runtime/wire/boot.ts(649,21): error TS2345: Argument is not assignable",
    })).toBe(false);
    expect(isSuspectInfraFailure({
      status: "failed",
      durationMs: 45,
      output: "file-size-guard: apps/plugin-dev/src/core/boot.ts grew from 1606 to 1633 lines",
    })).toBe(false);
  });

  it("may still classify an evidence-free sub-second failure as infrastructure (#3773)", () => {
    expect(isSuspectInfraFailure({
      status: "failed",
      durationMs: 26,
      output: "command exited non-zero",
    })).toBe(true);
  });

  it("leaves a plausible failure, a fast pass, and an unmeasured check alone", () => {
    expect(isSuspectInfraFailure({ status: "failed", durationMs: SUITE_MIN_PLAUSIBLE_MS })).toBe(false);
    expect(isSuspectInfraFailure({ status: "passed", durationMs: 3 })).toBe(false);
    expect(isSuspectInfraFailure({ status: "failed" })).toBe(false);
  });

  it("spells the evidence into the summary instead of leaving a duration to notice", () => {
    const summary = suspectInfraSummary({
      command: "pnpm -C /repo/apps/plugin-dev typecheck",
      exitCode: 1,
      durationMs: 1,
      summary: "command exited non-zero",
    });

    expect(summary).toContain(SUSPECT_INFRA_MARKER);
    expect(summary).toContain("exited 1 after 1ms");
    expect(summary).toContain("command exited non-zero");
  });
});
