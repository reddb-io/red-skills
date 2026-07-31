// core/two-player-migration.ts — the ONE-TIME, idempotent boot migration that
// carries a machine already running per-project runtimes into the two-player
// model of ADR 0130 Amendment 4: the project's MCP registers, the daemon polls.
//
// Pure: this module observes nothing and touches nothing. It receives a snapshot
// of what the machine carries and returns the plan, which is what makes every
// rule below provable without a live runtime, a real workspace or a running
// daemon (runtime/two-player-migration.ts does the IO).
//
// **The mechanism is ADR 0105's boot migration, not a third one.** A state-tier
// move has a precedent twice over here — `core/red-path-migration.ts` and
// `core/castle-cutover-migration.ts` — so this record follows it: plan purely,
// execute best-effort at boot, never overwrite, and be a pure no-op the second
// time.
//
// **This is a re-adoption, not an evacuation.** That is the one way it differs
// from the ADR 0130 cutover it follows. A Worker is an init-system unit, so it
// outlives the runtime that asked for it, and the daemon already re-attaches to
// it by unit name. The previous cutover had to quiesce Workers because they were
// born by a path with no unit to be named by; these Workers were born through the
// daemon and carry one, so stopping them would strand work the model can keep.
//
// The five rules that decide everything:
//
// 1. **A live per-project runtime is stopped, and stopped first.** It is the
//    third player Amendment 4 removes — a process that keeps asking for Workers
//    on a loop the daemon now owns. Stopping it first means nothing it decides
//    can land behind the migration.
//
// 2. **A live Worker is re-adopted, never stopped.** It survives its parent by
//    construction, and the daemon's reattach path names it by unit. Stranding one
//    is the exact failure this migration exists to prevent.
//
// 3. **Re-adoption carries the project label.** A Worker the host holds under a
//    stated placeholder is one an operator cannot route back to a repository, so
//    the label the stopped runtime owned travels with the Worker into host state.
//
// 4. **A claim is never released.** The Worker still holds it and is still
//    working, so returning the Ticket to the queue would put two Workers on one
//    piece of work. A DEAD Worker's claim is the crash reconcile path's, exactly
//    as before — the migration discards nothing and recovers nothing itself.
//
// 5. **The migration never registers the project.** Registering is the MCP's
//    one contribution to the two-player model, and it carries a selector and an
//    argv only the project states — a migration that invented either would start
//    Workers on work nobody asked for. So the migration removes the process that
//    would refuse the registration and names the registration as the caller's
//    next move. That is also what makes the plan idempotent independently of the
//    stamp: a machine already in the two-player model produces no action at all.

/** Contract id stamped on the migration report. */
export const TWO_PLAYER_CONTRACT = "red.castle.two-player.v1";

/** Env var an operator sets to declare the two-player era in effect on this host. */
export const TWO_PLAYER_ENV = "RED_TWO_PLAYER_CUTOVER";

/**
 * Where an operator goes when the migration misbehaves.
 *
 * Named in the boot summary AND stamped in the report, because the moment the
 * path is needed is the moment the machine is confusing: an operator reading a
 * one-line notice must not have to find out where the way back is written.
 */
export const TWO_PLAYER_RECOVERY_DOC =
  ".red/adr/0130-redskilled-host-scoped-execution-daemon.md#recovering-from-a-bad-two-player-migration";

/** The per-project runtime, as the migration finds it. */
export interface TwoPlayerRuntimeObservation {
  pid: number;
  /** Identity-verified liveness, never bare pid existence. */
  live: boolean;
}

/** One Worker the machine carries into the two-player model. */
export interface TwoPlayerWorkerObservation {
  workerId: string;
  /** The Ticket the Worker claimed, or null when it died before claiming. */
  issue: number | null;
  pid: number | null;
  live: boolean;
  /** The init-system unit the Worker was placed in at birth, when it has one. */
  unit?: string;
  /** Absolute workspace path (`.red/tmp/workers/<id>`). */
  workspace: string;
  /** Whether the daemon already carries this Worker in `host-state`. */
  heldByHost: boolean;
}

/** Everything the migration needs to decide, gathered once. */
export interface TwoPlayerObservation {
  /** The one opaque string the daemon keys this project by. */
  projectLabel: string;
  runtime: TwoPlayerRuntimeObservation | null;
  workers: readonly TwoPlayerWorkerObservation[];
  /** Whether the daemon already holds a registration for this project. */
  registered: boolean;
}

export type TwoPlayerActionKind = "stop-runtime" | "readopt-worker";

/** One thing the migration moves, with the reason it moved it. */
export interface TwoPlayerAction {
  kind: TwoPlayerActionKind;
  /** Human-readable identity of the thing acted on. */
  subject: string;
  reason: string;
  pid?: number;
  workerId?: string;
  projectLabel?: string;
  issue?: number | null;
  unit?: string;
}

/** One thing the migration deliberately leaves behind, with the reason. */
export interface TwoPlayerRetention {
  subject: string;
  reason: string;
}

export interface TwoPlayerPlan {
  actions: readonly TwoPlayerAction[];
  kept: readonly TwoPlayerRetention[];
}

