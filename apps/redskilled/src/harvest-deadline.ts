/**
 * harvest-deadline — a drain the operator gave a budget stops TAKING work
 * before the budget dies, and spends what is left bringing back what it has
 * (#4170, Spec #4164; glossary: **Harvest deadline**).
 *
 * **Finished-but-unlanded work counts as zero.** A drain that admits a Worker
 * ten minutes before its budget expires buys a claim it cannot land: the Ticket
 * is taken, the branch exists, and nothing merged. Past the harvest fraction —
 * 0.7 of the declared budget — the daemon therefore admits no NEW claim while
 * the Workers already alive keep publishing and landing what they carry. The
 * deadline gates births, never the landing lane, because the whole point is to
 * spend the last third of the budget harvesting.
 *
 * **No declared budget, no deadline.** The policy is armed by an operator
 * stating `budget_ms` on the drain registration and by nothing else: absent, it
 * reports `inert`, refuses nothing, and invents no instant (Spec #4164 —
 * "never invent a deadline the operator did not ask for"). There is no default
 * budget, and a daemon that picked one would be deciding how long an operator's
 * night is.
 *
 * **Shape is checked; meaning never is** (ADR 0130 rule 3). The declaration is
 * two numbers the daemon compares against its own clock — a budget in
 * milliseconds and a fraction — never a sentence about what the drain is for. A
 * non-positive budget and a fraction outside `(0, 1]` are refused as client
 * bugs the daemon can see without reading anything.
 *
 * PURE: every input is passed in, the clock included.
 */
import type { RedskilledWorkerBirthOutcome } from "./demand-loop.js";

/**
 * How much of a declared budget a drain spends taking new work.
 *
 * 0.7 leaves the last third for the harvest, which is the shape of the cost:
 * a claim is cheap to take and expensive to bring back — gate, publish, PR,
 * merge — so the tail has to be long enough for work in flight to land, and
 * short enough that most of the night is still spent working.
 */
export const REDSKILLED_DEFAULT_HARVEST_FRACTION = 0.7;

/**
 * What an operator declared about a drain's budget — the whole of the policy's
 * input, and absent on every registration that declared none.
 *
 * Carried by the registration REQUEST and by the record the daemon hands back,
 * so one type states the field names once and both sides spell them the same.
 */
export interface RedskilledHarvestDeclaration {
  /**
   * Wall-clock budget for this drain, running from the daemon's `registered_at`.
   *
   * Milliseconds, on the daemon's own clock: a client stating an absolute
   * deadline would state it in a clock the daemon cannot check, exactly as the
   * renewal window is stated as a window rather than an instant.
   */
  readonly budget_ms?: number;
  /** Where the harvest begins, as a fraction of the budget; 0.7 when unstated. */
  readonly harvest_fraction?: number;
}

/** Shape-check one operator declaration, or refuse it. PURE. */
export function requireHarvestDeclaration(
  declaration: RedskilledHarvestDeclaration,
  projectLabel: string,
): RedskilledHarvestDeclaration {
  const project = JSON.stringify(projectLabel);
  const budgetMs = declaration.budget_ms;
  if (budgetMs !== undefined && (!Number.isFinite(budgetMs) || budgetMs <= 0)) {
    throw new Error(
      `redskilled needs a positive drain budget to register project ${project}, not ` +
        `${JSON.stringify(budgetMs)}: a budget that is already spent would harvest a drain that never started`,
    );
  }
  const fraction = declaration.harvest_fraction;
  if (fraction !== undefined && (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)) {
    throw new Error(
      `redskilled needs a harvest fraction in (0, 1] to register project ${project}, not ` +
        `${JSON.stringify(fraction)}`,
    );
  }
  // A fraction without a budget is a policy nobody armed; refused rather than
  // stored, because a record carrying half a declaration reads as armed.
  if (fraction !== undefined && budgetMs === undefined) {
    throw new Error(
      `redskilled cannot hold a harvest fraction for project ${project} without a budget: the harvest deadline is ` +
        `armed by a declared \`budget_ms\` and by nothing else`,
    );
  }
  return {
    ...(budgetMs === undefined ? {} : { budget_ms: budgetMs }),
    ...(fraction === undefined ? {} : { harvest_fraction: fraction }),
  };
}

