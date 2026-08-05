import {
  VALIDATION_MOMENTS,
  type ValidationMoment,
  type ValidationMoments,
} from "./config.js";

/** Lifecycle moments the engine consumes; intentionally independent from the
 * config vocabulary so /red-doctor can catch either side changing alone. */
export const ENGINE_VALIDATION_MOMENTS = ["iteration", "post_done", "landing"] as const;

export type ValidationMomentState = "declared" | "skip";

export interface ValidationMomentDescription {
  readonly moment: ValidationMoment;
  readonly state: ValidationMomentState;
  readonly declared: boolean;
  readonly commands: string[];
}

export interface ValidationMomentSchedule {
  readonly narration: string;
  readonly moments: ValidationMomentDescription[];
}

/**
 * Describe the exact Validation schedule a Worker receives (ADR 0135). PURE.
 *
 * An absent declaration and an explicit empty declaration both skip execution,
 * but they are narrated differently: the distinction is useful when an
 * operator is deciding whether the engine ignored config or config said to do
 * nothing.
 */
export function describeValidationMoments(schedule: ValidationMoments): ValidationMomentSchedule {
  const moments = VALIDATION_MOMENTS.map((moment): ValidationMomentDescription => {
    const commands = schedule[moment];
    return {
      moment,
      state: commands != null && commands.length > 0 ? "declared" : "skip",
      declared: commands !== undefined,
      commands: commands ?? [],
    };
  });
  const narration = `Validation moments — ${moments.map((entry) => {
    if (entry.state === "declared") {
      return `${entry.moment}: declared [${entry.commands.join("; ")}]`;
    }
    return `${entry.moment}: skip (${entry.declared ? "empty declaration" : "undeclared"})`;
  }).join("; ")}`;
  return { narration, moments };
}

export function validationMomentLogPayload(
  schedule: ValidationMoments,
): Record<string, unknown> {
  const described = describeValidationMoments(schedule);
  return {
    narration: described.narration,
    ...Object.fromEntries(described.moments.map(({ moment, state }) => [moment, state])),
  };
}
