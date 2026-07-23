/**
 * The repo identity shared by resident services and their consumers.
 *
 * Linked worktrees, nested commands, and explicit root overrides must resolve
 * to the same state lanes or singleton ownership cannot be enforced.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveRedRoot, ROOT_OVERRIDE_ENV_VARS } from "./red-paths.js";

export function resolveRepoRoot(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const start = resolve(cwd);
  const override = ROOT_OVERRIDE_ENV_VARS.map((name) => env[name]).find(Boolean);
  if (override) {
    return resolveRedRoot({
      startDir: start,
      env: env as Record<string, string | undefined>,
      exists: existsSync,
    });
  }

  const boundary = gitRoot(start);
  const owned = findRedRoot(start, boundary);
  if (owned) return owned;
  return boundary ?? start;
}

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

function mainWorktreeRoot(gitFile: string): string | null {
  const worktreeEntry = readGitdirPointer(gitFile);
  if (!worktreeEntry) return null;
  const worktreesDir = dirname(worktreeEntry);
  const gitDir = dirname(worktreesDir);
  if (basename(worktreesDir) !== "worktrees" || basename(gitDir) !== ".git") {
    return null;
  }
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
