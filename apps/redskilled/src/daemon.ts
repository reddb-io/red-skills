/**
 * daemon — the `redskilled` singleton: one per MACHINE, behind a socket.
 *
 * Three mechanisms guard the singleton, and they answer different questions.
 * **Exclusive bind** answers "who owns the socket right now" — the kernel
 * refuses a second `listen()` on a bound path, so the start race between several
 * projects auto-spawning at once resolves without a vote. **The session lease**
 * answers "who owns this runtime directory across restarts" — a record that
 * survives the process, so a crash is reapable and a pid the OS reused cannot
 * impersonate the holder. **The machine claim** answers the one neither can see:
 * "does this machine already have a daemon somewhere else" — in another OS user's
 * `0700` runtime directory, which is invisible to both of the others (ADR 0130
 * Amendment 3). None is sufficient alone: a lease without a bind lets two daemons
 * both believe they own the socket, a bind without a lease loses the ownership
 * fact the moment the process dies, and both together still permit the second
 * daemon that voids the host budget.
 *
 * **Idle exit never runs while a Worker is believed alive** (ADR 0130 rule 7).
 * The rule is written into the timer rather than into a caller's discipline: on
 * every fire the daemon re-reads its own Worker set and rearms instead of
 * exiting if it is non-empty. Leaving by boredom would abandon a budget nobody
 * else is tracking.
 *
 * **A restart costs no work, and no accounting.** Workers are init-system units,
 * so a starting daemon does not find an empty world — it replays its own
 * append-only event lane, re-attaches to every Worker the host still confirms by
 * unit name, and records the deaths of the ones that ended while nobody was
 * watching. Identity and budget come back from the lane rather than from a
 * per-Worker durable record, because the two authorities that already hold the
 * rest of a Worker's story — the tracker and git — would only be contradicted by
 * a third copy.
 *
 * **A death is the host's answer, never the launch client's exit.** The process
 * the daemon watches under the transient-unit backend is `systemd-run --wait`,
 * which its own teardown kills while the init system keeps the Worker running.
 * Writing that exit onto the lane as a death is what let a live Worker escape the
 * host budget for good (#2917) — every successor replayed the death and adopted
 * nothing — so an exit is resolved against the unit before it is believed, and a
 * start additionally asks the host for the Worker units no lane accounts for.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { isPidAlive, sendLineRequest } from "@reddb-io/shared/resident-core.js";
import {
  evaluateWorkerAdmission,
  resolveHostCeiling,
  type RedskilledAdmissionVerdict,
  type RedskilledHostCeiling,
} from "./admission.js";
import {
  createRedskilledEventLane,
  rehydrateWorkers,
  type RedskilledEventLane,
  type RedskilledHostEvent,
} from "./event-lane.js";
import {
  buildRedskilledStopReport,
  type RedskilledDaemonStopped,
  type RedskilledStopReason,
} from "./daemon-stop.js";
import { buildHostState, type RedskilledHostState, type RedskilledWorkerView } from "./host-state.js";
import {
  evaluateMemoryBudgets,
  sampleWorkerTrees,
  type RedskilledBudgetTermination,
  type RedskilledCpuReading,
  type RedskilledRssReading,
  type RedskilledTreeReading,
  type RedskilledTreeSampler,
} from "./memory-sampler.js";
import {
  createRedskilledMachineClaimStore,
  currentMachineOwner,
  describeMachineScope,
  RedskilledMachineHeldError,
  resolveMachineClaimPath,
  type RedskilledMachineClaimStore,
  type RedskilledMachineOwner,
} from "./machine-scope.js";
import type { RedskilledPaths } from "./paths.js";
import {
  buildProjectRegistration,
  type RedskilledProjectRegistration,
  type RedskilledProjectRegistrationRequest,
} from "./project-registration.js";
import {
  detectUnitMainPid,
  detectWorkerLiveness,
  discoverUnownedWorkers,
  listActiveWorkerUnits,
  maySweepMachine,
  nameUnownedProject,
  reattachWorkers,
  stopWorker,
  type RedskilledLivenessProbe,
  type RedskilledStopProbe,
  type RedskilledUnitInventoryProbe,
  type RedskilledUnitPidProbe,
} from "./reattach.js";
import {
  REDSKILLED_PROTOCOL_VERSION,
  type RedskilledRequest,
  type RedskilledResponse,
  type RedskilledStatuslineRenderRequest,
  type RedskilledWorkerCommandRequest,
  type RedskilledProjectRegistered,
  type RedskilledWorkerCommandResult,
  type RedskilledWorkerHeartbeatAck,
  type RedskilledWorkerHeartbeatRequest,
} from "./protocol.js";
import { commandOp, evaluateSessionReach, type RedskilledSessionOp } from "./session-reach.js";
import {
  assertOneHostToken,
  DEFAULT_REDSKILLED_ACTIVITY_MS,
  fetchRepositoryActivity,
  type RedskilledActivityTransport,
  type RedskilledProjectRepository,
  type RedskilledRepositoryActivity,
} from "./repository-activity.js";
import { buildStatuslinePayload, type RedskilledStatuslinePayload } from "./statusline-payload.js";
import {
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledStatusline,
  type RedskilledStatuslineRender,
} from "./statusline-render.js";
import {
  launchWorker,
  type LaunchWorkerOptions,
  type LaunchedWorker,
  type RedskilledWorkerSpec,
} from "./worker-launch.js";
import {
  readLastLogLine,
  type RedskilledLogTailProbe,
  type RedskilledWorkerLogLine,
} from "./worker-log.js";
import {
  completeRedskilledReplacement,
  DEFAULT_REDSKILLED_REPLACE_CHECK_MS,
  isRedskilledSupervised,
  planRedskilledReplacement,
  prepareRedskilledReplacement,
  probePublishedRedskilledVersion,
  type RedskilledPublishedVersionProbe,
  type RedskilledReplacementDecision,
  type RedskilledReplacementIO,
} from "./self-replace.js";
import {
  createRedskilledLeaseStore,
  currentProcessOwner,
  type RedskilledLease,
  type RedskilledLeaseOwner,
  type RedskilledLeaseStore,
} from "./session-lease.js";

/** Default idle window before a Worker-free daemon leaves. */
export const DEFAULT_REDSKILLED_IDLE_MS = 300_000;

/**
 * Default window between memory samples.
 *
 * A whole-set sample is one pass over the process table, so the interval is
 * chosen for how fast a runaway must be caught rather than for how many Workers
 * are running — the cost does not move with the Worker count.
 */
export const DEFAULT_REDSKILLED_SAMPLE_MS = 15_000;

/** Raised when another daemon already serves this user session. */
export class RedskilledAlreadyRunningError extends Error {
  constructor(
    readonly socketPath: string,
    /** The live holder's lease, when the lease was the thing that refused us. */
    readonly lease?: RedskilledLease,
  ) {
    super(`a redskilled daemon already owns ${JSON.stringify(socketPath)}`);
    this.name = "RedskilledAlreadyRunningError";
  }
}

