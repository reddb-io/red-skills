// reseed-budget — the lane-scoped Re-seed budget (ADR 0129, Spec #2723).
//
// A **Re-seed** re-instructs the implementer in place — same Worker, same
// Worktree, same branch — after a gate stage blocked the work. The **Re-seed
// budget** bounds how many such rounds one Worker may spend: ONE ceiling per
// lane holding per-cause sub-caps, with the review's round modelled as a
// RESERVATION the other causes cannot draw from.
//
// The Worker is the unit because it is the only one there is. A Re-seed keeps
// the same Worker by construction, so its rounds are events inside one running
// Worker rather than a new unit of work — which is exactly why the budget is
// held in that Worker's own memory and needs no identity of its own.
//
// The reservation is the whole point. Under independent counters, gate churn
// burns every available round first and a Ticket parks on precisely the round a
// blocking review finding just asked for — the starvation defect ADR 0129 names.
// Reserving the review's round makes it unreachable to gate and tier draws even
// while the ceiling still has room.
//
// The standalone stall-convergence counter is GONE (#2733): its key carries an
// ADR 0117 tombstone and its replacement, `dev.reseed.afk.gate_budget`, folds in
// through {@link withGateSubCap} as one cause's SHARE of this budget. The lane
// keeps the ceiling and the review's reservation, so no operator setting can buy
// an unbounded run or starve the review's round.

import { LABEL_GO_LANE } from "../go.js";

/** The closed vocabulary of causes that may spend a Re-seed round. The `/go`
 * lane is NOT a cause — it is a budget profile. */
export type ReseedCause = "gate" | "tier" | "review";

export const RESEED_CAUSES: readonly ReseedCause[] = ["gate", "tier", "review"];

/** The two rulers. The mechanism is identical across lanes; only the numbers
 * differ, because the difference between them is economic (a human waits on
 * `/go`) and not structural. */
export type ReseedLane = "/afk" | "/go";

export interface ReseedBudget {
  readonly lane: ReseedLane;
  /** Total Re-seed rounds this Worker may spend across ALL causes. */
  readonly ceiling: number;
  /** Per-cause ceilings. These may sum ABOVE {@link ceiling} on purpose: they
   * bound each cause's share, while the ceiling bounds the whole. */
  readonly subCaps: Readonly<Record<ReseedCause, number>>;
  /** Rounds held for a cause and unreachable to every other cause. */
  readonly reserved: Readonly<Record<ReseedCause, number>>;
}

/** Rounds already spent, per cause. An absent cause has spent none. */
export type ReseedSpend = Partial<Record<ReseedCause, number>>;

/** Why a draw was refused. `sub-cap` — the cause exhausted its own share;
 * `reservation` — the ceiling still has room, but every remaining round is held
 * for another cause; `ceiling` — nothing is left at all. */
export type ReseedRefusal = "sub-cap" | "reservation" | "ceiling";

export interface ReseedDraw {
  readonly allowed: boolean;
  readonly refusal?: ReseedRefusal;
  /** Rounds this cause could still draw, reservations of others removed. */
  readonly remaining: number;
}

/** `/afk` totals 4 — gate ≤ 3, tier ≤ 1, review 1 reserved. */
export const AFK_RESEED_BUDGET: ReseedBudget = {
  lane: "/afk",
  ceiling: 4,
  subCaps: { gate: 3, tier: 1, review: 1 },
  reserved: { gate: 0, tier: 0, review: 1 },
};

/** `/go` totals 2 with no review round: review is not activated on the lane
 * outside `--mode no-mistakes` (ADR 0110), so reserving one would idle a round a
 * waiting human is paying for. */
export const GO_RESEED_BUDGET: ReseedBudget = {
  lane: "/go",
  ceiling: 2,
  subCaps: { gate: 2, tier: 1, review: 0 },
  reserved: { gate: 0, tier: 0, review: 0 },
};

/** `/go --mode no-mistakes` widens to 3 SO THE RESERVATION FITS — the lane keeps
 * its two working rounds and the review's reserved round is added on top rather
 * than carved out of them. */
export const GO_NO_MISTAKES_RESEED_BUDGET: ReseedBudget = {
  lane: "/go",
  ceiling: 3,
  subCaps: { gate: 2, tier: 1, review: 1 },
  reserved: { gate: 0, tier: 0, review: 1 },
};

export interface ResolveReseedBudgetInput {
  /** The lane label carried by the Ticket (`lane:go` selects the `/go` ruler). */
  readonly laneLabel?: string;
  /** The `/go` dispatch mode; `no-mistakes` widens the ceiling. */
  readonly runMode?: string;
  /**
   * Is the fold's review stage ACTIVATED (`afk.review.enabled`)? Default `true`
   * — every existing caller resolved the review-bearing ruler.
   */
  readonly reviewEnabled?: boolean;
}

/**
 * Strip the review's share AND its reservation from a profile. A DISABLED stage
 * must be a no-op, and a reservation is not one: the reserved round sits inside
 * the ceiling, invisible to every other cause, waiting for a stage that will
 * never ask for it (#2985). Under `/afk`'s ruler that silently converted the
 * last round of a 4-round ceiling into dead capacity — a tier escalation after
 * three gate corrections was refused with `reservation` while the ceiling still
 * had room.
 */
export function withoutReviewReservation(budget: ReseedBudget): ReseedBudget {
  return {
    ...budget,
    subCaps: { ...budget.subCaps, review: 0 },
    reserved: { ...budget.reserved, review: 0 },
  };
}

/** Resolve the lane's Re-seed budget. Anything that is not the `/go` lane is
 * `/afk`'s ruler, including the scout and manual dispatches, because they run
 * the same unattended pipeline. */
