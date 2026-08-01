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
import { isPidAlive, sendLineRequest, serveWireSocket } from "@reddb-io/shared/resident-core.js";
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
  DEFAULT_REDSKILLED_DEMAND_MS,
  emptyDemandTick,
  planHostDemand,
  REDSKILLED_DEMAND_BACKOFF_MS,
  type RedskilledDemandGrant,
  type RedskilledDemandTick,
} from "./demand-loop.js";
import {
  buildRedskilledStopReport,
  type RedskilledDaemonStopped,
  type RedskilledStopReason,
} from "./daemon-stop.js";
import {
  buildHostState,
  type RedskilledHostState,
  type RedskilledRegistrationLapse,
  type RedskilledWorkerView,
} from "./host-state.js";
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
import type { RedskilledLaunchTemplate } from "./launch-template.js";
import type { RedskilledPaths } from "./paths.js";
import {
  buildProjectRegistration,
  renewProjectRegistration,
  RedskilledProjectUnregisteredError,
  sustainProjectRegistration,
  sweepLapsedRegistrations,
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
  type RedskilledProjectDeregistered,
  type RedskilledProjectRegistered,
  type RedskilledProjectRenewed,
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
import {
  DEFAULT_REDSKILLED_QUEUE_MS,
  fetchQueueDiscovery,
  type RedskilledQueueDiscovery,
  type RedskilledQueueTransport,
} from "./queue-discovery.js";
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
  isLocalRedskilledBuild,
  isRedskilledBornByReplacement,
  isRedskilledSupervised,
  localRedskilledPublishedEvidence,
  planRedskilledMajorHold,
  planRedskilledReplacement,
  prepareRedskilledReplacement,
  probePublishedRedskilledVersion,
  readPublishedObservation,
  type RedskilledMajorHold,
  type RedskilledPublishedObservation,
  type RedskilledPublishedVersionProbe,
  type RedskilledReplacementDecision,
  type RedskilledReplacementHoldReason,
  type RedskilledReplacementIO,
} from "./self-replace.js";
import {
  createRedskilledLeaseStore,
  currentProcessOwner,
  type RedskilledLease,
  type RedskilledLeaseOwner,
  type RedskilledLeaseStore,
} from "./session-lease.js";

/**
 * Default idle window before a Worker-free daemon leaves.
 *
 * **Shorter than `DEFAULT_REDSKILLED_REPLACE_CHECK_MS` (fifteen minutes), which
 * is why the idle exit asks about the published version on its way out.** A quiet
 * host's daemon leaves three times over before that interval's first tick, so an
 * upgrade that only ever rode the timer could not fire here at all (#2968) — and
 * the failure hid itself, because a daemon born after a release reports the right
 * version without ever having upgraded. `leaveIdleSession` is the coupling; these
 * two numbers may move freely, in either direction, without reintroducing it.
 */
export const DEFAULT_REDSKILLED_IDLE_MS = 300_000;

/**
 * How long a published-version read may take before it counts as unresolved.
 *
 * A bound rather than a preference: the shipped probe is a `fetch` with no
 * timeout of its own, and the idle exit now waits on one — a registry that
 * accepts the connection and never answers would otherwise strand a daemon that
 * had already decided to leave, holding the session for a host that wanted none.
 * A read that runs out of time resolves to whatever this host can say WITHOUT
 * the registry — the cached bundle — and to UNKNOWN when it can say nothing.
 */
export const DEFAULT_REDSKILLED_PUBLISHED_PROBE_TIMEOUT_MS = 10_000;

/**
 * How long after starting a daemon takes its FIRST published-version look.
 *
 * **The busy daemon's blind spot, and the one the idle exit cannot cover.** A
 * daemon that only ever looks on the interval spends its first fifteen minutes
 * unable to know anything at all, and a daemon holding a registration never
 * reaches the idle boundary that would have asked — so a release published into
 * that window is served past for a whole interval, with `checks: 0` looking
 * exactly like a timer that is broken (#2975). One look shortly after boot makes
 * the daemon's own answer say which.
 *
 * Deliberately a minute rather than instant: a successor that mis-resolves its
 * own version would otherwise restart itself as fast as it could boot. A
 * replacement's own child skips this look entirely
 * (`REDSKILLED_BORN_BY_REPLACEMENT_ENV`) and waits for the ordinary interval.
 */
export const DEFAULT_REDSKILLED_REPLACE_BOOT_CHECK_MS = 60_000;

