import { encode, type JsonValue } from "@reddb-io/toon";
import { RESEED_CAUSES, type ReseedCause, type ReseedSpend } from "./reseed-budget.js";

export interface ReseedMeasurementFact {
  readonly version: 1;
  readonly rounds: number;
  readonly by_cause: Readonly<Record<ReseedCause, number>>;
}

export interface ReseedMeasurementAggregate {
  readonly workers: number;
  readonly rounds: number;
  readonly by_cause: Readonly<Record<ReseedCause, number>>;
}

function measuredRounds(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Freeze the Worker's in-memory budget spend into a stable Envelope/state fact. */
export function reseedMeasurementFact(spend: ReseedSpend): ReseedMeasurementFact {
  const byCause = Object.fromEntries(
    RESEED_CAUSES.map((cause) => [cause, measuredRounds(spend[cause])]),
  ) as Record<ReseedCause, number>;
  return {
    version: 1,
    rounds: RESEED_CAUSES.reduce((sum, cause) => sum + byCause[cause], 0),
    by_cause: byCause,
  };
}

/** Aggregate already-recorded Worker facts without reconstructing lifecycle events. */
export function aggregateReseedMeasurements(
  facts: readonly ReseedMeasurementFact[],
): ReseedMeasurementAggregate {
  const byCause: Record<ReseedCause, number> = { gate: 0, tier: 0, review: 0 };
  for (const fact of facts) {
    for (const cause of RESEED_CAUSES) byCause[cause] += measuredRounds(fact.by_cause[cause]);
  }
  return {
    workers: facts.length,
    rounds: RESEED_CAUSES.reduce((sum, cause) => sum + byCause[cause], 0),
    by_cause: byCause,
  };
}

/** TOON is the repository's structured Envelope wire format. */
export function renderReseedMeasurement(fact: ReseedMeasurementFact): string {
  return encode(fact as unknown as JsonValue);
}
