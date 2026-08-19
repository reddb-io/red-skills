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
 * asks for `min(target - live, depth)` Workers: live Workers consume capacity,
 * while the queue depth counts work still available for a new Worker. A loop
 * that asked for the remaining capacity regardless of depth would birth Workers
 * for work that is not there.
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
 * **A project that cannot keep a Worker alive stops being asked.** A refusal is
 * the host saying no; a Worker that is born and dies seconds later is the host
 * saying yes to something that cannot run. The second shape has no natural end:
 * the target is unmet, so the loop asks again, and a boot that fails
 * deterministically — a probe that refuses, a precondition that will not become
 * true by waiting — fails identically on the first attempt and the hundredth.
 * Measured before this existed: 108 births and 108 deaths in one hour for one
 * project, average lifetime 13 seconds, each birth spending GitHub quota that is
 * per token and therefore shared with every other project on the machine. The
 * breaker is per project because the fault is: a looping project must not hold
 * back a healthy neighbour, and a host-wide backoff would make it do exactly
 * that.
 *
 * **A clean "nothing to do" is not a loss.** The breaker asks whether a Worker
 * can boot HERE, and one that booted, read the queue, found it empty and said so
 * answered that question with a yes. Counting it as a loss inverted the meaning:
 * on 2026-08-19 a drained queue emptied three Workers within seconds of birth,
 * the latch armed, and when the queue was repaired nothing was born to consume
 * it until an operator cleared the latch by hand. The streak therefore folds an
 * OUTCOME CLASS beside the lifetime — see
 * {@link RedskilledWorkerBirthOutcome} — and only a death that reached no
 * terminal outcome counts.
 *
 * **Rule 3 survives.** A selector and an argv are carried and handed back; not
 * one branch here turns on what either of them says. The planner reads a depth,
 * a target, a count of live Workers and a streak of short-lived deaths — four
 * integers — and nothing else. The outcome class is a closed vocabulary of three
 * words the Worker protocol already speaks, never a repository's reason: this
 * module learns THAT a Worker reached a terminal outcome, never what the work
 * was, and the daemon is owed no more than that.
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

/**
 * A Worker dead sooner than this never reached its work; its birth was spent.
 *
 * Generous on purpose. A Worker that claims an issue, opens a worktree and
 * starts an agent is minutes old before it does anything; one that dies inside
 * this window died in boot, and boot failures are the deterministic kind.
 */
export const REDSKILLED_SHORT_LIFE_MS = 60_000;

/**
 * How many short lives in a row stop a project from being asked again.
 *
 * Three rather than one: a single early death can be a genuine transient (a
 * lock briefly held, a fetch that timed out), and refusing to retry it would
 * turn a blip into an outage. Three in a row is not a blip.
 */
export const REDSKILLED_SHORT_LIFE_STREAK = 3;

/**
 * How long a halted project waits before one Worker is allowed through.
 *
 * The halt expires rather than latching, because the cause is usually outside
 * this process and gets fixed there — a tree committed, a binary installed —
 * with nothing to tell the daemon it happened. One birth after the window is
 * the probe; if it dies short too, the streak re-arms the halt immediately.
 */
export const REDSKILLED_BIRTH_HALT_MS = 600_000;

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
  | "backing-off"
  /** This project's Workers keep dying in boot, so it is not asked again yet. */
  | "birth-halted"
  /** One birth is due or running after the breaker's cooldown. */
  | "half-open-probe";

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
  /**
   * Per project, when its birth halt expires — a project absent from this map
   * is not halted. Keyed by label so one looping project never holds back a
   * healthy one, which a host-wide backoff would.
   */
  readonly birthHaltUntilMs?: Readonly<Record<string, number>>;
  /**
   * The complete breaker state. New callers pass this instead of reducing the
   * state to a halt instant, because an expired halt is a half-open circuit —
   * exactly one probe — rather than an ordinary unlatched project.
   */
  readonly birthHealth?: Readonly<Record<string, RedskilledBirthHealth>>;
}

