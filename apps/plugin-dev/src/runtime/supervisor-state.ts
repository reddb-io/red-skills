import { constants } from "node:fs";
import { access, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isLivePid as defaultIsLivePid } from "./kill-tree.js";
import { readPidStartTime } from "../core/state.js";
import { decodeDevSnapshotSniff } from "../core/toon-snapshot.js";

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

/**
 * The heartbeat snapshot read as a liveness anchor: the pid that wrote
 * `state.toon`, the process-start pin it stamped (absent on snapshots written by
 * a bundle older than #2698), and the tick epoch that dates the claim.
 */
export interface FleetStateAnchor {
  pid: number;
  startTime: string | null;
  epoch: number | null;
}

/**
 * How long a heartbeat snapshot with NO process-start pin may vouch for its pid.
 * A stamped identity is verified exactly and needs no window; a legacy snapshot
 * can only argue "this pid was mine seconds ago", so it expires.
 */
export const FLEET_STATE_ANCHOR_MAX_AGE_S = 300;

/**
 * Read the supervisor identity recorded in a fleet's `state.toon`. Returns null
 * when the snapshot is absent, undecodable, or carries no pid — an unreadable
 * snapshot simply contributes no anchor.
 */
export async function readFleetStateAnchor(
  supervisorRuntimeDir: string,
): Promise<FleetStateAnchor | null> {
  let text: string;
  try {
    text = await readFile(join(supervisorRuntimeDir, "state.toon"), "utf8");
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = decodeDevSnapshotSniff(text);
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object") return null;
  const rec = decoded as { pid?: unknown; pid_start_time?: unknown; epoch?: unknown };
  const pid = Number(rec.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const epoch = Number(rec.epoch);
  return {
    pid,
    startTime: typeof rec.pid_start_time === "string" && rec.pid_start_time !== ""
      ? rec.pid_start_time
      : null,
    epoch: Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null,
  };
}

/**
 * Decide whether a heartbeat snapshot still names a live supervisor. With a
 * stamped process-start pin the check is the same exact identity comparison the
 * pid file gets. Without one, the pid must be live AND the snapshot recent, so a
 * long-dead fleet's leftover snapshot can never resurrect a recycled pid.
 */
export function isFleetStateAnchorLive(
  anchor: FleetStateAnchor,
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
  pidStartTime: (pid: number) => string | null = readPidStartTime,
  nowS: number = Math.floor(Date.now() / 1_000),
): boolean {
  if (!isLivePid(anchor.pid)) return false;
  if (anchor.startTime !== null) {
    return isSupervisorIdentityLive(
      { pid: anchor.pid, startTime: anchor.startTime },
      isLivePid,
      pidStartTime,
    );
  }
  if (anchor.epoch === null) return false;
  return Math.abs(nowS - anchor.epoch) <= FLEET_STATE_ANCHOR_MAX_AGE_S;
}

export interface SupervisorPidDiscovery {
  pid: number;
  source: "pid-file" | "fleet-state";
  path: string;
}

export interface DiscoverSupervisorPidOptions {
  /** Injectable stable process-start lookup for deterministic identity tests. */
  pidStartTime?: (pid: number) => string | null;
  /** Injectable clock (epoch seconds) for deterministic snapshot-age tests. */
  nowS?: number;
}

/**
 * Find the supervisor pid that owns the project's supervisor lane. ONE identity —
 * pid plus process-start pin — published to TWO anchors the supervisor writes:
 * the `afk-supervisor.pid` lock at boot, and the `state.toon` heartbeat every
 * tick. The pid file is consulted first; the heartbeat snapshot answers when the
 * lock was swept, never written, or lost its start sidecar, which is exactly how
 * a ticking supervisor used to read back as absent (#2698). Snapshot lane names
 * contain only a PID, so they cannot distinguish a recycled process and are
 * never an authoritative liveness source.
 */
export async function discoverLiveSupervisorPid(
  supervisorRuntimeDir: string,
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
  options: DiscoverSupervisorPidOptions = {},
): Promise<SupervisorPidDiscovery | null> {
  const pidStartTime = options.pidStartTime ?? readPidStartTime;
  const pidFile = join(supervisorRuntimeDir, "afk-supervisor.pid");
  const identity = await readSupervisorIdentity(pidFile);
  if (identity !== null && isSupervisorIdentityLive(identity, isLivePid, pidStartTime)) {
    return { pid: identity.pid, source: "pid-file", path: pidFile };
  }

  const anchor = await readFleetStateAnchor(supervisorRuntimeDir);
  if (
    anchor !== null &&
    isFleetStateAnchorLive(anchor, isLivePid, pidStartTime, options.nowS)
  ) {
    return {
      pid: anchor.pid,
      source: "fleet-state",
      path: join(supervisorRuntimeDir, "state.toon"),
    };
  }

  return null;
}

/**
 * The last-resort identity for a FORCED teardown (#2714): any supervisor pid
 * this lane recorded that is still alive, accepted WITHOUT the process-start
 * proof {@link discoverLiveSupervisorPid} demands. A lock that lost its start
 * sidecar, or a snapshot too old to vouch for itself, is exactly the state in
 * which strict discovery answers "no fleet running" about a process the operator
 * can see — and then has to kill by pid. `--force` is the operator's explicit
 * "I accept the weaker proof"; every other caller must keep the strict reader,
 * because an unpinned pid cannot rule out reuse by an unrelated process.
 */
export async function readRecordedLiveSupervisorPid(
  supervisorRuntimeDir: string,
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
): Promise<SupervisorPidDiscovery | null> {
  const pidFile = join(supervisorRuntimeDir, "afk-supervisor.pid");
  const pid = await readSupervisorPid(pidFile);
  if (pid !== null && isLivePid(pid)) {
    return { pid, source: "pid-file", path: pidFile };
  }
  const anchor = await readFleetStateAnchor(supervisorRuntimeDir);
  if (anchor !== null && isLivePid(anchor.pid)) {
    return {
      pid: anchor.pid,
      source: "fleet-state",
      path: join(supervisorRuntimeDir, "state.toon"),
    };
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
  nowS?: number,
): Promise<SupervisorStateReapResult> {
  const dirList = typeof dirs === "string" ? [dirs] : [...dirs];
  let pid: number | null = null;
  for (const dir of dirList) {
    const identity = await readSupervisorIdentity(join(dir, "afk-supervisor.pid"));
    if (identity !== null) {
      pid = identity.pid;
      if (isSupervisorIdentityLive(identity, isLivePid, pidStartTime)) {
        return { status: "live", pid, removed: [] };
      }
    }
    // The heartbeat snapshot is the second anchor of the SAME identity. Reaping
    // must consult it too: a sweep that trusted only the pid file deleted the
    // live supervisor's own state.toon and then let a second one launch (#2698).
    const anchor = await readFleetStateAnchor(dir);
    if (anchor !== null && isFleetStateAnchorLive(anchor, isLivePid, pidStartTime, nowS)) {
      return { status: "live", pid: anchor.pid, removed: [] };
    }
    if (identity !== null) break;
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
