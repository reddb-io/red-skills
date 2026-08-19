import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parkedSlotWorkFor,
  reapableWorktreeUnder,
} from "../src/runtime/supervisor-fs.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-sup-fs-"));
}

// ---------- parseWorkerIdsFromLog ----------

describe("reapableWorktreeUnder", () => {
  it("resolves the conventional worktree directly inside the worker workspace", () => {
    const tmp = scratch();
    try {
      const workspace = join(tmp, "workers", "wFLAT", "42");
      const worktree = join(workspace, "worktree");
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, ".git"), "gitdir: /repo/.git/worktrees/flat\n");
      expect(reapableWorktreeUnder(workspace)).toBe(worktree);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps legacy castle-branded worktrees visible to hygiene reaps", () => {
    const tmp = scratch();
    try {
      const workspace = join(tmp, "workers", "wOLD1", "42");
      const worktree = join(workspace, ".red-castle", "worktrees", "afk-wOLD1-42-old");
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, ".git"), "gitdir: /repo/.git/worktrees/old\n");
      expect(reapableWorktreeUnder(workspace)).toBe(worktree);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("colocates the worktree so one workspace removal removes it", () => {
    const tmp = scratch();
    const workspace = join(tmp, "workers", "wFLAT", "43");
    const worktree = join(workspace, "worktree");
    mkdirSync(worktree, { recursive: true });

    rmSync(workspace, { recursive: true, force: true });

    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------- parkedSlotWorkFor — the REAL path exercised end-to-end ----------
