// A host that already accumulated dead sessions, cleared without hand-deleting
// paths (#2884).
//
// The sweep's whole value is that an operator can trust it mid-diagnosis, so the
// assertions are about what it REFUSES to take as much as what it removes: a
// live lease, another tool's directory under the same shared parent, and a
// directory too young to have won its lease yet all survive.
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encode } from "@reddb-io/toon";
import { runReclaim } from "../src/cli.js";
import {
  reclaimRedskilledRuntimeDirs,
  redskilledRuntimeRoots,
} from "../src/reclaim.js";

const roots: string[] = [];
const NOW = Date.parse("2026-07-30T12:00:00.000Z");

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function runtimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-reclaim-"));
  roots.push(root);
  return root;
}

/** One runtime directory holding a lease that names `pid`. */
async function session(root: string, name: string, pid: number | null): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "redskilled.sock"), "", "utf8");
  if (pid !== null) {
    await writeFile(
      join(dir, "redskilled.lease.toon"),
      `${encode({
        version: 1,
        pid,
        start_time: "2026-07-30T11:00:00.000Z",
        session_key_hash: "aaaaaaaaaaaa",
        machine_id_hash: "bbbbbbbbbbbb",
        socket_path: join(dir, "redskilled.sock"),
        acquired_at: "2026-07-30T11:00:00.000Z",
        renewed_at: "2026-07-30T11:30:00.000Z",
      })}\n`,
      "utf8",
    );
  }
  return dir;
}

/** Age a directory past the grace window by moving its mtime back. */
async function age(dir: string, ms: number): Promise<void> {
  const when = new Date(NOW - ms);
  const current = await stat(dir);
  await utimes(dir, current.atime, when);
}

function sweep(root: string, overrides: Record<string, unknown> = {}) {
  return reclaimRedskilledRuntimeDirs({
    roots: [root],
    now: () => NOW,
    // Only the pids this test names are alive; the OS's real table would make
    // the outcome depend on whatever else the machine is running.
    isPidAlive: (pid) => pid === 1234,
    answers: async () => false,
    ...overrides,
  });
}

describe("reclaiming dead session runtime directories", () => {
  it("removes a directory whose lease names a dead pid, and reports what went", async () => {
    const root = await runtimeRoot();
    const dead = await session(root, "deadbeef", 999_001);

    const report = await sweep(root);

    expect(report.reclaimed).toBe(1);
    const entry = report.entries.find((row) => row.dir === dead);
    expect(entry?.verdict).toBe("reclaimed");
    expect(entry?.reason).toContain("999001");
    expect(entry?.reason).toContain("dead");
    // Named, not counted: the operator must be able to see the lease and the
    // socket left with it rather than trust a number.
    expect(entry?.removed).toEqual(["redskilled.lease.toon", "redskilled.sock"]);
    expect(existsSync(dead)).toBe(false);
  });

  it("keeps a directory whose lease names a live pid", async () => {
    const root = await runtimeRoot();
    const live = await session(root, "livelease", 1234);

    const report = await sweep(root);

    expect(report.reclaimed).toBe(0);
    expect(report.entries.find((row) => row.dir === live)?.verdict).toBe("live");
    expect(existsSync(live)).toBe(true);
  });

  it("keeps another tool's directory sharing the same runtime parent", async () => {
    // `rsp`'s resident sockets land under the same `red-skills/` parent, one
    // hashed directory per scope. A sweep that deleted by location would take a
    // live socket belonging to a different tool.
    const root = await runtimeRoot();
    const foreign = join(root, "rsp-resident");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "rsp.sock"), "", "utf8");
    await age(foreign, 60 * 60_000);

    const report = await sweep(root);

    expect(report.entries.find((row) => row.dir === foreign)?.verdict).toBe("foreign");
    expect(existsSync(foreign)).toBe(true);
  });

  it("keeps a lease-less directory that is still young, and takes it once stale", async () => {
    // A daemon mid-spawn has made its directory but not yet won its lease.
    const root = await runtimeRoot();
    const young = await session(root, "midspawn", null);

    const first = await sweep(root);
    expect(first.entries.find((row) => row.dir === young)?.verdict).toBe("young");
    expect(existsSync(young)).toBe(true);

    await age(young, 60 * 60_000);
    const second = await sweep(root);
    expect(second.entries.find((row) => row.dir === young)?.verdict).toBe("reclaimed");
    expect(existsSync(young)).toBe(false);
  });

  it("keeps a lease-less directory whose socket still answers", async () => {
    const root = await runtimeRoot();
    const answering = await session(root, "answering", null);
    await age(answering, 60 * 60_000);

    const report = await sweep(root, { answers: async () => true });

    expect(report.entries.find((row) => row.dir === answering)?.verdict).toBe("live");
    expect(existsSync(answering)).toBe(true);
  });

  it("removes the empty directories a start that never got anywhere left behind", async () => {
    const root = await runtimeRoot();
    const empty = join(root, "emptyshell");
    await mkdir(empty, { recursive: true });
    await age(empty, 60 * 60_000);

    const report = await sweep(root);

    expect(report.entries.find((row) => row.dir === empty)?.reason).toContain("empty");
    expect(existsSync(empty)).toBe(false);
  });

  it("removes nothing on a dry run, and still says what it would take", async () => {
    const root = await runtimeRoot();
    const dead = await session(root, "deadbeef", 999_001);

    const report = await sweep(root, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.reclaimed).toBe(1);
    expect(report.entries.find((row) => row.dir === dead)?.reason).toContain("dry run");
    expect(existsSync(dead)).toBe(true);
  });

  it("reads a missing root as a host that never littered", async () => {
    const report = await reclaimRedskilledRuntimeDirs({
      roots: [join(tmpdir(), "redskilled-reclaim-absent-root")],
    });
    expect(report.scanned).toBe(0);
    expect(report.reclaimed).toBe(0);
  });
});

describe("the roots a sweep looks in", () => {
  it("covers both the XDG parent and the tmpdir fallback", () => {
    const found = redskilledRuntimeRoots({ env: { XDG_RUNTIME_DIR: "/run/user/4242" }, uid: 4242 });
    expect(found).toContain("/run/user/4242/red-skills");
    expect(found).toContain(join(tmpdir(), "red-skills-4242"));
  });

  it("does not repeat a root when there is no XDG runtime dir", () => {
    const found = redskilledRuntimeRoots({ env: {}, uid: 4242 });
    expect(found).toEqual([join(tmpdir(), "red-skills-4242")]);
  });
});

describe("`redskilled reclaim`", () => {
  it("prints the sweep as TOON and exits 0", async () => {
    const root = await runtimeRoot();
    await session(root, "deadbeef", 999_001);
    let out = "";

    const code = await runReclaim([], {
      write: (text) => {
        out += text;
      },
      options: { roots: [root], now: () => NOW, isPidAlive: () => false, answers: async () => false },
    });

    expect(code).toBe(0);
    expect(out).toContain("reclaimed");
    expect(out).toContain("deadbeef");
  });

  it("honours `--dry-run`", async () => {
    const root = await runtimeRoot();
    const dead = await session(root, "deadbeef", 999_001);
    let out = "";

    await runReclaim(["--dry-run"], {
      write: (text) => {
        out += text;
      },
      options: { roots: [root], now: () => NOW, isPidAlive: () => false, answers: async () => false },
    });

    expect(out).toContain("dry run");
    expect(existsSync(dead)).toBe(true);
  });
});