/** The frozen reason strings — the report, the log line and the tests share them. */
export const TWO_PLAYER_REASONS = {
  runtimeStopped:
    "the per-project runtime is the third player ADR 0130 Amendment 4 removes; it is stopped first so no demand it decides can land behind the migration",
  runtimeAlreadyGone:
    "the runtime is already dead, so the machine has one fewer player to remove and nothing to stop",
  workerReadopted:
    "an init-system unit that outlives the runtime that asked for it, so the daemon re-attaches to it by unit name and holds it under this project's label — stopping it would strand work in flight",
  workerAlreadyHeld:
    "already carried in host state under its project label — the migration has nothing to move",
  workerDead:
    "already dead; its workspace, branch and claim are the crash reconcile path's to recover, not the migration's to discard",
  claimKept:
    "the Worker survives the migration and is still working the Ticket, so releasing its claim would put a second Worker on the same work",
  workspaceKept:
    "the workspace and its branch hold committed and uncommitted work git owns; reclaiming disk is never worth discarding a Worker's output",
  projectRegistrationIsCallers:
    "a registration carries a selector and an argv only the project states, so the migration clears the process that would refuse it and leaves the registering to the MCP — the one player entitled to make it",
  projectAlreadyRegistered:
    "the daemon already holds this project, so the machine is already in the two-player model",
} as const;

/**
 * The plan for one machine's pre-migration state.
 *
 * Order is load-bearing: the runtime is stopped before any Worker is re-adopted,
 * because a live runtime answers a Worker's death by asking for a replacement —
 * through the very loop the two-player model moved into the daemon.
 */
export function planTwoPlayerMigration(observation: TwoPlayerObservation): TwoPlayerPlan {
  const actions: TwoPlayerAction[] = [];
  const kept: TwoPlayerRetention[] = [];

  const runtime = observation.runtime;
  if (runtime !== null) {
    if (runtime.live) {
      actions.push({
        kind: "stop-runtime",
        subject: `project runtime pid ${runtime.pid}`,
        reason: TWO_PLAYER_REASONS.runtimeStopped,
        pid: runtime.pid,
      });
    } else {
      kept.push({
        subject: `project runtime pid ${runtime.pid}`,
        reason: TWO_PLAYER_REASONS.runtimeAlreadyGone,
      });
    }
  }

  for (const worker of observation.workers) {
    const subject = worker.issue === null ? worker.workerId : `${worker.workerId} (#${worker.issue})`;
    if (!worker.live) {
      kept.push({ subject, reason: TWO_PLAYER_REASONS.workerDead });
      continue;
    }
    kept.push({ subject: `${subject} claim`, reason: TWO_PLAYER_REASONS.claimKept });
    kept.push({ subject: `${subject} workspace`, reason: TWO_PLAYER_REASONS.workspaceKept });
    if (worker.heldByHost) {
      kept.push({ subject, reason: TWO_PLAYER_REASONS.workerAlreadyHeld });
      continue;
    }
    actions.push({
      kind: "readopt-worker",
      subject,
      reason: TWO_PLAYER_REASONS.workerReadopted,
      workerId: worker.workerId,
      projectLabel: observation.projectLabel,
      issue: worker.issue,
      ...(worker.unit !== undefined ? { unit: worker.unit } : {}),
    });
  }

  kept.push({
    subject: observation.projectLabel,
    reason: observation.registered
      ? TWO_PLAYER_REASONS.projectAlreadyRegistered
      : TWO_PLAYER_REASONS.projectRegistrationIsCallers,
  });

  return { actions, kept };
}

/** One line an operator can read at boot: what moved, what stayed, where to go. */
export function summarizeTwoPlayerMigration(plan: TwoPlayerPlan): string {
  const stopped = plan.actions.filter((action) => action.kind === "stop-runtime").length;
  const readopted = plan.actions.filter((action) => action.kind === "readopt-worker").length;
  return (
    `two-player migration: ${stopped} project runtime stopped, ${readopted} worker(s) re-adopted, ` +
    `${plan.kept.length} artifact(s) left in place — recovery: ${TWO_PLAYER_RECOVERY_DOC}`
  );
}

/** What the executor actually managed to do, fed back into the report. */
export interface TwoPlayerExecution {
  stopped: readonly string[];
  readopted: readonly string[];
  /** Actions the host refused; they stay in the report rather than vanishing. */
  failed: readonly string[];
}

/** The stamped, TOON-encodable migration report. */
export interface TwoPlayerReport {
  contract: typeof TWO_PLAYER_CONTRACT;
  at: string;
  /** Where an operator goes when this report describes something wrong. */
  recovery: typeof TWO_PLAYER_RECOVERY_DOC;
  moved: {
    stopped: string[];
    readopted: string[];
    failed: string[];
  };
  kept: { subject: string; reason: string }[];
  reasons: { subject: string; kind: TwoPlayerActionKind; reason: string }[];
}

/** Shape the report the migration stamps once, naming both halves of the move. */
export function buildTwoPlayerReport(
  plan: TwoPlayerPlan,
  execution: TwoPlayerExecution,
  at: string,
): TwoPlayerReport {
  return {
    contract: TWO_PLAYER_CONTRACT,
    at,
    recovery: TWO_PLAYER_RECOVERY_DOC,
    moved: {
      stopped: [...execution.stopped],
      readopted: [...execution.readopted],
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
 * Whether the two-player era is in effect for this launch.
 *
 * Explicit rather than inferred, for the same reason the previous cutover was:
 * the caller that registers instead of launching a runtime passes `true`, and an
 * operator can declare it with `RED_TWO_PLAYER_CUTOVER=1`. Inferring it from a
 * reachable daemon would stop a healthy per-project runtime the first time the
 * daemon happened to be up for some other project.
 */
export function resolveTwoPlayerActive(
  env: Record<string, string | undefined>,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  const raw = env[TWO_PLAYER_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
