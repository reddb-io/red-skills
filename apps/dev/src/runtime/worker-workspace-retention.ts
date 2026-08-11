import { readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEAD_WORKER_WORKTREE_TTL_S } from "../core/reclaim.js";
import type { WorkerArtifact } from "../core/worker-reclaim.js";
import { allWorkersRoots, parseReapableWorkerPath } from "../core/worker-paths.js";

export const WORKTREE_RECLAIM_TOMBSTONE = "worktree.reclaimed";

type IssueStateLookup = (issue: number) => "OPEN" | "CLOSED" | "UNKNOWN";

async function listNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** Collect workspace and evidence artifacts with the OPEN-issue stage-1 hold. */
export async function collectWorkerWorkspaceArtifacts(
  tmpDir: string,
  lookup: IssueStateLookup,
): Promise<{ artifacts: WorkerArtifact[]; observedPaths: string[] }> {
  const artifacts: WorkerArtifact[] = [];
  const observedPaths: string[] = [];
  for (const workersRoot of allWorkersRoots(tmpDir)) {
    for (const worker of await listNames(workersRoot)) {
      const workerPath = join(workersRoot, worker);
      let workerMtimeS: number;
      try {
        const workerStat = await stat(workerPath);
        if (!workerStat.isDirectory()) continue;
        workerMtimeS = Math.floor(workerStat.mtimeMs / 1000);
      } catch {
        continue;
      }
      for (const issue of await listNames(workerPath)) {
        const issueDir = join(workerPath, issue);
        const parsed = parseReapableWorkerPath(issueDir);
        if (!parsed) continue;
        const worktree = join(issueDir, "worktree");
        try {
          if (!(await stat(worktree)).isDirectory()) continue;
        } catch {
          continue;
        }
        observedPaths.push(worktree);
        const issueState = lookup(parsed.issue);
        artifacts.push({
          worker_id: worker,
          kind: "worktree",
          path: worktree,
          ...(issueState === "OPEN"
            ? {
                reclaim_after: new Date(
                  (workerMtimeS + DEAD_WORKER_WORKTREE_TTL_S) * 1000,
                ).toISOString(),
              }
            : issueState === "UNKNOWN"
              ? { reclaimable: false, reason: "the represented issue state is unknown" }
              : {}),
        });
        const log = join(dirname(issueDir), "worker.log.toonl");
        try {
          await stat(log);
          artifacts.push({ worker_id: worker, kind: "log", path: log });
        } catch {
          // No evidence log in this Worker lane.
        }
      }
    }
  }
  return { artifacts, observedPaths };
}

export function worktreeReclaimTombstoneLine(nowS: number): string {
  return `worktree reclaimed at ${new Date(nowS * 1000).toISOString()}\n`;
}

export async function writeWorktreeReclaimTombstone(
  worktreePath: string,
  nowS: number,
): Promise<void> {
  await writeFile(
    join(dirname(worktreePath), WORKTREE_RECLAIM_TOMBSTONE),
    worktreeReclaimTombstoneLine(nowS),
    "utf8",
  );
}
