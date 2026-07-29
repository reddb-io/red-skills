import { resolve } from "node:path";

export const CASTLE_WORKTREE_LANES = [
  "manual",
  "feedback",
  "landing",
  "rebase",
  "cascade",
  "adopt",
  "reconcile",
  "docs",
] as const;

export type CastleWorktreeLane = (typeof CASTLE_WORKTREE_LANES)[number];

/**
 * On-disk name of the project's single supervisor runtime lane. It reads as a
 * plain constant rather than a parameter because a project has exactly one
 * supervisor: the per-fleet lanes it once sat beside are gone (ADR 0130). The
 * name is retained so a checkout written by an older bundle still reads.
 */
export const PROJECT_SUPERVISOR_LANE = "default";

export interface EnginePaths {
  readonly redRoot: string;
  readonly stateRoot: string;
  readonly castleStateRoot: string;
  readonly castleHistory: string;
  readonly castleValidation: string;
  readonly tmpRoot: string;
  readonly supervisorsRoot: string;
  readonly supervisor: (id: string) => string;
  /**
   * The project's ONE supervisor runtime lane. There is exactly one — never one
   * per fleet (ADR 0130) — and it keeps the on-disk name it carried before named
   * fleets existed, so an existing checkout still reads its own state.
   */
  readonly projectSupervisor: string;
  readonly workersRoot: string;
  readonly worker: (workerId: string) => string;
  /** Live-steer file for a running worker (`workers/<id>/steer.toon`). */
  readonly workerSteerFile: (workerId: string) => string;
  readonly monitorsRoot: string;
  readonly monitor: (id: string) => string;
  /**
   * Shared pipeline/maintainer worktree lanes root. A WORKER's git worktree
   * does NOT live here: the castle materialises it at the worker's own
   * conventional workspace child, `tmp/workers/{id}/{issue}/worktree`
   * (ADR 0105 as re-amended).
   */
  readonly worktreesRoot: string;
  readonly worktreeLane: (lane: CastleWorktreeLane) => string;
}

export function createEnginePaths(redRoot: string): EnginePaths {
  const root = resolve(redRoot);
  const stateRoot = resolve(root, "state");
  const castleStateRoot = resolve(stateRoot, "castle");
  const tmpRoot = resolve(root, "tmp");
  const supervisorsRoot = resolve(tmpRoot, "supervisors");
  const workersRoot = resolve(tmpRoot, "workers");
  const monitorsRoot = resolve(tmpRoot, "monitors");
  const worktreesRoot = resolve(tmpRoot, "worktrees");

  return {
    redRoot: root,
    stateRoot,
    castleStateRoot,
    castleHistory: resolve(castleStateRoot, "history.toonl"),
    castleValidation: resolve(castleStateRoot, "validation.toonl"),
    tmpRoot,
    supervisorsRoot,
    supervisor: (id) => resolve(supervisorsRoot, id),
    projectSupervisor: resolve(supervisorsRoot, PROJECT_SUPERVISOR_LANE),
    workersRoot,
    worker: (workerId) => resolve(workersRoot, workerId),
    workerSteerFile: (workerId) => resolve(workersRoot, workerId, "steer.toon"),
    monitorsRoot,
    monitor: (id) => resolve(monitorsRoot, id),
    worktreesRoot,
    worktreeLane: (lane) => resolve(worktreesRoot, lane),
  };
}