export interface RedskilledDaemonOptions {
  readonly paths: RedskilledPaths;
  readonly daemonVersion?: string;
  readonly idleMs?: number;
  /** The host-wide ceiling admission is decided against; the host's own by default. */
  readonly ceiling?: RedskilledHostCeiling;
  readonly owner?: RedskilledLeaseOwner;
  readonly leaseStore?: RedskilledLeaseStore;
  /** Who this daemon is to the machine — pid, start instant and uid. */
  readonly machineOwner?: RedskilledMachineOwner;
  /** The machine-wide arbiter; this machine's own claim by default. */
  readonly machineClaimStore?: RedskilledMachineClaimStore;
  readonly clock?: () => string;
  /** How a Worker is born; injected so a test can birth one without a spawn. */
  readonly launch?: (options: LaunchWorkerOptions) => LaunchedWorker;
  /** The append-only host event lane; defaults to this session's own. */
  readonly eventLane?: RedskilledEventLane;
  /** How the daemon asks whether a re-attached Worker is still running. */
  readonly liveness?: RedskilledLivenessProbe;
  /** How the daemon stops a Worker it is reclaiming a budget from. */
  readonly stopWorker?: RedskilledStopProbe;
  /**
   * How the daemon lists the Worker units this host has active.
   *
   * Injected so the sweep is provable without systemd — and so a test daemon on a
   * machine that already runs the real one does not adopt its Workers.
   */
  readonly unitInventory?: RedskilledUnitInventoryProbe;
  /** How a unit's live process is resolved when the recorded pid is spent. */
  readonly unitMainPid?: RedskilledUnitPidProbe;
  /** How the whole Worker set's tree RSS and CPU are read; `/proc` by default. */
  readonly treeSampler?: RedskilledTreeSampler;
  /** Window between memory samples; 0 or below leaves the sampler unarmed. */
  readonly sampleMs?: number;
  /**
   * How the daemon recovers a Worker's last logged line after a restart.
   *
   * Injected so a test can prove the read happens exactly once, on exactly the
   * path the client gave. It is never used on the normal path: a live Worker's
   * line arrives on its own heartbeat.
   */
  readonly readLogTail?: RedskilledLogTailProbe;
  /**
   * How the daemon learns what version is published; the registry by default.
   *
   * Injected because the whole upgrade behaviour hangs off this one answer, and a
   * test that could not state it would have to publish a release to prove
   * anything.
   */
  readonly publishedVersion?: RedskilledPublishedVersionProbe;
  /** Window between published-version checks; 0 or below leaves the watch unarmed. */
  readonly replaceCheckMs?: number;
  /** True when a unit will revive this process, so replacing means exiting. */
  readonly supervised?: boolean;
  /** How the successor is found and started; the real handover by default. */
  readonly replacementIO?: RedskilledReplacementIO;
  /**
   * The repositories whose activity this daemon polls, and the one token it uses.
   *
   * Absent leaves the poller unarmed and the payload honestly empty: a daemon with
   * no registered repository has nothing to count and must not invent zeros. The
   * registration is decided by the client before it arrives, because the daemon
   * must never learn what a `.red/config.yaml` is (ADR 0130 rule 3).
   */
  readonly repositoryActivity?: RedskilledActivityRegistration;
}

/**
 * What one host-scoped poller needs, and nothing more.
 *
 * The token is named by reference rather than carried as a secret here: the
 * transport already holds the credential, and the daemon needs the *identity*
 * only to refuse a project that declares a different one (ADR 0130 Amendment 1).
 */
export interface RedskilledActivityRegistration {
  readonly projects: readonly RedskilledProjectRepository[];
  readonly hostTokenRef: string;
  readonly transport: RedskilledActivityTransport;
  /** Window between fetches; 0 or below leaves the poller unarmed. */
  readonly intervalMs?: number;
  readonly closedWindowMs?: number;
}

export interface RedskilledDaemon {
  readonly socketPath: string;
  readonly lease: RedskilledLease;
  readonly startedAt: string;
  /** Resolves when the daemon has stopped listening and released its lease. */
  readonly closed: Promise<void>;
  /** Birth a Worker from a spec: admit, plan placement, launch, track, report. */
  startWorker(spec: RedskilledWorkerSpec): LaunchedWorker;
  /** Judge a spec against the live host without birthing anything. */
  admit(spec: RedskilledWorkerSpec): RedskilledAdmissionVerdict;
  /** The ceiling this daemon admits against. */
  ceiling(): RedskilledHostCeiling;
  /** Record a Worker the daemon believes is alive — the idle gate reads this set. */
  trackWorker(worker: RedskilledWorkerView): void;
  /** Forget a Worker the daemon has observed dying. */
  releaseWorker(workerId: string): boolean;
  workerCount(): number;
  /**
   * Hold a project's registration, or refuse it because one already stands.
   *
   * Storing it is the whole of this: nothing polls the selector, nothing is
   * dispatched from the argv, and the daemon reads neither. What it does read is
   * the label, which is the same opaque string a Worker already carries.
   */
  registerProject(
    request: RedskilledProjectRegistrationRequest,
    sessionProject?: string,
  ): RedskilledProjectRegistered;
  /** The registrations this daemon holds, ordered by project label. */
  registrations(): readonly RedskilledProjectRegistration[];
  hostState(): RedskilledHostState;
  /**
   * The whole machine in one document, dated by the daemon's own last sample.
   *
   * A read, never a measurement: sampling on demand would let two surfaces
   * reading the same instant get two different answers, which is the very split
   * the payload exists to close. The age of the last tick travels inside it.
   */
  statuslinePayload(): RedskilledStatuslinePayload;
  /**
   * Reclaim a Worker's budget: stop it, record the kill, forget it.
   *
   * A budget kill is its own event rather than a death with a note, because the
   * two answer different questions — a reader counting how often the host ran
   * out of room must not have to distinguish it from a Worker that finished.
   */
  killWorkerOverBudget(workerId: string, detail: string): Promise<boolean>;
  /**
   * Sample the whole Worker set once and terminate everything over its budget.
   *
   * The floor every placement backend stands on, exposed so the tick can be
   * driven by a test as well as by the timer. Returns the terminations it
   * performed, each naming the budget it enforced.
   */
  sampleMemoryBudgets(): Promise<readonly RedskilledBudgetTermination[]>;
  /**
   * Store one Worker's last logged line, exactly as it was published.
   *
   * The daemon widens by one string and learns nothing: it does not parse the
   * line, does not date it from its content, and does not know which file it came
   * out of. That ignorance is what keeps the verbose statusline a single read
   * instead of a disk read per Worker per render.
   */
  publishWorkerHeartbeat(request: RedskilledWorkerHeartbeatRequest): RedskilledWorkerHeartbeatAck;
  /**
   * Fetch every registered project's counts once — one request, however many.
   *
   * Exposed so the interval can be driven by a test as well as by the timer, and
   * because a caller that has just registered a repository should not have to wait
   * a whole window to see it counted. Resolves to `null` when nothing is registered.
   */
  pollRepositoryActivity(): Promise<RedskilledRepositoryActivity | null>;
  /** Re-probe every re-attached Worker, retiring the ones the host no longer confirms. */
  sweepReattached(): Promise<readonly RedskilledWorkerView[]>;
  /** The Workers this daemon adopted at start rather than birthing itself. */
  reattached(): readonly RedskilledWorkerView[];
  /** Resolves once every event handed to the lane has reached disk. */
  flushEvents(): Promise<void>;
  /** Force the idle check to run now — the timer's body, exposed for tests. */
  evaluateIdle(): "exited" | "held-by-workers";
  /**
   * Resolve the published version and decide, WITHOUT acting on the decision.
   *
   * The observation and the handover are separate verbs so a reader can see a
   * decided replacement before it happens — and so the daemon's own version stays
   * the version it is running for the whole of that window.
   */
  observePublishedVersion(): Promise<RedskilledReplacementDecision>;
  /**
   * Observe, and if a newer version is published, hand the session over to it.
   *
   * Workers are untouched: they are init-system units (ADR 0130 rule 5), so a
   * replacement is a restart and the successor re-attaches to every one of them
   * through the event lane.
   */
  checkForReplacement(): Promise<RedskilledReplacementDecision>;
  /**
   * What a stop right now would be giving up — WITHOUT stopping anything.
   *
   * The report and the act are separate verbs for the same reason the version
   * observation and the handover are: an operator about to replace a daemon must
   * be able to read what it is holding before deciding to take it away.
   */
  stopReport(reason?: RedskilledStopReason): RedskilledDaemonStopped;
  /**
   * Let go of the session, stating why.
   *
   * The reason is written to the event lane before anything is released, so a
   * successor replaying it can tell a planned handover from a death (#2919). The
   * Workers are untouched either way — they are init-system units, so a stop is a
   * restart and not an evacuation.
   */
  stop(intent?: RedskilledStopIntent): Promise<void>;
}

