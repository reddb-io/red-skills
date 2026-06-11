// runtime/lock.ts — concrete branch-lock store closures (ADR 0031).
//
// Ports the read half of the branch-lock skill's lib/lock-store.sh
// (lock_store_read / lock_store_is_locked) against the gitignored
// `.red/tmp/branch-lock.yaml` file. The lock file is a bare YAML scalar — the
// branch name on the first line; its presence (non-empty first line) means
// "locked", its absence means "unlocked". These feed base-resolver's
// `readLockedBranch` (lock > pin > main) and process-issue's `isLocked` (which
// toggles landMerge vs landPr).

import { join } from "node:path";
import { readText } from "./fs.js";

/** Standard lock-file path for a primary checkout (.red/tmp/branch-lock.yaml). */
export function branchLockPath(root: string): string {
  return join(root, ".red", "tmp", "branch-lock.yaml");
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
