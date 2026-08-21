/**
 * Shared lifecycle policy and mechanics for bounded TOONL lanes.
 *
 * Writers own retention. The cheap append path performs one stat and leaves a
 * rewritten generation half empty; boot sweeps only remove replacement files
 * whose writer is provably dead. Trimming never appends marker rows because
 * several lanes have closed record vocabularies.
 */
import { execFile } from "node:child_process";
import {
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { encodeToonlLines, parseRecords } from "@reddb-io/toon";

type ToonlRecord = Record<string, string | number | boolean | null>;

const execFileAsync = promisify(execFile);

export const DEFAULT_LANE_RETENTION_TARGET_RATIO = 0.5;
export const LANE_RETENTION_TQ_TIMEOUT_MS = 5_000;
export const LIVE_WORKER_LOG_WARNING_THRESHOLD_BYTES = 256 * 1024 * 1024;

/** A lane declares only the ceilings meaningful to its own record stream. */
export interface LaneRetentionPolicy {
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly maxAgeMs?: number;
  readonly targetRatio?: number;
}

export type RegisteredLaneRetentionPolicy = LaneRetentionPolicy & {
  readonly targetRatio: number;
};

const MIB = 1024 * 1024;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * Policies decided by Spec #3581. Later writer slices consume this registry
 * rather than repeating ceilings beside each append implementation.
 */
export const LANE_RETENTION_REGISTRY = {
  "process-deaths": {
    maxBytes: 4 * MIB,
    maxAgeMs: FOURTEEN_DAYS_MS,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "github-spend": {
    maxBytes: 8 * MIB,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "github-balance": {
    // One current three-pool TOON snapshot. A small hard ceiling makes schema
    // growth visible instead of letting a singleton state file drift unbounded.
    maxBytes: 64 * 1024,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "github-balance-history": {
    maxBytes: 2 * MIB,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "castle-singleton-events": {
    maxBytes: 2 * MIB,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "redskilled-events": {
    // The most history one daemon generation asks every successor to replay.
    // Declared here rather than beside the writer because a ceiling only the
    // writer knows is one the census cannot audit (#3645).
    maxBytes: 4 * MIB,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "rsp-telemetry-spool": {
    maxBytes: 8 * MIB,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "rsp-telemetry-corrections": {
    maxBytes: MIB,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "death-attributions": {
    maxBytes: MIB,
    maxAgeMs: FOURTEEN_DAYS_MS,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "worker-log": {
    maxLines: 50_000,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "worker-liveness": {
    maxBytes: MIB,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "castle-history": {
    maxLines: 10_000,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
  "verdicts": {
    // ADR 0154's merge authorization: one row per judged head, so the lane is
    // low-rate and worth keeping long. Bounded by BYTES because a merge can be
    // blocked on this append, and a byte ceiling costs one stat.
    maxBytes: 4 * MIB,
    targetRatio: DEFAULT_LANE_RETENTION_TARGET_RATIO,
  },
} as const satisfies Readonly<Record<string, RegisteredLaneRetentionPolicy>>;

export type LaneRetentionPolicyName = keyof typeof LANE_RETENTION_REGISTRY;

export type LaneRetentionStat = (path: string) => Promise<{ readonly size: number }>;
export type LaneRetentionStatSync = (path: string) => { readonly size: number };

function maxBytes(policy: LaneRetentionPolicy): number | undefined {
  const ceiling = policy.maxBytes;
  if (ceiling !== undefined && (!Number.isSafeInteger(ceiling) || ceiling < 0)) {
    throw new Error("lane retention maxBytes must be a non-negative safe integer");
  }
  return ceiling;
}

function absentLane(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** One-stat ceiling check for ordinary asynchronous writers. */
export async function laneOverCeiling(
  path: string,
  incomingBytes: number,
  policy: LaneRetentionPolicy,
  readStat: LaneRetentionStat = stat,
): Promise<boolean> {
  const ceiling = maxBytes(policy);
  if (ceiling === undefined) return false;
  let size = 0;
  try {
    size = (await readStat(path)).size;
  } catch (error) {
    if (!absentLane(error)) throw error;
  }
  return size + incomingBytes > ceiling;
}

/** The same one-stat check for exit handlers, which cannot await. */
export function laneOverCeilingSync(
  path: string,
  incomingBytes: number,
  policy: LaneRetentionPolicy,
  readStat: LaneRetentionStatSync = statSync,
): boolean {
  const ceiling = maxBytes(policy);
  if (ceiling === undefined) return false;
  let size = 0;
  try {
    size = readStat(path).size;
  } catch (error) {
    if (!absentLane(error)) throw error;
  }
  return size + incomingBytes > ceiling;
}

/** Apply a ceiling to an already-inspected size without another filesystem read. */
export function laneSizeOverCeiling(
  currentBytes: number,
  incomingBytes: number,
  policy: LaneRetentionPolicy,
): boolean {
  const ceiling = maxBytes(policy);
  return ceiling !== undefined && currentBytes + incomingBytes > ceiling;
}

export type LaneTrimMethod = "tq" | "js";

export interface TrimLaneKeepLastOptions {
  readonly timeoutMs?: number;
  /** Return true only when tq completed the in-place replacement. */
  readonly runTq?: (path: string, keepLast: number, timeoutMs: number) => Promise<boolean>;
}

async function runTqTrim(path: string, keepLast: number, timeoutMs: number): Promise<boolean> {
  try {
    await execFileAsync("tq", ["trim", "--keep-last", String(keepLast), "--in-place", path], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function assertKeepLast(keepLast: number): void {
  if (!Number.isSafeInteger(keepLast) || keepLast < 0) {
    throw new Error("lane retention keepLast must be a non-negative safe integer");
  }
}

function encodeRows(rows: readonly ToonlRecord[]): string {
  if (rows.length === 0) return "";
  const writer = encodeToonlLines({ trailer: false });
  return rows.map((row) => writer.push(row)).join("");
}

/** Atomic replacement used by asynchronous lane writers and the JS trimmer. */
export async function replaceLaneAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.retaining-${process.pid}`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Atomic replacement for a dying process's synchronous exit handler. */
export function replaceLaneAtomicallySync(path: string, text: string): void {
  const temporary = `${path}.retaining-${process.pid}`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Keep the newest complete TOONL records. The pinned tq binary gets first
 * refusal; missing, failed, or timed-out tq falls back to a decoder round trip.
 */
export async function trimLaneKeepLast(
  path: string,
  keepLast: number,
  options: TrimLaneKeepLastOptions = {},
): Promise<LaneTrimMethod> {
  assertKeepLast(keepLast);
  const timeoutMs = options.timeoutMs ?? LANE_RETENTION_TQ_TIMEOUT_MS;
  const tq = options.runTq ?? runTqTrim;
  if (await tq(path, keepLast, timeoutMs)) return "tq";

  const raw = await readFile(path, "utf8");
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  const rows = complete === "" ? [] : parseRecords(complete);
  const kept = keepLast === 0 ? [] : rows.slice(-keepLast);
  await replaceLaneAtomically(path, encodeRows(kept));
  return "js";
}

export interface SweepLaneTempsOptions {
  readonly isPidAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface SweepLaneTempsResult {
  readonly removed: string[];
  readonly preserved: string[];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const LANE_REPLACEMENT_TEMP_PID = /\.(?:rotate|retaining)-(\d+)(?:-|$)/;
const RSP_DRAIN_TEMP_PID = /rsp-telemetry\.spool\.(?:toonl|jsonl)\.(\d+)\.\d+\.drain$/;

/** Return the owning pid for every temporary lane generation known to retention. */
export function laneTempOwnerPid(path: string): number | null {
  const match = LANE_REPLACEMENT_TEMP_PID.exec(path) ?? RSP_DRAIN_TEMP_PID.exec(path);
  return match === null ? null : Number(match[1]);
}

/** Recursively remove only replacement temps whose owning pid is dead. */
export async function sweepLaneTemps(
  root: string,
  options: SweepLaneTempsOptions = {},
): Promise<SweepLaneTempsResult> {
  const removed: string[] = [];
  const preserved: string[] = [];
  const isPidAlive = options.isPidAlive ?? pidAlive;

  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (absentLane(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const pid = laneTempOwnerPid(entry.name);
      if (pid === null) continue;
      if (await isPidAlive(pid)) {
        preserved.push(path);
        continue;
      }
      await rm(path, { force: true });
      removed.push(path);
    }
  };

  await visit(root);
  removed.sort();
  preserved.sort();
  return { removed, preserved };
}
