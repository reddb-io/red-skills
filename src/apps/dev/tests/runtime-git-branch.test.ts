import { describe, expect, it } from "vitest";
import { branchExists, fetchBranch, changedFiles } from "../src/runtime/git.js";
import type { GitContext } from "../src/runtime/git.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

// A recording exec fake: each call is logged as `argv`, and the response is
// keyed by a matcher so a missing branch can return code 1 (rev-parse --verify
// --quiet semantics) while a present branch returns code 0.
function recordingExec(
  responder: (cmd: string, args: readonly string[]) => ExecOutput,
): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return responder(cmd, args);
  };
  return { exec, calls };
}

const ok = (stdout = ""): ExecOutput => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1): ExecOutput => ({ code, stdout: "", stderr: "" });

describe("branchExists (FIX E)", () => {
  it("returns true when rev-parse --verify finds the local ref", async () => {
    const { exec, calls } = recordingExec(() => ok("deadbee\n"));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await branchExists(ctx, "afk/w/1-x")).toBe(true);
    expect(calls[0]).toEqual(["git", "rev-parse", "--verify", "--quiet", "refs/heads/afk/w/1-x"]);
  });

  it("returns false when the ref is absent (rev-parse exits non-zero)", async () => {
    const { exec } = recordingExec(() => fail());
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await branchExists(ctx, "afk/w/1-missing")).toBe(false);
  });

  it("returns false for an empty branch name without spawning git", async () => {
    const { exec, calls } = recordingExec(() => ok());
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await branchExists(ctx, "")).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("fetchBranch (FIX E recovery)", () => {
  it("issues a best-effort git fetch origin <branch>", async () => {
    const { exec, calls } = recordingExec(() => ok());
    const ctx: GitContext = { cwd: "/repo", exec };
    await fetchBranch(ctx, "afk/w/1-x");
    expect(calls[0]).toEqual(["git", "fetch", "origin", "afk/w/1-x"]);
  });

  it("no-ops for an empty branch name", async () => {
    const { exec, calls } = recordingExec(() => ok());
    const ctx: GitContext = { cwd: "/repo", exec };
    await fetchBranch(ctx, "");
    expect(calls).toEqual([]);
  });
});

describe("changedFiles — the silent-empty hazard FIX E guards against", () => {
  it("returns [] (code 0) for a three-dot diff against a MISSING branch — the bypass risk", async () => {
    // git diff base...branch against a non-existent branch returns empty, code 0.
    // This is exactly why a presence check must precede the feedback gate.
    const { exec } = recordingExec((_c, args) => (args.includes("diff") ? ok("") : ok()));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await changedFiles(ctx, "afk/w/1-missing", "main")).toEqual([]);
  });

  it("parses the changed-file list for a real diff", async () => {
    const { exec } = recordingExec(() => ok("packages/x/src/a.ts\npackages/y/b.ts\n"));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await changedFiles(ctx, "afk/w/1-x", "main")).toEqual([
      "packages/x/src/a.ts",
      "packages/y/b.ts",
    ]);
  });
});
