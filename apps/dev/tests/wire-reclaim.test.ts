import { describe, expect, it } from "vitest";
import { reclaimDeadWorkers, type DeadWorkerSweepDeps } from "../src/runtime/wire.js";
import { parseState } from "../src/core/state.js";
import type { WorkerStateRecord } from "../src/core/worker-state-reader.js";

// issue #1219 PART 4: read-time liveness-gated teardown.
//
// A WorkerStateRecord fixture whose `path` encodes {worker}/{N}-a{n} so the
// sweep can derive the attempt dir, worktree, and owning worker dir. Only the
// fields reclaimDeadWorkers reads are populated.
function record(
  root: string,
  worker: string,
  issue: number,
  renderableLive: boolean,
): WorkerStateRecord {
  return {
    path: `${root}/.red/tmp/workers/${worker}/${issue}-a1/afk.state.toon`,
    state: parseState({ worker_id: worker, current: { number: issue } }),
    live: renderableLive,
    active: renderableLive,
    liveness: renderableLive ? "active" : "dead",
    livenessVerdict: {
      status: renderableLive ? "alive" : "stalled",
      laneFresh: renderableLive,
      crossCheckArmed: false,
      reason: "",
    },
    pidIdentityLive: renderableLive,
    hostPidLive: false,
    renderableLive,
  };
}

/** A deps bundle capturing every fs/git/gh side effect for assertion. */
function harness(over: Partial<DeadWorkerSweepDeps> = {}): {
  deps: DeadWorkerSweepDeps;
  removedWorktrees: string[];
  removedDirs: string[];
} {
  const removedWorktrees: string[] = [];
  const removedDirs: string[] = [];
  const deps: DeadWorkerSweepDeps = {
    // The daemon's verdict: dead unless a test overrides it.
    workerLiveness: async () => "dead",
    issueState: async () => "CLOSED",
    exists: () => true,
    removeWorktree: async (p) => {
      removedWorktrees.push(p);
    },
    removeDir: async (d) => {
      removedDirs.push(d);
    },
    ...over,
  };
  return { deps, removedWorktrees, removedDirs };
}

describe("reclaimDeadWorkers (issue #1219)", () => {
  const ROOT = "/r";
  const NOW = 2_000_000_000;

  it("reclaims a dead, non-preserved worker's worktree AND attempt dir", async () => {
    const { deps, removedWorktrees, removedDirs } = harness();
    const reclaimed = await reclaimDeadWorkers(ROOT, [record(ROOT, "wDEAD", 5, false)], "", deps);
    expect(removedWorktrees).toEqual(["/r/.red/tmp/workers/wDEAD/5-a1/worktree"]);
    expect(removedDirs).toEqual(["/r/.red/tmp/workers/wDEAD/5-a1"]);
    expect(reclaimed).toEqual(["/r/.red/tmp/workers/wDEAD/5-a1"]);
  });

  it("leaves a freshly dead Worker's OPEN-issue workspace untouched", async () => {
    const { deps, removedWorktrees, removedDirs } = harness({
      issueState: async () => "OPEN",
      dirMtimeS: () => NOW,
      nowS: NOW,
    });

    const reclaimed = await reclaimDeadWorkers(
      ROOT,
      [record(ROOT, "wFRESH", 3585, false)],
      "",
      deps,
    );

    expect(removedWorktrees).toEqual([]);
    expect(removedDirs).toEqual([]);
    expect(reclaimed).toEqual([]);
  });

  it("NEVER touches a dir whose Worker the daemon names", async () => {
    const { deps, removedWorktrees, removedDirs } = harness({ workerLiveness: async () => "alive" });
    const reclaimed = await reclaimDeadWorkers(ROOT, [record(ROOT, "wLIVE", 5, true)], "", deps);
    expect(removedWorktrees).toEqual([]);
    expect(removedDirs).toEqual([]);
    expect(reclaimed).toEqual([]);
  });

  it("removes only the worktree of a 14-day dead Worker with an OPEN issue", async () => {
    const { deps, removedWorktrees, removedDirs } = harness({
      issueState: async () => "OPEN",
      dirMtimeS: () => NOW - 14 * 86_400,
      nowS: NOW,
    });
    const reclaimed = await reclaimDeadWorkers(ROOT, [record(ROOT, "wBLOCKED", 6, false)], "", deps);
    expect(removedWorktrees).toEqual(["/r/.red/tmp/workers/wBLOCKED/6-a1/worktree"]);
    expect(removedDirs).toEqual([]);
    expect(reclaimed).toEqual([]);
  });

  it("reclaims a dead worker while preserving a live sibling in the same sweep", async () => {
    // wLIVE alive, wDEAD dead — the verdict is per-Worker, from the daemon.
    const alive = new Set(["/r/.red/tmp/workers/wLIVE"]);
    const { deps, removedDirs } = harness({
      workerLiveness: async (workerDir) => (alive.has(workerDir) ? "alive" : "dead"),
    });
    const reclaimed = await reclaimDeadWorkers(
      ROOT,
      [record(ROOT, "wLIVE", 5, true), record(ROOT, "wDEAD", 6, false)],
      "",
      deps,
    );
    expect(removedDirs).toEqual(["/r/.red/tmp/workers/wDEAD/6-a1"]);
    expect(reclaimed).toEqual(["/r/.red/tmp/workers/wDEAD/6-a1"]);
  });

  it("spares every dir when the daemon does not answer", async () => {
    const { deps, removedWorktrees, removedDirs } = harness({
      workerLiveness: async () => "unknown",
    });
    const reclaimed = await reclaimDeadWorkers(ROOT, [record(ROOT, "wGHOST", 5, false)], "", deps);
    expect(removedWorktrees).toEqual([]);
    expect(removedDirs).toEqual([]);
    expect(reclaimed).toEqual([]);
  });

  it("skips the worktree removal when it does not exist, still reclaims the dir", async () => {
    const { deps, removedWorktrees, removedDirs } = harness({ exists: () => false });
    await reclaimDeadWorkers(ROOT, [record(ROOT, "wDEAD", 5, false)], "", deps);
    expect(removedWorktrees).toEqual([]);
    expect(removedDirs).toEqual(["/r/.red/tmp/workers/wDEAD/5-a1"]);
  });
});
