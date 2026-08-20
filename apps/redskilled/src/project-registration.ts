/**
 * project-registration — what a project contributes, now that it contributes no
 * process.
 *
 * ADR 0130 Amendment 4: **there are exactly two players.** The project's MCP,
 * alive in a user's session, which REGISTERS; and the daemon, alive on the
 * machine, which will own the demand loop. A registration is the whole of the
 * project's side of that seam: a record the daemon stores and reports back.
 *
 * **A registration carries its work, launch, placement and lifetime, and the
 * daemon interprets none of the project-authored parts.**
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
 * frontier by a repository identity and a token; ADR 0133 adds a typed REST
 * equivalent beside the query so the transport can revalidate it without making
 * the daemon parse project semantics.
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
  requireLaunchLogPath,
  type RedskilledLaunchTemplate,
} from "./launch-template.js";
import {
  REDSKILLED_PUBLIC_HOST_EVENT_KINDS,
  type RedskilledPublicHostEventKind,
} from "./event-lane.js";
import type { RedskilledQueueOutcome } from "./queue-discovery.js";
import {
  isQueuePollPlanShape,
  requireQueuePollPlan,
  type RedskilledQueuePollPlan,
} from "./project-registration-queue.js";
export type { RedskilledCounterLabels, RedskilledQueuePollPlan } from "./project-registration-queue.js";

/** One project-owned notification, asynchronous unless it declares a bounded wait. */
export type RedskilledProjectHook = RedskilledLaunchTemplate & {
  readonly mode?: "async" | "sync";
  readonly deadline_ms?: number;
};

/** Launch templates a project asks the daemon to fire for public host events. */
export type RedskilledProjectHooks = Partial<
  Readonly<Record<RedskilledPublicHostEventKind, RedskilledProjectHook>>
>;

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

/** The remote branch whose fetched commit becomes every admitted Worker's fork. */
export interface RedskilledTrunk {
  readonly remote: string;
  readonly branch: string;
}

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
  /** REST equivalent of the selector; optional for mixed-version clients. */
  readonly queue_poll?: RedskilledQueuePollPlan;
  /** What to run when a Worker is born for this project. Opaque, likewise. */
  readonly argv: readonly string[];
  /** Where to run it — used verbatim as the Worker's working directory. */
  readonly workspace_path: string;
  /** Explicit git coordinates; optional only for one-release client skew. */
  readonly trunk?: RedskilledTrunk;
  /** What to add to a Worker's environment at birth; opaque, with
   * `{{worker_id}}`-style placeholders the daemon fills in. Absent = nothing. */
  readonly env?: Readonly<Record<string, string>>;
  /** Where a Worker writes its output; a `{{worker_id}}` template so two
   * Workers never share a file. Absent = the heartbeat carries the last line. */
  readonly log_path?: string;
  /** Project-scoped notifications keyed by the public host-event vocabulary. */
  readonly hooks?: RedskilledProjectHooks;
  /** What to SAY to a born Worker (#4100); opaque like the argv, with
   * `{{work_item}}`-style facts the daemon expands. Absent = born unspoken-to. */
  readonly prompt?: string;
  /**
   * The project's DECLARED local gate, run by the Worker instead of an
   * improvised suite (#4166). Opaque command strings, exactly like the argv.
   */
  readonly validation_commands?: readonly string[];
  /** How many Workers this project wants; the host still decides how many it gets. */
  readonly target: number;
  /** Whether project policy declares this drain should remain recoverable. */
  readonly standing?: boolean;
  /** How long this registration stands without renewal; the default when absent. */
  readonly renew_within_ms?: number;
}