/**
 * Default window between memory samples.
 *
 * A whole-set sample is one pass over the process table, so the interval is
 * chosen for how fast a runaway must be caught rather than for how many Workers
 * are running — the cost does not move with the Worker count.
 */
export const DEFAULT_REDSKILLED_SAMPLE_MS = 15_000;

/**
 * How many lapsed registrations the daemon keeps where a reader can see them.
 *
 * A tail, not a history: the question a lapse block answers is "did my drain stop,
 * and when", which is asked about the last few — and an unbounded list on a
 * long-lived host is a leak wearing the shape of an audit trail.
 */
export const REDSKILLED_LAPSE_MEMORY = 16;

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
  /**
   * How long one published-version read may take before it counts as unresolved.
   *
   * Injected so the bound itself is provable: an idle exit that waits on a read
   * has to be able to stop waiting, and a test that could not shorten the
   * deadline would have to spend it.
   */
  readonly publishedProbeTimeoutMs?: number;
  /**
   * What this host can say about the published world without asking anybody.
   *
   * Consulted only when the read itself resolved nothing, so it never competes
   * with the registry — it is what keeps a slow registry from erasing the
   * evidence a host already holds.
   */
  readonly localPublishedEvidence?: (running: string) => RedskilledPublishedObservation | null;
  /** How long after start the first published look happens; 0 or below is never. */
  readonly replaceBootCheckMs?: number;
  /** True when a replacement started this process, which is owed no boot look. */
  readonly bornByReplacement?: boolean;
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
  /**
   * How this daemon reaches the tracker for queue depth, and how often.
   *
   * Its own block and its own window, next to the activity poller rather than
   * inside it: ADR 0130 Amendment 3 batches the two fetches but keeps their
   * cadences apart, because forcing the slow half onto the fast half's rhythm
   * would spend more quota than the batching saves.
   */
  readonly queueDiscovery?: RedskilledQueueRegistration;
  /**
   * Window between demand ticks; 0 or below leaves the loop unarmed.
   *
   * Its own window rather than the queue poller's callback, because the two
   * answer different questions: the poll asks the tracker how much work exists,
   * and the tick asks this host what it can afford right now — which changes
   * every time a Worker dies, with no request involved.
   */
  readonly demandMs?: number;
  /** How long a refusal holds the loop back; the module's window when absent. */
  readonly demandBackoffMs?: number;
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

/**
 * What the queue poller needs, and nothing more.
 *
 * No project list: the queue is discovered for whatever is REGISTERED at the
 * instant a poll begins, so a project registered a moment ago is counted from the
 * next interval instead of waiting for the daemon to be restarted with a wider
 * list. The selectors come from the registrations; this block is only the reach.
 */