export function resolveReseedBudget(input: ResolveReseedBudgetInput): ReseedBudget {
  const lane =
    input.laneLabel !== LABEL_GO_LANE
      ? AFK_RESEED_BUDGET
      : input.runMode === "no-mistakes"
        ? GO_NO_MISTAKES_RESEED_BUDGET
        : GO_RESEED_BUDGET;
  return input.reviewEnabled === false ? withoutReviewReservation(lane) : lane;
}

/** What asked for a Re-seed round. A closed vocabulary: a gate stage
 * blocked the work, a DONE arrived with no diff to accept, a repeated failure
 * bought a higher model tier, the fold's review stage raised a blocking
 * finding, or Spin persisted after its free in-session steer. The LANE is not
 * a trigger — it is a budget profile, which is why it appears in
 * {@link ReseedBudget} and not here. */
export type ReseedTrigger =
  | "gate-stage"
  | "no-diff-done"
  | "tier-escalation"
  | "review-finding"
  | "spin";

export const RESEED_TRIGGERS: readonly ReseedTrigger[] = [
  "gate-stage",
  "no-diff-done",
  "tier-escalation",
  "review-finding",
  "spin",
];

/** Which sub-cap a trigger draws from. A no-diff DONE is a gate rejection — the
 * gate refused to accept the completion claim — so it shares the gate's share.
 * A tier escalation draws its OWN round: charging it to the gate is what muted
 * every subsequent gate correction (ADR 0129, defect 1). A blocking review
 * finding draws the RESERVED review round, which gate churn cannot consume — the
 * starvation defect (#2730). Persistent Spin uses the ordinary gate share: it
 * is branch repair, not a new recovery economy. */
export function reseedTriggerCause(trigger: ReseedTrigger): ReseedCause {
  if (trigger === "tier-escalation") return "tier";
  if (trigger === "review-finding") return "review";
  return "gate";
}

/** Fold the operator's configured gate cap into a lane profile. The lane owns
 * the ceiling and the reservations; the config owns only how much of it gate
 * corrections may claim, so a raised gate cap can never eat the review's
 * reserved round. */
export function withGateSubCap(budget: ReseedBudget, gateCap: number): ReseedBudget {
  const cap = Number.isInteger(gateCap) && gateCap > 0 ? gateCap : 0;
  return { ...budget, subCaps: { ...budget.subCaps, gate: cap } };
}

function spentFor(spend: ReseedSpend, cause: ReseedCause): number {
  const raw = spend[cause];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/** Rounds spent across every cause. */
export function totalReseedSpend(spend: ReseedSpend): number {
  return RESEED_CAUSES.reduce((sum, cause) => sum + spentFor(spend, cause), 0);
}

/** Reserved rounds still unclaimed by causes OTHER than `cause`. These sit
 * inside the ceiling but are invisible to this cause. */
function reservedElsewhere(budget: ReseedBudget, spend: ReseedSpend, cause: ReseedCause): number {
  return RESEED_CAUSES.filter((other) => other !== cause).reduce((held, other) => {
    const unclaimed = (budget.reserved[other] ?? 0) - spentFor(spend, other);
    return held + Math.max(0, unclaimed);
  }, 0);
}

/** Decide whether `cause` may spend one more Re-seed round given what has been
 * spent already. Three refusals, checked in the order a reader would ask them:
 * did this cause use up its own share, is anything left at all, and is what is
 * left held for someone else. */
export function reseedDraw(budget: ReseedBudget, cause: ReseedCause, spend: ReseedSpend = {}): ReseedDraw {
  const capLeft = (budget.subCaps[cause] ?? 0) - spentFor(spend, cause);
  const ceilingLeft = budget.ceiling - totalReseedSpend(spend);
  const drawable = Math.max(0, Math.min(capLeft, ceilingLeft - reservedElsewhere(budget, spend, cause)));
  if (capLeft <= 0) return { allowed: false, refusal: "sub-cap", remaining: 0 };
  if (ceilingLeft <= 0) return { allowed: false, refusal: "ceiling", remaining: 0 };
  if (drawable <= 0) return { allowed: false, refusal: "reservation", remaining: 0 };
  return { allowed: true, remaining: drawable };
}

/** Convenience predicate over {@link reseedDraw}. */
export function canDrawReseed(budget: ReseedBudget, cause: ReseedCause, spend: ReseedSpend = {}): boolean {
  return reseedDraw(budget, cause, spend).allowed;
}

/** Record one drawn round. Pure: the caller owns where the tally lives. */
export function recordReseedDraw(spend: ReseedSpend, cause: ReseedCause): ReseedSpend {
  return { ...spend, [cause]: spentFor(spend, cause) + 1 };
}

/** Static incoherences in a profile — a ceiling that cannot honour its own
 * reservations, or a reservation larger than the cause's own share. A sub-cap
 * ABOVE the ceiling is not a defect: the ceiling is what actually binds. */
export function reseedBudgetDefects(budget: ReseedBudget): readonly string[] {
  const defects: string[] = [];
  const reservedTotal = RESEED_CAUSES.reduce((sum, cause) => sum + (budget.reserved[cause] ?? 0), 0);
  if (reservedTotal > budget.ceiling) {
    defects.push(`reservations (${reservedTotal}) exceed the ceiling (${budget.ceiling})`);
  }
  for (const cause of RESEED_CAUSES) {
    const reserved = budget.reserved[cause] ?? 0;
    if (reserved > (budget.subCaps[cause] ?? 0)) {
      defects.push(`\`${cause}\` reserves ${reserved} beyond its sub-cap of ${budget.subCaps[cause] ?? 0}`);
    }
  }
  return defects;
}
