// project-workspace-gc — reclaim `local-*` project workspaces whose seeding
// checkout no longer exists.
//
// Every ACP bind of a repository-less directory mints a `local:<pathhash>`
// project and clones the directory into the daemon home — and nothing ever
// swept those clones: a test suite driving the real daemon from throwaway
// `/tmp` fixtures left ~38 permanent orphans pointing at deleted paths. The
// sweep follows reclaim's philosophy: report-first (dry-run by default), judge
// by evidence (the seed clone's origin IS the original checkout path), and
// never touch what still might be wanted — `github-*`/`remote-*` directories
// are not its business, a young directory may be mid-seed, and a project with
// live drain intent is kept whatever its origin says.
import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;

/** A local workspace younger than this may still be mid-seed; kept. */
export const LOCAL_PROJECT_GC_GRACE_MS = 60 * 60_000;

export type LocalProjectGcVerdict = "reclaimed" | "kept" | "young" | "failed";

export interface LocalProjectGcEntry {
  readonly dir: string;
  readonly verdict: LocalProjectGcVerdict;
  readonly reason: string;
}

export interface LocalProjectGcReport {
  readonly root: string;
  readonly scanned: number;
  readonly reclaimed: number;
  readonly dryRun: boolean;
  readonly entries: readonly LocalProjectGcEntry[];
}

export interface SweepOrphanedLocalProjectsOptions {
  readonly dryRun?: boolean;
  readonly graceMs?: number;
  readonly now?: () => number;
  /** Project ids holding live control intent; their workspaces are kept. */
  readonly liveProjectDirNames?: ReadonlySet<string>;
}

/** Sweep `local-*` workspaces whose seeding checkout is gone. Never throws. */
export async function sweepOrphanedLocalProjects(
  workspaceRoot: string,
  options: SweepOrphanedLocalProjectsOptions = {},
): Promise<LocalProjectGcReport> {
  const dryRun = options.dryRun ?? true;
  const graceMs = options.graceMs ?? LOCAL_PROJECT_GC_GRACE_MS;
  const now = options.now?.() ?? Date.now();
  const entries: LocalProjectGcEntry[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(workspaceRoot)).filter((name) => name.startsWith("local-"));
  } catch {
    return { root: workspaceRoot, scanned: 0, reclaimed: 0, dryRun, entries: [] };
  }
  for (const name of names.sort()) {
    const dir = join(workspaceRoot, name);
    try {
      if (options.liveProjectDirNames?.has(name)) {
        entries.push({ dir, verdict: "kept", reason: "this project holds live control intent" });
        continue;
      }
      const age = now - (await stat(dir)).mtimeMs;
      if (age < graceMs) {
        entries.push({ dir, verdict: "young", reason: "younger than the grace window; may be mid-seed" });
        continue;
      }
      const origin = await gitOriginOf(join(dir, "workspace"));
      if (origin == null) {
        entries.push({ dir, verdict: "kept", reason: "no readable seed origin; evidence decides, absence keeps" });
        continue;
      }
      if (!isAbsolute(origin)) {
        entries.push({ dir, verdict: "kept", reason: `seeded from a non-local origin (${origin})` });
        continue;
      }
      if (await exists(origin)) {
        entries.push({ dir, verdict: "kept", reason: `its seeding checkout still exists at ${origin}` });
        continue;
      }
      if (!dryRun) await rm(dir, { recursive: true, force: true });
      entries.push({
        dir,
        verdict: "reclaimed",
        reason: `its seeding checkout at ${origin} no longer exists`,
      });
    } catch (error) {
      entries.push({
        dir,
        verdict: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    root: workspaceRoot,
    scanned: names.length,
    reclaimed: entries.filter((entry) => entry.verdict === "reclaimed").length,
    dryRun,
    entries,
  };
}

async function gitOriginOf(workspacePath: string): Promise<string | undefined> {
  return await new Promise((resolve) => {
    execFile(
      "git",
      ["-C", workspacePath, "remote", "get-url", "origin"],
      { timeout: GIT_TIMEOUT_MS },
      (error, stdout) => {
        const value = stdout?.trim();
        resolve(error != null || value === "" ? undefined : value);
      },
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