/** One project the daemon holds, as it reports it back. */
export interface RedskilledProjectRegistration {
  readonly version: 1;
  readonly project_label: string;
  readonly selector: string;
  readonly queue_poll?: RedskilledQueuePollPlan;
  readonly argv: readonly string[];
  readonly workspace_path: string;
  readonly trunk?: RedskilledTrunk;
  readonly env: Readonly<Record<string, string>>;
  /** The declared log-path template; absent when this project declared none. */
  readonly log_path?: string;
  /** Project-scoped notifications keyed by the public host-event vocabulary. */
  readonly hooks?: RedskilledProjectHooks;
  /** What to say to a Worker born for this project; opaque, expanded at birth. */
  readonly prompt?: string;
  /** The project's declared local gate; opaque command strings (#4166). */
  readonly validation_commands?: readonly string[];
  readonly target: number;
  /** True only when the project explicitly declared a standing drain policy. */
  readonly standing?: boolean;
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
  /**
   * How many times the deadline moved after registration, whatever moved it.
   *
   * This is the end-to-end liveness counter an operator reads. A self-renewing
   * registration with `renewals: 0` claimed that its deadline moved while the
   * only counter for that event did not, making a live path indistinguishable
   * from one that never fired (#3180).
   */
  readonly renewals: number;
  /** How many of those renewals came from a session message rather than observed work. */
  readonly session_renewals?: number;
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
   * questions an operator asks are different: `renewals` answers "is the
   * deadline moving", while this answers "is the Worker born next the one this
   * project last asked for" — the number that moves when a runner directive lands.
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
  const queuePoll = requireQueuePollPlan(request.queue_poll, projectLabel);
  const argv = requireLaunchArgv(request.argv, projectLabel);
  const env = requireLaunchEnv(request.env, projectLabel);
  const logPath = requireLaunchLogPath(request.log_path, projectLabel);
  const hooks = requireProjectHooks(request.hooks, projectLabel);
  // Shape only, like every other project-authored string: present means a
  // non-empty one, and an empty prompt is a client bug the daemon can see
  // without reading a word of what a prompt says.
  // Blank, not merely empty: a prompt of spaces is a Worker told nothing.
  if (request.prompt !== undefined) requireText(request.prompt.trim(), `a prompt for ${projectLabel}`);
  const prompt = request.prompt;
  // Same opacity as the argv: shape-checked strings the daemon never reads.
  const validationCommands = request.validation_commands == null
    ? undefined
    : request.validation_commands.map((command, index) =>
      requireText(command, `validation command ${index} for project ${JSON.stringify(projectLabel)}`));
  // Same shape check, same reason as the argv: a registration the host could
  // never start a Worker for is a client bug the daemon can see without reading
  // anything about what the path names.
  const workspacePath = requireText(
    request.workspace_path,
    `a workspace path for project ${JSON.stringify(projectLabel)}`,
  );
  const trunk = request.trunk == null
    ? undefined
    : {
      remote: requireText(request.trunk.remote, `a trunk remote for project ${JSON.stringify(projectLabel)}`),
      branch: requireText(request.trunk.branch, `a trunk branch for project ${JSON.stringify(projectLabel)}`),
    };
  if (!Number.isInteger(request.target) || request.target < 0) {
    throw new Error(
      `redskilled needs a whole, non-negative target to register project ${JSON.stringify(projectLabel)}, not ` +
        `${JSON.stringify(request.target)}`,
    );
  }
  if (request.standing !== undefined && typeof request.standing !== "boolean") {
    throw new Error(
      `redskilled needs standing intent for project ${JSON.stringify(projectLabel)} to be boolean, not ` +
        `${JSON.stringify(request.standing)}`,
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
    ...(queuePoll == null ? {} : { queue_poll: queuePoll }),
    argv,
    workspace_path: workspacePath,
    ...(trunk == null ? {} : { trunk }),
    env,
    ...(logPath == null ? {} : { log_path: logPath }),
    ...(hooks == null ? {} : { hooks }),
    ...(prompt == null ? {} : { prompt }),
    ...(validationCommands == null || validationCommands.length === 0 ? {} : { validation_commands: validationCommands }),
    target: request.target,
    ...(request.standing === true ? { standing: true } : {}),
    registered_at: new Date(nowMs).toISOString(),
    renew_within_ms: renewWithinMs,
    renew_by: new Date(nowMs + renewWithinMs).toISOString(),
    renewed_at: new Date(nowMs).toISOString(),
    renewals: 0,
    session_renewals: 0,
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
  constructor(
    readonly projectLabel: string,
    readonly absence: RedskilledProjectRegistrationAbsence = { kind: "never" },
  ) {
    super(describeRegistrationAbsence(projectLabel, absence));
    this.name = "RedskilledProjectUnregisteredError";
  }
}

/** Why a project has no registration on the daemon which answered. */
export type RedskilledProjectRegistrationAbsence =
  | { readonly kind: "never" }
  | { readonly kind: "lapsed"; readonly at: string; readonly registered_at?: string }
  | { readonly kind: "stopped"; readonly at: string }
  | { readonly kind: "orphaned" };

function describeRegistrationAbsence(
  projectLabel: string,
  absence: RedskilledProjectRegistrationAbsence,
): string {
  const project = JSON.stringify(projectLabel);
  if (absence.kind === "lapsed") {
    const registered = absence.registered_at == null ? "" : ` (registered ${absence.registered_at})`;
    return `redskilled holds no registration for project ${project} to renew: it lapsed at ${absence.at}${registered}; ` +
      `renewal stopped — find why before registering it again`;
  }
  if (absence.kind === "stopped") {
    return `redskilled holds no registration for project ${project} to renew: it was stopped at ${absence.at}; ` +
      `this is the requested state, so there is nothing to renew`;
  }
  if (absence.kind === "orphaned") {
    return `redskilled holds no registration for project ${project} to renew: it is registered on a daemon this ` +
      `socket does not reach — do not register it again`;
  }
  return `redskilled holds no registration for project ${project} to renew: it was never registered on this host; ` +
    `register it first, stating the selector, the argv and the target`;
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
  // All-or-nothing with the rest of the launch: a restatement that kept the old
  // path while replacing the argv would point a new Worker's output at the file
  // an older decision named. So a restated launch that declares none CLEARS it,
  // which a spread of an absent key could not do.
  const logPath = options.launch == null
    ? held.log_path
    : requireLaunchLogPath(options.launch.log_path, held.project_label);
  const { log_path: _cleared, ...carried } = held;
  return {
    ...carried,
    ...(logPath == null ? {} : { log_path: logPath }),
    ...launch,
    renew_within_ms: renewWithinMs,
    renewed_at: new Date(nowMs).toISOString(),
    // Dated from the renewal rather than from the registration: a deadline that
    // kept counting from the first record would lapse a session that renewed on
    // time, which is the one thing renewing is for.
    renew_by: new Date(nowMs + renewWithinMs).toISOString(),
    renewals: held.renewals + 1,
    // Old daemons carried only `renewals`, whose meaning was session-only. Read
    // that count forward once, then keep the two counters separate.
    session_renewals: (held.session_renewals ?? held.renewals) + 1,
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
   * The outcome travels with the depth because a `null` depth means several
   * different things, and only the counted zero is a drained queue. The union
   * is the poll's own (`RedskilledQueueOutcome`): every uncounted outcome —
   * unreachable, rate-limited, unconfigured — sustains nothing, exactly like
   * the silence a closed laptop produces.
   */
  readonly queue?: { readonly outcome: RedskilledQueueOutcome; readonly depth: number | null };
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
      // A sustain is a renewal: it moved the deadline. Keeping only `sustains`
      // made the headline counter permanently zero on a self-renewing drain.
      renewals: held.renewals + 1,
      session_renewals: held.session_renewals ?? held.renewals,
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
    (registration.queue_poll === undefined || isQueuePollPlanShape(registration.queue_poll)) &&
    Array.isArray(registration.argv) &&
    registration.argv.every((word) => typeof word === "string") &&
    typeof registration.workspace_path === "string" &&
    (registration.trunk === undefined || isTrunkShape(registration.trunk)) &&
    Number.isInteger(registration.target) &&
    (registration.standing === undefined || typeof registration.standing === "boolean") &&
    typeof registration.registered_at === "string" &&
    typeof registration.renew_within_ms === "number" &&
    typeof registration.renew_by === "string" &&
    // Checked only when present, exactly as the host state's own optional blocks
    // are: one daemon serves checkouts pinned to different bundle versions, so a
    // record from a daemon older than renewal must still read as complete — while
    // a field that IS there and is the wrong shape still fails closed.
    (registration.renewed_at === undefined || typeof registration.renewed_at === "string") &&
    (registration.renewals === undefined || Number.isInteger(registration.renewals)) &&
    (registration.session_renewals === undefined || Number.isInteger(registration.session_renewals)) &&
    (registration.env === undefined || isLaunchEnvShape(registration.env)) &&
    (registration.log_path === undefined || typeof registration.log_path === "string") &&
    (registration.hooks === undefined || isProjectHooksShape(registration.hooks)) &&
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

function requireProjectHooks(value: unknown, projectLabel: string): RedskilledProjectHooks | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `redskilled needs project hooks to be a map keyed by public host event kind for project ` +
        `${JSON.stringify(projectLabel)}`,
    );
  }
  const hooks: Partial<Record<RedskilledPublicHostEventKind, RedskilledProjectHook>> = {};
  for (const [kind, launch] of Object.entries(value as Record<string, unknown>)) {
    if (!REDSKILLED_PUBLIC_HOST_EVENT_KINDS.includes(kind as RedskilledPublicHostEventKind)) {
      throw new Error(
        `redskilled cannot register project hook ${JSON.stringify(kind)} for project ${JSON.stringify(projectLabel)}: ` +
          `public host event kinds are ${REDSKILLED_PUBLIC_HOST_EVENT_KINDS.join(", ")}`,
      );
    }
    if (launch === null || typeof launch !== "object" || Array.isArray(launch)) {
      throw new Error(
        `redskilled needs hook ${JSON.stringify(kind)} for project ${JSON.stringify(projectLabel)} to be a launch template`,
      );
    }
    const template = launch as Record<string, unknown>;
    const mode = template.mode ?? "async";
    if (mode !== "async" && mode !== "sync") {
      throw new Error(
        `redskilled needs hook ${JSON.stringify(kind)} for project ${JSON.stringify(projectLabel)} mode to be ` +
          `"async" or "sync", not ${JSON.stringify(mode)}`,
      );
    }
    if (mode === "sync" &&
      (typeof template.deadline_ms !== "number" ||
        !Number.isFinite(template.deadline_ms) ||
        template.deadline_ms <= 0)) {
      throw new Error(
        `redskilled cannot register sync ${kind} hook for project ${JSON.stringify(projectLabel)} without a ` +
          `finite, positive deadline_ms: ${JSON.stringify(template.deadline_ms)} is not a bounded deadline`,
      );
    }
    hooks[kind as RedskilledPublicHostEventKind] = {
      argv: requireLaunchArgv(template.argv, projectLabel),
      env: requireLaunchEnv(template.env, projectLabel),
      ...(template.log_path == null
        ? {}
        : { log_path: requireLaunchLogPath(template.log_path, projectLabel) }),
      ...(template.mode == null ? {} : { mode }),
      ...(mode === "sync" ? { deadline_ms: template.deadline_ms as number } : {}),
    };
  }
  return hooks;
}

function isProjectHooksShape(value: unknown): value is RedskilledProjectHooks {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([kind, launch]) => {
    if (!REDSKILLED_PUBLIC_HOST_EVENT_KINDS.includes(kind as RedskilledPublicHostEventKind)) return false;
    if (launch === null || typeof launch !== "object" || Array.isArray(launch)) return false;
    const template = launch as Record<string, unknown>;
    return Array.isArray(template.argv) &&
      template.argv.length > 0 &&
      template.argv.every((word) => typeof word === "string" && word !== "") &&
      (template.env === undefined || isLaunchEnvShape(template.env)) &&
      (template.log_path === undefined || (typeof template.log_path === "string" && template.log_path !== "")) &&
      (template.mode === undefined || template.mode === "async" || template.mode === "sync") &&
      (template.mode !== "sync" ||
        (typeof template.deadline_ms === "number" &&
          Number.isFinite(template.deadline_ms) &&
          template.deadline_ms > 0));
  });
}

function isTrunkShape(value: unknown): value is RedskilledTrunk {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const trunk = value as Record<string, unknown>;
  return typeof trunk.remote === "string" && trunk.remote.trim() !== "" &&
    typeof trunk.branch === "string" && trunk.branch.trim() !== "";
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
