import {
  VALIDATION_MOMENTS,
  type ValidationMoment,
  type ValidationMoments,
} from "./config.js";

/** Lifecycle moments the engine consumes; intentionally independent from the
 * config vocabulary so /red-doctor can catch either side changing alone. */
export const ENGINE_VALIDATION_MOMENTS = ["iteration", "post_done", "landing"] as const;

/**
 * Keys under `afk.validation.*` that are SETTINGS, not moments — each paired
 * with the module that reads it, so the pairing is checkable rather than
 * asserted.
 *
 * The drift audit used to treat every key under `afk.validation` as a moment
 * name and call anything outside the engine registry an unsupported
 * declaration. Its printed remediation — "remove or rename the declaration" —
 * therefore told an operator to DELETE four pieces of live configuration,
 * including the regeneration declaration whose paths had just been widened to
 * stop a mirror going stale in CI four times over (#3466).
 *
 * A key belongs here when a reader resolves it and it names no lifecycle
 * moment. Adding one is a line here plus the reader it names; the guard proves
 * the reader exists, so an entry cannot outlive what it describes.
 */
export const VALIDATION_SETTING_KEYS: Readonly<Record<string, string>> = {
  preflight: "apps/dev/src/core/config.ts",
  generated: "apps/dev/src/core/generated-surfaces.ts",
  node_max_old_space_mb: "apps/dev/src/core/config.ts",
  heavy_available_memory_mb: "apps/dev/src/core/config.ts",
  vitest_max_workers: "apps/dev/src/core/config.ts",
  turbo_concurrency: "apps/dev/src/core/config.ts",
};

/** Whether an `afk.validation.<key>` names a setting rather than a moment. */
export function isValidationSettingKey(key: string): boolean {
  return Object.hasOwn(VALIDATION_SETTING_KEYS, key);
}

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
