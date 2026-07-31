/**
 * demand-loop — the daemon decides WHEN to ask for the next Worker, not only
 * whether one may be born.
 *
 * ADR 0130 Amendment 4 closes a gap the producer left open. A per-project
 * runtime had to accept a smaller grant without arguing, because *"the host is
 * the only authority that can see every project at once"* — and a component that
 * defers on **how many** Workers exist while independently deciding **when** to
 * ask is deferring on the half it can see and insisting on the half it cannot.
 * Target resolution, the decision to ask, and shortfall accounting live here, in
 * the one process that holds every project's registration and every project's
 * live Worker at the same instant.
 *
 * **The queue bounds the target, and the target bounds nothing else.** A project
 * asks for `min(target, depth) - live` Workers: a registration states how wide
 * the project may go, the queue states how much work exists to go wide on, and
 * the smaller of the two is the honest answer. A loop that asked for the target
 * regardless of depth would birth Workers for work that is not there.
 *
 * **A depth is never invented.** `0` means the queue drained; an absent depth
 * means nobody counted it, and the two are told apart in the sentence a reader
 * gets, because only the first of them is a project that has finished. The
 * distinction is `queue-discovery`'s and this module preserves it rather than
 * folding both into "nothing to do".
 *
 * **A refusal ends the whole tick and starts a backoff.** The host refuses on a
 * host-wide ceiling, so the next request would be asked only to be refused —
 * asking anyway is exactly how a full machine becomes a busy loop. The refusal
 * is recorded as an ordinary outcome carrying the host's own words, never as an
 * error, because the host is the party that knows.
 *
 * **Rule 3 survives.** A selector and an argv are carried and handed back; not
 * one branch here turns on what either of them says. The planner reads a depth,
 * a target and a count of live Workers — three integers — and nothing else.
 *
 * PURE.
 */

/**
 * How long the loop waits after a refusal before asking again.
 *
 * Long enough that a full machine is quiet rather than spinning, short enough
 * that the Worker which frees the room is followed by a birth within one poll
 * window rather than one coffee.
 */
export const REDSKILLED_DEMAND_BACKOFF_MS = 30_000;

/** Default window between demand ticks — the queue's cadence, by construction. */
export const DEFAULT_REDSKILLED_DEMAND_MS = 15_000;

/** One registered project, as the loop reads it: three integers and two opaque values. */
export interface RedskilledDemandProject {
  readonly project_label: string;
  /** The query that names this project's work. Carried, never read. */
  readonly selector: string;
  /** What to run when a Worker is born for it. Carried, never read. */
  readonly argv: readonly string[];
  /** Used verbatim as the Worker's working directory. */
  readonly workspace_path: string;
  readonly target: number;
}

/** What the loop decided about one project this tick, and why. */
export type RedskilledDemandOutcome =
  | "asking"
  | "at-target"
  | "queue-drained"
  | "queue-unknown"
  | "backing-off";

export interface RedskilledDemandIntent {
  readonly project_label: string;
  readonly outcome: RedskilledDemandOutcome;
  /** What the last poll counted; `null` whenever no poll produced a number. */
  readonly queue_depth: number | null;
  readonly target: number;
  readonly live: number;
  /** Births this project would ask for, once the queue and its live set bounded it. */
  readonly wanted: number;
  readonly detail: string;
}

/** One Worker the loop will ask the host for. */
export interface RedskilledDemandBirth {
  readonly project_label: string;
  /** Which of this project's requests this is, from zero. */
  readonly index: number;
  readonly argv: readonly string[];
  readonly workspace_path: string;
}

export interface RedskilledDemandPlan {
  readonly intents: readonly RedskilledDemandIntent[];
  /** In the order they will be asked for; empty when nothing is wanted. */
  readonly births: readonly RedskilledDemandBirth[];
}

export interface PlanHostDemandInput {
  readonly projects: readonly RedskilledDemandProject[];
  /** Depth by project label; a missing key is a project no poll has counted yet. */
  readonly queue: Readonly<Record<string, number | null>>;
  /** Live Workers by project label, as the host counts them. */
  readonly live: Readonly<Record<string, number>>;
  readonly nowMs: number;
  /** When the host's last refusal stops holding the loop back; absent when none does. */
  readonly backoffUntilMs?: number | null;
}

/**
 * Decide what every registered project may ask for this tick. PURE.
 *
 * **Births are spread one apiece before a second**, so the project that happens
 * to sort first cannot take the whole host while the others wait for the next
 * tick. Order inside a round is by label, which is a fact about the registration
 * set rather than about what any selector says.
 */
