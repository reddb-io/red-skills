import type { SpinPattern } from "@reddb-io/worker/engine";
import { decideVerdict, type EnvironmentLedger } from "../verdict.js";
import {
  isSpinOutcome,
  spinPatternFromOutcome,
  type SpinOutcome,
} from "../worker-outcome.js";

type ReseedOutcome = "granted" | "refused" | "hook-aborted";

export type PersistentSpinResolution =
  | { readonly kind: "not-spin" }
  | { readonly kind: "reseed" }
  | {
      readonly kind: "terminal";
      readonly outcome: SpinOutcome;
      readonly evidence: string;
      readonly log: string;
    };

export interface ResolvePersistentSpinInput {
  readonly outcome: string;
  readonly log: string;
  readonly environment: EnvironmentLedger;
  readonly branchBudgetAvailable: boolean;
  readonly firePostAttempt: (outcome: SpinOutcome) => Promise<unknown>;
  readonly requestReseed: (pattern: SpinPattern, outcome: SpinOutcome) => Promise<ReseedOutcome>;
  readonly parkReseedTrail: (evidence: string) => Promise<void>;
}

/** Route a persistent stream Spin through its one Re-seed path or terminal fault. */
export async function resolvePersistentSpin(
  input: ResolvePersistentSpinInput,
): Promise<PersistentSpinResolution> {
  if (!isSpinOutcome(input.outcome)) return { kind: "not-spin" };
  const outcome = input.outcome;
  const pattern = spinPatternFromOutcome(outcome);
  await input.firePostAttempt(outcome);
  const verdict = decideVerdict({
    checks: [],
    signature: outcome,
    spinPattern: pattern,
    history: { environment: input.environment, branchBudgetAvailable: input.branchBudgetAvailable },
    environment: {},
  });
  if (!verdict.parkNow && (await input.requestReseed(pattern, outcome)) === "granted") {
    return { kind: "reseed" };
  }
  const evidence = `${outcome} fault: ${verdict.reason}`;
  await input.parkReseedTrail(evidence);
  return { kind: "terminal", outcome, evidence, log: input.log };
}
