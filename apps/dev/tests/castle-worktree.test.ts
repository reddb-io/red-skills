import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { castleWorktreeUnder, readCapturedWorktreePath } from "../src/commands/run.js";
import { buildWorktreePathCaptureHook } from "../src/core/execution/host-hooks.js";

// Guards the loc/vitals reader: worker worktrees are mirror-owned and never
// appear in the primary's `git worktree list`, so the heartbeat resolves the
// conventional `{workerWorkspace}/worktree` path directly.
describe("castleWorktreeUnder", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "castle-wt-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when there is no conventional worktree", () => {
    expect(castleWorktreeUnder(root)).toBeUndefined();
  });

  it("resolves the .git-bearing conventional worktree", () => {
    const wt = join(root, "worktree");
    mkdirSync(wt, { recursive: true });
    // A linked worktree's `.git` is a file (a gitdir pointer), not a directory.
    writeFileSync(join(wt, ".git"), "gitdir: /mirror/.git/worktrees/afk-wABCD-42-some-slug\n");
    expect(castleWorktreeUnder(root)).toBe(wt);
  });

  it("does not treat castle-branded nested worktrees as a current reader path", () => {
    const legacy = join(root, ".red-castle", "worktrees", "afk-wABCD-42-some-slug");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, ".git"), "gitdir: /mirror/.git/worktrees/legacy\n");
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
    const wt = join(root, "worktree");
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

  it("rejects a captured castle-branded nested path outside hygiene", () => {
    const legacy = join(root, ".red-castle", "worktrees", "afk-wABCD-42-old");
    writeFileSync(join(root, ".worktree-path"), `${legacy}\n`);
    expect(readCapturedWorktreePath(root)).toBeUndefined();
  });

  // Round-trip: `onWorktreeReady` runs with cwd = the conventional direct child,
  // so the hook's `pwd > ../.worktree-path` lands in the worker workspace.
  it("round-trips the hook's pwd back through readCapturedWorktreePath", () => {
    const wt = join(root, "worktree");
    mkdirSync(wt, { recursive: true });
    execFileSync("sh", ["-c", buildWorktreePathCaptureHook().command], { cwd: wt, stdio: "ignore" });
    const captured = readCapturedWorktreePath(root);
    expect(captured).toBeDefined();
    expect(captured?.endsWith("worktree")).toBe(true);
  });
});
