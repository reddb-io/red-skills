import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { castleWorktreeUnder } from "../src/commands/run.js";

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
