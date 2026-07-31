/**
 * project-registration — what a project contributes, now that it contributes no
 * process.
 *
 * ADR 0130 Amendment 4: **there are exactly two players.** The project's MCP,
 * alive in a user's session, which REGISTERS; and the daemon, alive on the
 * machine, which will own the demand loop. A registration is the whole of the
 * project's side of that seam: a record the daemon stores and reports back.
 *
 * **A registration carries six things, and the daemon interprets none of them.**
 * The repository identity — already carried today as the opaque project label. An
 * opaque **selector**, the query that names this project's work. An opaque
 * **argv**, what to run when a Worker is born for it. An opaque **workspace
 * path**, where to run it. A target width. And a renewal deadline, because a
 * registration that died with its MCP would defeat the purpose and one that never
 * expired would make a closed laptop poll forever.
 *
 * The workspace is stated for the same reason the argv is: the daemon owns the
 * demand loop (Amendment 4), so it births the Worker itself, and a host that had
 * to *derive* a working directory would have to know what a checkout looks like
 * — the one thing rule 3 forbids. A path it needs is a path it was given.
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
 * The fraction of its window a session is expected to renew inside.
 *
 * **A lease's half-life is the only cadence a deadline states on its own.** The
 * daemon holds no connection to the session — every request arrives on its own
 * socket — so the one thing it can tell a live session from a closed terminal by
 * is silence, and silence is only readable against an expected rhythm. Renewing
 * at the half-life leaves a whole half-window of slack for a slow tick, and going
 * quiet past it is what "nothing is renewing this any more" looks like from here.
 */
export const REDSKILLED_RENEWAL_CADENCE = 0.5;

/**
 * Whether a session is still renewing a registration, or it is running on alone.
 *
 * Both states are POLLED — a drain must outlive the terminal that started it —
 * and that is exactly why they have to be distinguishable: an operator reading
 * `running-on` is reading work nobody is watching, on a deadline it will lapse at.
 */
export type RedskilledRenewalStatus = "renewing" | "running-on";

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
  /** Where to run it — used verbatim as the Worker's working directory. */
  readonly workspace_path: string;
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
  readonly workspace_path: string;
  readonly target: number;
  /** The daemon's own clock, at the instant it accepted this registration. */
  readonly registered_at: string;
  readonly renew_within_ms: number;
  /** When this registration lapses unless renewed — the last renewal plus the window. */
  readonly renew_by: string;
  /**
   * The last instant a session was heard from about this registration.
   *
   * The registration itself counts as the first: a record the daemon accepted a
   * second ago is being renewed by definition, and dating it from a renewal that
   * has not happened yet would report every new registration as abandoned.
   */
  readonly renewed_at: string;
  /** How many renewals the daemon has accepted; 0 for a registration never renewed. */
  readonly renewals: number;
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
  // Same shape check, same reason as the argv: a registration the host could
  // never start a Worker for is a client bug the daemon can see without reading
  // anything about what the path names.
  const workspacePath = requireText(
    request.workspace_path,
    `a workspace path for project ${JSON.stringify(projectLabel)}`,
  );
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
    workspace_path: workspacePath,
    target: request.target,
    registered_at: new Date(nowMs).toISOString(),
    renew_within_ms: renewWithinMs,
    renew_by: new Date(nowMs + renewWithinMs).toISOString(),
    renewed_at: new Date(nowMs).toISOString(),
    renewals: 0,
  };
}

/**
 * Raised when a project asks to renew a registration the daemon is not holding.
 *
 * **A renewal is never a registration.** A client whose record lapsed while its
 * session was blocked must re-register — stating its selector, its argv and its
 * target again — because the daemon deliberately kept none of them, and a renewal
 * that quietly minted a record would resurrect an argv nobody restated.
 */
export class RedskilledProjectUnregisteredError extends Error {
  constructor(readonly projectLabel: string) {
    super(
      `redskilled holds no registration for project ${JSON.stringify(projectLabel)} to renew: it lapsed or was never ` +
        `held, and a renewal never mints a record — register again, stating the selector, the argv and the target`,
    );
    this.name = "RedskilledProjectUnregisteredError";
  }
}

export interface RenewProjectRegistrationOptions {
  /** The daemon's clock, as an instant it can parse. */
  readonly now: string;
  /** A restated window; the one the registration already stands on when absent. */
  readonly renew_within_ms?: number;
}

