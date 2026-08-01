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
 * **The launch is restated, never frozen (Amendment 5).** A Worker's runner, its
 * model tier, its effort and its slot-scoped env are decided per birth, and one
 * fixed argv cannot express a decision made per Worker. So the argv and the env
 * are the one part of a registration a renewal MAY restate: the session rotates
 * them on the message it already sends every half-window, and the daemon expands
 * the daemon's own facts into them at birth (`launch-template.ts`). Everything
 * else a renewal carries over untouched, because a renewal is still a session
 * saying "I am still here" and not a second chance to restate what work it wants.
 *
 * PURE: every input is passed in, the clock included.
 */
import {
  requireLaunchArgv,
  requireLaunchEnv,
  type RedskilledLaunchTemplate,
} from "./launch-template.js";

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
 * Whether a session is still renewing a registration, what is holding it up
 * instead, or that nothing is.
 *
 * All three states are POLLED — a drain must outlive the terminal that started
 * it — and that is exactly why they have to be distinguishable. `self-renewing`
 * is a registration no session has spoken for inside the cadence and the daemon
 * is holding up on the project's own open work (Amendment 7); `running-on` is
 * work nobody is watching, on a deadline it will actually lapse at.
 */
export type RedskilledRenewalStatus = "renewing" | "self-renewing" | "running-on";

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
  /**
   * What to add to a Worker's environment at birth. Opaque, likewise.
   *
   * The slot-scoped bag that used to be composed at the spawn site — a retire
   * file, a worker id, a slot — arrives here, with the per-birth facts written as
   * `{{worker_id}}`-style placeholders the daemon fills in. Absent means nothing
   * to add, which is an ordinary answer rather than a missing one.
   */
  readonly env?: Readonly<Record<string, string>>;
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
  readonly env: Readonly<Record<string, string>>;
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
  /**
   * The last instant the project's own work held this registration up.
   *
   * Beside `renewed_at` rather than folded into it, because the two answer
   * different questions and an operator needs both: `renewed_at` is the last time
   * a SESSION said "I am still here", and this is the last time the daemon saw the
   * project still draining (Amendment 7). Absent until something sustained it —
   * which is honest, not missing: a registration a second old has been held up by
   * nothing yet.
   */
  readonly sustained_at?: string;
  /** How many observations of open work pushed this deadline out; absent until one did. */
  readonly sustains?: number;
  /** Which observation last sustained it — a reason, never just a count. */
  readonly sustained_by?: RedskilledSustainSignal;
  /**
   * How many times the launch has been restated; 0 for the one registered with.
   *
   * Separate from `renewals` because most renewals restate nothing, and the two
   * questions an operator asks are different: `renewals` answers "is a session
   * still here", while this answers "is the Worker born next the one this project
   * last asked for" — the number that moves when a runner directive lands.
   */
  readonly launch_revision: number;
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
  const argv = requireLaunchArgv(request.argv, projectLabel);
  const env = requireLaunchEnv(request.env, projectLabel);
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
    env,
    target: request.target,
    registered_at: new Date(nowMs).toISOString(),
    renew_within_ms: renewWithinMs,
    renew_by: new Date(nowMs + renewWithinMs).toISOString(),
    renewed_at: new Date(nowMs).toISOString(),
    renewals: 0,
    launch_revision: 0,
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
  /**
   * A restated launch — what the NEXT Worker of this project is started with.
   *
   * The one part of a registration a renewal may rewrite (Amendment 5), because
   * it is the one part decided per birth rather than per project: a runner that
   * degraded mid-drain is swapped by restating the argv on the next renewal, with
   * no re-registration and so no window where the host holds no record of a
   * project that is still draining. **Restating it is all-or-nothing**: a launch
   * half from one tick's decision and half from an older one is a Worker neither
   * tick asked for, so an argv given without an env replaces the env with none.
   */
  readonly launch?: RedskilledLaunchTemplate;
}