export interface RedskilledQueueRegistration {
  /**
   * How the query reaches the tracker; the activity transport when absent.
   *
   * One token serves both fetches (ADR 0130 Amendment 1), so stating a second
   * transport is for a caller that wants the two windows separable — a test that
   * counts each cadence, above all.
   */
  readonly transport?: RedskilledQueueTransport;
  /** Window between fetches; 0 or below leaves the poller unarmed. */
  readonly intervalMs?: number;
  /** How many selectors one request may span; the module's bound when absent. */
  readonly batchSize?: number;
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
  /**
   * Release a project's registration, whether or not one stood.
   *
   * A release the daemon had nothing to do is reported, never raised: stopping
   * work is the one act two sources perform on the same project — the operator
   * and the session that ends — so the second one must read as done, not failed.
   */
  deregisterProject(projectLabel: string, sessionProject?: string): RedskilledProjectDeregistered;
  /**
   * Push a project's registration out to a new deadline, because its session lives.
   *
   * Renewal is the ONLY thing that keeps a registration standing, and its absence
   * is the only thing that ends one on its own: the daemon holds no connection to
   * a session — every request arrives on its own socket — so a closed terminal is
   * something it learns by not being told anything for a window.
   */
  renewProject(
    projectLabel: string,
    options?: {
      readonly sessionProject?: string;
      readonly renewWithinMs?: number;
      /** What the NEXT Worker is started with; the standing launch when absent. */
      readonly launch?: RedskilledLaunchTemplate;
    },
  ): RedskilledProjectRenewed;
  /** The registrations this daemon holds, ordered by project label; lapsed ones swept. */
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
  /**
   * Discover every registered project's queue depth once — one request, not N.
   *
   * The registrations are read at the instant the poll begins and never again
   * inside it: a project registered while a request is in flight belongs to the
   * next interval, because folding it into an answer built without it would date
   * its depth to a fetch that never asked about it. Resolves to `null` when
   * nothing is registered — a host with no selector has no depth, not a zero.
   */
  pollQueueDiscovery(): Promise<RedskilledQueueDiscovery | null>;
  /** The last queue fetch, dated by the poll it came from; `null` before the first. */
  queueDiscovery(): RedskilledQueueDiscovery | null;
  /**
   * One tick of the demand loop: decide what every project may ask for, ask, live
   * with the answer.
   *
   * Exposed so the loop can be driven by a test as well as by the timer. It
   * RESOLVES on a refusal — a smaller grant is what the machine could afford,
   * which is an outcome carrying the host's own reason and never an error.
   */
  driveDemand(): Promise<RedskilledDemandTick>;
  /** The last demand tick; `null` before the first one ran. */
  demand(): RedskilledDemandTick | null;
  /** Re-probe every re-attached Worker, retiring the ones the host no longer confirms. */
  sweepReattached(): Promise<readonly RedskilledWorkerView[]>;
  /** The Workers this daemon adopted at start rather than birthing itself. */
  reattached(): readonly RedskilledWorkerView[];
  /** Resolves once every event handed to the lane has reached disk. */
  flushEvents(): Promise<void>;
  /**
   * Force the idle check to run now — the timer's body, exposed for tests.
   *
   * `"exited"` is the DECISION to give the session up, not a completed exit: a
   * daemon on its way out first asks whether it should come back newer instead
   * (#2968), so the leaving finishes on `closed` rather than on this return.
   */
  evaluateIdle(): "exited" | "held-by-workers" | "held-by-registrations";
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
  const publishedProbeTimeoutMs = options.publishedProbeTimeoutMs ?? DEFAULT_REDSKILLED_PUBLISHED_PROBE_TIMEOUT_MS;
  const localEvidence = options.localPublishedEvidence ??
    ((running: string) => localRedskilledPublishedEvidence(running, options.replacementIO?.env ?? process.env));
  const bornByReplacement = options.bornByReplacement ?? isRedskilledBornByReplacement();
  const replaceBootCheckMs = options.replaceBootCheckMs ?? DEFAULT_REDSKILLED_REPLACE_BOOT_CHECK_MS;
  const supervised = options.supervised ?? isRedskilledSupervised();
  const replacementIO = options.replacementIO ?? {};
  const activityRegistration = options.repositoryActivity;
  const activityMs = activityRegistration?.intervalMs ?? DEFAULT_REDSKILLED_ACTIVITY_MS;
  const queueRegistration = options.queueDiscovery;
  const queueTransport = queueRegistration?.transport ?? activityRegistration?.transport;
  const queueMs = queueRegistration?.intervalMs ?? DEFAULT_REDSKILLED_QUEUE_MS;
  const demandMs = options.demandMs ?? DEFAULT_REDSKILLED_DEMAND_MS;
  const demandBackoffMs = options.demandBackoffMs ?? REDSKILLED_DEMAND_BACKOFF_MS;
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
  // How many looks have COMPLETED, and what the last one concluded. Counted
  // because "the check never fired" and "it fired and held" are different
  // defects that report the same null published version (#2975).
  let publishedChecks = 0;
  let publishedHoldReason: RedskilledReplacementHoldReason | null = null;
  let replacementState: "none" | "pending" | "in-progress" = "none";
  // The world's newest version whatever its major, and the hold it implies. Kept
  // beside the in-major answer because that one is capped by construction: on its
  // own it cannot tell a current daemon from one holding at a boundary (#2926).
  let publishedNewest: string | null = null;
  let majorHold: RedskilledMajorHold | null = null;
  // The last activity fetch, kept for the same reason the RSS reading is: a read
  // between two polls is dated by the poll it came from, never by the read.
  let lastActivity: RedskilledRepositoryActivity | null = null;
  // The last queue fetch, held beside the activity one rather than merged into it:
  // two cadences produce two instants, and a document that carried one date for
  // both would age the fast half by the slow half's clock.
  let lastQueue: RedskilledQueueDiscovery | null = null;
  // The loop's own memory: the last tick a reader can ask about, and the instant
  // the host's refusal stops holding every project back. The backoff is
  // host-wide because the ceiling that produced it is — a refusal aimed at one
  // project would let the next one walk into the same wall.
  let lastDemand: RedskilledDemandTick | null = null;
  // The registrations this daemon dropped, newest last. Kept because a lapse is
  // otherwise only an absence, and an absence is what let a stopped drain read as
  // a healthy one (#2973).
  const lapses: RedskilledRegistrationLapse[] = [];
  let demandBackoffUntilMs: number | null = null;
  let demandTicking = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let sampleTimer: NodeJS.Timeout | undefined;
  let demandTimer: NodeJS.Timeout | undefined;
  let replaceTimer: NodeJS.Timeout | undefined;
  let replaceBootTimer: NodeJS.Timeout | undefined;
  let activityTimer: NodeJS.Timeout | undefined;
  let queueTimer: NodeJS.Timeout | undefined;
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

