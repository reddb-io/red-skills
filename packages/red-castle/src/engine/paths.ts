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

export interface EnginePaths {
  readonly redRoot: string;
  readonly stateRoot: string;
  readonly castleStateRoot: string;
  readonly castleHistory: string;
  readonly castleValidation: string;
  /** Named-fleet profile registry (`name -> FleetProfile`). */
  readonly castleFleets: string;
  readonly tmpRoot: string;
  readonly supervisorsRoot: string;
  readonly supervisor: (id: string) => string;
  /** Runtime lane of ONE named fleet's supervisor. */
  readonly fleet: (name: string) => string;
  readonly workersRoot: string;
  readonly worker: (workerId: string) => string;
  /** Live-steer file for a running worker (`workers/<id>/steer.toon`). */
  readonly workerSteerFile: (workerId: string) => string;
  readonly monitorsRoot: string;
  readonly monitor: (id: string) => string;
  readonly worktreesRoot: string;
  readonly workerWorktreesRoot: string;
  readonly workerWorktree: (
    workerId: string,
    ticketId: number | string,
  ) => string;
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
  const workerWorktreesRoot = resolve(worktreesRoot, "workers");

  return {
    redRoot: root,
    stateRoot,
    castleStateRoot,
    castleHistory: resolve(castleStateRoot, "history.toonl"),
    castleValidation: resolve(castleStateRoot, "validation.toonl"),
    castleFleets: resolve(castleStateRoot, "fleets.toonl"),
    tmpRoot,
    supervisorsRoot,
    supervisor: (id) => resolve(supervisorsRoot, id),
    fleet: (name) => resolve(supervisorsRoot, name),
    workersRoot,
    worker: (workerId) => resolve(workersRoot, workerId),
    workerSteerFile: (workerId) => resolve(workersRoot, workerId, "steer.toon"),
    monitorsRoot,
    monitor: (id) => resolve(monitorsRoot, id),
    worktreesRoot,
    workerWorktreesRoot,
    workerWorktree: (workerId, ticketId) =>
      resolve(workerWorktreesRoot, `${workerId}-${ticketId}`),
    worktreeLane: (lane) => resolve(worktreesRoot, lane),
  };
}
