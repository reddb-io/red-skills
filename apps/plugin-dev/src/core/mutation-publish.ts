/**
 * mutation-publish — diff-scoped mutation testing, once per publish, under a
 * hard wall-clock budget (Spec #4129, Ticket #4140).
 *
 * `mutation-operators.ts` decides WHICH single-token changes this diff admits;
 * this module decides how many of them the publish can afford to run, what the
 * result authorizes, and — the part that matters most — what happens when the
 * clock runs out first. The plan ARRIVES as input rather than being computed
 * here, because planning needs the TypeScript compiler and the compiler may not
 * reach the shipped bundle: this module speaks only the mutant model.
 *
 * ## Where it runs, and why not anywhere else
 *
 * Once per publish, inside the review stage. Not on every inner gate iteration:
 * the gate runs many times per Ticket while the implementer iterates, and a
 * check that re-runs the suite once per mutant would multiply the loop's cost
 * by the mutant count every single pass. The review stage runs once, at the end,
 * on the tree that is actually going to be published — which is also the only
 * tree whose mutation score means anything.
 *
 * ## The budget is a wall, not a target
 *
 * A mutation run is the easiest check in the repo to turn into a hang: each
 * mutant costs one suite execution, the count scales with the diff, and a
 * pathological diff would poll forever while every liveness surface reported a
 * healthy Worker (#3024). So the run holds a DEADLINE, and crossing it has
 * exactly one consequence, stated three ways so nobody can read it as a pass:
 *
 *   - the in-flight mutant's run is CANCELLED,
 *   - the outcome is `budget-exhausted`, which never blocks,
 *   - and the row carries an ADVISORY note naming what was and was not judged.
 *
 * **A truncated run never blocks a publish.** A score computed over the prefix
 * the clock allowed is not the score of the change, and blocking on it would
 * make the verdict depend on how loaded the machine was. It is equally
 * forbidden to present that prefix as a full run — hence the advisory note
 * rather than silence. Survivors found before the deadline are named in the
 * note, so the evidence is not thrown away; it is just not authorization.
 *
 * ## Everything that touches the world is a seam
 *
 * Running a suite is a subprocess and reading the clock is nondeterminism, so
 * both arrive as {@link MutationRunner} and {@link MutationClock}. Nothing here
 * spawns, reads a file or reaches the network, which is what lets the fake-clock
 * test pin the bound exactly rather than approximately.
 */
import { describeMutant, type Mutant } from "./mutation-plan.js";

/** What one mutant's suite run concluded. There is deliberately no third value. */
export type MutantFate =
  /** The suite went red: the tests notice this change. */
  | "killed"
  /** The suite stayed green: nothing judges this line. */
  | "survived";

/**
 * One in-flight mutant run. Polled rather than awaited, because a wall-clock
 * wall needs a handle it can CANCEL — an awaited promise the caller cannot stop
 * is the hang the budget exists to prevent.
 */
export interface MutationRunHandle {
  /** The fate once the suite has settled, or `null` while it is still running. */
  settle(): MutantFate | null;
  /** Stop the run. Called exactly once, when the deadline passes. */
  cancel(reason: string): void;
}

/** The suite-execution seam. Production hands it a child-process runner. */
export interface MutationRunner {
  start(mutant: Mutant): MutationRunHandle;
}

/** The clock seam: one reading and one sleep, both injected. */
export interface MutationClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** What the wait says on every poll, so a stalled publish names its subject. */
export interface MutationWaitBeat {
  readonly mutantId: string;
  /** How long this mutant has been running. */
  readonly waitedMs: number;
  /** How much of the publish's whole budget is left. */
  readonly remainingMs: number;
}

export interface MutationRunDeps {
  /** `null` is an UNWIRED runner: an advisory note, never a block (see below). */
  readonly runner: MutationRunner | null;
  readonly clock: MutationClock;
  /** The declared heartbeat — named `onWait` in `DECLARED_WAITS`. */
  readonly onWait?: (beat: MutationWaitBeat) => void;
}

/** The knobs, all four with a stated default so an unconfigured repo still runs. */
export interface MutationPolicy {
  readonly enabled: boolean;
  /** The hard wall-clock wall for the WHOLE run, not per mutant. */
  readonly budgetMs: number;
  /** How often an in-flight mutant is polled. */
  readonly pollMs: number;
  /** Killed ÷ run, below which a COMPLETE run blocks the publish. */
  readonly threshold: number;
  readonly maxMutants: number;
}

export const DEFAULT_MUTATION_BUDGET_MS = 120_000;
export const DEFAULT_MUTATION_POLL_MS = 250;
export const DEFAULT_MUTATION_THRESHOLD = 0.8;
export const DEFAULT_MUTATION_MAX_MUTANTS = 40;

export const DEFAULT_MUTATION_POLICY: MutationPolicy = {
  enabled: true,
  budgetMs: DEFAULT_MUTATION_BUDGET_MS,
  pollMs: DEFAULT_MUTATION_POLL_MS,
  threshold: DEFAULT_MUTATION_THRESHOLD,
  maxMutants: DEFAULT_MUTATION_MAX_MUTANTS,
};

