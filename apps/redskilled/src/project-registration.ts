/**
 * project-registration — what a project contributes, now that it contributes no
 * process.
 *
 * ADR 0130 Amendment 3: **there are exactly two players.** The project's MCP,
 * alive in a user's session, which REGISTERS; and the daemon, alive on the
 * machine, which will own the demand loop. A registration is the whole of the
 * project's side of that seam: a record the daemon stores and reports back.
 *
 * **A registration carries five things, and the daemon interprets none of them.**
 * The repository identity — already carried today as the opaque project label. An
 * opaque **selector**, the query that names this project's work. An opaque
 * **argv**, what to run when a Worker is born for it. A target width. And a
 * renewal deadline, because a registration that died with its MCP would defeat
 * the purpose and one that never expired would make a closed laptop poll forever.
 *
 * **Rule 3 is the constraint that shapes this.** The daemon must not learn what
 * an Issue, a label, a Spec, a gate or a Landing *is*. A selector is a string it
 * carries and hands back, never a sentence it reads — exactly as it already
 * carries a Worker's last logged line without parsing it. Amendment 1 moved the
 * frontier by a repository identity and a token; this moves it by a query string
 * and no further.
 *
 * **Shape is checked; meaning never is.** The daemon asks whether it holds a
 * string and whether that string is empty, and that is the last thing it ever
 * asks about a selector's content. An empty selector is refused because a record
 * that names no work is a client bug the daemon can see without reading anything
 * — not because the daemon formed an opinion about what the query says.
 *
 * PURE: every input is passed in, the clock included.
 */

/**
 * Default window a registration survives without renewal.
 *
 * Five minutes: long enough that an ordinary session renews well inside it, short
 * enough that a laptop closed mid-tick stops being a registered project within
 * one coffee rather than one afternoon.
 */
export const REDSKILLED_REGISTRATION_TTL_MS = 300_000;

/**
 * One project asking to be held, as it states itself.
 *
 * The deadline arrives as a WINDOW rather than as an instant, and the daemon
 * dates it on its own clock: a client stating an absolute deadline would be
 * stating it in a clock the daemon cannot check, and a few seconds of skew would
 * silently lengthen or shorten every registration on the host.
 */
export interface RedskilledProjectRegistrationRequest {
  /** The repository identity, carried as the same opaque label a Worker carries. */
  readonly project_label: string;
  /** The query that names this project's work. Opaque — carried, never read. */
  readonly selector: string;
  /** What to run when a Worker is born for this project. Opaque, likewise. */
  readonly argv: readonly string[];
  /** How many Workers this project wants; the host still decides how many it gets. */
  readonly target: number;
  /** How long this registration stands without renewal; the default when absent. */
  readonly renew_within_ms?: number;
}

/** One project the daemon holds, as it reports it back. */
export interface RedskilledProjectRegistration {
  readonly version: 1;
  readonly project_label: string;
  readonly selector: string;
  readonly argv: readonly string[];
  readonly target: number;
  /** The daemon's own clock, at the instant it accepted this registration. */
  readonly registered_at: string;
  readonly renew_within_ms: number;
  /** When this registration lapses unless renewed — `registered_at` plus the window. */
  readonly renew_by: string;
}

/**
 * Raised when a project is registered twice.
 *
 * The refusal NAMES the registration already standing, because the two ways a
 * client gets here want opposite next moves: a second session that should be
 * renewing reads the deadline it has to beat, and a duplicate loop reads the
 * instant the other one registered and learns it exists. A silently overwritten
 * record would have told neither of them anything.
 */
export class RedskilledProjectRegisteredError extends Error {
  constructor(readonly held: RedskilledProjectRegistration) {
    super(
      `redskilled already holds a registration for project ${JSON.stringify(held.project_label)}, registered at ` +
        `${held.registered_at} for a target of ${held.target} and standing until ${held.renew_by}: a project ` +
        `contributes one registration, so a second one is refused rather than silently replacing the first`,
    );
    this.name = "RedskilledProjectRegisteredError";
  }
}

export interface BuildProjectRegistrationOptions {
  /** The daemon's clock, as an instant it can parse. */
  readonly now: string;
  /** The registration this project already has, when it has one. */
  readonly held?: RedskilledProjectRegistration | undefined;
}

/**
 * Build one registration, or refuse it. PURE.
 *
 * The conflict is decided here rather than at the call site so that the refusal
 * and the record it names are the same piece of code: a caller that checked for
 * a duplicate itself would be free to check for it differently.
 */
export function buildProjectRegistration(
  request: RedskilledProjectRegistrationRequest,
  options: BuildProjectRegistrationOptions,
): RedskilledProjectRegistration {
  if (options.held != null) throw new RedskilledProjectRegisteredError(options.held);

  const projectLabel = requireText(request.project_label, "a project label");
  // Shape, not meaning. The daemon asks whether it holds a non-empty string and
  // never asks a second question about what the string says.
  const selector = requireText(request.selector, "a selector");
  if (!Array.isArray(request.argv) || request.argv.length === 0) {
    throw new Error(
      `redskilled needs an argv to register project ${JSON.stringify(projectLabel)}: a registration with nothing to run ` +
        `is a project the host could never start a Worker for`,
    );
  }
  const argv = request.argv.map((word, index) => {
    if (typeof word !== "string" || word === "") {
      throw new Error(
        `redskilled needs every word of an argv to be a non-empty string, and word ${index} of project ` +
          `${JSON.stringify(projectLabel)} is not`,
      );
    }
    return word;
  });
  if (!Number.isInteger(request.target) || request.target < 0) {
    throw new Error(
      `redskilled needs a whole, non-negative target to register project ${JSON.stringify(projectLabel)}, not ` +
        `${JSON.stringify(request.target)}`,
    );
  }
  const renewWithinMs = request.renew_within_ms ?? REDSKILLED_REGISTRATION_TTL_MS;
  if (!Number.isFinite(renewWithinMs) || renewWithinMs <= 0) {
    throw new Error(
      `redskilled needs a positive renewal window to register project ${JSON.stringify(projectLabel)}, not ` +
        `${JSON.stringify(request.renew_within_ms)}: a registration that lapses on arrival is a poll nobody asked for`,
    );
  }
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`redskilled needs an instant to date a registration, not ${JSON.stringify(options.now)}`);
  }

  return {
    version: 1,
    project_label: projectLabel,
    selector,
    argv,
    target: request.target,
    registered_at: new Date(nowMs).toISOString(),
    renew_within_ms: renewWithinMs,
    renew_by: new Date(nowMs + renewWithinMs).toISOString(),
  };
}

/** True when `value` is a complete registration — a client's fail-closed check. */
export function isRedskilledProjectRegistration(value: unknown): value is RedskilledProjectRegistration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const registration = value as Record<string, unknown>;
  return registration.version === 1 &&
    typeof registration.project_label === "string" &&
    typeof registration.selector === "string" &&
    Array.isArray(registration.argv) &&
    registration.argv.every((word) => typeof word === "string") &&
    Number.isInteger(registration.target) &&
    typeof registration.registered_at === "string" &&
    typeof registration.renew_within_ms === "number" &&
    typeof registration.renew_by === "string";
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`redskilled needs ${what} to register a project, not ${JSON.stringify(value)}`);
  }
  return value;
}
