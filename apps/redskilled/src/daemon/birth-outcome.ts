// birth-outcome — what a dead Worker REPORTED, and how that folds into its
// project's birth breaker.
//
// The breaker asks one question: can a Worker boot HERE. A Worker that booted,
// read the queue, found nothing eligible and said so answered it with a yes —
// and until #4048 the daemon counted that answer as a loss, because the only
// thing it read about a death was how long the Worker lived. On 2026-08-19 a
// drained queue emptied three Workers within seconds of birth, the latch armed,
// and every birth that would have consumed the queue once it was repaired was
// refused until an operator cleared the latch by hand.
//
// So a death now carries an OUTCOME CLASS beside its lifetime. The vocabulary is
// three words of the Worker protocol's own `<promise>` sentinel — never a
// repository's account of its work (ADR 0130 rule 3): this module learns THAT a
// Worker finished, never what it finished.
import {
  describeBirthOutcome,
  EMPTY_BIRTH_HEALTH,
  foldWorkerDeath,
  REDSKILLED_SHORT_LIFE_MS,
  type RedskilledBirthHealth,
  type RedskilledWorkerBirthOutcome,
} from "../demand-loop.js";

/**
 * What one dead Worker reported, from evidence the daemon already holds. PURE.
 *
 * The bounded tail read that recovers a `session-error:` boot refusal also
 * carries the terminal sentinel, so this costs no second read and no new wire
 * field.
 *
 * **A non-zero exit or a signal is unreported whatever the log says.** A Worker
 * that printed its sentinel and then crashed on the way out did not end cleanly,
 * and a breaker that took the sentence over the exit status would be reading the
 * claim instead of the outcome.
 */
export function workerTerminalOutcome(input: {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly tail: string | null;
}): RedskilledWorkerBirthOutcome {
  if (input.exitCode !== 0 || input.signal != null) return "unreported";
  const sentinel = input.tail?.match(/<promise>\s*(DONE|BLOCKED|NO MORE TASKS)\s*<\/promise>/i)?.[1];
  if (sentinel == null) return "unreported";
  return sentinel.toUpperCase() === "NO MORE TASKS" ? "no-eligible-work" : "work-reported";
}

export interface FoldProjectBirthHealthInput {
  /** The daemon's live per-project record, updated in place. */
  readonly health: Record<string, RedskilledBirthHealth>;
  readonly projectLabel: string;
  readonly lifetimeMs: number;
  readonly outcome: RedskilledWorkerBirthOutcome;
  readonly nowMs: number;
  /** Said once, when the breaker opens; a loop that logs per cycle fills a disk. */
  readonly announce: (line: string) => void;
}

/**
 * Fold one death into its project's birth health.
 *
 * An unreadable lifetime is treated as long, never as short: the breaker exists
 * to stop a loop it can prove, and halting a project on a clock it could not
 * parse would be the same silent overreach in the other direction.
 *
 * The outcome class travels with the lifetime because a fast death and a fast
 * FINISH look identical on a clock, and only one of them is a project to stop
 * asking.
 */
export function foldProjectBirthHealth(input: FoldProjectBirthHealthInput): void {
  const { health, projectLabel, lifetimeMs, outcome } = input;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs < 0) {
    health[projectLabel] = EMPTY_BIRTH_HEALTH;
    return;
  }
  const before = health[projectLabel] ?? EMPTY_BIRTH_HEALTH;
  const after = foldWorkerDeath(before, lifetimeMs, input.nowMs, outcome);
  health[projectLabel] = after;
  if (after.haltUntilMs == null || before.haltUntilMs != null) return;
  input.announce(
    `redskilled: project ${JSON.stringify(projectLabel)} lost ${after.shortLifeStreak} Workers in a row inside ` +
      `${REDSKILLED_SHORT_LIFE_MS}ms of birth (${describeBirthOutcome(outcome)}); not asking for another until ` +
      `${new Date(after.haltUntilMs).toISOString()}\n`,
  );
}
