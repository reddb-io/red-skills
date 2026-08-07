// runtime/red-path-migration.ts — the real-fs executor behind the one-time boot
// migration (core/red-path-migration.ts owns the pure legacy → canonical plan).
// Best-effort throughout: a boot must never fail because a legacy artifact could
// not be relocated, so every fs error is swallowed and the artifact is simply
// left where it is (a later reader's legacy fallback still finds it).
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendCastleHistoryRecord } from "@reddb-io/red-castle/engine";
import {
  migrationActionFor,
  planDevDurablePathMigration,
  supervisorLogMigration,
} from "../core/red-path-migration.js";
import { parseHistoryLines } from "../core/history.js";
import { afkStateDir, stateDir } from "@reddb-io/shared/red-paths.js";

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

async function convertLegacyJsonlHistoryIfSafe(root: string): Promise<boolean> {
  const legacy = join(stateDir(root), "afk-history.jsonl");
  const current = join(afkStateDir(root), "history.toonl");
  const [legacyExists, currentExists] = await Promise.all([pathExists(legacy), pathExists(current)]);
  if (migrationActionFor(legacyExists, currentExists) !== "move") return false;
  try {
    const records = parseHistoryLines(await readFile(legacy, "utf8"));
    await mkdir(dirname(current), { recursive: true });
    const tmp = `${current}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, "", "utf8");
    for (const record of records) await appendCastleHistoryRecord(tmp, record);
    await rename(tmp, current);
    await rm(legacy, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Relocate every dev-owned artifact from its legacy home to the canonical state
 * or tmp lane, once and idempotently. A second boot (legacy already gone) is a
 * pure no-op. Safe to call on every boot.
 */
export async function migrateLegacyDevPaths(root: string): Promise<DevPathMigrationResult> {
  const moved: string[] = [];
  for (const entry of planDevDurablePathMigration(root)) {
    if (await moveIfSafe(entry.legacy, entry.current)) moved.push(entry.id);
  }
  if (await convertLegacyJsonlHistoryIfSafe(root)) moved.push("afk-history.jsonl");
  // Retire the old tmp-root structured supervisor firehose
  // (afk-supervisor.log.toonl -> supervisor.log.toonl). Human prose
  // afk-supervisor.log is not moved or dual-written into a new lane.
  const { legacyDir, currentDir, logPrefix } = supervisorLogMigration(root);
  let entries: string[] = [];
  try {
    entries = await readdir(legacyDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (!name.startsWith(logPrefix)) continue;
    if (name !== "afk-supervisor.log.toonl") continue;
    const currentName = "supervisor.log.toonl";
    if (await moveIfSafe(join(legacyDir, name), join(currentDir, currentName))) moved.push(name);
  }
  return { moved };
}
