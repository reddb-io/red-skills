/**
 * paths.ts — the single repo-identity authority for `rsp wait`.
 *
 * Every wait surface (the registry writer, `rsp wait ls`, the dashboard, and the
 * capture spool) must agree on ONE root, or a wait started in a linked git
 * worktree becomes invisible to a `ls` run from the main checkout. Before this
 * module each caller spelled its own upward walk, so a linked worktree silently
 * grew a second, private registry.
 *
 * Resolution order, most explicit first:
 *
 * 1. A plugin root env override ({@link resolveRedRoot} honors these).
 * 2. An owned `.red` directory found by walking up from `startDir` — but the
 *    walk STOPS at the repository boundary. An unbounded walk escapes the repo
 *    on the first ancestor that happens to own a `.red` (a stray `/tmp/.red` is
 *    enough), which would silently merge unrelated repos' registries.
 * 3. The MAIN worktree of a linked git worktree — a worktree's `.git` is a FILE
 *    holding `gitdir: <main>/.git/worktrees/<name>`, so the main root is three
 *    levels above that gitdir. This is what unifies linked worktrees.
 * 4. A plain `.git` directory (an ordinary checkout with no `.red` yet).
 * 5. `startDir`, so resolution never throws.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveRedRoot, ROOT_OVERRIDE_ENV_VARS, waitsDir } from "@reddb-io/shared/red-paths.js";

/** Where bounded command capture spills bytes before they reach the store. */
const SPOOL_SEGMENT = "spool";

/**
 * The repo root that owns this wait's `.red` — shared by every linked worktree
 * of the same repository.
 */
export function waitRepoRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const start = resolve(cwd);
  // An explicit override wins outright and is not subject to the boundary.
  const override = ROOT_OVERRIDE_ENV_VARS.map((name) => env[name]).find(Boolean);
  if (override) {
    return resolveRedRoot({ startDir: start, env: env as Record<string, string | undefined>, exists: existsSync });
  }

  const boundary = gitRoot(start);
  const owned = findRedRoot(start, boundary);
  if (owned) return owned;
  return boundary ?? start;
}

/**
 * The nearest ancestor of `startDir` that owns a `.red`, never searching above
 * `boundary`. A null boundary means there is no repo to stay inside, so the walk
 * is unbounded — the caller is outside version control and has nothing to leak
 * across.
 */
function findRedRoot(startDir: string, boundary: string | null): string | null {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".red"))) return current;
    if (boundary && current === boundary) return null;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/** The shared registry lane: `<root>/.red/tmp/waits`. */
export function waitRegistryDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return waitsDir(waitRepoRoot(cwd, env));
}

/** The bounded-capture spool lane: `<root>/.red/tmp/waits/spool`. */
export function waitSpoolDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(waitRegistryDir(cwd, env), SPOOL_SEGMENT);
}

/**
 * Walk up for a `.git`, following a linked worktree's `.git` FILE back to the
 * main worktree so both share one identity. Returns null when there is no repo.
 */
function gitRoot(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const candidate = join(current, ".git");
    if (existsSync(candidate)) {
      return isDirectory(candidate) ? current : mainWorktreeRoot(candidate) ?? current;
    }
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve `gitdir: <main>/.git/worktrees/<name>` to `<main>`. Anything that does
 * not match that exact shape (a submodule gitlink, a relocated gitdir) returns
 * null so the caller falls back to the worktree's own directory rather than
 * guessing a wrong root.
 */
function mainWorktreeRoot(gitFile: string): string | null {
  // The pointer IS the worktree's entry directory, so the main root is exactly
  // three levels up: <main>/.git/worktrees/<name>.
  const worktreeEntry = readGitdirPointer(gitFile);
  if (!worktreeEntry) return null;
  const worktreesDir = dirname(worktreeEntry);
  const gitDir = dirname(worktreesDir);
  if (basename(worktreesDir) !== "worktrees" || basename(gitDir) !== ".git") return null;
  return dirname(gitDir);
}

function readGitdirPointer(gitFile: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(gitFile, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(raw.trim());
  if (!match) return null;
  const target = match[1]!.trim();
  return isAbsolute(target) ? resolve(target) : resolve(dirname(gitFile), target);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