  /**
   * Drop every registration whose deadline has passed, and say which those were.
   *
   * Called from each surface that reads the set rather than from a timer of its
   * own: a lapse is only ever observable at a read, and a timer would have to keep
   * this process awake to enforce a deadline whose whole purpose is to let it
   * sleep. A registration therefore stops being polled, stops being reported and
   * stops holding the daemon alive at the same instant — the first read past it.
   *
   * **The read is also where a registration is held up.** Amendment 7 gave the
   * renewal an owner, and the owner is this process: every read sustains what the
   * project's own work speaks for before deciding what lapsed, so the two halves
   * are one decision made from one set of facts at one instant.
   */
  function expireLapsedRegistrations(now: string): readonly RedskilledProjectRegistration[] {
    // Sustained BEFORE the sweep, at this same instant: the renewal and the lapse
    // are one decision seen from two sides (Amendment 7), and a sweep that ran on
    // facts an earlier timer left behind would drop a project whose work the
    // daemon can see right now.
    sustainRegistrations(now);
    const nowMs = Date.parse(now);
    const swept = sweepLapsedRegistrations(registrations.values(), nowMs);
    for (const lapsed of swept.lapsed) {
      registrations.delete(lapsed.project_label);
      rememberLapse(lapsed, nowMs);
    }
    return swept.lapsed;
  }

  /**
   * Keep a lapse where a reader can find it, because an absence explains nothing.
   *
   * A registration that lapses simply stops being in the set, and every surface
   * then renders the project as one this host never heard of — which is how "my
   * drain stopped" reads as "nothing is wrong" (#2973). The record is what turns
   * the absence into a stated fact with an instant and a reason on it. Bounded on
   * purpose: this is the tail an operator asks about, not a history.
   */
  function rememberLapse(registration: RedskilledProjectRegistration, nowMs: number): void {
    const at = Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : registration.renew_by;
    lapses.push({
      project_label: registration.project_label,
      at,
      renew_by: registration.renew_by,
      renewals: registration.renewals,
      sustains: registration.sustains ?? 0,
      detail:
        `redskilled dropped the registration for project ${JSON.stringify(registration.project_label)}: it stood ` +
        `until ${registration.renew_by} and nothing renewed it — no session spoke for it, and no poll found it ` +
        `work or a Worker to hold it up`,
    });
    if (lapses.length > REDSKILLED_LAPSE_MEMORY) lapses.splice(0, lapses.length - REDSKILLED_LAPSE_MEMORY);
  }

  /**
   * Hold every registration up that the project's own work still speaks for.
   *
   * ADR 0130 Amendment 7: the renewal's owner is this process. It runs off the
   * facts the daemon already holds at the instant it holds them — the depth its
   * last poll counted and the Workers it is itself running — so a drain survives
   * the terminal that started it without one message from a session, and a project
   * with neither still lapses at its deadline. Nothing here reads a selector: the
   * decision is made from one integer per project (ADR 0130 rule 3).
   */
  function sustainRegistrations(now: string): void {
    if (registrations.size === 0) return;
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return;
    const live: Record<string, number> = {};
    for (const worker of workers.values()) {
      live[worker.project_label] = (live[worker.project_label] ?? 0) + 1;
    }
    const polled = new Map((lastQueue?.projects ?? []).map((project) => [project.project_label, project]));
    for (const held of [...registrations.values()]) {
      const poll = polled.get(held.project_label);
      const sustained = sustainProjectRegistration(held, {
        now,
        ...(poll == null ? {} : { queue: { outcome: poll.outcome, depth: poll.depth } }),
        liveWorkers: live[held.project_label] ?? 0,
      });
      if (sustained.registration !== held) registrations.set(held.project_label, sustained.registration);
    }
  }

