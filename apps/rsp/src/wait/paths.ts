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
import { join } from "node:path";
import { waitsDir } from "@reddb-io/shared/red-paths.js";
import { resolveRepoRoot } from "@reddb-io/shared/repo-root.js";

/** Where bounded command capture spills bytes before they reach the store. */
const SPOOL_SEGMENT = "spool";

/**
 * The repo root that owns this wait's `.red` — shared by every linked worktree
 * of the same repository.
 */
export function waitRepoRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveRepoRoot(cwd, env);
}

/** The shared registry lane: `<root>/.red/tmp/waits`. */
export function waitRegistryDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return waitsDir(waitRepoRoot(cwd, env));
}

/** The bounded-capture spool lane: `<root>/.red/tmp/waits/spool`. */
export function waitSpoolDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(waitRegistryDir(cwd, env), SPOOL_SEGMENT);
}