/** One project's declaration, dated on the instant its budget started running. */
export interface RedskilledHarvestWatch extends RedskilledHarvestDeclaration {
  /** When the budget started — the daemon's own `registered_at`, in milliseconds. */
  readonly startedAtMs: number;
}

/**
 * What a budget is doing to admission right now.
 *
 * `inert` is a distinct state from `admitting` on purpose: both admit, and only
 * one of them will ever stop. An operator reading "admitting" wants to know
 * whether a deadline is coming.
 */
export type RedskilledHarvestState = "inert" | "admitting" | "harvesting";

/** The admission answer, with the instants a reader needs to check it. */
export interface RedskilledHarvestDecision {
  readonly state: RedskilledHarvestState;
  /** Whether a NEW claim may be admitted; landing is never gated by this. */
  readonly admits: boolean;
  readonly budgetMs: number | null;
  readonly fraction: number | null;
  /** When new claims stop being admitted; `null` when no budget was declared. */
  readonly harvestAtMs: number | null;
  /** When the declared budget runs out; `null` when none was declared. */
  readonly deadlineAtMs: number | null;
  readonly detail: string;
}

/** The answer for a project whose operator declared nothing. PURE. */
const INERT: RedskilledHarvestDecision = {
  state: "inert",
  admits: true,
  budgetMs: null,
  fraction: null,
  harvestAtMs: null,
  deadlineAtMs: null,
  detail: "no drain budget was declared, so no harvest deadline stands and admission is unchanged",
};

/**
 * Decide what a declared budget does to admission at `nowMs`. PURE.
 *
 * An unreadable budget start is treated as no budget at all rather than as an
 * expired one: refusing every birth on a clock the daemon could not parse would
 * stop a drain the operator never budgeted.
 */
export function decideHarvest(
  watch: RedskilledHarvestWatch | undefined,
  nowMs: number,
): RedskilledHarvestDecision {
  const budgetMs = watch?.budget_ms;
  if (watch == null || budgetMs == null || !Number.isFinite(watch.startedAtMs)) return INERT;
  const fraction = watch.harvest_fraction ?? REDSKILLED_DEFAULT_HARVEST_FRACTION;
  const harvestAtMs = watch.startedAtMs + budgetMs * fraction;
  const deadlineAtMs = watch.startedAtMs + budgetMs;
  const harvesting = nowMs >= harvestAtMs;
  return {
    state: harvesting ? "harvesting" : "admitting",
    admits: !harvesting,
    budgetMs,
    fraction,
    harvestAtMs,
    deadlineAtMs,
    detail: harvesting
      ? `the declared ${budgetMs}ms budget passed its harvest fraction of ${fraction} at ` +
        `${new Date(harvestAtMs).toISOString()}, so no new claim is admitted before the budget ends at ` +
        `${new Date(deadlineAtMs).toISOString()} — work already in flight keeps landing`
      : `the declared ${budgetMs}ms budget admits new claims until ${new Date(harvestAtMs).toISOString()}, ` +
        `after which the drain harvests what it holds until ${new Date(deadlineAtMs).toISOString()}`,
  };
}

/** The watch a held registration arms, or `undefined` when it declared none. PURE. */
export function harvestWatchOf(
  registration: RedskilledHarvestDeclaration & { readonly registered_at?: string },
): RedskilledHarvestWatch | undefined {
  if (registration.budget_ms == null) return undefined;
  const startedAtMs = Date.parse(registration.registered_at ?? "");
  if (!Number.isFinite(startedAtMs)) return undefined;
  return {
    budget_ms: registration.budget_ms,
    ...(registration.harvest_fraction == null ? {} : { harvest_fraction: registration.harvest_fraction }),
    startedAtMs,
  };
}

/**
 * The planner fields one held registration contributes. PURE.
 *
 * Spread rather than branched at the call site: the demand tick assembles one
 * project record per registration inside the daemon's longest closure, and a
 * policy that made that closure one condition longer would be paid for by every
 * reader of it, for one optional field.
 */
export function harvestPlanFields(
  registration: RedskilledHarvestDeclaration & { readonly registered_at?: string },
): { readonly harvest?: RedskilledHarvestWatch } {
  const watch = harvestWatchOf(registration);
  return watch == null ? {} : { harvest: watch };
}