/**
 * Read `dev.review.mutation.*`, falling back to {@link DEFAULT_MUTATION_POLICY}
 * one key at a time. PURE.
 *
 * A garbage value resolves to the default rather than to zero: `budget_ms: ""`
 * parsed as `0` would be an instantly-exhausted run that advisory-notes every
 * publish, which is the "silent pass presented as a full run" this ticket exists
 * to refuse — just spelled as a typo instead of a bug.
 */
export function resolveMutationPolicy(get: (key: string) => string): MutationPolicy {
  return {
    enabled: get("dev.review.mutation.enabled").trim().toLowerCase() !== "false",
    budgetMs: positiveNumber(get("dev.review.mutation.budget_ms"), DEFAULT_MUTATION_BUDGET_MS),
    pollMs: positiveNumber(get("dev.review.mutation.poll_ms"), DEFAULT_MUTATION_POLL_MS),
    threshold: fraction(get("dev.review.mutation.threshold"), DEFAULT_MUTATION_THRESHOLD),
    maxMutants: positiveNumber(get("dev.review.mutation.max_mutants"), DEFAULT_MUTATION_MAX_MUTANTS),
  };
}

function positiveNumber(raw: string, fallback: number): number {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function fraction(raw: string, fallback: number): number {
  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * How the run ended. Only ONE of these blocks, and the name says which.
 *
 * `unwired` and `disabled` are distinct on purpose: an operator who turned the
 * check off reads a different sentence from one whose runner was never plumbed
 * in, and collapsing them would send the second to the wrong repair.
 */
export type MutationStatus =
  /** A complete run at or above the threshold. */
  | "killed-all"
  /** A complete run below the threshold — the ONLY blocking status. */
  | "survivors"
  /** The wall-clock wall arrived first. Advisory, exit 0. */
  | "budget-exhausted"
  /** The changed lines admit no mutant. Advisory, exit 0. */
  | "no-mutants"
  /** No runner is wired. Advisory, exit 0. */
  | "unwired"
  /** `dev.review.mutation.enabled: false`. Advisory, exit 0. */
  | "disabled";

export interface MutationOutcome {
  readonly status: MutationStatus;
  /** Mutants the plan held, after the ceiling. */
  readonly planned: number;
  /** Mutants that actually settled before the wall. */
  readonly ran: number;
  readonly killed: number;
  readonly survived: number;
  /** killed ÷ ran, or `null` when nothing ran. */
  readonly score: number | null;
  readonly threshold: number;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  /** Every survivor, described, in plan order. */
  readonly survivors: readonly string[];
  /** True only for a COMPLETE run below the threshold. */
  readonly blocking: boolean;
  /** Non-null whenever the run was not a full judgement — the note the row carries. */
  readonly advisory: string | null;
}

/** Everything the fold needs to build an outcome, with no clock and no runner. */
export interface MutationTally {
  readonly planned: number;
  readonly killed: number;
  readonly survivors: readonly string[];
  readonly exhausted: boolean;
  readonly elapsedMs: number;
  readonly policy: MutationPolicy;
}

/**
 * Turn a finished tally into the outcome, including whether it blocks. PURE.
 *
 * Split out from the loop so the whole decision table is reachable without a
 * clock or a runner, and so the one rule that matters is stated in one place:
 * **`blocking` is true only when the run was COMPLETE and the score fell short.**
 */
export function decideMutationOutcome(tally: MutationTally): MutationOutcome {
  const survived = tally.survivors.length;
  const ran = tally.killed + survived;
  const score = ran === 0 ? null : tally.killed / ran;
  const base = {
    planned: tally.planned,
    ran,
    killed: tally.killed,
    survived,
    score,
    threshold: tally.policy.threshold,
    elapsedMs: tally.elapsedMs,
    budgetMs: tally.policy.budgetMs,
    survivors: tally.survivors,
  };

  if (tally.exhausted) {
    return {
      ...base,
      status: "budget-exhausted",
      blocking: false,
      advisory:
        `mutation testing hit its ${tally.policy.budgetMs}ms wall-clock budget after ${ran} of ` +
        `${tally.planned} mutant(s) — this is a PARTIAL run and authorizes nothing; ` +
        `${survived} survivor(s) were seen before the wall` +
        (survived === 0 ? "" : `: ${tally.survivors.join("; ")}`),
    };
  }
  if (tally.planned === 0) {
    return {
      ...base,
      status: "no-mutants",
      blocking: false,
      advisory: "the changed lines admit no mutant, so this publish carries no mutation evidence",
    };
  }
  if (score !== null && score < tally.policy.threshold) {
    return {
      ...base,
      status: "survivors",
      blocking: true,
      advisory: null,
    };
  }
  return { ...base, status: "killed-all", blocking: false, advisory: null };
}

/** The outcome for a run that never started, with the reason as its note. PURE. */
export function skippedMutationOutcome(
  status: "unwired" | "disabled",
  policy: MutationPolicy,
  advisory: string,
): MutationOutcome {
  return {
    status,
    planned: 0,
    ran: 0,
    killed: 0,
    survived: 0,
    score: null,
    threshold: policy.threshold,
    elapsedMs: 0,
    budgetMs: policy.budgetMs,
    survivors: [],
    blocking: false,
    advisory,
  };
}

/**
 * The one-line mutation evidence a verdict row carries. PURE.
 *
 * Written as evidence rather than as a verdict of its own: ADR 0154's row says
 * who judged the head and what they cited, and the mutation score is a citation.
 * A publish that blocked on survivors still writes this line, because the next
 * reader's question is "what did it let through", not "did it fail".
 */
export function mutationEvidence(outcome: MutationOutcome): string {
  const score = outcome.score === null ? "n/a" : `${Math.round(outcome.score * 100)}%`;
  return (
    `mutation ${outcome.status}: ${outcome.killed}/${outcome.ran} killed (score ${score}, ` +
    `threshold ${Math.round(outcome.threshold * 100)}%, ${outcome.planned} planned, ` +
    `${outcome.elapsedMs}ms of ${outcome.budgetMs}ms)`
  );
}

/**
 * The sentence a blocking outcome hands the implementer. PURE.
 *
 * Names the survivors, because "mutation score too low" tells a Worker to
 * re-run the check and a survivor list tells it which assertion to write.
 */
export function mutationRefusal(outcome: MutationOutcome): string {
  return (
    `mutation testing refused the publish: ${outcome.survived} of ${outcome.ran} mutant(s) on the ` +
    `changed lines survived (score ${Math.round((outcome.score ?? 0) * 100)}%, below the ` +
    `${Math.round(outcome.threshold * 100)}% threshold) — the tests do not judge these lines. ` +
    `Add an assertion that fails for each: ${outcome.survivors.join("; ")}`
  );
}

export interface MutationRunInput {
  /** The diff-scoped plan, already cut to `policy.maxMutants` by the planner. */
  readonly mutants: readonly Mutant[];
  readonly policy: MutationPolicy;
}

/**
 * Run the publish's mutation check, bounded by the policy's wall clock.
 *
 * The budget is measured from the FIRST clock reading and covers the WHOLE run,
 * not one mutant: a per-mutant deadline would let a plan of forty slow mutants
 * buy forty deadlines, which is the unbounded run wearing a bounded name.
 */
export async function runDiffScopedMutation(
  input: MutationRunInput,
  deps: MutationRunDeps,
): Promise<MutationOutcome> {
  if (!input.policy.enabled) {
    return skippedMutationOutcome(
      "disabled",
      input.policy,
      "mutation testing is off (`dev.review.mutation.enabled: false`), so this publish carries no mutation evidence",
    );
  }
  const runner = deps.runner;
  if (runner === null) {
    return skippedMutationOutcome(
      "unwired",
      input.policy,
      "mutation testing is enabled but no runner is wired, so this publish carries no mutation evidence",
    );
  }

  const startedAt = deps.clock.now();
  const deadline = startedAt + input.policy.budgetMs;
  const plan = input.mutants;

  let killed = 0;
  const survivors: string[] = [];
  let exhausted = false;

  for (const mutant of plan) {
    if (deps.clock.now() >= deadline) {
      exhausted = true;
      break;
    }
    const fate = await awaitMutantSettled(mutant, runner, deadline, input.policy.pollMs, deps);
    if (fate === null) {
      exhausted = true;
      break;
    }
    if (fate === "killed") killed += 1;
    else survivors.push(describeMutant(mutant));
  }

  return decideMutationOutcome({
    planned: plan.length,
    killed,
    survivors,
    exhausted,
    elapsedMs: deps.clock.now() - startedAt,
    policy: input.policy,
  });
}

/**
 * Poll one mutant's suite run until it settles or the publish's deadline passes.
 *
 * DECLARED WAIT (`DECLARED_WAITS`, #3024) — subject: one mutant's suite run
 * settling; deadline: the publish's shared mutation budget, never a per-mutant
 * one; escalation: cancel the run and return `null`, which ends the whole check
 * as `budget-exhausted` — advisory, exit 0.
 *
 * The sleep is capped at the REMAINING budget rather than at `pollMs`, so the
 * wall lands on the budget exactly instead of one poll past it. That is what
 * makes the fake-clock bound a number a test can assert rather than a window.
 */
async function awaitMutantSettled(
  mutant: Mutant,
  runner: MutationRunner,
  deadline: number,
  pollMs: number,
  deps: MutationRunDeps,
): Promise<MutantFate | null> {
  const startedAt = deps.clock.now();
  const handle = runner.start(mutant);
  for (;;) {
    const fate = handle.settle();
    if (fate !== null) return fate;
    const remainingMs = deadline - deps.clock.now();
    if (remainingMs <= 0) {
      handle.cancel(`mutation budget exhausted while running ${mutant.id}`);
      return null;
    }
    deps.onWait?.({
      mutantId: mutant.id,
      waitedMs: deps.clock.now() - startedAt,
      remainingMs,
    });
    await deps.clock.sleep(Math.min(pollMs, remainingMs));
  }
}