/**
 * Push one registration's deadline out, and restate its launch if asked. PURE.
 *
 * Everything the project said about its WORK is carried over untouched — the
 * selector, the target and the instant it first registered — because a renewal is
 * a session saying "I am still here", never a second chance to restate what work
 * it wants. What a renewal may restate is the launch, and only because the launch
 * is a per-birth decision the registration would otherwise freeze; a renewal that
 * restates nothing is byte-for-byte the renewal that existed before Amendment 5.
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
  // The fallbacks are for a record from a daemon older than Amendment 5, which
  // carried an argv and no launch revision: a renewal that read one back as
  // `undefined` would strand the field rather than carry the record forward.
  const launch = options.launch == null
    ? { env: held.env ?? {}, launch_revision: held.launch_revision ?? 0 }
    : {
      argv: requireLaunchArgv(options.launch.argv, held.project_label),
      env: requireLaunchEnv(options.launch.env, held.project_label),
      launch_revision: (held.launch_revision ?? 0) + 1,
    };
  return {
    ...held,
    ...launch,
    renew_within_ms: renewWithinMs,
    renewed_at: new Date(nowMs).toISOString(),
    // Dated from the renewal rather than from the registration: a deadline that
    // kept counting from the first record would lapse a session that renewed on
    // time, which is the one thing renewing is for.
    renew_by: new Date(nowMs + renewWithinMs).toISOString(),
    renewals: held.renewals + 1,
  };
}

/**
 * What the daemon saw holding one registration up, at one instant.
 *
 * Two signals rather than one, because "this project still intends to drain" is
 * true in two shapes and only one of them is a queue: a project whose last Worker
 * is still landing its Ticket has a drained selector and is manifestly draining.
 */
export type RedskilledSustainSignal = "open-work" | "live-worker";

/**
 * How one sustain read came out — a sustained registration, or the reason it was not.
 *
 * `drained` and `uncounted` are kept apart for the reason `queue-discovery` keeps
 * them apart everywhere else: a queue nobody could count is not an empty one, and
 * only the empty one is a project that has finished.
 */
export type RedskilledSustainVerdict = RedskilledSustainSignal | "drained" | "uncounted";

/** What the daemon knows about one project's work at the instant it sustains. */
export interface RegistrationWorkObservation {
  /** The daemon's clock, as an instant it can parse. */
  readonly now: string;
  /**
   * The last poll that covered this project; absent when none did.
   *
   * The outcome travels with the depth because a `null` depth means three
   * different things, and only the counted zero is a drained queue.
   */
  readonly queue?: { readonly outcome: "counted" | "unreachable" | "rate-limited"; readonly depth: number | null };
  /** How many Workers the host holds for this project right now. */
  readonly liveWorkers?: number;
}

/** One sustain read: the record it produced, and the reason it produced it. */
export interface SustainedRegistration {
  readonly registration: RedskilledProjectRegistration;
  readonly verdict: RedskilledSustainVerdict;
  readonly detail: string;
}

/**
 * Push a registration's deadline out for as long as the project still drains. PURE.
 *
 * **ADR 0130 Amendment 7: open work renews a registration, and a session does not
 * have to.** Amendment 4 made the registration the thing that keeps a drain alive
 * and gave it a deadline; the deadline shipped and the renewal had no owner, so
 * every drain stopped one window after it started (#2973). The owner is the
 * daemon, because it is the one party that outlives the session AND already holds
 * the two facts that say a project is still draining — the depth its own poll
 * counted, and the Workers it is itself holding.
 *
 * **Only an observation sustains; silence never does.** A counted, positive depth
 * or a live Worker pushes the deadline; a counted ZERO does not, which is how a
 * project that finished lapses on schedule and stops being polled. An outcome the
 * poll could not count — an unreachable tracker, a spent quota — sustains nothing
 * either, and deliberately so: that is exactly the silence a closed laptop
 * produces, and a registration held up by silence is the forever-poll the window
 * exists to prevent. A session that is alive renews straight through such an
 * outage, and a project that is not can register again in one call.
 *
 * **The session's own clock is never touched.** `renewed_at` keeps meaning "a
 * session was heard from", so a sustained registration still reports honestly that
 * nobody is watching it — `self-renewing` rather than `renewing`.
 */
