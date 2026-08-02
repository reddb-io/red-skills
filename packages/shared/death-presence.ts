/**
 * death-presence — the anchor a living process leaves so a later reader can
 * speak for its death.
 *
 * **The anchor exists because a SIGKILL cannot write.** `death-record.ts` covers
 * every death a process can narrate; this file covers the setup for the ones it
 * cannot. A process writes one small file when it starts and removes it the
 * moment a death record lands, so an anchor still on disk means exactly one
 * thing: a process left without saying how.
 *
 * **It lives here, apart from both the recorder and the reaper, so neither has to
 * import the other.** The recorder writes anchors and the boot reaper reads them;
 * putting the shape in either one would make the two modules circular, and a
 * cycle in the code that runs during a crash is a cost nobody should pay.
 *
 * Written through the TOON encoder (repo mandate) with the SYNCHRONOUS file API,
 * for the same reason the death record is: the writer may be moments from death.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { encodeLines, parseRecords, type ToonlRecord } from "@reddb-io/toon";
import type { ProcessDeathKind } from "./death-record.js";

export { DEATH_PRESENCE_DIR, deathPresenceDir, deathPresenceDirIn } from "./red-paths.js";

/** Where the boot id lives under any `/proc`-shaped root. */
export const BOOT_ID_PATH = join("sys", "kernel", "random", "boot_id");

/** The anchor shape's version; bumped only when a field's meaning changes. */
export const PROCESS_PRESENCE_VERSION = 1;

/**
 * One living process's anchor — what a later reader needs to attribute its death.
 *
 * `boot_id` and `cgroup` are carried at ANCHOR time, not read at reap time: the
 * process is gone by then, so `/proc/<pid>/cgroup` is gone with it, and the boot
 * id the process lived under is exactly the fact a freeze erases.
 */
export interface ProcessPresence {
  readonly version: number;
  readonly ts: string;
  readonly kind: ProcessDeathKind;
  readonly id: string;
  readonly pid: number;
  /** Who started it — the account that makes `parent-death` provable. */
  readonly ppid: number;
  readonly boot_id: string | null;
  readonly cgroup: string | null;
  readonly last_phase: string;
}

// ---------------------------------------------------------------------------
// The anchor
// ---------------------------------------------------------------------------

export interface BuildProcessPresenceFacts {
  readonly kind: ProcessDeathKind;
  readonly id: string;
  readonly last_phase: string;
  readonly pid?: number;
  readonly ppid?: number;
}

export interface BuildProcessPresenceOptions {
  readonly procRoot?: string;
  readonly now?: () => string;
}

/** Assemble an anchor, reading the boot id and cgroup this process lives under. */
export function buildProcessPresence(
  facts: BuildProcessPresenceFacts,
  options: BuildProcessPresenceOptions = {},
): ProcessPresence {
  const procRoot = options.procRoot ?? "/proc";
  const pid = facts.pid ?? process.pid;
  return {
    version: PROCESS_PRESENCE_VERSION,
    ts: (options.now ?? (() => new Date().toISOString()))(),
    kind: facts.kind,
    id: facts.id,
    pid,
    ppid: facts.ppid ?? process.ppid,
    boot_id: readTrimmed(join(procRoot, BOOT_ID_PATH)),
    cgroup: readCgroup(procRoot, pid),
    last_phase: facts.last_phase,
  };
}

function readTrimmed(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * The cgroup v2 path this pid sits in, or the first v1 path when v2 is absent.
 *
 * Unified (`0::/…`) first because that is what systemd-oomd names when it kills a
 * scope, and matching what the killer PRINTS is the only match that proves
 * anything.
 */
function readCgroup(procRoot: string, pid: number): string | null {
  const raw = readTrimmed(join(procRoot, String(pid), "cgroup"));
  if (raw === null) return null;
  const lines = raw.split("\n");
  const unified = lines.find((line) => line.startsWith("0::"));
  if (unified) return unified.slice("0::".length) || null;
  const first = lines[0]?.split(":").slice(2).join(":");
  return first === undefined || first === "" ? null : first;
}

/** A file name that survives an id with a slash, a space or a colon in it. */
export function presenceFileName(presence: ProcessPresence): string {
  const id = presence.id.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${presence.kind}-${id}-${presence.pid}.toon`;
}

/** Write one anchor. Best effort: an unwritable lane must never end a process. */
export function writeProcessPresence(dir: string, presence: ProcessPresence): string | null {
  const path = join(dir, presenceFileName(presence));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, encodeLines({ trailer: false }).push(toRow(presence)), {
      encoding: "utf8",
      mode: 0o600,
    });
    return path;
  } catch {
    return null;
  }
}

/** Remove one anchor. Best effort, and idempotent. */
export function clearProcessPresence(dir: string, presence: ProcessPresence): void {
  try {
    rmSync(join(dir, presenceFileName(presence)), { force: true });
  } catch {
    // An anchor that will not go leaves a false absent-but-expected death, which
    // the next reaper reports as `unknown` — noisy, never wrong.
  }
}

/**
 * Every anchor in `dir`. An absent directory is an empty host, not an error.
 *
 * A file that will not decode is skipped and REPORTED through `onSkip` rather
 * than dropped silently: a corrupt anchor is itself a symptom of the crash the
 * reaper is investigating.
 */
export function readProcessPresences(
  dir: string,
  onSkip?: (file: string, reason: string) => void,
): ProcessPresence[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const presences: ProcessPresence[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".toon")) continue;
    const path = join(dir, entry);
    try {
      const rows = parseRecords(readFileSync(path, "utf8"));
      const row = rows[0];
      if (row === undefined) throw new Error("anchor holds no record");
      presences.push(toPresence(row));
    } catch (error) {
      onSkip?.(basename(path), error instanceof Error ? error.message : String(error));
    }
  }
  return presences;
}

function toPresence(row: ToonlRecord): ProcessPresence {
  const kind = row.kind;
  if (kind !== "launcher" && kind !== "worker" && kind !== "daemon") {
    throw new Error(`presence anchor has unknown kind ${String(kind)}`);
  }
  return {
    version: num(row.version),
    ts: String(row.ts),
    kind,
    id: String(row.id),
    pid: num(row.pid),
    ppid: num(row.ppid),
    boot_id: row.boot_id == null ? null : String(row.boot_id),
    cgroup: row.cgroup == null ? null : String(row.cgroup),
    last_phase: String(row.last_phase),
  };
}


function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function toRow(presence: ProcessPresence): ToonlRecord {
  return { ...presence };
}
