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

async function supervisorArtifactPaths(tmpDir: string): Promise<string[]> {
  const out = [
    join(tmpDir, "afk-supervisor.pid"),
    join(tmpDir, "afk-supervisor.state.json"),
    join(tmpDir, "afk-supervisor.state.json.tmp"),
    join(tmpDir, "afk-supervisor.stop"),
  ];
  try {
    for (const entry of await readdir(tmpDir)) {
      if (entry.startsWith("afk-supervisor.log")) out.push(join(tmpDir, entry));
    }
  } catch {
    // Missing/unreadable tmp dir means there are no removable artifacts we can see.
  }
  return [...new Set(out)];
}

export async function reapStaleSupervisorState(
  tmpDir: string,
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
): Promise<SupervisorStateReapResult> {
  const pidFile = join(tmpDir, "afk-supervisor.pid");
  const pid = await readSupervisorPid(pidFile);
  if (pid !== null && isLivePid(pid)) return { status: "live", pid, removed: [] };

  const artifacts = await supervisorArtifactPaths(tmpDir);
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
