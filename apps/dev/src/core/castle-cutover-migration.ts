// core/castle-cutover-migration.ts — the ONE-TIME, idempotent boot migration
// that carries a machine's live pre-cutover state across the ADR 0130 cutover,
// where the daemon becomes the thing that births Workers.
//
// Pure: this module observes nothing and touches nothing. It receives a
// snapshot of what the machine carries and returns the plan — which is what
// makes every rule below provable without a live supervisor, a real worktree,
// or a running daemon (runtime/castle-cutover-migration.ts does the IO).
//
// **The mechanism is ADR 0105's boot migration, not a second one.** A state-tier
// move already has a precedent here (`core/red-path-migration.ts`): plan purely,
// execute best-effort at boot, never overwrite, and be a pure no-op the second
// time. This record follows it rather than inventing a parallel migration path.
//
// The three rules that decide everything:
//
// 1. **A Worker in flight at cutover time is quiesced, never adopted.** The
//    daemon re-attaches to a Worker by UNIT NAME (`redskilled/reattach.ts`) and
//    a Worker born by the classic path has no unit to be named by. Placement is
//    decided at birth (ADR 0130 rule 4) because moving a live process between
//    resource units does not move the memory it already charged — so a
//    pre-cutover Worker cannot be moved into the host budget after the fact.
//    Adopting it would mean the daemon holding a budget it cannot enforce, which
//    is precisely the unbudgeted spawn ADR 0130 exists to end.
//
// 2. **Quiescing costs supervision, never work.** A quiesced Worker's branch,
//    workspace and claim are left exactly where they are. Git owns the commits
//    and the tracker owns the claim, so the existing crash reconcile path — the
//    one that already returns a dead Worker's Ticket to the queue — is what
//    recovers the Ticket. A stopped Worker is indistinguishable from a crashed
//    one to that path, which is why no new recovery mechanism appears here.
//
// 3. **Only what nothing owns is reclaimed.** A git worktree registration whose
//    workspace is gone is a dangling pointer with no owner, so it is pruned. A
//    branch is never deleted and a workspace holding a real worktree is never
//    removed: both are recoverable work, and reclaiming disk is not worth
//    discarding a Worker's output.

/** Contract id stamped on the migration report. */
export const CASTLE_CUTOVER_CONTRACT = "red.castle.cutover.v1";

/** Env var an operator sets to declare the daemon era in effect on this host. */
export const CASTLE_CUTOVER_ENV = "RED_CASTLE_CUTOVER";

/** The classic supervisor, as the migration finds it. */
export interface CutoverSupervisorObservation {
  pid: number;
  /** Identity-verified liveness, never bare pid existence. */
  live: boolean;
}

/** One Worker workspace the machine carries into the cutover. */
export interface CutoverWorkerObservation {
  workerId: string;
  /** The Ticket the Worker claimed, or null when it died before claiming. */
  issue: number | null;
  pid: number | null;
  live: boolean;
  /** Absolute workspace path (`.red/tmp/workers/<id>`). */
  workspace: string;
  /**
   * Init-system unit the Worker was placed in at birth. A Worker carrying one
   * was born THROUGH the daemon and is already host state; a Worker without one
   * was born by the classic path and is what this migration exists for.
   */
  unit?: string;
}

/** A git worktree registration and whether its directory still exists. */
export interface CutoverWorktreeObservation {
  path: string;
  present: boolean;
}

/** Everything the migration needs to decide, gathered once. */
export interface CastleCutoverObservation {
  supervisor: CutoverSupervisorObservation | null;
  workers: readonly CutoverWorkerObservation[];
  worktrees: readonly CutoverWorktreeObservation[];
}

export type CutoverActionKind = "stop-supervisor" | "quiesce-worker" | "prune-worktree";

/** One thing the migration moves, with the reason it moved it. */
export interface CutoverAction {
  kind: CutoverActionKind;
  /** Human-readable identity of the thing acted on. */
  subject: string;
  reason: string;
  pid?: number;
  issue?: number | null;
  path?: string;
}

/** One thing the migration deliberately leaves behind, with the reason. */
export interface CutoverRetention {
  subject: string;
  reason: string;
}

export interface CastleCutoverPlan {
  actions: readonly CutoverAction[];
  kept: readonly CutoverRetention[];
}

/** The frozen reason strings — the report, the log line and the tests share them. */
export const CUTOVER_REASONS = {
  supervisorStopped:
    "the classic supervisor births Workers the daemon never sees; it is stopped first so it cannot respawn a slot behind the migration",
  workerQuiesced:
    "born by the classic path with no unit name, so the daemon can neither re-attach to it nor move its memory charge into the host budget; its claim returns to the queue through the existing crash reconcile path",
  workerDaemonBorn:
    "born through the daemon and already carried in host state — the cutover has nothing to move",
  workerDead:
    "already dead; its workspace, branch and claim are the crash reconcile path's to recover, not the migration's to discard",
  worktreePruned:
    "a git worktree registration whose workspace no longer exists — a dangling pointer nothing owns",
  worktreeKept:
    "the workspace still exists, so the registration still points at recoverable work",
} as const;

