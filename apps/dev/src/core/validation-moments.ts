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

/**
 * Why the schedule is empty, when the reason is NOT the declaration (#3939).
 *
 * The activation gate discards the WHOLE `plugins.dev` block in a directory
 * that never opted in (ADR 0067/0116, `auditConfigLoad`), so a repository that
 * declared all three moments reads back as having declared none. The narration
 * then reported the declaration's absence — the one thing the operator could
 * see was false, because the block was sitting right there in the file they
 * had just written.
 *
 * The two states take DIFFERENT repairs: an undeclared moment wants a block,
 * an inert directory wants `plugins.dev.enabled: true`. Telling them apart is
 * the whole job of this context.
 *
 * The field names are `ConfigLoadAudit`'s own, so an audit satisfies this
 * structurally and a caller hands over the thing it already loaded rather than
 * transcribing two fields out of it.
 */
export interface ValidationGateContext {
  /** `ConfigLoadAudit.gateClosed` — the directory never opted into the plugin. */
  readonly gateClosed?: boolean;
  /** The config file the verdict came from, so the repair names a path. */
  readonly path?: string;
}

export interface ValidationMomentSchedule {
  readonly narration: string;
  readonly moments: ValidationMomentDescription[];
  /** True when every skip above is the gate's doing rather than the config's. */
  readonly gateClosed: boolean;
}

/**
 * Describe the exact Validation schedule a Worker receives (ADR 0135). PURE.
 *
 * An absent declaration and an explicit empty declaration both skip execution,
 * but they are narrated differently: the distinction is useful when an
 * operator is deciding whether the engine ignored config or config said to do
 * nothing.
 */
export function describeValidationMoments(
  schedule: ValidationMoments,
  context: ValidationGateContext = {},
): ValidationMomentSchedule {
  const gateClosed = context.gateClosed === true;
  const moments = VALIDATION_MOMENTS.map((moment): ValidationMomentDescription => {
    const commands = schedule[moment];
    return {
      moment,
      state: commands != null && commands.length > 0 ? "declared" : "skip",
      declared: commands !== undefined,
      commands: commands ?? [],
    };
  });
  const reason = (entry: ValidationMomentDescription): string => {
    // The gate wins the explanation: with the block discarded, `declared` is
    // false for every moment regardless of what the file says, so reporting it
    // would be reporting an artefact of the discard.
    if (gateClosed) return "plugin inert here";
    return entry.declared ? "empty declaration" : "undeclared";
  };
  const listing = moments.map((entry) => {
    if (entry.state === "declared") {
      return `${entry.moment}: declared [${entry.commands.join("; ")}]`;
    }
    return `${entry.moment}: skip (${reason(entry)})`;
  }).join("; ");
  // One repair sentence for the whole schedule rather than three copies: the
  // moments are scanned, the repair is read once.
  const repair = gateClosed
    ? ` — \`plugins.dev.enabled\` is not \`true\`${
      context.path === undefined ? "" : ` in ${context.path}`
    }, so the entire \`plugins.dev\` block is discarded before any moment is read (ADR 0067)`
    : "";
  return { narration: `Validation moments — ${listing}${repair}`, moments, gateClosed };
}

export function validationMomentLogPayload(
  schedule: ValidationMoments,
  context: ValidationGateContext = {},
): Record<string, unknown> {
  const described = describeValidationMoments(schedule, context);
  return {
    narration: described.narration,
    ...Object.fromEntries(described.moments.map(({ moment, state }) => [moment, state])),
    // A structured reader must be able to tell the two silences apart without
    // parsing prose.
    gate: described.gateClosed ? "closed" : "open",
  };
}
