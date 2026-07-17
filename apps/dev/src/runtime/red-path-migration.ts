// runtime/red-path-migration.ts — the real-fs executor behind the one-time boot
// migration (core/red-path-migration.ts owns the pure legacy → canonical plan).
// Best-effort throughout: a boot must never fail because a legacy artifact could
// not be relocated, so every fs error is swallowed and the artifact is simply
// left where it is (a later reader's legacy fallback still finds it).
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  migrationActionFor,
  planDevDurablePathMigration,
  supervisorLogMigration,
} from "../core/red-path-migration.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Move `legacy` → `current` iff only the legacy copy exists. Returns true when
 * the move happened. Ambiguous (both present) and absent states are no-ops and
 * NEVER delete the legacy copy. */
async function moveIfSafe(legacy: string, current: string): Promise<boolean> {
  const [legacyExists, currentExists] = await Promise.all([pathExists(legacy), pathExists(current)]);
  if (migrationActionFor(legacyExists, currentExists) !== "move") return false;
  try {
    await mkdir(dirname(current), { recursive: true });
    await rename(legacy, current);
    return true;
  } catch {
    // Cross-device rename, a racing peer, or a permissions hiccup — leave the
    // legacy copy untouched so nothing is lost.
    return false;
  }
}

export interface DevPathMigrationResult {
  /** Ids/basenames of the artifacts actually relocated this boot. */
  moved: string[];
}

/**
 * Relocate every dev-owned durable artifact from its legacy `.red/tmp` home to
 * the state tier, once and idempotently. A second boot (legacy already gone) is a
 * pure no-op. Safe to call on every boot.
 */
export async function migrateLegacyDevPaths(root: string): Promise<DevPathMigrationResult> {
  const moved: string[] = [];
  for (const entry of planDevDurablePathMigration(root)) {
    if (await moveIfSafe(entry.legacy, entry.current)) moved.push(entry.id);
  }
  // Rotated supervisor launch logs (afk-supervisor.log, .log.N) plus the old
  // TOONL firehose name (afk-supervisor.log.jsonl -> afk-supervisor.log.toonl).
  const { legacyDir, currentDir, logPrefix } = supervisorLogMigration(root);
  let entries: string[] = [];
  try {
    entries = await readdir(legacyDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (!name.startsWith(logPrefix)) continue;
    const currentName = name === "afk-supervisor.log.jsonl" ? "afk-supervisor.log.toonl" : name;
    if (await moveIfSafe(join(legacyDir, name), join(currentDir, currentName))) moved.push(name);
  }
  return { moved };
}
