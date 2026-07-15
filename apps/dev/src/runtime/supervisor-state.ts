import { constants } from "node:fs";
import { access, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isLivePid as defaultIsLivePid } from "./kill-tree.js";

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
    join(dir, "afk-supervisor.state.json"),
    join(dir, "afk-supervisor.state.json.tmp"),
    join(dir, "afk-supervisor.stop"),
  ];
  try {
    for (const entry of await readdir(dir)) {
      if (entry.startsWith("afk-supervisor.log")) out.push(join(dir, entry));
    }
  } catch {
    // Missing/unreadable dir means there are no removable artifacts we can see.
  }
  return [...new Set(out)];
}

/**
 * Reap stale supervisor artifacts across the canonical state-tier home and any
 * legacy `.red/tmp` home (issue #1685). Pass the state dir first; a legacy dir is
 * scanned for the one-release migration window so a supervisor whose pid still
 * lives under the old layout is honoured and its dead artifacts are cleaned up.
 */
export async function reapStaleSupervisorState(
  dirs: string | readonly string[],
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
): Promise<SupervisorStateReapResult> {
  const dirList = typeof dirs === "string" ? [dirs] : [...dirs];
  let pid: number | null = null;
  for (const dir of dirList) {
    pid = await readSupervisorPid(join(dir, "afk-supervisor.pid"));
    if (pid !== null) break;
  }
  if (pid !== null && isLivePid(pid)) return { status: "live", pid, removed: [] };

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