  function hostState(): RedskilledHostState {
    const now = clock();
    expireLapsedRegistrations(now);
    return buildHostState({
      now,
      daemonVersion,
      machineIdHash: paths.machineIdHash,
      sessionKeyHash: paths.sessionKeyHash,
      pid: owner.pid,
      startedAt,
      scope: describeMachineScope(machineClaimStore.claimPath, claimLabels, machineOwner),
      workers: [...workers.values()],
      registrations: [...registrations.values()],
      // The ones that stopped, beside the ones that stand: a project missing from
      // the set is either one that never registered or one whose drain ended, and
      // only the second is something an operator has to act on.
      lapses,
      // The poll each registration was last covered by, so "why is nothing
      // happening" is answerable from one read instead of from a log.
      queue: lastQueue,
      published: {
        version: publishedVersion,
        checkedAt: publishedCheckedAt,
        newer: publishedIsNewer,
        replacement: replacementState,
        newest: publishedNewest,
        majorHold,
        checks: publishedChecks,
        holdReason: publishedHoldReason,
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
   * One interval's queue fetch: ONE request, however many projects are registered.
   *
   * The registration set is snapshotted before the request leaves and never
   * consulted again inside this call, which is what makes "included from the next
   * interval" a property rather than a race: a project that registers mid-flight
   * is simply absent from an answer that never asked about it, and present in the
   * one after. The depths are stored and never read here — the daemon holds an
   * integer per opaque selector and knows nothing about what the selector says.
   */
  async function pollQueueDiscovery(): Promise<RedskilledQueueDiscovery | null> {
    if (queueTransport == null) return null;
    const now = clock();
    // Swept before the set is snapshotted, so a lapsed project is absent from the
    // very poll that would otherwise have asked the tracker about it again.
    expireLapsedRegistrations(now);
    const projects = [...registrations.values()]
      .map((registration) => ({ project_label: registration.project_label, selector: registration.selector }))
      // By label, like every other list the daemon reports: the order a client
      // happened to register in is not a fact about the host.
      .sort((left, right) => left.project_label.localeCompare(right.project_label));
    if (projects.length === 0) return null;
    lastQueue = await fetchQueueDiscovery({
      projects,
      transport: queueTransport,
      now,
      ...(queueRegistration?.batchSize == null ? {} : { batchSize: queueRegistration.batchSize }),
    });
    // The depth this poll just counted is the renewal a project with open work
    // gets (Amendment 7), applied here rather than at the next read so a deadline
    // is never judged against a poll the daemon had already superseded.
    sustainRegistrations(clock());
    return lastQueue;
  }

  /**
   * One tick of the demand loop: what may be asked for, asked for.
   *
   * The depths come from the last poll rather than from a fetch of this tick's
   * own: one aliased request per interval is the whole point of Amendment 3, and
   * a tick that fetched would spend the quota the batching saves. A depth nobody
   * measured yet holds its project back rather than standing in for a zero.
   *
   * **A refusal ends the tick and arms the backoff.** The host refused on a
   * host-wide ceiling, so every further request this tick would meet the same
   * wall; asking anyway is how a full machine becomes a busy loop. The refusal is
   * recorded with the host's own words and returned as an ordinary outcome.
   *
   * **Nothing here reads a selector or an argv.** The plan is built from three
   * integers per project, and the argv is handed to the launcher exactly as the
   * registration stated it (ADR 0130 rule 3).
   */
  async function driveDemand(): Promise<RedskilledDemandTick> {
    const at = clock();
    // One tick at a time: a second one overlapping the first would judge its
    // targets against a live count the first has not finished changing.
    if (demandTicking) return lastDemand ?? emptyDemandTick(at);
    demandTicking = true;
    try {
      const live: Record<string, number> = {};
      for (const worker of workers.values()) {
        live[worker.project_label] = (live[worker.project_label] ?? 0) + 1;
      }
      const queue: Record<string, number | null> = {};
      for (const project of lastQueue?.projects ?? []) queue[project.project_label] = project.depth;

      const nowMs = Date.parse(at);
      const plan = planHostDemand({
        projects: [...registrations.values()].map((registration) => ({
          project_label: registration.project_label,
          selector: registration.selector,
          argv: registration.argv,
          workspace_path: registration.workspace_path,
          target: registration.target,
        })),
        queue,
        live,
        nowMs: Number.isFinite(nowMs) ? nowMs : 0,
        backoffUntilMs: demandBackoffUntilMs,
      });

      const granted: RedskilledDemandGrant[] = [];
      let refusal: string | null = null;
      for (const birth of plan.births) {
        let launched: LaunchedWorker;
        try {
          launched = startWorker({
            project_label: birth.project_label,
            workspace_path: birth.workspace_path,
            command: birth.argv[0]!,
            args: birth.argv.slice(1),
          });
        } catch (err) {
          refusal = err instanceof Error ? err.message : String(err);
          demandBackoffUntilMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) + demandBackoffMs;
          break;
        }
        granted.push({
          project_label: birth.project_label,
          worker_id: launched.worker.worker_id,
          pid: launched.worker.pid,
          warnings: launched.warnings,
        });
      }
      // A tick that asked and was never refused clears the hold, so the room a
      // dying Worker freed is spent on the next tick rather than on the timer
      // the last refusal set.
      if (refusal == null && plan.births.length > 0) demandBackoffUntilMs = null;

      lastDemand = {
        version: 1,
        at,
        requested: plan.births.length,
        granted,
        shortfall: plan.births.length - granted.length,
        refusal,
        retry_after: demandBackoffUntilMs == null ? null : new Date(demandBackoffUntilMs).toISOString(),
        projects: plan.intents,
      };
      return lastDemand;
    } finally {
      demandTicking = false;
    }
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
    const now = clock();
    // Swept first, so a project whose last session died is refused nothing: the
    // record it would collide with is one no session has renewed past its deadline.
    expireLapsedRegistrations(now);
    const registration = buildProjectRegistration(request, {
      now,
      held: registrations.get(request.project_label),
    });
    registrations.set(registration.project_label, registration);
    // A registration holds the daemon awake, exactly as a Worker does: a drain the
    // operator walked away from must outlive the terminal, and a daemon that idled
    // out under a standing registration would take the promise with it.
    armIdleTimer();
    return {
      version: 1,
      registration,
      reach,
      detail:
        `redskilled holds a registration for project ${JSON.stringify(registration.project_label)} at a target of ` +
        `${registration.target} until ${registration.renew_by}, and has read neither its selector nor its argv`,
    };
  }

  /**
   * Keep one project's registration standing, once reach has permitted it.
   *
   * Reach is checked against the project being renewed — its own label, exactly as
   * at registration. A renewal for a record the daemon is not holding is REFUSED
   * rather than minted: the selector, the argv and the target were deliberately
   * not kept anywhere else, so a renewal that created a registration would be
   * inventing the very strings ADR 0130 rule 3 forbids this process to author.
   */
  function renewProject(
    projectLabel: string,
    options: {
      readonly sessionProject?: string;
      readonly renewWithinMs?: number;
      readonly launch?: RedskilledLaunchTemplate;
    } = {},
  ): RedskilledProjectRenewed {
    const reach = authorize("project-renew", options.sessionProject, projectLabel);
    if (!reach.permitted) throw new Error(reach.reason);
    const now = clock();
    expireLapsedRegistrations(now);
    const held = registrations.get(projectLabel);
    if (held == null) throw new RedskilledProjectUnregisteredError(projectLabel);
    const registration = renewProjectRegistration(held, {
      now,
      ...(options.renewWithinMs == null ? {} : { renew_within_ms: options.renewWithinMs }),
      ...(options.launch == null ? {} : { launch: options.launch }),
    });
    registrations.set(registration.project_label, registration);
    armIdleTimer();
    return {
      version: 1,
      registration,
      reach,
      detail:
        `redskilled renewed the registration for project ${JSON.stringify(registration.project_label)}, which now ` +
        `stands until ${registration.renew_by} after renewal ${registration.renewals}` +
        // The revision, not the launch itself: an operator needs to know that the
        // next Worker differs from the last, and the daemon has read nothing that
        // would let it say how.
        (options.launch == null ? "" : `, carrying launch revision ${registration.launch_revision} for its next Worker`),
    };
  }

  /**
   * Give one project's registration back.
   *
   * Reach is checked against the project being released — its own label, exactly
   * as at registration — so a session cannot stop another project's work. What is
   * NOT checked is whether a record stood: a release states the outcome and lets
   * the caller decide what an already-released project means to it.
   */
  function deregisterProject(projectLabel: string, sessionProject?: string): RedskilledProjectDeregistered {
    const reach = authorize("project-deregister", sessionProject, projectLabel);
    if (!reach.permitted) throw new Error(reach.reason);
    const released = registrations.delete(projectLabel);
    return {
      version: 1,
      project_label: projectLabel,
      released,
      reach,
      detail: released
        ? `redskilled released the registration for project ${JSON.stringify(projectLabel)}`
        : `redskilled held no registration for project ${JSON.stringify(projectLabel)}, so there was nothing to release`,
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
   *
   * The major beyond this one is RECORDED and never acted on: adopting it would
   * be a breaking change arriving on a timer, and staying quiet about it is how a
   * held daemon becomes indistinguishable from a current one (#2926).
   */
  /**
   * One read of the published world, bounded — a throw and a silence both fall
   * back to what this host already holds.
   *
   * The two failures are the same fact: the registry resolved nothing. They are
   * answered the same way for exactly that reason — the shipped probe already
   * consults the bundle cache when the read THROWS, and a deadline that answered
   * `null` instead left a host holding the newer bundle serving the older one
   * (#2975). The deadline itself stays, because the idle exit WAITS on this
   * answer and an unbounded read would hold a daemon that had decided to leave.
   *
   * Local evidence never competes with the registry: it is consulted only when
   * the read resolved nothing at all.
   */
  async function askWhatIsPublished(): Promise<string | null | RedskilledPublishedObservation> {
    try {
      if (publishedProbeTimeoutMs <= 0) return await publishedProbe(daemonVersion);
      return await new Promise((resolve) => {
        const deadline = setTimeout(() => resolve(withoutTheRegistry()), publishedProbeTimeoutMs);
        deadline.unref();
        publishedProbe(daemonVersion).then(
          (answer) => {
            clearTimeout(deadline);
            resolve(answer);
          },
          () => {
            clearTimeout(deadline);
            resolve(withoutTheRegistry());
          },
        );
      });
    } catch {
      return withoutTheRegistry();
    }
  }

  /** What the host can say alone; a lookup that itself fails says nothing. */
  function withoutTheRegistry(): RedskilledPublishedObservation | null {
    try {
      return localEvidence(daemonVersion);
    } catch {
      return null;
    }
  }

  async function observePublishedVersion(): Promise<RedskilledReplacementDecision> {
    // A local build is decided BEFORE the read, on every route rather than at the
    // idle boundary alone: no release supersedes a source checkout, so the read
    // could only spend a shared registry quota to be told what is already known.
    // The look still COUNTS — it fired, and it concluded something.
    if (isLocalRedskilledBuild(daemonVersion)) {
      publishedChecks += 1;
      publishedCheckedAt = clock();
      publishedHoldReason = "local-build";
      return { act: "hold", reason: "local-build" };
    }
    const observation = readPublishedObservation(await askWhatIsPublished());
    const observed = observation.version;
    publishedVersion = observed;
    publishedNewest = observation.newest ?? null;
    publishedCheckedAt = clock();
    majorHold = planRedskilledMajorHold({ running: daemonVersion, newest: publishedNewest, supervised });
    const decision = planRedskilledReplacement({ running: daemonVersion, published: observed, supervised });
    publishedIsNewer = decision.act === "replace";
    publishedChecks += 1;
    publishedHoldReason = decision.act === "hold" ? decision.reason : null;
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

  /**
   * Arm the two looks a WORKING daemon gets: one shortly after boot, then the
   * interval.
   *
   * The interval alone leaves a daemon unable to know anything for its first
   * fifteen minutes, and a daemon holding a registration never reaches the idle
   * boundary that would have asked — so a release published into that window is
   * served past, and the daemon's own answer cannot say whether the check held or
   * had simply never run (#2975). The boot look is what closes both.
   *
   * A successor is owed no boot look: it was started BY a replacement seconds
   * ago, and a mis-resolving one would otherwise restart itself as fast as it
   * could boot. It waits for the interval like any other tick.
   */
  function armReplaceTimer(): void {
    if (stopping || replaceTimer != null || replaceCheckMs <= 0) return;
    if (!bornByReplacement && replaceBootCheckMs > 0) {
      replaceBootTimer = setTimeout(() => {
        void checkForReplacement().catch(() => undefined);
      }, replaceBootCheckMs);
      replaceBootTimer.unref();
    }
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

  /**
   * Arm the queue poller on ITS window, which is not the activity poller's.
   *
   * Armed even with nothing registered, unlike the activity poller: the selectors
   * arrive by registration rather than at start, so a timer that waited for a
   * non-empty set would never start on a daemon that outlives every session — and
   * a poll with nothing registered costs no request at all.
   */
  function armQueueTimer(): void {
    if (stopping || queueTimer != null) return;
    if (queueTransport == null || queueMs <= 0) return;
    queueTimer = setInterval(() => {
      void pollQueueDiscovery().catch(() => undefined);
    }, queueMs);
    queueTimer.unref();
  }

  /**
   * Arm the demand loop on its own window.
   *
   * Armed at start and never re-armed per registration: the loop is the daemon's
   * from the moment it exists (ADR 0130 Amendment 4), and a tick with nothing
   * registered plans nothing and asks nobody.
   */
  function armDemandTimer(): void {
    if (stopping || demandTimer != null || demandMs <= 0) return;
    demandTimer = setInterval(() => {
      void driveDemand().catch(() => undefined);
    }, demandMs);
    demandTimer.unref();
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

  function evaluateIdle(): "exited" | "held-by-workers" | "held-by-registrations" {
    // The rule that will matter once Workers exist, in place from the start: a
    // daemon that believes it holds live Workers rearms instead of exiting.
    if (workers.size > 0) {
      armIdleTimer();
      return "held-by-workers";
    }
    // A standing registration holds the daemon just as a Worker does, and holds it
    // for the state a Worker cannot: a project between Workers is a project the
    // host must still be awake to poll for. The deadline is what keeps this from
    // being "awake forever" — a registration nobody renews lapses in the sweep
    // above, and the very next tick finds nothing holding anything.
    expireLapsedRegistrations(clock());
    if (registrations.size > 0) {
      armIdleTimer();
      return "held-by-registrations";
    }
    void leaveIdleSession();
    return "exited";
  }

  /**
   * Leave — as a newer daemon when one is published, or for good.
   *
   * **The idle boundary is where a quiet host's daemon asks, because it is the
   * only moment it ever reaches.** The check interval is three times the idle
   * window, so this process exits three times over before the timer's first tick;
   * self-replacement shipped unable to fire here at all (#2968). It is also the
   * safest instant to ask: nothing is waiting on this socket, and the alternative
   * already on the table was going away entirely — so an upgrade that fails costs
   * only the upgrade.
   *
   * ONE read, and only when it can decide something. A local build is not a point
   * on the published lane, so it leaves exactly as it did before, without asking —
   * which is also why a developer's own daemon never spends a registry read to be
   * told what it already knows.
   */
  async function leaveIdleSession(): Promise<void> {
    if (!isLocalRedskilledBuild(daemonVersion)) {
      // A replacement stops this daemon itself, and by a different name: the
      // successor is what takes the session, so there is no idle exit to make.
      const decision = await checkForReplacement().catch(() => null);
      if (decision?.act === "replace") return;
      if (leaving || stopping) return;
      // A Worker or a registration that arrived while the registry was being read
      // holds this daemon exactly as it would have a moment earlier — the read is
      // a window the instantaneous decision never had.
      if (workers.size > 0 || registrations.size > 0) {
        armIdleTimer();
        return;
      }
    }
    await stop({ reason: "idle" });
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
    if (replaceBootTimer) clearTimeout(replaceBootTimer);
    if (activityTimer) clearInterval(activityTimer);
    if (queueTimer) clearInterval(queueTimer);
    if (demandTimer) clearInterval(demandTimer);
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
    handleSocket(socket, async (request, reply) => {
      armIdleTimer();
      const response = await respond(request);
      reply(response);
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
      if (request.op === "project-renew") {
        return {
          id: request.id,
          ok: true,
          value: renewProject(request.project_label, {
            ...(request.session_project == null ? {} : { sessionProject: request.session_project }),
            ...(request.renew_within_ms == null ? {} : { renewWithinMs: request.renew_within_ms }),
            ...(request.launch == null ? {} : { launch: request.launch }),
          }),
        };
      }
      if (request.op === "project-deregister") {
        return { id: request.id, ok: true, value: deregisterProject(request.project_label, request.session_project) };
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
  armQueueTimer();
  armDemandTimer();

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
    pollQueueDiscovery,
    queueDiscovery: () => lastQueue,
    driveDemand,
    demand: () => lastDemand,
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
    renewProject,
    deregisterProject,
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

/**
 * Read one framed request and answer it in the encoding it arrived in.
 *
 * The framing, the two encodings and the order client and daemon may adopt them
 * in all live in `resident-wire`; the daemon holds none of that itself so it
 * cannot drift from the rsp resident, which reads the same wire.
 *
 * The error answer carries a FRESH id on purpose: a frame that never became a
 * request has no id to echo, and that difference is exactly how a newer client
 * recognises a daemon too old to read it (`isUnintelligibleResponse`).
 */
function handleSocket(
  socket: Socket,
  handler: (request: RedskilledRequest, respond: (response: RedskilledResponse) => void) => Promise<void>,
): void {
  serveWireSocket<RedskilledRequest>(
    socket,
    (request, respond) => handler(request, respond as (response: RedskilledResponse) => void),
    (err, request, respond) => {
      respond({
        id: request?.id ?? randomUUID(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies RedskilledResponse);
    },
  );
}