export function planHostDemand(input: PlanHostDemandInput): RedskilledDemandPlan {
  const projects = [...input.projects].sort((left, right) =>
    left.project_label.localeCompare(right.project_label)
  );
  const backoffUntilMs = input.backoffUntilMs ?? null;
  const holding = backoffUntilMs != null && input.nowMs < backoffUntilMs;

  const intents: RedskilledDemandIntent[] = [];
  const rounds: RedskilledDemandBirth[][] = [];

  for (const project of projects) {
    const live = Math.max(0, input.live[project.project_label] ?? 0);
    const counted = Object.prototype.hasOwnProperty.call(input.queue, project.project_label);
    const depth = counted ? input.queue[project.project_label] ?? null : null;
    const base = { project_label: project.project_label, queue_depth: depth, target: project.target, live };

    if (holding) {
      intents.push({
        ...base,
        outcome: "backing-off",
        wanted: 0,
        detail:
          `the host refused a Worker, so no project is asked for one again before ` +
          `${new Date(backoffUntilMs!).toISOString()}`,
      });
      continue;
    }
    if (depth == null) {
      intents.push({
        ...base,
        outcome: "queue-unknown",
        wanted: 0,
        detail: counted
          ? `the last poll produced no depth for project ${JSON.stringify(project.project_label)}, and an absent ` +
            `depth is not a drained queue`
          : `no poll has counted project ${JSON.stringify(project.project_label)} yet, so it is not asked for a ` +
            `Worker on a depth nobody measured`,
      });
      continue;
    }
    if (depth === 0) {
      intents.push({
        ...base,
        outcome: "queue-drained",
        wanted: 0,
        detail: `project ${JSON.stringify(project.project_label)} has nothing queued, so it is asked for no Worker`,
      });
      continue;
    }

    // The queue bounds the target: a project may be as wide as it registered
    // for, but never wider than the work that exists to be done.
    const wanted = Math.max(0, Math.min(Math.max(0, project.target), depth) - live);
    if (wanted === 0) {
      intents.push({
        ...base,
        outcome: "at-target",
        wanted: 0,
        detail:
          `project ${JSON.stringify(project.project_label)} holds ${live} Worker(s) against a target of ` +
          `${project.target} and a queue of ${depth}, so it asks for none`,
      });
      continue;
    }
    intents.push({
      ...base,
      outcome: "asking",
      wanted,
      detail:
        `project ${JSON.stringify(project.project_label)} holds ${live} Worker(s) against a target of ` +
        `${project.target} and a queue of ${depth}, so it asks for ${wanted} more`,
    });
    for (let index = 0; index < wanted; index += 1) {
      const round = rounds[index] ?? (rounds[index] = []);
      round.push({
        project_label: project.project_label,
        index: live + index,
        argv: project.argv,
        workspace_path: project.workspace_path,
      });
    }
  }

  return { intents, births: rounds.flat() };
}

/** One Worker the host granted this tick, in the facts a reader needs back. */
export interface RedskilledDemandGrant {
  readonly project_label: string;
  readonly worker_id: string;
  readonly pid: number;
  /** Warnings the host attached — a downgraded unit is running AND degraded. */
  readonly warnings: readonly string[];
}

/**
 * One tick of the loop, as the daemon reports it.
 *
 * A refusal rides here rather than throwing: the tick did what the machine
 * allowed, which is an outcome and not a fault.
 */
export interface RedskilledDemandTick {
  readonly version: 1;
  readonly at: string;
  readonly requested: number;
  readonly granted: readonly RedskilledDemandGrant[];
  /** Requests the host did not grant; zero when the machine had the room. */
  readonly shortfall: number;
  /** The host's own words for the refusal that ended this tick, if one did. */
  readonly refusal: string | null;
  /** When the loop will ask again after that refusal; `null` when none stands. */
  readonly retry_after: string | null;
  readonly projects: readonly RedskilledDemandIntent[];
}

/** The tick a daemon with nothing registered has: honest, and empty. */
export function emptyDemandTick(at: string): RedskilledDemandTick {
  return {
    version: 1,
    at,
    requested: 0,
    granted: [],
    shortfall: 0,
    refusal: null,
    retry_after: null,
    projects: [],
  };
}

/** True when `value` is a complete tick — a client's fail-closed check. */
export function isRedskilledDemandTick(value: unknown): value is RedskilledDemandTick {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const tick = value as Record<string, unknown>;
  return tick.version === 1 &&
    typeof tick.at === "string" &&
    Number.isInteger(tick.requested) &&
    Array.isArray(tick.granted) &&
    Number.isInteger(tick.shortfall) &&
    (tick.refusal === null || typeof tick.refusal === "string") &&
    (tick.retry_after === null || typeof tick.retry_after === "string") &&
    Array.isArray(tick.projects);
}
