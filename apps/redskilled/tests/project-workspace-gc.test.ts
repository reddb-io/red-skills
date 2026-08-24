// Every ACP bind of a repository-less directory mints a `local:<pathhash>`
// project and clones it into the daemon home — and nothing ever swept those
// clones: a test suite driving the real daemon from throwaway /tmp fixtures
// left ~38 permanent orphans pointing at deleted paths. The sweep judges by
// the one piece of evidence a seed clone carries — its origin IS the original
// checkout path — and keeps everything it cannot prove orphaned.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { sweepOrphanedLocalProjects } from "../src/project-workspace-gc.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-project-gc-"));
  roots.push(root);
  return root;
}

async function localProject(root: string, name: string, origin: string): Promise<string> {
  const dir = join(root, name);
  const workspace = join(dir, "workspace");
  await mkdir(workspace, { recursive: true });
  await run("git", ["-C", workspace, "init", "--quiet"]);
  await run("git", ["-C", workspace, "remote", "add", "origin", origin]);
  // Old enough to be past the mid-seed grace window.
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  await utimes(dir, old, old);
  return dir;
}

describe("sweeping orphaned local project workspaces", () => {
  it("reclaims a local project whose seeding checkout is gone, and only for real off dry-run", async () => {
    const root = await scratch();
    const goneCheckout = join(root, "was-a-fixture");
    const dir = await localProject(root, "local-aaaa1111-bbbb2222", goneCheckout);

    const dry = await sweepOrphanedLocalProjects(root, { dryRun: true });
    expect(dry.entries).toEqual([
      { dir, verdict: "reclaimed", reason: expect.stringContaining("no longer exists") },
    ]);
    expect(existsSync(dir)).toBe(true);

    const real = await sweepOrphanedLocalProjects(root, { dryRun: false });
    expect(real.reclaimed).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps a project whose checkout still exists, a remote-seeded one, and a live one", async () => {
    const root = await scratch();
    const livingCheckout = join(root, "still-here");
    await mkdir(livingCheckout, { recursive: true });
    await localProject(root, "local-cccc3333-dddd4444", livingCheckout);
    await localProject(root, "local-eeee5555-ffff6666", "https://github.com/reddb-io/red-skills.git");
    const claimed = await localProject(root, "local-9999aaaa-bbbbcccc", join(root, "gone"));

    const report = await sweepOrphanedLocalProjects(root, {
      dryRun: false,
      liveProjectDirNames: new Set(["local-9999aaaa-bbbbcccc"]),
    });

    expect(report.reclaimed).toBe(0);
    expect(report.entries.map((entry) => entry.verdict)).toEqual(["kept", "kept", "kept"]);
    expect(existsSync(claimed)).toBe(true);
  });

  it("never touches github or remote project directories, and keeps the young and the unreadable", async () => {
    const root = await scratch();
    await mkdir(join(root, "github-1240684599-268fd370", "workspace"), { recursive: true });
    await mkdir(join(root, "remote-reddb-io-red-skills-25a3bfdc", "workspace"), { recursive: true });
    const young = join(root, "local-1234abcd-5678efgh");
    await mkdir(join(young, "workspace"), { recursive: true });
    const originless = join(root, "local-aaaabbbb-ccccdddd");
    await mkdir(originless, { recursive: true });
    await writeFile(join(originless, "note"), "no workspace at all");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(originless, old, old);

    const report = await sweepOrphanedLocalProjects(root, { dryRun: false });

    expect(report.scanned).toBe(2);
    expect(report.entries.map((entry) => [entry.dir.split("/").pop(), entry.verdict])).toEqual([
      ["local-1234abcd-5678efgh", "young"],
      ["local-aaaabbbb-ccccdddd", "kept"],
    ]);
    expect(existsSync(join(root, "github-1240684599-268fd370"))).toBe(true);
    expect(existsSync(join(root, "remote-reddb-io-red-skills-25a3bfdc"))).toBe(true);
  });
});