/** Why a daemon is being stopped, and by what, when a signal asked. */
export interface RedskilledStopIntent {
  /** Defaults to `requested`: someone asked, through the socket or in code. */
  readonly reason?: RedskilledStopReason;
  readonly signal?: string;
  /** The asker's own words, recorded with the stop and never interpreted. */
  readonly note?: string;
}

/**
 * Start the daemon, or refuse because this session already has one.
 *
 * Refusal is a typed throw rather than a `null`: ADR 0130 fails closed, and a
 * caller that cannot tell "already running" from "failed to start" would either
 * spawn a second daemon or drop the client on the floor.
 */
export async function startRedskilledDaemon(options: RedskilledDaemonOptions): Promise<RedskilledDaemon> {
  const { paths } = options;
  const daemonVersion = options.daemonVersion ?? "0.0.0-dev";
  const idleMs = options.idleMs ?? DEFAULT_REDSKILLED_IDLE_MS;
  const clock = options.clock ?? (() => new Date().toISOString());
  const launch = options.launch ?? launchWorker;
  const ceiling = options.ceiling ?? resolveHostCeiling();
  // Before the lease, before the socket: a host whose repositories do not all
  // answer to one token has no arrangement to start with, and discovering that a
  // window later would mean the daemon had already polled under a wrong identity.
  if (options.repositoryActivity != null) {
    assertOneHostToken(options.repositoryActivity.projects, options.repositoryActivity.hostTokenRef);
  }
  const owner = options.owner ?? currentProcessOwner();
  const leaseStore = options.leaseStore ?? createRedskilledLeaseStore(paths.leasePath, {
    sessionKeyHash: paths.sessionKeyHash,
    machineIdHash: paths.machineIdHash,
    socketPath: paths.socketPath,
  }, { clock });

  const machineOwner = options.machineOwner ?? currentMachineOwner();
  const claimLabels = {
    machineIdHash: paths.machineIdHash,
    sessionKeyHash: paths.sessionKeyHash,
    socketPath: paths.socketPath,
  };
  const machineClaimStore = options.machineClaimStore ??
    createRedskilledMachineClaimStore(paths.machineClaimPath, claimLabels, { clock });

  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });

  // The machine before the runtime directory: a daemon that bound a socket and
  // then discovered another user already holds the machine would have been the
  // second arbiter for the length of that window, and the budget is only
  // meaningful if it never was (ADR 0130 Amendment 3).
  const claimed = await machineClaimStore.claim(machineOwner);
  if (!claimed.claimed) {
    // A holder on OUR OWN socket is not the machine-scope story: it is the
    // ordinary start race, and the caller that loses it wants the refusal that
    // names a running daemon it can join. The machine claim speaks only for the
    // case the lease and the bind cannot see — a daemon somewhere else.
    if (claimed.claim?.socket_path === paths.socketPath) {
      throw new RedskilledAlreadyRunningError(paths.socketPath);
    }
    throw new RedskilledMachineHeldError(machineClaimStore.claimPath, claimed.reason, claimed.claim);
  }

  const acquisition = await leaseStore.acquire(owner);
  if (!acquisition.acquired) {
    await machineClaimStore.release(machineOwner).catch(() => undefined);
    throw new RedskilledAlreadyRunningError(paths.socketPath, acquisition.lease);
  }

  let server: Server;
  try {
    server = await bindExclusive(paths.socketPath);
  } catch (err) {
    await leaseStore.release(owner).catch(() => undefined);
    await machineClaimStore.release(machineOwner).catch(() => undefined);
    throw err;
  }

  const startedAt = clock();
  const eventLane = options.eventLane ?? createRedskilledEventLane(paths.eventLanePath);
  const liveness = options.liveness ?? detectWorkerLiveness;
  const stopProbe = options.stopWorker ?? stopWorker;
  const unitInventory = options.unitInventory ??
    (() =>
      maySweepMachine(paths.machineClaimPath, resolveMachineClaimPath({ machineIdHash: paths.machineIdHash }))
        ? listActiveWorkerUnits()
        : []);
  const unitMainPid = options.unitMainPid ?? detectUnitMainPid;
  const treeSampler = options.treeSampler ?? sampleWorkerTrees;
  const readLogTail = options.readLogTail ?? readLastLogLine;
  const sampleMs = options.sampleMs ?? DEFAULT_REDSKILLED_SAMPLE_MS;
  const publishedProbe = options.publishedVersion ?? ((running: string) => probePublishedRedskilledVersion(running));
  const replaceCheckMs = options.replaceCheckMs ?? DEFAULT_REDSKILLED_REPLACE_CHECK_MS;
  const supervised = options.supervised ?? isRedskilledSupervised();
  const replacementIO = options.replacementIO ?? {};
  const activityRegistration = options.repositoryActivity;
  const activityMs = activityRegistration?.intervalMs ?? DEFAULT_REDSKILLED_ACTIVITY_MS;
  const workers = new Map<string, RedskilledWorkerView>();
  // Re-attached Workers have no child handle to deliver an exit, so their death
  // is discovered by asking the host rather than by being told.
  const reattached = new Set<string>();
  // The last line each Worker published, by Worker id. Held in memory only: it is
  // a live progress note, and a durable copy would be a third authority on a
  // Worker's story next to the tracker and git (ADR 0130).
  const logLines = new Map<string, RedskilledWorkerLogLine>();
  // What each project asked the host to hold for it, by project label. In memory,
  // like the log lines and for the same reason: a registration is a live statement
  // a session renews, and a durable copy would outlive the thing it describes. The
  // slice that polls it owns keeping the daemon alive while one stands.
  const registrations = new Map<string, RedskilledProjectRegistration>();
  const activeSockets = new Set<Socket>();
  // The last thing the sampler measured, kept so a read is dated rather than
  // dating itself: staleness belongs to the daemon that took the measurement.
  let lastReading: RedskilledRssReading = {};
  let lastSampledAt: string | null = null;
  // What this daemon has resolved about the world's version, kept beside — never
  // inside — the version it is running.
  let publishedVersion: string | null = null;
  let publishedCheckedAt: string | null = null;
  let publishedIsNewer = false;
  let replacementState: "none" | "pending" | "in-progress" = "none";
  // The last activity fetch, kept for the same reason the RSS reading is: a read
  // between two polls is dated by the poll it came from, never by the read.
  let lastActivity: RedskilledRepositoryActivity | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  let sampleTimer: NodeJS.Timeout | undefined;
  let replaceTimer: NodeJS.Timeout | undefined;
  let activityTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  // Raised the instant a stop begins; `stopping` follows once the daemon's own
  // departure has reached the lane. See `stop`.
  let leaving = false;
  // The one append that says this daemon left, held so every route to a stop —
  // the op, a signal, idle, a handover — writes it exactly once.
  let departure: Promise<unknown> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function hostState(): RedskilledHostState {
    return buildHostState({
      daemonVersion,
      machineIdHash: paths.machineIdHash,
      sessionKeyHash: paths.sessionKeyHash,
      pid: owner.pid,
      startedAt,
      scope: describeMachineScope(machineClaimStore.claimPath, claimLabels, machineOwner),
      workers: [...workers.values()],
      registrations: [...registrations.values()],
      published: {
        version: publishedVersion,
        checkedAt: publishedCheckedAt,
        newer: publishedIsNewer,
        replacement: replacementState,
      },
    });
  }

  /**
   * The host-wide payload, assembled from this daemon's own facts alone.
   *
   * Nothing here is read from a second place: the Worker set, the ceiling, the
   * last RSS reading and the instant it was taken all belong to this process, so
   * a consumer never holds a private source it could contradict the daemon with.
   */
  function statuslinePayload(): RedskilledStatuslinePayload {
    return buildStatuslinePayload({
      hostState: hostState(),
      ceiling,
      rss: lastReading,
      sampledAt: lastSampledAt,
      logLines: Object.fromEntries(logLines),
      now: clock(),
      reattachedWorkerIds: [...reattached],
      repositoryActivity: lastActivity,
    });
  }

  /**
   * One interval's activity fetch: ONE request, however many projects.
   *
   * The counts are stored and never read here — the daemon does not know what an
   * open pull request is, only that it holds an integer someone else will render.
   * A failed fetch replaces the stored document rather than leaving the last one
   * to pass for current, because the failure is itself the fact a consumer needs.
   */
  async function pollRepositoryActivity(): Promise<RedskilledRepositoryActivity | null> {
    if (activityRegistration == null || activityRegistration.projects.length === 0) return null;
    lastActivity = await fetchRepositoryActivity({
      projects: activityRegistration.projects,
      hostTokenRef: activityRegistration.hostTokenRef,
      transport: activityRegistration.transport,
      closedWindowMs: activityRegistration.closedWindowMs,
      now: clock(),
    });
    return lastActivity;
  }

  /**
   * The rendered line, from that same payload and from nothing else.
   *
   * The request carries taste already settled by the client — mode, project and
   * the count budgets — because a daemon that resolved a config would have to
   * know what a `.red/config.yaml` is, and ADR 0130 rule 3 keeps repository
   * layout out of this process entirely. An absent field takes the shared
   * default, so a bare read still renders.
   */
  function statuslineString(render?: RedskilledStatuslineRenderRequest): RedskilledStatuslineRender {
    return renderRedskilledStatusline(statuslinePayload(), {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      mode: render?.mode ?? REDSKILLED_STATUSLINE_DEFAULTS.mode,
      project: render?.project ?? REDSKILLED_STATUSLINE_DEFAULTS.project,
      maxWorkers: render?.max_workers ?? REDSKILLED_STATUSLINE_DEFAULTS.maxWorkers,
      maxProjects: render?.max_projects ?? REDSKILLED_STATUSLINE_DEFAULTS.maxProjects,
      maxWidth: render?.max_width ?? REDSKILLED_STATUSLINE_DEFAULTS.maxWidth,
      verbose: render?.verbose ?? REDSKILLED_STATUSLINE_DEFAULTS.verbose,
    });
  }

  /**
   * Decide whether a session may do this, before any mechanism runs.
   *
   * Reach is checked FIRST and against the target's project, so a cross-project
   * command is refused identically whether or not the daemon could have carried
   * it out — a refusal that leaked "no such Worker" would let a session map
   * another project's Worker set by guessing at it.
   */
  function authorize(op: RedskilledSessionOp, sessionProject: string | undefined, targetProject: string | null) {
    return evaluateSessionReach({ op, sessionProject: sessionProject ?? null, targetProject });
  }

  /** Carry out one commanding verb, once reach has permitted it. */
  async function runWorkerCommand(request: RedskilledWorkerCommandRequest): Promise<RedskilledWorkerCommandResult> {
    const target = workers.get(request.worker_id);
    const reach = authorize(commandOp(request.command), request.session_project, target?.project_label ?? null);
    if (!reach.permitted) throw new Error(reach.reason);
    if (request.command !== "stop") {
      // Recycle and steer are work decisions — which Ticket is retried, what a
      // runner is told — and the daemon carries no castle semantics (ADR 0130
      // rule 3). Their reach is decided here; their mechanism belongs to the
      // project's own bundle, on top of stop and birth.
      throw new Error(
        `redskilled does not implement ${request.command}: it owns birth, death and limits, and ${request.command} is a work decision the project's own bundle makes on top of them`,
      );
    }
    const stopped = target != null && await stopWorkerNow(target, request.detail ?? "stopped by its own project");
    return {
      version: 1,
      command: request.command,
      worker_id: request.worker_id,
      applied: stopped,
      reach,
      detail: stopped
        ? `redskilled stopped Worker ${JSON.stringify(request.worker_id)} of project ${JSON.stringify(target!.project_label)}`
        : `redskilled holds no live Worker ${JSON.stringify(request.worker_id)} to stop`,
    };
  }

  /**
   * Drop every belief about one Worker at once.
   *
   * One function rather than three deletes at each site: a Worker forgotten from
   * the live set but left in the log-line map would keep a dead Worker's progress
   * note alive and leak a little memory per death.
   */
  function forgetWorker(workerId: string): void {
    workers.delete(workerId);
    reattached.delete(workerId);
    logLines.delete(workerId);
  }

  /**
   * Record one heartbeat's line, once reach has permitted it.
   *
   * Reach is checked against the TARGET's project, exactly as a command is, so a
   * session cannot publish a line into another project's statusline. A refusal
   * throws and stores nothing.
   */
  function publishWorkerHeartbeat(request: RedskilledWorkerHeartbeatRequest): RedskilledWorkerHeartbeatAck {
    const target = workers.get(request.worker_id);
    const reach = authorize("worker-heartbeat", request.session_project, target?.project_label ?? null);
    if (!reach.permitted) throw new Error(reach.reason);
    if (typeof request.last_log_line !== "string") {
      // The shape, not the content: the daemon must know it holds a string, and
      // that is the last thing it ever asks about this value.
      throw new Error("redskilled worker heartbeat last_log_line must be a string");
    }
    if (target == null) {
      return {
        version: 1,
        worker_id: request.worker_id,
        accepted: false,
        reach,
        published_at: null,
        detail: `redskilled holds no live Worker ${JSON.stringify(request.worker_id)} to publish a line for`,
      };
    }
    const publishedAt = clock();
    logLines.set(request.worker_id, { line: request.last_log_line, published_at: publishedAt, source: "heartbeat" });
    return {
      version: 1,
      worker_id: request.worker_id,
      accepted: true,
      reach,
      published_at: publishedAt,
      detail: `redskilled stored a line for Worker ${JSON.stringify(request.worker_id)} without reading it`,
    };
  }

  /**
   * Decide what one observed process exit MEANS, before recording anything.
   *
   * Under the transient-unit backend the process the daemon watches is
   * `systemd-run --wait` — a client standing beside the unit, not the unit — so
   * its exit is evidence and not a verdict. The daemon's own teardown kills that
   * client (its cgroup goes with it) while the init system keeps the Worker
   * running, and a daemon that wrote a death for it put a live Worker outside the
   * host budget permanently: the death is on the lane, so every successor replays
   * it and adopts nothing (#2917). An unisolated Worker has no such gap — the
   * process that exited IS the Worker — so its exit is a death exactly as before.
   */
  async function resolveObservedExit(
    worker: RedskilledWorkerView,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const ended = `exit code=${code ?? "null"} signal=${signal ?? "null"}`;
    if (worker.unit != null && worker.unit !== "" && (await confirmedAlive(worker))) {
      adoptSurvivingUnit(
        worker,
        `its launch client ended (${ended}) while unit ${JSON.stringify(worker.unit)} stayed active, ` +
          "so the daemon holds it by unit name from here on and its death is discovered by asking the host",
      );
      return;
    }
    forgetWorker(worker.worker_id);
    record("worker-death", worker, ended, { exitCode: code, signal });
    armIdleTimer();
  }

  /** Ask the host about one Worker; an unanswerable probe is not a confirmation. */
  async function confirmedAlive(worker: RedskilledWorkerView): Promise<boolean> {
    try {
      return (await liveness(worker)) === true;
    } catch {
      return false;
    }
  }

  /**
   * Keep holding a Worker whose unit outlived the process that launched it.
   *
   * Nothing is written to the lane: the birth already there is exactly what a
   * successor needs, and the daemon's own belief moves into the re-attached set
   * because there is no child handle left to deliver an exit — from here the
   * Worker's death is discovered by the sweep, on the same terms as one adopted
   * across a restart. The pid is refreshed from the unit for the sampler's sake:
   * a budget watched through a reclaimed pid is a budget nobody measures.
   */
  function adoptSurvivingUnit(worker: RedskilledWorkerView, reason: string): void {
    const pid = worker.unit == null ? null : unitMainPid(worker.unit);
    workers.set(worker.worker_id, {
      ...worker,
      ...(pid != null && pid > 0 ? { pid } : {}),
      warnings: [...worker.warnings, reason],
    });
    reattached.add(worker.worker_id);
    armIdleTimer();
  }

  /**
   * Hold one project's registration, once reach has permitted it.
   *
   * Reach is checked against the registration's OWN label — the project being
   * registered is the target — so a session cannot commit another project to an
   * argv it never chose. The record is then built and stored without a single
   * question being asked about what its selector says (ADR 0130 rule 3).
   */
  function registerProject(
    request: RedskilledProjectRegistrationRequest,
    sessionProject?: string,
  ): RedskilledProjectRegistered {
    const reach = authorize("project-register", sessionProject, request.project_label);
    if (!reach.permitted) throw new Error(reach.reason);
    const registration = buildProjectRegistration(request, {
      now: clock(),
      held: registrations.get(request.project_label),
    });
    registrations.set(registration.project_label, registration);
    return {
      version: 1,
      registration,
      reach,
      detail:
        `redskilled holds a registration for project ${JSON.stringify(registration.project_label)} at a target of ` +
        `${registration.target} until ${registration.renew_by}, and has read neither its selector nor its argv`,
    };
  }

  /** Stop one Worker the daemon holds, and record its death. */
  async function stopWorkerNow(worker: RedskilledWorkerView, detail: string): Promise<boolean> {
    try {
      await stopProbe(worker);
    } catch {
      // A stop the host refused still ends the daemon's claim: a Worker it keeps
      // holding a budget for while nothing supervises it is the worse state.
    }
    forgetWorker(worker.worker_id);
    record("worker-death", worker, detail);
    armIdleTimer();
    return true;
  }

  /**
   * Judge one request against the Workers this daemon is holding right now.
   *
   * The denominator is live process state across every project, which is the
   * whole point: a per-repository profile would let each checkout conclude the
   * machine affords N Workers and spend that budget alone.
   */
  function admit(spec: RedskilledWorkerSpec): RedskilledAdmissionVerdict {
    return evaluateWorkerAdmission({
      ceiling,
      workers: [...workers.values()],
      budget: spec.budget,
      projectLabel: spec.project_label,
    });
  }

  /**
   * Birth one Worker.
   *
   * Admission comes first and the verdict travels into the launch, so a refusal
   * is a Worker that never existed rather than one killed after the fact.
   *
   * Tracking happens here rather than in the caller, so the idle gate and the
   * host state learn about a Worker at the same instant the process exists —
   * a launch the daemon forgot to track would be an untracked budget.
   */
  function startWorker(spec: RedskilledWorkerSpec): LaunchedWorker {
    const launched = launch({
      spec,
      admission: admit(spec),
      clock,
      onExit: (workerId, code, signal) => {
        const worker = workers.get(workerId);
        if (worker == null) {
          armIdleTimer();
          return;
        }
        void resolveObservedExit(worker, code, signal).catch(() => undefined);
      },
    });
    workers.set(launched.worker.worker_id, launched.worker);
    record("worker-birth", launched.worker, null);
    armIdleTimer();
    return launched;
  }

  /**
   * Append one event, without making the caller wait for the disk.
   *
   * The lane serialises its own appends, so ordering survives the fire-and-
   * forget; what a failed write must not do is take down the daemon that still
   * holds the live Worker the event was about.
   */
  function record(
    event: RedskilledHostEvent["event"],
    worker: RedskilledWorkerView,
    detail: string | null,
    // The exit facts a project's policy turns on, when the daemon witnessed
    // them. Absent for every event that is not an observed process exit.
    exit: { readonly exitCode?: number | null; readonly signal?: NodeJS.Signals | null } = {},
  ): void {
    // A stopped daemon writes nothing. Its beliefs about who is alive stopped
    // being authoritative when it let go of the session, and the next daemon
    // re-derives every one of them by asking the host directly.
    if (stopping) return;
    void eventLane
      .record({
        event,
        worker,
        ts: clock(),
        detail,
        ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
        ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
      })
      .catch(() => undefined);
  }

  /**
   * Ask the host about every re-attached Worker, and retire the ones it no
   * longer confirms. Returns the Workers that were retired.
   */
  async function sweepReattached(): Promise<readonly RedskilledWorkerView[]> {
    const adopted = [...reattached].map((id) => workers.get(id)).filter((w): w is RedskilledWorkerView => w != null);
    if (adopted.length === 0) return [];
    const { dead } = await reattachWorkers(adopted, liveness);
    for (const worker of dead) {
      forgetWorker(worker.worker_id);
      record("worker-death", worker, "the host no longer confirms this Worker");
    }
    if (dead.length > 0) armIdleTimer();
    return dead;
  }

  async function killWorkerOverBudget(workerId: string, detail: string): Promise<boolean> {
    const worker = workers.get(workerId);
    if (!worker) return false;
    try {
      await stopProbe(worker);
    } catch {
      // The kill is recorded either way: a stop the host refused still ends the
      // daemon's claim on the budget, and a silent failure would leave the
      // accounting holding room for a Worker nobody is tracking any more.
    }
    forgetWorker(workerId);
    record("worker-budget-kill", worker, detail);
    armIdleTimer();
    return true;
  }

  /**
   * One tick of the floor: sample the whole set, terminate what is over budget.
   *
   * The sample is taken ONCE for every Worker the daemon holds, so the tick's
   * cost is the host's process table rather than the Worker count. An empty set
   * is not sampled at all — there is nothing to measure and nothing to kill.
   *
   * The tick's CPU reading is recorded on every Worker it measured and acted on
   * by nothing here: this tick enforces the memory budget, exactly as it did
   * before the second number existed.
   */
  async function sampleMemoryBudgets(): Promise<readonly RedskilledBudgetTermination[]> {
    const live = [...workers.values()];
    if (live.length === 0) return [];
    let reading: RedskilledTreeReading;
    try {
      reading = await treeSampler(live);
    } catch {
      // A sampler that could not read the host measured nothing, and a Worker
      // nothing measured is never killed on suspicion — nor is the last reading
      // re-dated, because a failed tick must age the payload rather than refresh it.
      return [];
    }
    const rss = reading.rss;
    lastReading = rss;
    lastSampledAt = clock();
    recordCpuReading(reading.cpu_seconds, lastSampledAt);
    const { terminations } = evaluateMemoryBudgets({ workers: live, rss });
    const done: RedskilledBudgetTermination[] = [];
    for (const termination of terminations) {
      if (await killWorkerOverBudget(termination.worker_id, termination.reason)) done.push(termination);
    }
    return done;
  }

  /**
   * Carry this tick's CPU reading onto the Workers it measured.
   *
   * A Worker the tick did NOT measure keeps the sample it already had, dated by
   * the tick that took it: dropping the number would erase the last thing known
   * about a Worker exactly when it went quiet, and re-dating it would forge a
   * measurement this tick never made.
   */
  function recordCpuReading(cpuSeconds: RedskilledCpuReading, sampledAt: string): void {
    for (const [workerId, seconds] of Object.entries(cpuSeconds)) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) continue;
      const held = workers.get(workerId);
      if (!held) continue;
      workers.set(workerId, { ...held, cpu: { cpu_seconds: seconds, sampled_at: sampledAt } });
    }
  }

  /**
   * Ask what is published, record it, and decide — acting on nothing.
   *
   * A probe that throws leaves the answer UNKNOWN rather than asserting the
   * running version: an unresolvable read must not manufacture the match that
   * makes a superseded daemon look current (#2809).
   */
  async function observePublishedVersion(): Promise<RedskilledReplacementDecision> {
    let observed: string | null;
    try {
      observed = await publishedProbe(daemonVersion);
    } catch {
      observed = null;
    }
    publishedVersion = observed;
    publishedCheckedAt = clock();
    const decision = planRedskilledReplacement({ running: daemonVersion, published: observed, supervised });
    publishedIsNewer = decision.act === "replace";
    // An in-progress handover is never talked back down: the socket and the lease
    // are already going, and a later "hold" would only mislabel what is happening.
    if (replacementState !== "in-progress") replacementState = decision.act === "replace" ? "pending" : "none";
    return decision;
  }

  /**
   * Observe, then hand the session over when a newer version is published.
   *
   * The order is the contract: flush the lane, let go of the socket and the
   * lease, and only then start the successor — a successor racing this process
   * for the exclusive bind would die, and the machine would keep the old bundle.
   */
  async function checkForReplacement(): Promise<RedskilledReplacementDecision> {
    const decision = await observePublishedVersion();
    if (decision.act !== "replace" || replacementState === "in-progress") return decision;
    // The successor is found FIRST. A published bundle this host cannot reach
    // costs the upgrade and nothing else: the throw leaves this daemon serving,
    // still holding every Worker, still reporting the version it actually runs.
    const prepared = prepareRedskilledReplacement(decision, replacementIO);
    replacementState = "in-progress";
    await eventLane.flush().catch(() => undefined);
    await stop({ reason: "replaced" });
    completeRedskilledReplacement(prepared, paths, {
      ...(idleMs == null ? {} : { idleMs }),
      io: replacementIO,
    });
    return decision;
  }

  function armReplaceTimer(): void {
    if (stopping || replaceTimer != null || replaceCheckMs <= 0) return;
    replaceTimer = setInterval(() => {
      void checkForReplacement().catch(() => undefined);
    }, replaceCheckMs);
    replaceTimer.unref();
  }

  function armSampleTimer(): void {
    if (stopping || sampleTimer != null || sampleMs <= 0) return;
    sampleTimer = setInterval(() => {
      void sampleMemoryBudgets().catch(() => undefined);
    }, sampleMs);
    sampleTimer.unref();
  }

  /**
   * Arm the poller, once, on its own window.
   *
   * Its interval is the tracker's rather than the sampler's: repository activity
   * moves at human speed and costs shared quota, so polling it as often as the
   * process table would spend a budget every project on the host draws from.
   */
  function armActivityTimer(): void {
    if (stopping || activityTimer != null) return;
    if (activityRegistration == null || activityRegistration.projects.length === 0 || activityMs <= 0) return;
    void pollRepositoryActivity().catch(() => undefined);
    activityTimer = setInterval(() => {
      void pollRepositoryActivity().catch(() => undefined);
    }, activityMs);
    activityTimer.unref();
  }

  function armIdleTimer(): void {
    if (stopping) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Sweep before deciding: a daemon that exited on a stale belief in a
      // re-attached Worker would hold this session's socket for nothing.
      void sweepReattached()
        .catch(() => undefined)
        .then(() => evaluateIdle());
    }, idleMs);
    idleTimer.unref();
  }

  function evaluateIdle(): "exited" | "held-by-workers" {
    // The rule that will matter once Workers exist, in place from the start: a
    // daemon that believes it holds live Workers rearms instead of exiting.
    if (workers.size > 0) {
      armIdleTimer();
      return "held-by-workers";
    }
    void stop({ reason: "idle" });
    return "exited";
  }

  /**
   * What this daemon is holding, and what a stop for `reason` would leave behind.
   *
   * Answered BEFORE anything is given up, so the report a caller reads describes
   * the machine it is about to change rather than the one left over afterwards.
   */
  function stopReport(reason: RedskilledStopReason): RedskilledDaemonStopped {
    return buildRedskilledStopReport({
      reason,
      socketPath: paths.socketPath,
      daemonVersion,
      pid: owner.pid,
      workers: [...workers.values()],
      projects: [...registrations.keys()],
    });
  }

  /**
   * Write this daemon's departure to the lane — ONCE, however often it is asked.
   *
   * Separate from `stop` because the two have different deadlines: the stop op
   * answers only after the departure is on disk, so an operator told "stopping"
   * holds a fact a successor can already read, while the release of the socket and
   * the lease follows behind it.
   */
  function recordDeparture(intent: RedskilledStopIntent): Promise<unknown> {
    if (departure != null) return departure;
    const reason = intent.reason ?? "requested";
    const note = intent.note?.trim();
    departure = eventLane
      .recordDaemonStop({
        ts: clock(),
        pid: owner.pid,
        socketPath: paths.socketPath,
        reason,
        detail: note == null || note === "" ? stopReport(reason).detail : `${stopReport(reason).detail} — ${note}`,
        ...(intent.signal == null ? {} : { signal: intent.signal }),
      })
      .catch(() => undefined);
    return departure;
  }

  async function stop(intent: RedskilledStopIntent = {}): Promise<void> {
    // `leaving` rather than `stopping`: the departure is awaited before the daemon
    // stops trusting itself, and a second caller arriving inside that window would
    // otherwise release a session whose record was still in flight.
    if (leaving) return await closed;
    leaving = true;
    // Recorded before `stopping` is set, because the daemon writes nothing to the
    // lane once it is — and awaited, because a stop still in flight when the
    // process leaves is indistinguishable from the crash it exists to rule out.
    await recordDeparture(intent);
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (sampleTimer) clearInterval(sampleTimer);
    if (replaceTimer) clearInterval(replaceTimer);
    if (activityTimer) clearInterval(activityTimer);
    // Every event already handed over reaches the lane before the daemon lets go
    // of the session: a birth still in flight would leave the next daemon with a
    // Worker it holds a budget for and no record of.
    await eventLane.flush().catch(() => undefined);
    server.close();
    for (const socket of activeSockets) socket.destroy();
    await new Promise<void>((resolve) => server.once("close", () => resolve()));
    await rm(paths.socketPath, { force: true });
    await leaseStore.release(owner).catch(() => undefined);
    // Released last, in the reverse order it was taken: the machine is free only
    // once nothing of this daemon is left holding it.
    await machineClaimStore.release(machineOwner).catch(() => undefined);
    resolveClosed();
    return await closed;
  }

  // Rehydrate BEFORE the socket starts answering: a client that read host state
  // in the window between binding and replay would be told this session holds
  // nothing, and would then birth a second Worker for work already running.
  const replayed = rehydrateWorkers(await eventLane.read().catch(() => []));
  const reattachment = await reattachWorkers(replayed, liveness);
  for (const worker of reattachment.alive) {
    // Named, never dropped: a Worker whose owning project the lane no longer
    // carries is still a live process charged to this machine, and the label it
    // is reported under is the only thing an operator has to act on.
    const adopted = nameUnownedProject(worker);
    // The lane's pid is the launch client's, which a restart routinely outlives;
    // the unit is the identity, so the pid is re-asked rather than believed.
    const refreshed = adopted.unit == null || isPidAlive(adopted.pid) ? null : unitMainPid(adopted.unit);
    workers.set(adopted.worker_id, refreshed != null && refreshed > 0 ? { ...adopted, pid: refreshed } : adopted);
    reattached.add(adopted.worker_id);
  }
  for (const worker of reattachment.dead) {
    record("worker-death", worker, "the Worker ended while no daemon was watching");
  }
  // The lane is this daemon's memory, not the machine's: a Worker whose birth was
  // never written — or was written and then falsely retired — is invisible to the
  // replay and very much alive to the host. So the host itself is asked, and a
  // unit nobody accounts for is adopted rather than left outside the budget
  // (#2917). Failing to ask costs the sweep and never the start.
  const discovered = discoverUnownedWorkers({
    units: await Promise.resolve(unitInventory()).catch(() => []),
    held: [...workers.values()],
    mainPid: unitMainPid,
    now: startedAt,
  });
  for (const worker of discovered) {
    workers.set(worker.worker_id, worker);
    reattached.add(worker.worker_id);
    record("worker-birth", worker, "adopted from an active unit with no birth on this lane");
  }
  // The bounded exception. A daemon that has just come back holds Workers it has
  // never heard a heartbeat from, so for those — and only those — it reads the log
  // ONCE, from the path the client GAVE at spawn and carried on the event lane. A
  // Worker whose client gave no path stays without a line until it publishes one;
  // guessing a filename inside its workspace would be the derived layout ADR 0130
  // rule 3 forbids. Recovery is not the normal path.
  for (const worker of reattachment.alive) {
    if (worker.log_path == null || logLines.has(worker.worker_id)) continue;
    const recovered = await readLogTail(worker.log_path).catch(() => null);
    if (recovered == null || recovered.trim() === "") continue;
    logLines.set(worker.worker_id, { line: recovered, published_at: clock(), source: "rehydrated" });
  }

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    armIdleTimer();
    handleSocket(socket, async (request) => {
      armIdleTimer();
      const response = await respond(request);
      writeResponse(socket, response);
      // The report is written to the caller BEFORE the daemon leaves: a stop that
      // took the socket down first would be indistinguishable, from the operator's
      // side, from a daemon that died while being asked.
      if (request.op === "shutdown") setImmediate(() => void stop({ reason: "requested" }));
    });
  });

  async function respond(request: RedskilledRequest): Promise<RedskilledResponse> {
    try {
      if (request.op === "ping") {
        return {
          id: request.id,
          ok: true,
          value: {
            pong: true,
            protocol_version: REDSKILLED_PROTOCOL_VERSION,
            daemon_version: daemonVersion,
            pid: owner.pid,
          },
        };
      }
      if (request.op === "host-state") return { id: request.id, ok: true, value: hostState() };
      if (request.op === "statusline-payload") {
        // A host read, permitted from any project: seeing the machine is the
        // requirement, and a session that could not would diagnose contention
        // by leaving the session it is in.
        return { id: request.id, ok: true, value: statuslinePayload() };
      }
      if (request.op === "statusline-string") {
        // The same host read, already rendered. The daemon renders it from the
        // payload the other op returns — one call of a pure function — so the
        // two surfaces are the same answer twice and never two answers.
        return { id: request.id, ok: true, value: statuslineString(request.render) };
      }
      if (request.op === "worker-heartbeat") {
        return { id: request.id, ok: true, value: publishWorkerHeartbeat(request.heartbeat) };
      }
      if (request.op === "project-register") {
        return { id: request.id, ok: true, value: registerProject(request.registration, request.session_project) };
      }
      if (request.op === "worker-command") {
        return { id: request.id, ok: true, value: await runWorkerCommand(request.command) };
      }
      if (request.op === "worker-start") {
        const reach = authorize("worker-start", request.session_project, request.spec.project_label);
        if (!reach.permitted) return { id: request.id, ok: false, error: reach.reason };
        const launched = startWorker(request.spec);
        // The acknowledgement waits for the birth to reach the lane. A client told
        // "your Worker exists" by a daemon that is then replaced a millisecond
        // later — the ordinary operation — would otherwise leave a live Worker
        // whose birth nothing recorded, and no successor can re-attach to a Worker
        // it was never told about (#2917).
        await eventLane.flush().catch(() => undefined);
        return {
          id: request.id,
          ok: true,
          value: { worker: launched.worker, admission: launched.admission, warnings: launched.warnings },
        };
      }
      if (request.op === "shutdown") {
        const report = stopReport("requested");
        // The departure reaches the lane BEFORE the caller is told: an operator
        // holding a stop report and a successor replaying the lane must never
        // disagree about whether this daemon left on purpose (#2919).
        await recordDeparture({ reason: "requested", ...(request.detail == null ? {} : { note: request.detail }) });
        return { id: request.id, ok: true, value: report };
      }
      const unknown = request as { id?: string; op?: string };
      return { id: unknown.id ?? randomUUID(), ok: false, error: `unsupported redskilled op: ${unknown.op ?? "unknown"}` };
    } catch (err) {
      return { id: (request as { id?: string }).id ?? randomUUID(), ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  armIdleTimer();
  armSampleTimer();
  armReplaceTimer();
  armActivityTimer();

  return {
    socketPath: paths.socketPath,
    lease: acquisition.lease,
    startedAt,
    closed,
    startWorker,
    admit,
    ceiling: () => ceiling,
    killWorkerOverBudget,
    sampleMemoryBudgets,
    pollRepositoryActivity,
    sweepReattached,
    publishWorkerHeartbeat,
    reattached: () => [...reattached].map((id) => workers.get(id)).filter((w): w is RedskilledWorkerView => w != null),
    flushEvents: () => eventLane.flush(),
    trackWorker(worker) {
      workers.set(worker.worker_id, worker);
      record("worker-birth", worker, null);
      armIdleTimer();
    },
    releaseWorker(workerId) {
      const worker = workers.get(workerId);
      const removed = workers.delete(workerId);
      reattached.delete(workerId);
      logLines.delete(workerId);
      if (worker) record("worker-death", worker, "released by the daemon");
      armIdleTimer();
      return removed;
    },
    workerCount: () => workers.size,
    registerProject,
    registrations: () => hostState().registrations ?? [],
    hostState,
    statuslinePayload,
    evaluateIdle,
    observePublishedVersion,
    checkForReplacement,
    stopReport,
    stop,
  };
}

/**
 * Bind the socket, refusing to steal one another daemon is answering on.
 *
 * `EADDRINUSE` is ambiguous — a live peer and a socket file a crash left behind
 * look identical on disk — so it is resolved by *asking*: a path that answers a
 * ping has an owner, and a path that does not is debris to unlink and retry.
 */
async function bindExclusive(socketPath: string): Promise<Server> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server;
    } catch (err) {
      server.close();
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      if (await socketAnswers(socketPath)) throw new RedskilledAlreadyRunningError(socketPath);
      await rm(socketPath, { force: true });
    }
  }
  throw new RedskilledAlreadyRunningError(socketPath);
}

/** True when something on the other end of `socketPath` answers a ping. */
export async function socketAnswers(socketPath: string, timeoutMs = 250): Promise<boolean> {
  try {
    const response = await sendLineRequest<RedskilledRequest, RedskilledResponse>(
      { socketPath, timeoutMs },
      { id: randomUUID(), op: "ping" },
      "redskilled daemon",
    );
    return response.ok === true;
  } catch {
    return false;
  }
}

function handleSocket(socket: Socket, handler: (request: RedskilledRequest) => Promise<void>): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    socket.pause();
    void (async () => {
      let request: RedskilledRequest | undefined;
      try {
        request = JSON.parse(line) as RedskilledRequest;
        await handler(request);
      } catch (err) {
        writeResponse(socket, {
          id: request?.id ?? randomUUID(),
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        socket.end();
      }
    })();
  });
}

function writeResponse(socket: Socket, response: RedskilledResponse): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify(response)}\n`);
  } catch {}
}
