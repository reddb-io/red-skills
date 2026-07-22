import { constants } from "node:fs";
import { access, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isLivePid as defaultIsLivePid } from "./kill-tree.js";
import { readPidStartTime } from "../core/state.js";

export interface SupervisorIdentity {
  pid: number;
  startTime: string;
}

/**
 * Verify the repo-owned supervisor identity, not merely PID existence. A PID
 * reused by another process (including a same-command supervisor in a sibling
 * repo) is dead for this lane when its stable process-start token differs.
 */
export function isSupervisorIdentityLive(
  identity: SupervisorIdentity,
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
  pidStartTime: (pid: number) => string | null = readPidStartTime,
): boolean {
  if (!isLivePid(identity.pid)) return false;
  if (identity.startTime === "") return false;
  const actualStartTime = pidStartTime(identity.pid);
  return actualStartTime !== null && actualStartTime === identity.startTime;
}

export interface SupervisorStateReapResult {
  status: "absent" | "live" | "stale";
  pid?: number;
  removed: string[];
}

export async function readSupervisorPid(pidFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function readSupervisorIdentity(
  pidFile: string,
  pidStartFile = `${pidFile}.start`,
): Promise<SupervisorIdentity | null> {
  const pid = await readSupervisorPid(pidFile);
  if (pid === null) return null;
  try {
    const startTime = (await readFile(pidStartFile, "utf8")).trim();
    return { pid, startTime };
  } catch {
    return { pid, startTime: "" };
  }
}

export interface SupervisorPidDiscovery {
  pid: number;
  source: "pid-file";
  path: string;
}

export interface DiscoverSupervisorPidOptions {
  /** Named fleet retained for call-site compatibility; liveness is resolved
   * exclusively from that fleet's pinned pid identity. */
  fleet?: string;
  /** Injectable stable process-start lookup for deterministic identity tests. */
  pidStartTime?: (pid: number) => string | null;
}

/**
 * Find the supervisor pid that owns ONE fleet's runtime lane. The pid file is
 * the authoritative lock and its process-start sidecar is mandatory. Snapshot
 * lane names contain only a PID, so they cannot distinguish a recycled process
 * and are never an authoritative liveness source.
 */
export async function discoverLiveSupervisorPid(
  supervisorRuntimeDir: string,
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
  options: DiscoverSupervisorPidOptions = {},
): Promise<SupervisorPidDiscovery | null> {
  const pidFile = join(supervisorRuntimeDir, "afk-supervisor.pid");
  const identity = await readSupervisorIdentity(pidFile);
  if (
    identity !== null &&
    isSupervisorIdentityLive(identity, isLivePid, options.pidStartTime ?? readPidStartTime)
  ) {
    return { pid: identity.pid, source: "pid-file", path: pidFile };
  }

  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function supervisorArtifactPaths(dir: string): Promise<string[]> {
  const out = [
    join(dir, "afk-supervisor.pid"),
    join(dir, "afk-supervisor.pid.start"),
    join(dir, "afk-supervisor-boot.pid"),
    join(dir, "state.toon"),
    join(dir, "state.toon.tmp"),
    join(dir, "afk-supervisor.stop"),
    join(dir, "afk-supervisor.recovering"),
    join(dir, "resize.toon"),
    join(dir, "restarts.toon"),
    join(dir, "monitor-log-cursors.toon"),
  ];
  try {
    for (const entry of await readdir(dir)) {
      if (entry.startsWith("afk-supervisor.log") || entry === "supervisor.log.toonl") out.push(join(dir, entry));
    }
  } catch {
    // Missing/unreadable dir means there are no removable artifacts we can see.
  }
  return [...new Set(out)];
}

/**
 * Reap stale supervisor artifacts across the canonical tmp supervisor home and any
 * legacy home (issue #1685). Pass the current dir first; a legacy dir is
 * scanned for the one-release migration window so a supervisor whose pid still
 * lives under the old layout is honoured and its dead artifacts are cleaned up.
 */
export async function reapStaleSupervisorState(
  dirs: string | readonly string[],
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
  pidStartTime: (pid: number) => string | null = readPidStartTime,
): Promise<SupervisorStateReapResult> {
  const dirList = typeof dirs === "string" ? [dirs] : [...dirs];
  let pid: number | null = null;
  for (const dir of dirList) {
    const identity = await readSupervisorIdentity(join(dir, "afk-supervisor.pid"));
    if (identity === null) continue;
    pid = identity.pid;
    if (isSupervisorIdentityLive(identity, isLivePid, pidStartTime)) {
      return { status: "live", pid, removed: [] };
    }
    break;
  }

  const artifacts = (await Promise.all(dirList.map((d) => supervisorArtifactPaths(d)))).flat();
  const present: string[] = [];
  for (const path of artifacts) {
    if (await exists(path)) present.push(path);
  }
  if (present.length === 0) return { status: "absent", removed: [] };

  const removed: string[] = [];
  for (const path of present) {
    try {
      await rm(path, { force: true });
      removed.push(path);
    } catch {
      // Best-effort cleanup: leave failures for the caller's normal path.
    }
  }
  return { status: "stale", ...(pid !== null ? { pid } : {}), removed };
}

export async function reapDeadSupervisorSnapshotDirs(
  supervisorsRoot: string,
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
  currentPid: number = process.pid,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(supervisorsRoot);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries) {
    const match = /^s([1-9][0-9]*)$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === currentPid || isLivePid(pid)) continue;
    const dir = join(supervisorsRoot, entry);
    try {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Best-effort cleanup; a failed remove remains visible for the next boot.
    }
  }
  return removed;
}
