// The daemon's option, registration and handle shapes — its contract with
// every caller, kept apart from the lifecycle that implements it.
import type { DeathAttribution } from "@reddb-io/shared/death-attribution.js";
import { type RedskilledAdmissionVerdict,
  type RedskilledHostCeiling,
} from "../admission.js";
import { type RedskilledEventLane,
} from "../event-lane.js";
import { type RedskilledDemandTick,
} from "../demand-loop.js";
import { type RedskilledDaemonStopped,
  type RedskilledStopReason,
} from "../daemon-stop.js";
import { type RedskilledHostState,
  type RedskilledOrphanedRegistration,
  type RedskilledWorkerView,
} from "../host-state.js";
import { type RedskilledBudgetTermination,
  type RedskilledTreeSampler,
} from "../memory-sampler.js";
import { type RedskilledMachineClaimStore,
  type RedskilledMachineOwner,
} from "../machine-scope.js";
import type {
  RedskilledOrphanReaperMode,
  RedskilledProcessCensus,
  RedskilledProcessCensusRow,
} from "../orphan-reaper.js";
import { type RedskilledLaunchTemplate } from "../launch-template.js";
import type { RedskilledPaths } from "../paths.js";
import type { RedskilledHostEventSinks } from "../host-event-sink.js";
import { type RedskilledRegistrationIntentStore,
} from "../registration-intent-store.js";
import { type RedskilledProjectRegistration,
  type RedskilledProjectRegistrationRequest,
} from "../project-registration.js";
import { REDSKILLED_LIVENESS_GRACE_MS,
  type RedskilledLivenessProbe,
  type RedskilledStopProbe,
  type RedskilledUnitExitFactsProbe,
  type RedskilledUnitInventoryProbe,
  type RedskilledUnitPidProbe,
} from "../reattach.js";
import { type RedskilledProjectDeregistered,
  type RedskilledProjectRegistered,
  type RedskilledProjectRenewed,
  type RedskilledProjectReset,
  type RedskilledWorkerHeartbeatAck,
  type RedskilledWorkerHeartbeatRequest,
} from "../protocol.js";
import { type GithubBalance,
  type GithubBalanceHistory,
  type GithubBalanceStore,
  type GithubBalanceTransport,
} from "@reddb-io/github";
import { type RedskilledActivityTransport,
  type RedskilledProjectRepository,
  type RedskilledRepositoryActivity,
} from "../repository-activity.js";
import { type RedskilledQueueDiscovery,
  type RedskilledQueueTransport,
} from "../queue-discovery.js";
import { type RedskilledStatuslinePayload,
} from "../statusline-payload.js";
import { type LaunchWorkerOptions,
  type LaunchedWorker,
  type RedskilledWorkerSpec,
} from "../worker-launch.js";
import { type RedskilledBaseMovementCounter,
  type RedskilledTrunkRefresh,
} from "../trunk-mirror.js";
import { type RedskilledLogTailProbe,
} from "../worker-log.js";
import { type RedskilledPublishedObservation,
  type RedskilledPublishedVersionProbe,
  type RedskilledReplacementDecision,
  type RedskilledReplacementIO,
} from "../self-replace.js";
import { type RedskilledLease,
  type RedskilledLeaseOwner,
  type RedskilledLeaseStore,
} from "../session-lease.js";
export interface RedskilledDaemonOptions {
  readonly paths: RedskilledPaths;
  /** Operator-owned lifecycle hooks and desktop notification declarations. */
  readonly hostEventSinks?: RedskilledHostEventSinks;
  /** Hard deadline for each daemon-owned GitHub call; 0 or below disables it. */
  readonly remotePollTimeoutMs?: number;
  /** Self-request cadence; 0 or below disables request-lane monitoring. */
  readonly selfPingIntervalMs?: number;
  /** Wall-clock deadline for one self-request. */
  readonly selfPingTimeoutMs?: number;
  /** Consecutive misses that make host-state report the lane degraded. */
  readonly selfPingMissThreshold?: number;
  /** Test seam; production probes the daemon's own socket. */
  readonly selfPing?: () => Promise<unknown>;
  readonly daemonVersion?: string;
  /**
   * The verdicts this host's boot reaper posed, carried into every surface.
   *
   * Passed in rather than read here because the reaper runs BEFORE this daemon
   * anchors itself (slice #3028) — by the time the socket is listening the
   * anchors are already cleared, so the one process that saw them has to hand
   * them over. Absent leaves the payload's block absent, which is a daemon that
   * never reaped and not a machine where nothing died.
   */
  readonly deaths?: readonly DeathAttribution[];
  /** Registrations proved to remain behind another live daemon beyond this socket. */
  readonly orphanedRegistrations?: readonly RedskilledOrphanedRegistration[];
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
  /** Daemon-owned git seam; injected by concurrency and unreachable-remote fixtures. */
  readonly refreshTrunk?: RedskilledTrunkRefresh;
  /** Daemon-owned fork-to-refreshed-head counter; injected by moved-base fixtures. */
  readonly countBaseMovement?: RedskilledBaseMovementCounter;
  /** The append-only host event lane; defaults to this session's own. */
  readonly eventLane?: RedskilledEventLane;
  /** The durable registration snapshot; defaults to this session's own. */
  readonly registrationIntentStore?: RedskilledRegistrationIntentStore;
  /** How the daemon asks whether a re-attached Worker is still running. */
  readonly liveness?: RedskilledLivenessProbe;
  /** How the daemon reads systemd's retained exit receipt for a dead Worker unit. */
  readonly unitExitFacts?: RedskilledUnitExitFactsProbe;
  /**
   * How long a newborn Worker is exempt from the liveness sweep.
   *
   * Injected so a test can prove the sweep without waiting out the grace; a real
   * daemon takes {@link REDSKILLED_LIVENESS_GRACE_MS}.
   */
  readonly livenessGraceMs?: number;
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
  /** Window between lease renewals; 0 or below leaves the renewer unarmed. */
  readonly leaseRenewMs?: number;
  /** Window between registration sustain passes; 0 or below leaves the belt unarmed. */
  readonly registrationSustainMs?: number;
  /** Independent orphan-census cadence; 0 or below leaves the timer unarmed. */
  readonly orphanReaperMs?: number;
  /** Operator kill-switch posture; defaults from `REDSKILLED_ORPHAN_REAPER`. */
  readonly orphanReaperMode?: RedskilledOrphanReaperMode;
  /** Process-table census seam; authority still comes only from the machine claim. */
  readonly orphanCensus?: () => readonly RedskilledProcessCensusRow[] | Promise<readonly RedskilledProcessCensusRow[]>;
  /** Crash/core dump census seam; detection only and never an unlink authority. */
  readonly orphanDumpFiles?: () => readonly string[] | Promise<readonly string[]>;
  /** PID-reuse verification seam, immediately before a stamped group kill. */
  readonly orphanStarttime?: (pid: number) => string | null | Promise<string | null>;
  /** Whole-process-group escalating teardown seam. */
  readonly orphanKillGroup?: (pgid: number) => boolean | Promise<boolean>;
  /** Where suspects and withheld actions are reported. */
  readonly orphanReport?: (detail: string) => void;
  /**
   * How the daemon performs a bounded read after restart or pre-heartbeat death.
   *
   * Injected so a test can prove the read happens exactly once, on exactly the
   * path the client gave. A live Worker's line still arrives on its own heartbeat;
   * an early death gets one read solely to surface an explicit boot refusal.
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
   * How this daemon asks GitHub for the token's remaining budget.
   *
   * Absent leaves the poller unarmed and every surface honestly `unknown`: a
   * daemon that was given no way to ask must not report a full budget, because a
   * full budget is the one answer that admits every call.
   */
  readonly githubBalance?: RedskilledBalanceRegistration;
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
/**
 * What a daemon nobody armed says about its own polling — the fallback sentence.
 *
 * Named rather than inlined so the one surface that reports it and the tests that
 * pin it read the same string: this is the answer to "a valid registration, a
 * target of two and no Worker", and an operator meets it on the host state.
 */
export const REDSKILLED_QUEUE_UNCONFIGURED_REASON =
  "no tracker transport was given to this daemon, so no queue depth was ever asked for";

export interface RedskilledActivityRegistration {
  readonly projects: readonly RedskilledProjectRepository[];
  readonly hostTokenRef: string;
  readonly transport: RedskilledActivityTransport;
  /** Window between fetches; 0 or below leaves the poller unarmed. */
  readonly intervalMs?: number;
  readonly closedWindowMs?: number;
}

/**
 * How this daemon asks the token what it has left — ONE poller, host-wide.
 *
 * ADR 0132 Amendment 2. The balance is asked rather than accumulated, because a
 * host-scoped ledger of a per-token quota reports one machine's share as if it
 * were the whole; and it is asked on a CADENCE rather than before each call,
 * because a check per call doubles the request count and puts a synchronous round
 * trip in every hot path.
 *
 * No interval: the cadence is a function of the balance itself, so a registration
 * that stated one would be overriding the adaptation with a constant.
 *
 * No threshold either. The daemon stores the integer the token answered with and
 * interprets none of it — what fraction of a pool is held back for work that must
 * not fail is a POLICY, and policy lives in `@reddb-io/github` beside the surface
 * that renders it (ADR 0130 rule 3).
 */
export interface RedskilledBalanceRegistration {
  readonly transport: GithubBalanceTransport;
  /** Host-state snapshot shared with fresh and parallel local processes. */
  readonly store?: GithubBalanceStore;
  /** Append-only forensic pool curve written from the same answers as the snapshot. */
  readonly history?: GithubBalanceHistory;
  /** Additional credential ceilings observed on the same host cadence. */
  readonly observers?: readonly RedskilledBalanceObserver[];
  /**
   * A hard window, for a test that needs one. Production leaves this absent and
   * lets the balance decide — that is the whole decision.
   */
  readonly intervalMsOverride?: number;
}

export interface RedskilledBalanceObserver {
  /** Stable payer label written into history, e.g. `app:153309957`. */
  readonly identity: string;
  readonly transport: GithubBalanceTransport;
  readonly store?: GithubBalanceStore;
  readonly history?: GithubBalanceHistory;
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
   * Why this daemon polls no tracker, in the words of whoever would have armed it.
   *
   * Carried rather than derived because the daemon cannot know what was looked
   * for: the CLI knows it searched the host token variables and found none, and
   * that sentence is the whole of what an operator needs. Absent, the daemon
   * still names the absence with {@link REDSKILLED_QUEUE_UNCONFIGURED_REASON}.
   */
  readonly unconfiguredReason?: string;
  /**
   * How the query reaches the tracker; the activity transport when absent.
   *
   * One token serves both fetches (ADR 0130 Amendment 1), so stating a second
   * transport is for a caller that wants the two windows separable — a test that
   * counts each cadence, above all.
   */
  readonly transport?: RedskilledQueueTransport;
  /**
   * How an unarmed daemon tries again, asked before each poll while it holds no
   * transport — never once it does.
   *
   * **A credential resolved once at start is a credential resolved in someone
   * else's environment** (#3056). The daemon is auto-spawned by whatever session
   * first touched the socket (ADR 0130 rule 7) and then outlives every one of
   * them, so a spawn from a session with no token in its environment and no
   * tracker CLI on its `PATH` left the poller unarmed for the whole life of the
   * process — and every registration made afterwards, by sessions that DID hold a
   * credential, lapsed uncounted one window later while the host reported itself
   * healthy. Re-asking costs nothing on an armed host and is the difference
   * between a drain and a silence on an unarmed one.
   *
   * **Asked on the poll's own window, so it must be bounded by whoever supplies
   * it**: this runs inside the daemon, and a credential lookup that hangs holds
   * the process that owns every Worker on the machine.
   */
  readonly armTransport?: () => RedskilledQueueArming;
  /** Window between fetches; 0 or below leaves the poller unarmed. */
  readonly intervalMs?: number;
  /** How many selectors one request may span; the module's bound when absent. */
  readonly batchSize?: number;
}

/**
 * One attempt at arming the queue poller: the transport, or why there is none.
 *
 * Exactly one of the two is present, and the reason is produced by the SAME
 * attempt that failed rather than by an earlier one — a host whose credential
 * disappeared and a host that never had one owe an operator different sentences.
 */
export interface RedskilledQueueArming {
  readonly transport?: RedskilledQueueTransport;
  readonly unconfiguredReason?: string;
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
  /** Explicitly clear this project's birth breaker. */
  resetProjectBirthBreaker(projectLabel: string, sessionProject?: string): RedskilledProjectReset;
  /** The registrations this daemon holds, ordered by project label; lapsed ones swept. */
  registrations(): readonly RedskilledProjectRegistration[];
  hostState(): RedskilledHostState;
  /** Run the background trunk-refresh body now; exposed so timer behavior is fixture-driven. */
  refreshRegisteredTrunks(): Promise<void>;
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
   * Advance the lease's `renewed_at`, once.
   *
   * Exposed for the same reason the memory sample is: the timer drives it in
   * production and a test drives it directly. `null` means the renewal did not
   * happen — the lease is gone or belongs to someone else — which is a fact to
   * read, never a reason for a serving daemon to fall over.
   */
  renewLease(): Promise<RedskilledLease | null>;
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
   * Ask the token for its remaining budget once — one request, host-wide.
   *
   * Exposed so the adaptive cadence can be driven by a test as well as by the
   * timer, and so a caller that has just armed the poller does not wait a whole
   * window to see a balance. Resolves to `null` when nothing armed it.
   */
  pollGithubBalance(): Promise<GithubBalance | null>;
  /** The last balance the token answered with; `null` before the first ask. */
  githubBalance(): GithubBalance | null;
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
  /** Re-probe every held Worker, retiring the ones the host no longer confirms. */
  sweepWorkerLiveness(): Promise<readonly RedskilledWorkerView[]>;
  /** Census, adopt, reap or report orphan process groups once. */
  sweepOrphanProcesses(): Promise<{ readonly adopted: number; readonly reaped: number; readonly suspects: number }>;
  /** Read the shared process census without adoption, signalling or deletion. */
  censusOrphanProcesses(): Promise<RedskilledProcessCensus>;
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
