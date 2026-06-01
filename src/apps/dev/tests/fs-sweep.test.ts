import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStaleClaimDirs, listLegacyWorkDirs } from "../src/runtime/fs.js";

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
