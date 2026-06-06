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

  it("wipes a dead-orchestrator work-* dir and ignores other entries", async () => {
    const root = scratch();
    try {
      const dead = join(root, "work-aaaa");
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

  it("spares a live-orchestrator work-* dir", async () => {
    const root = scratch();
    try {
      const live = join(root, "work-bbbb");
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, "afk.pid"), ALIVE_PID);
      expect(await listLegacyWorkDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wipes a work-* dir with no pid file", async () => {
    const root = scratch();
    try {
      const orphan = join(root, "work-cccc");
      mkdirSync(orphan, { recursive: true });
      expect(await listLegacyWorkDirs(root)).toEqual([orphan]);
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