export function sustainProjectRegistration(
  held: RedskilledProjectRegistration,
  observation: RegistrationWorkObservation,
): SustainedRegistration {
  const nowMs = Date.parse(observation.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`redskilled needs an instant to sustain a registration, not ${JSON.stringify(observation.now)}`);
  }
  const label = JSON.stringify(held.project_label);
  const live = Math.max(0, observation.liveWorkers ?? 0);
  const queue = observation.queue;
  const depth = queue != null && queue.outcome === "counted" ? queue.depth : null;

  const signal: RedskilledSustainSignal | null = depth != null && depth > 0
    ? "open-work"
    // Checked after the depth and before the drain: a project whose last Worker is
    // still landing its work has a drained selector and is manifestly still
    // draining, so a zero must not retire the registration out from under it.
    : live > 0
      ? "live-worker"
      : null;

  if (signal == null) {
    const verdict: RedskilledSustainVerdict = depth === 0 ? "drained" : "uncounted";
    return {
      registration: held,
      verdict,
      detail: verdict === "drained"
        ? `project ${label} has nothing queued and no Worker running, so nothing holds its registration up and it ` +
          `lapses at ${held.renew_by}`
        : `no poll counted project ${label}, and an uncounted queue never sustains a registration — it stands on ` +
          `its own deadline of ${held.renew_by}`,
    };
  }

  return {
    registration: {
      ...held,
      // Dated from the observation, exactly as a renewal is: a deadline that kept
      // counting from the registration would lapse a project that is still working.
      renew_by: new Date(nowMs + held.renew_within_ms).toISOString(),
      sustained_at: new Date(nowMs).toISOString(),
      sustains: (held.sustains ?? 0) + 1,
      sustained_by: signal,
    },
    verdict: signal,
    detail: signal === "open-work"
      ? `project ${label} has ${depth} item(s) queued, so its registration stands past its window`
      : `project ${label} holds ${live} Worker(s), so its registration stands past its window`,
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
 * renews at". Past that, the verdict says which of the two things holding the
 * record up is doing it — the project's own open work (`self-renewing`,
 * Amendment 7) or nothing at all (`running-on`, on its way to a deadline).
 */
export function registrationRenewalStatus(
  registration: RedskilledProjectRegistration,
  nowMs: number,
): RedskilledRenewalStatus {
  // The fallback is for a record from a daemon older than renewal, which dates
  // itself by the only instant it carries: the one it was registered at.
  const heardAt = Date.parse(registration.renewed_at ?? registration.registered_at);
  const withinCadence = (at: number): boolean =>
    Number.isFinite(at) && nowMs - at <= registration.renew_within_ms * REDSKILLED_RENEWAL_CADENCE;
  if (withinCadence(heardAt)) return "renewing";
  // Judged on the same cadence the session is, because it answers the same
  // question about the same silence: a sustain older than the cadence is a
  // registration the last poll did not hold up, whatever an earlier one did.
  const sustainedAt = registration.sustained_at == null ? Number.NaN : Date.parse(registration.sustained_at);
  return withinCadence(sustainedAt) ? "self-renewing" : "running-on";
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
    (registration.renewals === undefined || Number.isInteger(registration.renewals)) &&
    (registration.env === undefined || isLaunchEnvShape(registration.env)) &&
    (registration.launch_revision === undefined || Number.isInteger(registration.launch_revision)) &&
    // Optional for the same reason, one amendment later: a daemon older than the
    // sustain holds no such fields, and a client that failed its records closed
    // would refuse every registration a mixed-version host answers with.
    (registration.sustained_at === undefined || typeof registration.sustained_at === "string") &&
    (registration.sustains === undefined || Number.isInteger(registration.sustains)) &&
    (registration.sustained_by === undefined ||
      registration.sustained_by === "open-work" ||
      registration.sustained_by === "live-worker");
}

/** True when `value` is a map of strings to strings — a launch env's whole shape. */
function isLaunchEnvShape(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`redskilled needs ${what} to register a project, not ${JSON.stringify(value)}`);
  }
  return value;
}
