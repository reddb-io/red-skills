import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquire,
  pruneStale,
  release,
  WorktreeLockError,
  type LockData,
} from "./WorktreeLock.js";

const makeTmpDir = async (): Promise<string> => {
  const dir = join(
    tmpdir(),
    `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
};

describe("WorktreeLock", () => {
  it("acquire creates a lock file with correct JSON content", async () => {
    const lockDir = await makeTmpDir();
    try {
      await acquire(lockDir, "test-worktree", "my-branch");

      const lockPath = join(lockDir, "test-worktree.lock");
      expect(existsSync(lockPath)).toBe(true);

      const data: LockData = JSON.parse(await readFile(lockPath, "utf-8"));
      expect(data.pid).toBe(process.pid);
      expect(data.branch).toBe("my-branch");
      expect(data.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("release removes the lock file", async () => {
    const lockDir = await makeTmpDir();
    try {
      await acquire(lockDir, "test-worktree", "my-branch");
      await release(lockDir, "test-worktree");

      const lockPath = join(lockDir, "test-worktree.lock");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("release is idempotent when lock file does not exist", async () => {
    const lockDir = await makeTmpDir();
    try {
      await expect(
        release(lockDir, "no-such-worktree"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("acquire fails if lock file already exists (live PID)", async () => {
    const lockDir = await makeTmpDir();
    try {
      await acquire(lockDir, "test-worktree", "my-branch");
      await expect(
        acquire(lockDir, "test-worktree", "my-branch"),
      ).rejects.toThrow("Worktree is in use by process");
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("acquire creates the lockDir if it does not exist", async () => {
    const baseDir = await makeTmpDir();
    const lockDir = join(baseDir, "locks");
    try {
      await acquire(lockDir, "test-worktree", "my-branch");

      const lockPath = join(lockDir, "test-worktree.lock");
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("acquire throws WorktreeLockError with owning PID when lock held by live process", async () => {
    const lockDir = await makeTmpDir();
    try {
      // Manually write a lock file with the current process PID (which is alive)
      const lockPath = join(lockDir, "test-worktree.lock");
      const lockData: LockData = {
        pid: process.pid,
        branch: "feature-x",
        acquiredAt: "2026-01-15T10:00:00.000Z",
      };
      await writeFile(lockPath, JSON.stringify(lockData, null, 2));

      const err = await acquire(lockDir, "test-worktree", "other-branch").catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(WorktreeLockError);
      expect(err.message).toContain(`process ${process.pid}`);
      expect(err.message).toContain("feature-x");
      expect(err.owningPid).toBe(process.pid);
      expect(err.branch).toBe("feature-x");
      expect(err.timestamp).toBe("2026-01-15T10:00:00.000Z");
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("acquire recovers stale lock when owning PID is dead", async () => {
    const lockDir = await makeTmpDir();
    try {
      // Write a lock file with a PID that almost certainly doesn't exist
      const lockPath = join(lockDir, "test-worktree.lock");
      const staleLock: LockData = {
        pid: 999999999,
        branch: "stale-branch",
        acquiredAt: "2025-01-01T00:00:00.000Z",
      };
      await writeFile(lockPath, JSON.stringify(staleLock, null, 2));

      // acquire should succeed by removing the stale lock and re-acquiring
      await acquire(lockDir, "test-worktree", "new-branch");

      // Verify the new lock file has our PID
      const data: LockData = JSON.parse(await readFile(lockPath, "utf-8"));
      expect(data.pid).toBe(process.pid);
      expect(data.branch).toBe("new-branch");
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("two concurrent acquire() calls for the same name — exactly one succeeds", async () => {
    const lockDir = await makeTmpDir();
    try {
      const results = await Promise.allSettled([
        acquire(lockDir, "race-worktree", "branch-a"),
        acquire(lockDir, "race-worktree", "branch-b"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });
});

describe("WorktreeLock.pruneStale", () => {
  it("removes lock files whose worktree is not in the active set", async () => {
    const lockDir = await makeTmpDir();
    try {
      // Create a lock for a worktree that is NOT in the active set
      const lockPath = join(lockDir, "orphan-worktree.lock");
      const lockData: LockData = {
        pid: process.pid,
        branch: "orphan-branch",
        acquiredAt: new Date().toISOString(),
      };
      await writeFile(lockPath, JSON.stringify(lockData, null, 2));

      // Active set does NOT include "orphan-worktree"
      await pruneStale(lockDir, new Set(["other-worktree"]));

      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("removes lock files whose owning PID is dead", async () => {
    const lockDir = await makeTmpDir();
    try {
      const lockPath = join(lockDir, "dead-pid-worktree.lock");
      const lockData: LockData = {
        pid: 999999999, // PID that almost certainly doesn't exist
        branch: "some-branch",
        acquiredAt: "2025-01-01T00:00:00.000Z",
      };
      await writeFile(lockPath, JSON.stringify(lockData, null, 2));

      // Worktree IS in the active set, but owning PID is dead
      await pruneStale(lockDir, new Set(["dead-pid-worktree"]));

      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("preserves lock files for live processes with active worktrees", async () => {
    const lockDir = await makeTmpDir();
    try {
      const lockPath = join(lockDir, "live-worktree.lock");
      const lockData: LockData = {
        pid: process.pid, // Current process — definitely alive
        branch: "active-branch",
        acquiredAt: new Date().toISOString(),
      };
      await writeFile(lockPath, JSON.stringify(lockData, null, 2));

      // Worktree IS in the active set and PID is alive
      await pruneStale(lockDir, new Set(["live-worktree"]));

      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  });

  it("handles missing lock directory gracefully", async () => {
    // Pass a path that does not exist
    await expect(
      pruneStale("/tmp/nonexistent-lock-dir-" + Date.now(), new Set()),
    ).resolves.toBeUndefined();
  });
});