/**
 * What a drain has brought back, and what it has lost, since the daemon began
 * holding this project.
 *
 * Folded from the outcome class a dead Worker REPORTED — the same three words
 * the birth breaker reads — and never from an account of what the work was:
 * `work-reported` is one unit harvested, `unreported` is one unit lost, and
 * `no-eligible-work` is neither because nothing was taken.
 *
 * In memory, per daemon generation, like the birth health it folds beside: a
 * tally is what this drain has done, not a lifetime total of the machine.
 */
export interface RedskilledHarvestTally {
  /** Workers that reported a terminal outcome on work they took. */
  readonly harvested: number;
  /** Workers that ended without reporting one — work taken and not brought back. */
  readonly stranded: number;
}

export const EMPTY_HARVEST_TALLY: RedskilledHarvestTally = { harvested: 0, stranded: 0 };

/** Fold one death's outcome class into a project's tally. PURE. */
export function foldHarvestOutcome(
  tally: RedskilledHarvestTally | undefined,
  outcome: RedskilledWorkerBirthOutcome,
): RedskilledHarvestTally {
  const held = tally ?? EMPTY_HARVEST_TALLY;
  if (outcome === "work-reported") return { ...held, harvested: held.harvested + 1 };
  if (outcome === "unreported") return { ...held, stranded: held.stranded + 1 };
  return held;
}

/** Fold one death into the daemon's live per-project record, in place. */
export function foldProjectHarvest(
  tallies: Record<string, RedskilledHarvestTally>,
  projectLabel: string,
  outcome: RedskilledWorkerBirthOutcome,
): void {
  tallies[projectLabel] = foldHarvestOutcome(tallies[projectLabel], outcome);
}

/** The harvest block a drain summary carries — instants as the wire spells them. */
export interface RedskilledHarvestReport {
  readonly state: RedskilledHarvestState;
  readonly budget_ms: number | null;
  readonly harvest_fraction: number | null;
  readonly harvest_at: string | null;
  readonly deadline_at: string | null;
  /** Units of work this drain brought back. */
  readonly harvested: number;
  /** Units it did not: lost Workers, plus what the deadline leaves behind. */
  readonly stranded: number;
  readonly detail: string;
}

export interface HarvestReportInput {
  /** The daemon's `registered_at` for this project; absent leaves the policy inert. */
  readonly registeredAt?: string | undefined;
  readonly declaration?: RedskilledHarvestDeclaration | undefined;
  readonly tally?: RedskilledHarvestTally | undefined;
  /** Workers alive for this project at the read. */
  readonly live: number;
  /** The last counted queue depth; `null` when nobody counted it. */
  readonly queueDepth: number | null;
  /** The instant the summary is dated at. */
  readonly observedAt: string;
}

/**
 * Compose the harvested-versus-stranded block for one project's drain. PURE.
 *
 * **Stranded grows at the deadline, not before it.** Until the harvest begins,
 * a live Worker and a queued item are work in progress; once it has begun,
 * neither will be finished by this drain, so both join what the budget leaves
 * behind. Counted separately from the lost Workers already folded into the
 * tally, and summed into one number an operator can read at a glance.
 *
 * The counts are reported whatever the state, including `inert`: they describe
 * what the drain DID, not what the policy did, and a drain with no budget still
 * brings work back. What "inert" removes is the deadline and the refusal.
 */
export function harvestReport(input: HarvestReportInput): RedskilledHarvestReport {
  const watch = input.declaration == null
    ? undefined
    : harvestWatchOf({ ...input.declaration, ...(input.registeredAt == null ? {} : { registered_at: input.registeredAt }) });
  const decision = decideHarvest(watch, Date.parse(input.observedAt));
  const tally = input.tally ?? EMPTY_HARVEST_TALLY;
  const leftBehind = decision.state === "harvesting"
    ? Math.max(0, input.live) + Math.max(0, input.queueDepth ?? 0)
    : 0;
  return {
    state: decision.state,
    budget_ms: decision.budgetMs,
    harvest_fraction: decision.fraction,
    harvest_at: decision.harvestAtMs == null ? null : new Date(decision.harvestAtMs).toISOString(),
    deadline_at: decision.deadlineAtMs == null ? null : new Date(decision.deadlineAtMs).toISOString(),
    harvested: tally.harvested,
    stranded: tally.stranded + leftBehind,
    detail: decision.detail,
  };
}