/** True when a Worker was born by the pre-cutover path (it carries no unit). */
export function isPreCutoverWorker(worker: CutoverWorkerObservation): boolean {
  return worker.unit === undefined || worker.unit === "";
}

/**
 * The plan for one machine's pre-cutover state.
 *
 * Order is load-bearing: the supervisor is stopped before any Worker, because a
 * live supervisor answers a Worker's death by spawning a replacement — through
 * the very path the cutover is removing.
 */
export function planCastleCutover(observation: CastleCutoverObservation): CastleCutoverPlan {
  const actions: CutoverAction[] = [];
  const kept: CutoverRetention[] = [];

  const supervisor = observation.supervisor;
  if (supervisor !== null && supervisor.live) {
    actions.push({
      kind: "stop-supervisor",
      subject: `supervisor pid ${supervisor.pid}`,
      reason: CUTOVER_REASONS.supervisorStopped,
      pid: supervisor.pid,
    });
  }

  for (const worker of observation.workers) {
    const subject = worker.issue === null ? worker.workerId : `${worker.workerId} (#${worker.issue})`;
    if (!isPreCutoverWorker(worker)) {
      kept.push({ subject, reason: CUTOVER_REASONS.workerDaemonBorn });
      continue;
    }
    if (!worker.live || worker.pid === null) {
      kept.push({ subject, reason: CUTOVER_REASONS.workerDead });
      continue;
    }
    actions.push({
      kind: "quiesce-worker",
      subject,
      reason: CUTOVER_REASONS.workerQuiesced,
      pid: worker.pid,
      issue: worker.issue,
      path: worker.workspace,
    });
    kept.push({
      subject: `${subject} workspace`,
      reason: CUTOVER_REASONS.workerDead,
    });
  }

  for (const worktree of observation.worktrees) {
    if (worktree.present) {
      kept.push({ subject: worktree.path, reason: CUTOVER_REASONS.worktreeKept });
      continue;
    }
    actions.push({
      kind: "prune-worktree",
      subject: worktree.path,
      reason: CUTOVER_REASONS.worktreePruned,
      path: worktree.path,
    });
  }

  return { actions, kept };
}

/** One line an operator can read at boot: what moved, and what stayed. */
export function summarizeCastleCutover(plan: CastleCutoverPlan): string {
  const stopped = plan.actions.filter((action) => action.kind === "stop-supervisor").length;
  const quiesced = plan.actions.filter((action) => action.kind === "quiesce-worker").length;
  const pruned = plan.actions.filter((action) => action.kind === "prune-worktree").length;
  return (
    `castle cutover: ${stopped} supervisor stopped, ${quiesced} worker(s) quiesced, ` +
    `${pruned} worktree registration(s) pruned, ${plan.kept.length} artifact(s) left in place`
  );
}

/** What the executor actually managed to do, fed back into the report. */
export interface CastleCutoverExecution {
  stopped: readonly string[];
  quiesced: readonly string[];
  pruned: readonly string[];
  /** Actions the host refused; they stay in the report rather than vanishing. */
  failed: readonly string[];
}

/** The stamped, TOON-encodable migration report. */
export interface CastleCutoverReport {
  contract: typeof CASTLE_CUTOVER_CONTRACT;
  at: string;
  moved: {
    stopped: string[];
    quiesced: string[];
    pruned: string[];
    failed: string[];
  };
  kept: { subject: string; reason: string }[];
  reasons: { subject: string; kind: CutoverActionKind; reason: string }[];
}

/** Shape the report the migration stamps once, naming both halves of the move. */
export function buildCastleCutoverReport(
  plan: CastleCutoverPlan,
  execution: CastleCutoverExecution,
  at: string,
): CastleCutoverReport {
  return {
    contract: CASTLE_CUTOVER_CONTRACT,
    at,
    moved: {
      stopped: [...execution.stopped],
      quiesced: [...execution.quiesced],
      pruned: [...execution.pruned],
      failed: [...execution.failed],
    },
    kept: plan.kept.map((entry) => ({ subject: entry.subject, reason: entry.reason })),
    reasons: plan.actions.map((action) => ({
      subject: action.subject,
      kind: action.kind,
      reason: action.reason,
    })),
  };
}

/**
 * Whether the daemon era is in effect for this launch.
 *
 * The gate is explicit rather than inferred: the caller that births Workers
 * through the daemon passes `true`, and an operator can declare it with
 * `RED_CASTLE_CUTOVER=1`. Inferring it from a reachable socket would quiesce a
 * healthy classic supervisor the first time the daemon happened to be running
 * for some other project — a machine-wide stop event triggered by a coincidence.
 */
export function resolveCutoverActive(
  env: Record<string, string | undefined>,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  const raw = env[CASTLE_CUTOVER_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