/**
 * Push one registration's deadline out. PURE.
 *
 * Everything the project said about its work is carried over untouched — the
 * selector, the argv, the target and the instant it first registered — because a
 * renewal is a session saying "I am still here", never a second chance to restate
 * what it wants. The only fields that move are the ones about time.
 */
export function renewProjectRegistration(
  held: RedskilledProjectRegistration,
  options: RenewProjectRegistrationOptions,
): RedskilledProjectRegistration {
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`redskilled needs an instant to date a renewal, not ${JSON.stringify(options.now)}`);
  }
  const renewWithinMs = options.renew_within_ms ?? held.renew_within_ms;
  if (!Number.isFinite(renewWithinMs) || renewWithinMs <= 0) {
    throw new Error(
      `redskilled needs a positive renewal window to renew project ${JSON.stringify(held.project_label)}, not ` +
        `${JSON.stringify(options.renew_within_ms)}`,
    );
  }
  return {
    ...held,
    renew_within_ms: renewWithinMs,
    renewed_at: new Date(nowMs).toISOString(),
    // Dated from the renewal rather than from the registration: a deadline that
    // kept counting from the first record would lapse a session that renewed on
    // time, which is the one thing renewing is for.
    renew_by: new Date(nowMs + renewWithinMs).toISOString(),
    renewals: held.renewals + 1,
  };
}

/** True once a registration's deadline has passed with nothing renewing it. PURE. */
export function hasRegistrationLapsed(registration: RedskilledProjectRegistration, nowMs: number): boolean {
  const renewBy = Date.parse(registration.renew_by);
  // An undatable deadline is not a lapse: dropping a record because its own
  // timestamp is unreadable would stop work over a field nobody meant to act on.
  if (!Number.isFinite(renewBy)) return false;
  return nowMs >= renewBy;
}

/**
 * Whether a session is still renewing this registration, at one instant. PURE.
 *
 * Read off silence and nothing else: the daemon has no session to ask, so the
 * question it can answer is "have I heard about this within the cadence a session
 * renews at", and the answer past that is `running-on` — still held, still polled,
 * on its way to a deadline.
 */
export function registrationRenewalStatus(
  registration: RedskilledProjectRegistration,
  nowMs: number,
): RedskilledRenewalStatus {
  // The fallback is for a record from a daemon older than renewal, which dates
  // itself by the only instant it carries: the one it was registered at.
  const heardAt = Date.parse(registration.renewed_at ?? registration.registered_at);
  if (!Number.isFinite(heardAt)) return "running-on";
  return nowMs - heardAt <= registration.renew_within_ms * REDSKILLED_RENEWAL_CADENCE ? "renewing" : "running-on";
}

/** What one sweep of a registration set decided, at one instant. */
export interface LapsedRegistrationSweep {
  readonly standing: readonly RedskilledProjectRegistration[];
  readonly lapsed: readonly RedskilledProjectRegistration[];
}

/**
 * Split a registration set into the ones still standing and the ones that lapsed. PURE.
 *
 * Both halves are returned because the lapse is a fact somebody has to be told:
 * a caller that only received the survivors could drop a project's work without
 * ever being able to say which project stopped, or when.
 */
export function sweepLapsedRegistrations(
  registrations: Iterable<RedskilledProjectRegistration>,
  nowMs: number,
): LapsedRegistrationSweep {
  const standing: RedskilledProjectRegistration[] = [];
  const lapsed: RedskilledProjectRegistration[] = [];
  for (const registration of registrations) {
    (hasRegistrationLapsed(registration, nowMs) ? lapsed : standing).push(registration);
  }
  return { standing, lapsed };
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
    typeof registration.workspace_path === "string" &&
    Number.isInteger(registration.target) &&
    typeof registration.registered_at === "string" &&
    typeof registration.renew_within_ms === "number" &&
    typeof registration.renew_by === "string" &&
    // Checked only when present, exactly as the host state's own optional blocks
    // are: one daemon serves checkouts pinned to different bundle versions, so a
    // record from a daemon older than renewal must still read as complete — while
    // a field that IS there and is the wrong shape still fails closed.
    (registration.renewed_at === undefined || typeof registration.renewed_at === "string") &&
    (registration.renewals === undefined || Number.isInteger(registration.renewals));
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`redskilled needs ${what} to register a project, not ${JSON.stringify(value)}`);
  }
  return value;
}
