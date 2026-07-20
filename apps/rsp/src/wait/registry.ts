/**
 * registry.ts — the authority for the live-wait registry under `.red/tmp/waits`.
 *
 * The registry is the only thing that answers "which waits are running right
 * now?", so it owns the whole contract: the v1 TOON schema, atomic writes,
 * tolerant reads of legacy records, process identity, and stale cleanup.
 *
 * Two invariants drive the design:
 *
 * - **Atomic under concurrent observation.** Writes land by `rename`, never by
 *   in-place truncation, so a concurrent `rsp wait ls` reads either the old
 *   record or the new one and never a half-written file.
 * - **A live PID is not a live wait.** The OS reuses PIDs; a record is only
 *   live when the PID's start time still matches the one recorded with it.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, type JsonObject } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import { WAIT_REGISTRY_SCHEMA, WAIT_SCHEMA_VERSION, type WaitRegistryEntry, type WaitStatus } from "./model.js";
import { waitRegistryDir } from "./paths.js";
import { pidIdentityMatches } from "./process-tree.js";

/** New records are TOON, always. `.json` is read-only legacy. */
const REGISTRY_EXTENSION = ".toon";
const READABLE_EXTENSIONS = [".toon", ".json"];

export function registryPathFor(cwd: string, id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(waitRegistryDir(cwd, env), `${id}${REGISTRY_EXTENSION}`);
}

/** Write the v1 record atomically. Callers mutate `entry` then re-write it. */
export async function writeRegistryEntry(path: string, entry: WaitRegistryEntry): Promise<void> {
  await atomicWrite(path, `${encodeSnapshotToon(entry as unknown as JsonObject)}\n`);
}

/** Set the status and persist in one step — the common registry mutation. */
export async function writeStatus(path: string, entry: WaitRegistryEntry, status: WaitStatus): Promise<void> {
  entry.status = status;
  await writeRegistryEntry(path, entry);
}

/**
 * Every live wait, newest schema and legacy alike.
 *
 * Reading is also the cleanup pass: a record whose process is gone, whose PID
 * was reused, or whose bytes no longer parse is removed. Corruption is treated
 * as staleness rather than an error, because a wait that crashed mid-write must
 * not wedge every future `ls`.
 */
export async function listWaits(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject[]> {
  const dir = waitRegistryDir(cwd, env);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir).catch(() => []);
  const waits: JsonObject[] = [];
  for (const file of files.filter((name) => READABLE_EXTENSIONS.some((ext) => name.endsWith(ext)))) {
    const path = join(dir, file);
    const entry = await readRegistryRecord(path);
    if (!entry) {
      await rm(path, { force: true });
      continue;
    }
    if (!(await isLiveRecord(entry))) {
      await rm(path, { force: true });
      continue;
    }
    waits.push(entry as JsonObject);
  }
  return waits;
}

/** Parse one registry file, or null when it is unreadable or not an object. */
export async function readRegistryRecord(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const body = raw.trim();
  if (!body) return null;
  const parsed = parseStructured(body);
  return parsed && Object.keys(parsed).length > 0 ? parsed : null;
}

/**
 * Is this record's owning process still the one that wrote it? A record with no
 * usable PID is stale by definition — nothing can be waiting on it.
 */
async function isLiveRecord(entry: Record<string, unknown>): Promise<boolean> {
  const pid = typeof entry.pid === "number" ? entry.pid : 0;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const startTime = typeof entry.pid_start_time === "string" ? entry.pid_start_time : undefined;
  return await pidIdentityMatches(pid, startTime);
}

/**
 * TOON first, JSON second. New records are TOON; the JSON branch exists only so
 * a registry written by a pre-v1 binary still reads.
 */
function parseStructured(body: string): Record<string, unknown> | null {
  try {
    const decoded = decode(body);
    if (isRecord(decoded)) return decoded;
  } catch {}
  try {
    const parsed = JSON.parse(body);
    if (isRecord(parsed)) return parsed;
  } catch {}
  return null;
}

/**
 * Write-then-rename, so a reader never observes a partial record. The temp name
 * carries the PID and a UUID so two concurrent writers cannot collide, and the
 * `finally` sweep keeps a failed write from leaving debris in the lane.
 */
export async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

export function newRegistryEntry(fields: Omit<WaitRegistryEntry, "schema" | "version">): WaitRegistryEntry {
  return { schema: WAIT_REGISTRY_SCHEMA, version: WAIT_SCHEMA_VERSION, ...fields };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
