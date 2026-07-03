import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  listStaleClaimDirs,
  listLegacyWorkDirs,
  tryAcquireClaimDir,
  listOrphanDirs,
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
      expect(stale).toEqual([{ path: dir }]);
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
      const stale = (await listStaleClaimDirs(root)).map((s) => s.path).sort();
      expect(stale).toEqual([noPid, blank].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tryAcquireClaimDir (#434 atomic claim)", () => {
  it("grants the claim once and writes the holder pid", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "430");
      expect(await tryAcquireClaimDir(dir, process.pid)).toBe(true);
      expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies a second claim on the same issue (EEXIST → false)", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "430");
      expect(await tryAcquireClaimDir(dir, process.pid)).toBe(true);
      expect(await tryAcquireClaimDir(dir, process.pid)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets exactly ONE of N concurrent claimers win the same issue (the dup-PR race)", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "936");
      const results = await Promise.all(
        Array.from({ length: 8 }, () => tryAcquireClaimDir(dir, process.pid)),
      );
      expect(results.filter((won) => won)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite the original holder's pid when a later claim loses", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "430");
      expect(await tryAcquireClaimDir(dir, process.pid)).toBe(true);
      expect(await tryAcquireClaimDir(dir, 9999)).toBe(false);
      expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-heals a stale existing claim before acquiring", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "431");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pid"), DEAD_PID);
      expect(await tryAcquireClaimDir(dir, process.pid)).toBe(true);
      expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets exactly ONE of N concurrent claimers win when RECLAIMING a stale dir (#568 recovery race)", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "568");
      // A crashed worker left a stale claim (dead pid). Several workers boot at
      // once and all observe the dead holder. The prior rm-then-mkdir reclaim was
      // a TOCTOU that let two of them both reclaim it (the #434 dup-PR race,
      // reopened on the recovery path); the atomic-rename reclaim lets exactly one
      // win even when every racer sees the same dead holder.
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pid"), DEAD_PID);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => tryAcquireClaimDir(dir, process.pid)),
      );
      expect(results.filter((won) => won)).toHaveLength(1);
      expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not remove a live existing claim while self-healing", async () => {
    const root = scratch();
    try {
      const dir = join(root, "claims", "432");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pid"), ALIVE_PID);
      expect(await tryAcquireClaimDir(dir, 4242)).toBe(false);
      expect(readFileSync(join(dir, "pid"), "utf8")).toBe(ALIVE_PID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines a poisoned non-directory claim path by replacing it", async () => {
    const root = scratch();
    try {
      const claims = join(root, "claims");
      mkdirSync(claims, { recursive: true });
      const dir = join(claims, "433");
      writeFileSync(dir, "not a claim directory");
      expect(await tryAcquireClaimDir(dir, process.pid)).toBe(true);
      expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
