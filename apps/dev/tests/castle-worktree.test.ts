import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { castleWorktreeUnder, readCapturedWorktreePath } from "../src/commands/run.js";
import { buildWorktreePathCaptureHook } from "../src/core/execution/host-hooks.js";

// Guards the loc/vitals fix: red-castle worktrees are mirror-owned and never
// appear in the primary's `git worktree list`, so the heartbeat must resolve
// them from the on-disk layout `{attemptDir}/.red-castle/worktrees/{slug}` or it
// falls back to the dead legacy `{attemptDir}/worktree` and reports `+0 -0`.
describe("castleWorktreeUnder", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "castle-wt-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when there is no .red-castle/worktrees tree", () => {
    expect(castleWorktreeUnder(root)).toBeUndefined();
  });

  it("resolves the .git-bearing worktree under .red-castle/worktrees", () => {
    const wt = join(root, ".red-castle", "worktrees", "afk-wABCD-42-some-slug");
    mkdirSync(wt, { recursive: true });
    // A linked worktree's `.git` is a file (a gitdir pointer), not a directory.
    writeFileSync(join(wt, ".git"), "gitdir: /mirror/.git/worktrees/afk-wABCD-42-some-slug\n");
    expect(castleWorktreeUnder(root)).toBe(wt);
  });

  it("returns undefined (never the dead legacy path) when no child carries a .git", () => {
    mkdirSync(join(root, ".red-castle", "worktrees", "stray"), { recursive: true });
    expect(castleWorktreeUnder(root)).toBeUndefined();
  });
});

// The castle publishes its own worktree path via an onWorktreeReady host hook
// (ADR 0103): it runs ON THE HOST with cwd = the real worktree, so its `pwd`
// lands in `{attemptDir}/.worktree-path`. The heartbeat reads that first, which
// sidesteps reconstructing the mirror-owned worktree from disk entirely.
describe("readCapturedWorktreePath", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "captured-wt-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the recorded absolute path, trimmed of the hook's trailing newline", () => {
    const wt = "/mirror/.red-castle/worktrees/afk-wABCD-42-slug";
    writeFileSync(join(root, ".worktree-path"), `${wt}\n`);
    expect(readCapturedWorktreePath(root)).toBe(wt);
  });

  it("returns undefined when no .worktree-path has been published", () => {
    expect(readCapturedWorktreePath(root)).toBeUndefined();
  });

  it("returns undefined when the capture file is present but empty", () => {
    writeFileSync(join(root, ".worktree-path"), "   \n");
    expect(readCapturedWorktreePath(root)).toBeUndefined();
  });

  // Round-trip: run the REAL capture hook in a real castle-shaped worktree, then
  // read it back. `onWorktreeReady` runs with cwd = the worktree three levels
  // below the attempt dir ({attemptDir}/.red-castle/worktrees/{slug}), so the
  // hook's `pwd > ../../../.worktree-path` must land the path in the attempt dir.
  it("round-trips the hook's pwd back through readCapturedWorktreePath", () => {
    const wt = join(root, ".red-castle", "worktrees", "afk-wABCD-42-slug");
    mkdirSync(wt, { recursive: true });
    execFileSync("sh", ["-c", buildWorktreePathCaptureHook().command], { cwd: wt, stdio: "ignore" });
    const captured = readCapturedWorktreePath(root);
    expect(captured).toBeDefined();
    expect(captured?.endsWith(join(".red-castle", "worktrees", "afk-wABCD-42-slug"))).toBe(true);
  });
});
