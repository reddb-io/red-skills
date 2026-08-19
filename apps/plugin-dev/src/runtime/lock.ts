// runtime/lock.ts — concrete branch-lock store closures (ADR 0031).
//
// Ports the read half of the branch-lock skill's lib/lock-store.sh
// (lock_store_read / lock_store_is_locked) against the gitignored
// `.red/tmp/branch-lock.yaml` file. The lock file is a bare YAML scalar — the
// branch name on the first line; its presence (non-empty first line) means
// "locked", its absence means "unlocked". These feed base-resolver's
// `readLockedBranch` (lock > pin > main) and process-issue's `isLocked` (which
// toggles landMerge vs landPr).

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { branchLockFile, tmpDir } from "@reddb-io/shared/red-paths.js";
import { readText } from "./fs.js";

/**
 * The branch-lock file path for a primary checkout, funnelled through the shared
 * path authority (issue #1685). The canonical home is the state tier
 * (`.red/state/branch-lock.yaml`), but the branch-lock skill's SHELL writer still
 * owns the legacy `.red/tmp/branch-lock.yaml` during the migration window — so
 * this reader prefers whichever exists (canonical first) to always track the live
 * writer. The dev runtime only READS the lock; the writer migrates separately, so
 * the lock is deliberately NOT relocated by the boot migration.
 */
export function branchLockPath(root: string): string {
  const canonical = branchLockFile(root);
  if (existsSync(canonical)) return canonical;
  const legacy = join(tmpDir(root), "branch-lock.yaml");
  if (existsSync(legacy)) return legacy;
  return canonical;
}

/**
 * Read the locked branch name, or `undefined` when unlocked. Mirrors
 * `lock_store_read`: take the first line, strip trailing whitespace, and treat
 * an absent/empty file as unlocked (`undefined`).
 */
export async function readLockedBranch(lockPath: string): Promise<string | undefined> {
  const text = await readText(lockPath);
  if (text === null) return undefined;
  const first = text.split("\n", 1)[0] ?? "";
  const branch = first.trim();
  return branch.length > 0 ? branch : undefined;
}

/** True when a non-empty lock file is present. Mirrors `lock_store_is_locked`. */
export async function isLocked(lockPath: string): Promise<boolean> {
  return (await readLockedBranch(lockPath)) !== undefined;
}

export async function clearBranchLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

export async function writeBranchLock(lockPath: string, branch: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${branch}\n`, "utf8");
}
