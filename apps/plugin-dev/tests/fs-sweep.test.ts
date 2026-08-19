import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  listStaleClaimDirs,
  listLegacyWorkDirs,
  listOrphanDirs,
  removeDir,
  reapDeadEmptyWorkerShells,
} from "../src/runtime/fs.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-sweep-"));
}

/** A pid that is virtually certain to be dead. */
const DEAD_PID = "999999";
/** This test process — guaranteed alive. */
const ALIVE_PID = String(process.pid);

describe("listStaleClaimDirs", () => {
  it("returns [] when there is no claims dir", async () => {
    const root = scratch();
    try {
      expect(await listStaleClaimDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reclaims a claim whose recorded pid is dead", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "7");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pid"), DEAD_PID);
      const stale = await listStaleClaimDirs(root);
      expect(stale).toEqual([{ path: dir, issue: 7 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spares a claim whose recorded pid is alive", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "8");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pid"), ALIVE_PID);
      expect(await listStaleClaimDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing/blank pid file as stale", async () => {
    const root = scratch();
    try {
      const noPid = join(root, "claims", "11"); // no pid file at all
      const blank = join(root, "claims", "12");
      mkdirSync(noPid, { recursive: true });
      mkdirSync(blank, { recursive: true });
      writeFileSync(join(blank, "pid"), "   ");
      const stale = (await listStaleClaimDirs(root)).sort((a, b) => a.path.localeCompare(b.path));
      expect(stale).toEqual([
        { path: noPid, issue: 11 },
        { path: blank, issue: 12 },
      ].sort((a, b) => a.path.localeCompare(b.path)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removeDir sweep guard (#1928)", () => {
  it("refuses to remove the .red/tmp root", async () => {
    const root = scratch();
    try {
      const tmpRoot = join(root, ".red", "tmp");
      mkdirSync(tmpRoot, { recursive: true });

      await expect(removeDir(tmpRoot)).rejects.toThrow("refusing to remove .red/tmp root");
      expect(existsSync(tmpRoot)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to remove a live supervisor anchor", async () => {
    const root = scratch();
    try {
      const supervisorDir = join(root, ".red", "tmp", "supervisors", "default");
      mkdirSync(supervisorDir, { recursive: true });
      writeFileSync(join(supervisorDir, "afk-supervisor.pid"), ALIVE_PID);
      const log = join(supervisorDir, "supervisor.log.toonl");
      writeFileSync(log, "live\n");

      await expect(removeDir(log)).rejects.toThrow("refusing to remove live supervisor artifact");
      expect(readFileSync(log, "utf8")).toBe("live\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to remove a live worker anchor", async () => {
    const root = scratch();
    try {
      const worker = join(root, ".red", "tmp", "workers", "wLIVE");
      mkdirSync(worker, { recursive: true });
      const pidFile = join(worker, "worker.pid");
      writeFileSync(pidFile, ALIVE_PID);

      await expect(removeDir(pidFile)).rejects.toThrow("refusing to remove live worker artifact");
      expect(readFileSync(pidFile, "utf8")).toBe(ALIVE_PID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The atomic claim/steal semantics (#434, #568) now live in the ONE lease
// implementation in castle (`createFsIssueLeaseStore`, #2578); their unit
// coverage moved to packages/worker/src/engine/tracker/claim.test.ts. This
// suite keeps the sweep-reader coverage that consumes the `pid` file the lease
// writes (`listStaleClaimDirs` above).

describe("listLegacyWorkDirs", () => {
  it("returns [] when the tmp dir is missing", async () => {
    expect(await listLegacyWorkDirs(join(tmpdir(), "does-not-exist-afk-xyz"))).toEqual([]);
  });

  it("wipes a dead-orchestrator work-NNN relic and ignores other entries", async () => {
    const root = scratch();
    try {
      const dead = join(root, "work-1234");
      mkdirSync(dead, { recursive: true });
      writeFileSync(join(dead, "afk.pid"), DEAD_PID);
      // a non-work entry and the nested workers root must be ignored
      mkdirSync(join(root, "workers"), { recursive: true });
      mkdirSync(join(root, "claims"), { recursive: true });
      const dirs = await listLegacyWorkDirs(root);
      expect(dirs).toEqual([dead]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spares a live-orchestrator work-NNN relic", async () => {
    const root = scratch();
    try {
      const live = join(root, "work-5678");
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, "afk.pid"), ALIVE_PID);
      expect(await listLegacyWorkDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1052: the pre-cutover relics were `work-<issue-number>` dirs the AFK
  // orchestrator itself created, marked by an `afk.pid` sentinel. A maintainer
  // hand-work worktree under `.red/tmp/work-<slug>` is NOT AFK-owned — it never
  // carries an afk.pid — and must be untouchable by the boot sweep.
  it("spares a maintainer work-<slug> worktree with no afk.pid (with or without commits)", async () => {
    const root = scratch();
    try {
      // fresh, zero commits — just the worktree dir
      const fresh = join(root, "work-afk-first-doctrine");
      mkdirSync(fresh, { recursive: true });
      // one with WIP files present (simulating committed/uncommitted content)
      const withWip = join(root, "work-statusline-fix");
      mkdirSync(withWip, { recursive: true });
      writeFileSync(join(withWip, "README.md"), "wip");
      expect(await listLegacyWorkDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spares a work-<slug> dir even when it carries an afk.pid file", async () => {
    // Belt-and-braces: the name must ALSO look like a relic. A slug-named dir is
    // never an AFK relic regardless of stray sentinel files.
    const root = scratch();
    try {
      const slug = join(root, "work-afk-first-doctrine");
      mkdirSync(slug, { recursive: true });
      writeFileSync(join(slug, "afk.pid"), DEAD_PID);
      expect(await listLegacyWorkDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spares a work-NNN relic with no afk.pid — absent sentinel means not AFK-owned", async () => {
    const root = scratch();
    try {
      const noSentinel = join(root, "work-4321");
      mkdirSync(noSentinel, { recursive: true });
      expect(await listLegacyWorkDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("listOrphanDirs (#444 — skip live siblings)", () => {
  it("returns a dead worker's attempt dir as an orphan", async () => {
    const root = scratch();
    try {
      const att = join(root, "wDEAD", "190-a1");
      mkdirSync(att, { recursive: true });
      writeFileSync(join(root, "wDEAD", "worker.pid"), DEAD_PID);
      const orphans = await listOrphanDirs(root, Math.floor(Date.now() / 1000));
      expect(orphans.map((o) => o.path)).toEqual([att]);
      expect(orphans[0]!.issue).toBe(190);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a worker with no worker.pid as dead (its attempts are orphans)", async () => {
    const root = scratch();
    try {
      const att = join(root, "wNOPID", "7-a1");
      mkdirSync(att, { recursive: true });
      const orphans = await listOrphanDirs(root, Math.floor(Date.now() / 1000));
      expect(orphans.map((o) => o.path)).toEqual([att]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SKIPS a LIVE worker's attempt dirs — never reaps a live sibling", async () => {
    const root = scratch();
    try {
      const live = join(root, "wLIVE", "363-a1");
      mkdirSync(live, { recursive: true });
      writeFileSync(join(root, "wLIVE", "worker.pid"), ALIVE_PID);
      // a dead sibling alongside the live one is still collected
      const dead = join(root, "wDEAD", "9-a1");
      mkdirSync(dead, { recursive: true });
      writeFileSync(join(root, "wDEAD", "worker.pid"), DEAD_PID);
      const orphans = await listOrphanDirs(root, Math.floor(Date.now() / 1000));
      expect(orphans.map((o) => o.path)).toEqual([dead]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reapDeadEmptyWorkerShells (#1355)", () => {
  it("removes dead empty worker shells across every worker namespace", async () => {
    const root = scratch();
    try {
      for (const ns of ["workers", "go-workers", "scout-workers"]) {
        const worker = join(root, ns, `w-${ns}`);
        mkdirSync(worker, { recursive: true });
        writeFileSync(join(worker, "worker.pid"), DEAD_PID);
      }

      const result = await reapDeadEmptyWorkerShells(root);

      expect(result.workerDirs.sort()).toEqual([
        join(root, "go-workers", "w-go-workers"),
        join(root, "scout-workers", "w-scout-workers"),
        join(root, "workers", "w-workers"),
      ].sort());
      expect(existsSync(join(root, "workers", "w-workers"))).toBe(false);
      expect(existsSync(join(root, "go-workers", "w-go-workers"))).toBe(false);
      expect(existsSync(join(root, "scout-workers", "w-scout-workers"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spares a live worker shell", async () => {
    const root = scratch();
    try {
      const worker = join(root, "workers", "wLIVE");
      mkdirSync(worker, { recursive: true });
      writeFileSync(join(worker, "worker.pid"), ALIVE_PID);

      expect(await reapDeadEmptyWorkerShells(root)).toEqual({
        workerDirs: [],
        workerPidFiles: [],
        emptyAttemptDirs: [],
      });
      expect(readFileSync(join(worker, "worker.pid"), "utf8")).toBe(ALIVE_PID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only empty attempt dirs and preserves non-empty attempt evidence", async () => {
    const root = scratch();
    try {
      const emptyWorker = join(root, "go-workers", "wEMPTYATT");
      mkdirSync(join(emptyWorker, "12-a1"), { recursive: true });
      writeFileSync(join(emptyWorker, "worker.pid"), "corrupt");

      const preservedWorker = join(root, "scout-workers", "wPRESERVE");
      const preservedAttempt = join(preservedWorker, "13-a1");
      mkdirSync(preservedAttempt, { recursive: true });
      writeFileSync(join(preservedAttempt, "agent.log.toonl"), "blocked evidence");
      writeFileSync(join(preservedWorker, "worker.pid"), DEAD_PID);

      const result = await reapDeadEmptyWorkerShells(root);

      expect(result.workerDirs).toEqual([emptyWorker]);
      expect(result.emptyAttemptDirs).toEqual([join(emptyWorker, "12-a1")]);
      expect(existsSync(emptyWorker)).toBe(false);
      expect(readdirSync(preservedAttempt)).toEqual(["agent.log.toonl"]);
      expect(readFileSync(join(preservedWorker, "worker.pid"), "utf8")).toBe(DEAD_PID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