/**
 * How a refusal says which loss armed the latch. PURE.
 *
 * An unstated class is reported as unstated rather than assumed to be the
 * crashloop: a caller that passed only a halt instant told us when, not why, and
 * a sentence that guessed would be the confusion this whole change removes.
 */
function lossPhrase(outcome: RedskilledWorkerBirthOutcome | null | undefined): string {
  return outcome == null
    ? "outcome class unstated by the caller"
    : `outcome class ${JSON.stringify(outcome)}: ${describeBirthOutcome(outcome)}`;
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
    // Checked before the depth, and deliberately: a halted project is not asked
    // for a Worker whether or not anyone has counted its queue, and reporting
    // "nobody counted yet" for a project whose Workers are dying in boot names
    // the wrong problem to whoever reads it.
    const health = input.birthHealth?.[project.project_label];
    const haltUntilMs = health?.haltUntilMs ?? input.birthHaltUntilMs?.[project.project_label];
    if (haltUntilMs != null && input.nowMs < haltUntilMs) {
      intents.push({
        ...base,
        outcome: "birth-halted",
        wanted: 0,
        detail:
          `project ${JSON.stringify(project.project_label)} lost ` +
          `${REDSKILLED_SHORT_LIFE_STREAK} Workers in a row inside ` +
          `${REDSKILLED_SHORT_LIFE_MS}ms of birth (each ${lossPhrase(health?.lossOutcome)}), so it is not asked ` +
          `for another before ${new Date(haltUntilMs).toISOString()} — a Worker that cannot survive boot will not ` +
          `survive the next one either, and every birth spends host quota shared with every project`,
      });
      continue;
    }
    if (health?.probeWorkerId != null) {
      intents.push({
        ...base,
        outcome: "half-open-probe",
        wanted: 0,
        detail:
          `project ${JSON.stringify(project.project_label)} is half-open and probe Worker ` +
          `${JSON.stringify(health.probeWorkerId)} has not yet survived ${REDSKILLED_SHORT_LIFE_MS}ms, ` +
          `so no second birth is admitted`,
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

    // Live Workers consume project capacity, while queue depth counts work that
    // remains available for new Workers. A Worker already busy on de-queued work
    // therefore cannot consume a freshly queued item as well.
    const wanted = Math.max(0, Math.min(Math.max(0, project.target - live), depth));
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
    const halfOpen = health?.haltUntilMs != null && input.nowMs >= health.haltUntilMs;
    const admitted = halfOpen ? 1 : wanted;
    intents.push({
      ...base,
      outcome: halfOpen ? "half-open-probe" : "asking",
      wanted: admitted,
      detail: halfOpen
        ? `project ${JSON.stringify(project.project_label)} finished its birth-breaker cooldown, so exactly one ` +
          `probe Worker is admitted before the remaining ${Math.max(0, wanted - 1)} birth(s)`
        : `project ${JSON.stringify(project.project_label)} holds ${live} Worker(s) against a target of ` +
          `${project.target} and a queue of ${depth}, so it asks for ${wanted} more`,
    });
    for (let index = 0; index < admitted; index += 1) {
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
  /** Exact commit the daemon fetched before admitting this birth. */
  readonly fork_sha?: string;
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

/**
 * What one dead Worker managed to REPORT before it ended. PURE vocabulary.
 *
 * Three words, and every one of them is the Worker protocol's own — a
 * `<promise>` sentinel — rather than a repository's account of its work. The
 * distinction the breaker needs is exactly this coarse: a Worker that reached
 * any terminal outcome proved boot works here, and a Worker that reached none is
 * the shape the breaker exists to stop.
 */
export type RedskilledWorkerBirthOutcome =
  /** Exited cleanly having reported the queue held nothing eligible for it. */
  | "no-eligible-work"
  /** Exited cleanly having reported a terminal verdict on work it took. */
  | "work-reported"
  /** Ended without reaching any terminal outcome — the loss the breaker counts. */
  | "unreported";

/** How an operator reading one line should hear an outcome class. PURE. */
export function describeBirthOutcome(outcome: RedskilledWorkerBirthOutcome): string {
  switch (outcome) {
    case "no-eligible-work":
      return "exited cleanly reporting no eligible work";
    case "work-reported":
      return "exited cleanly reporting a terminal outcome on its work";
    default:
      return "died before reporting any terminal outcome";
  }
}

/**
 * One project's record of Workers that died before they could work.
 *
 * The streak, not a rate: a project that loses one Worker an hour is not
 * looping, and a rate would eventually smear a tight loop into an average that
 * looks survivable. Consecutive is the property that distinguishes "boot cannot
 * succeed here" from "one Worker had bad luck".
 */
export interface RedskilledBirthHealth {
  /** Consecutive Workers that died inside {@link REDSKILLED_SHORT_LIFE_MS}. */
  readonly shortLifeStreak: number;
  /** When this project may be asked for a Worker again; `null` when it may now. */
  readonly haltUntilMs: number | null;
  /** The instant the current open period began; refreshed after a failed probe. */
  readonly openedAtMs: number | null;
  /** The sole half-open Worker; while present no second birth is admitted. */
  readonly probeWorkerId: string | null;
  /**
   * The outcome class of the deaths in the current streak; `null` with no streak.
   *
   * Carried so the refusal an operator reads names WHICH loss armed the latch —
   * a crashloop and a drained queue produced the same sentence before, and only
   * one of them is a project to distrust.
   */
  readonly lossOutcome: RedskilledWorkerBirthOutcome | null;
}

/** A project with no history — never halted, no streak. */
export const EMPTY_BIRTH_HEALTH: RedskilledBirthHealth = {
  shortLifeStreak: 0,
  haltUntilMs: null,
  openedAtMs: null,
  probeWorkerId: null,
  lossOutcome: null,
};

/** The structured cure carried beside every visible birth latch. */
export interface RedskilledBirthLatchRepair {
  readonly tool: "project_reset";
  readonly args: { readonly latch: "project-birth-breaker" };
  readonly why: string;
}

/** One project's birth-refusing latch, in the shape read surfaces expose. */
export interface RedskilledBirthLatch {
  readonly name: "project-birth-breaker";
  readonly project_label: string;
  readonly state: "open" | "half-open";
  readonly opened_at: string;
  readonly reason: string;
  readonly closes: string;
  readonly probe_worker_id: string | null;
  readonly repair: RedskilledBirthLatchRepair;
}

/**
 * Fold one Worker's death into its project's birth health. PURE.
 *
 * **A long life clears the streak outright rather than decrementing it.** The
 * question the streak answers is "can a Worker boot here right now", and one
 * that did is a complete answer — carrying forward failures from before a
 * working boot would halt a project that has already recovered.
 *
 * **A reported terminal outcome clears the streak exactly as a long life does,
 * however short the Worker lived.** A Worker that boots, reads the queue, finds
 * nothing eligible and says so is not a Worker that failed to boot — it is the
 * proof the chain works, delivered in seconds. Counting it armed the breaker on
 * a drained queue and then refused every birth that would have consumed the
 * queue once it was refilled. Only `unreported` — an end with no terminal
 * outcome behind it — is a loss, which leaves the guard's original job whole: a
 * probe that refuses, a workspace that will not materialise and a runner that is
 * not installed all end that way.
 *
 * The halt is armed on the death that completes the streak and re-armed by
 * every short death after it, so a project probed after the window and still
 * broken goes quiet again immediately instead of leaking one birth per window
 * forever.
 */
export function foldWorkerDeath(
  health: RedskilledBirthHealth,
  lifetimeMs: number,
  nowMs: number,
  outcome: RedskilledWorkerBirthOutcome = "unreported",
): RedskilledBirthHealth {
  if (outcome !== "unreported") return EMPTY_BIRTH_HEALTH;
  if (lifetimeMs >= REDSKILLED_SHORT_LIFE_MS) return EMPTY_BIRTH_HEALTH;
  const shortLifeStreak = health.shortLifeStreak + 1;
  const wasLatched = health.haltUntilMs != null || health.probeWorkerId != null;
  if (!wasLatched && shortLifeStreak < REDSKILLED_SHORT_LIFE_STREAK) {
    return { shortLifeStreak, haltUntilMs: null, openedAtMs: null, probeWorkerId: null, lossOutcome: outcome };
  }
  return {
    shortLifeStreak,
    haltUntilMs: nowMs + REDSKILLED_BIRTH_HALT_MS,
    openedAtMs: nowMs,
    probeWorkerId: null,
    lossOutcome: outcome,
  };
}

/** Mark the one Worker admitted by a half-open circuit. PURE. */
export function beginBirthProbe(health: RedskilledBirthHealth, workerId: string): RedskilledBirthHealth {
  return health.haltUntilMs == null
    ? health
    : { ...health, probeWorkerId: workerId };
}

/** Explicit operator reset and successful-probe closure share one transition. PURE. */
export function resetBirthHealth(): RedskilledBirthHealth {
  return EMPTY_BIRTH_HEALTH;
}

/** Compose the one truthful latch record every read surface carries. PURE. */
export function describeBirthLatch(
  projectLabel: string,
  health: RedskilledBirthHealth,
  nowMs: number,
): RedskilledBirthLatch | null {
  if (health.haltUntilMs == null || health.openedAtMs == null) return null;
  const halfOpen = nowMs >= health.haltUntilMs;
  return {
    name: "project-birth-breaker",
    project_label: projectLabel,
    state: halfOpen ? "half-open" : "open",
    opened_at: new Date(health.openedAtMs).toISOString(),
    reason:
      `${health.shortLifeStreak} Workers from this project died before surviving ` +
      `${REDSKILLED_SHORT_LIFE_MS}ms (${lossPhrase(health.lossOutcome)})`,
    closes: halfOpen
      ? health.probeWorkerId == null
        ? "the next demand tick admits one probe Worker; surviving the short-life window closes the latch"
        : `probe Worker ${JSON.stringify(health.probeWorkerId)} surviving ${REDSKILLED_SHORT_LIFE_MS}ms closes ` +
          "the latch; a fast death re-opens it with a fresh cooldown"
      : `the cooldown ends at ${new Date(health.haltUntilMs).toISOString()}, then one probe Worker is admitted; ` +
        "surviving the short-life window closes the latch",
    probe_worker_id: health.probeWorkerId,
    repair: {
      tool: "project_reset",
      args: { latch: "project-birth-breaker" },
      why: "clear the project's birth-breaker history and allow the next demand tick to birth normally",
    },
  };
}

/** Every active latch, stable by project label for host-state readers. PURE. */
export function describeBirthLatches(
  health: Readonly<Record<string, RedskilledBirthHealth>>,
  nowMs: number,
): readonly RedskilledBirthLatch[] {
  return Object.entries(health)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([projectLabel, record]) => describeBirthLatch(projectLabel, record, nowMs))
    .filter((latch): latch is RedskilledBirthLatch => latch != null);
}

/**
 * The halt map `planHostDemand` reads, from a health record per project. PURE.
 *
 * An expired halt is dropped rather than kept as a past instant, so the planner
 * compares against present halts only and a stale entry can never read as one.
 */
export function birthHaltMap(
  health: Readonly<Record<string, RedskilledBirthHealth>>,
  nowMs: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [label, record] of Object.entries(health)) {
    if (record.haltUntilMs != null && nowMs < record.haltUntilMs) out[label] = record.haltUntilMs;
  }
  return out;
}
