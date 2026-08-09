import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";
import { bindExclusive, handleSocket, probeSocketOwnership } from "./socket.js";
import { RedskilledAlreadyRunningError } from "./errors.js";
import {
  appendRedskilledMetricObservation,
  replayRedskilledMetricObservations,
} from "./metric-history.js";
import {
  deriveWorkerScopeCeiling,
  evaluateWorkerAdmission,
  resolveHostCeiling,
  type RedskilledAdmissionVerdict,
} from "../admission.js";
import {
  buildHostEvent,
  createRedskilledEventLane,
  rehydrateWorkers,
  type RedskilledHostEvent,
  type RedskilledWorkerEventKind,
  type RecordWorkerEventInput,
} from "../event-lane.js";
import {
  DEFAULT_REDSKILLED_DEMAND_MS,
  beginBirthProbe,
  describeBirthLatches,
  emptyDemandTick,
  planHostDemand,
  foldWorkerDeath,
  EMPTY_BIRTH_HEALTH,
  resetBirthHealth,
  REDSKILLED_SHORT_LIFE_MS,
  type RedskilledBirthHealth,
  REDSKILLED_DEMAND_BACKOFF_MS,
  type RedskilledDemandGrant,
  type RedskilledDemandTick,
} from "../demand-loop.js";
import {
  buildRedskilledStopReport,
  type RedskilledDaemonStopped,
  type RedskilledStopReason,
} from "../daemon-stop.js";
import {
  buildHostState,
  type RedskilledHostState,
  type RedskilledRegistrationLapse,
  type RedskilledRegistrationStop,
  type RedskilledWorkerView,
} from "../host-state.js";
import {
  evaluateMemoryBudgets,
  sampleWorkerTrees,
  type RedskilledBudgetTermination,
  type RedskilledCpuReading,
  type RedskilledRssReading,
  type RedskilledTreeReading,
} from "../memory-sampler.js";
import {
  createRedskilledMachineClaimStore,
  currentMachineOwner,
  describeMachineScope,
  RedskilledMachineHeldError,
  resolveMachineClaimPath,
} from "../machine-scope.js";
import { workerSpecFromLaunch, type RedskilledLaunchTemplate } from "../launch-template.js";
import {
  createRedskilledRegistrationIntentStore,
} from "../registration-intent-store.js";
import {
  buildProjectRegistration,
  renewProjectRegistration,
  RedskilledProjectUnregisteredError,
  sustainProjectRegistration,
  sweepLapsedRegistrations,
  type RedskilledProjectRegistration,
  type RedskilledProjectRegistrationRequest,
} from "../project-registration.js";
import { createRedskilledProjectHookRuntime } from "../project-hook.js";
import {
  detectUnitMainPid,
  detectWorkerLiveness,
  discoverUnownedWorkers,
  listActiveWorkerUnits,
  maySweepMachine,
  nameUnownedProject,
  reattachWorkers,
  REDSKILLED_LIVENESS_GRACE_MS,
  stopWorker,
} from "../reattach.js";
import {
  REDSKILLED_PROTOCOL_VERSION,
  type RedskilledRequest,
  type RedskilledResponse,
  type RedskilledStatuslineRenderRequest,
  type RedskilledDashboardRenderRequest,
  type RedskilledWorkerCommandRequest,
  type RedskilledProjectDeregistered,
  type RedskilledProjectRegistered,
  type RedskilledProjectRenewed,
  type RedskilledProjectReset,
  type RedskilledWorkerCommandResult,
  type RedskilledWorkerHeartbeatAck,
  type RedskilledWorkerHeartbeatRequest,
} from "../protocol.js";
import {
  fetchGithubBalance,
  githubBalanceCadenceMs,
  unaskedGithubBalance,
  type GithubBalance,
} from "@reddb-io/github";
import { commandOp, evaluateSessionReach, type RedskilledSessionOp } from "../session-reach.js";
import {
  assertOneHostToken,
  DEFAULT_REDSKILLED_ACTIVITY_MS,
  fetchRepositoryActivity,
  type RedskilledRepositoryActivity,
} from "../repository-activity.js";
import {
  DEFAULT_REDSKILLED_QUEUE_MS,
  fetchQueueDiscovery,
  nextQueuePollMs,
  unconfiguredQueueDiscovery,
  type RedskilledQueueDiscovery,
} from "../queue-discovery.js";
import {
  buildStatuslinePayload,
  withholdStatuslineExtras,
  type RedskilledDeathObservation,
  type RedskilledStatuslinePayload,
} from "../statusline-payload.js";
import {
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledStatusline,
  type RedskilledStatuslineRender,
} from "@reddb-io/redskilled-render";
import {
  REDSKILLED_DASHBOARD_DEFAULTS,
  renderRedskilledDashboard,
  type RedskilledDashboard,
} from "@reddb-io/redskilled-render";
import { coerceWorkerDisplay, type RedskilledWorkerDisplayRecord } from "../worker-display.js";
import {
  deriveRedskilledLiveMetrics,
  pruneRedskilledMetricHistory,
  type RedskilledWorkerMetricObservation,
  type RedskilledWorkerOutcomeMark,
} from "../live-metrics.js";
import {
  launchWorker,
  mintHostWorkerId,
  RedskilledAdmissionError,
  type LaunchedWorker,
  type RedskilledWorkerSpec,
} from "../worker-launch.js";
import {
  countRedskilledBaseMovement,
  refreshRedskilledTrunk,
  redskilledTrunkRefreshKey,
  type RedskilledTrunkRefreshInput,
  unreachableTrunkAdmission,
} from "../trunk-mirror.js";
import {
  readLastLogLine,
  type RedskilledWorkerLogLine,
} from "../worker-log.js";
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
  type RedskilledReplacementDecision,
  type RedskilledReplacementHoldReason,
} from "../self-replace.js";
import {
  createRedskilledLeaseStore,
  currentProcessOwner,
  type RedskilledLease,
} from "../session-lease.js";
import {
  REDSKILLED_QUEUE_UNCONFIGURED_REASON,
  RedskilledDaemon,
  RedskilledDaemonOptions,
  RedskilledStopIntent,
} from "./types.js";
import {
  DEFAULT_REDSKILLED_IDLE_MS,
  DEFAULT_REDSKILLED_LEASE_RENEW_MS,
  DEFAULT_REDSKILLED_PUBLISHED_PROBE_TIMEOUT_MS,
  DEFAULT_REDSKILLED_REGISTRATION_SUSTAIN_MS,
  DEFAULT_REDSKILLED_REPLACE_BOOT_CHECK_MS,
  DEFAULT_REDSKILLED_SAMPLE_MS,
  REDSKILLED_LAPSE_MEMORY,
  REDSKILLED_SOCKETLESS_LEASE_REAP_MS,
  bootRefusalFromLog,
  observedWorkerDeath,
} from "./tunables.js";
// Error moved to ./daemon/errors.ts — keep re-export for backward compat
export { RedskilledAlreadyRunningError } from "../daemon/errors.js";

export async function startRedskilledDaemon(options: RedskilledDaemonOptions): Promise<RedskilledDaemon> {
  const { paths } = options;
  const daemonVersion = options.daemonVersion ?? "0.0.0-dev";
  const idleMs = options.idleMs ?? DEFAULT_REDSKILLED_IDLE_MS;
  const clock = options.clock ?? (() => new Date().toISOString());
  const launch = options.launch ?? launchWorker;
  const refreshTrunk = options.refreshTrunk ?? refreshRedskilledTrunk;
  const countBaseMovement = options.countBaseMovement ?? countRedskilledBaseMovement;
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

  // A pid alone is not a daemon. If both ownership records name the same live
  // process, its lease has missed two renewals, and the kernel says nothing owns
  // its socket, the records describe the shutdown wedge from #3401 rather than a
  // singleton. Release them as their recorded owner so the successor can bind;
  // a fresh startup lease remains authoritative throughout its grace window.
  const [heldLease, heldClaim] = await Promise.all([
    leaseStore.read().catch(() => undefined),
    machineClaimStore.read().catch(() => undefined),
  ]);
  const nowMs = Date.parse(clock());
  const renewedAtMs = heldLease == null ? Number.NaN : Date.parse(heldLease.renewed_at);
  const socketlessOwner = heldLease != null &&
    heldClaim != null &&
    heldLease.pid === heldClaim.pid &&
    heldLease.start_time === heldClaim.start_time &&
    heldLease.socket_path === paths.socketPath &&
    heldClaim.socket_path === paths.socketPath &&
    Number.isFinite(nowMs) &&
    Number.isFinite(renewedAtMs) &&
    nowMs - renewedAtMs >= REDSKILLED_SOCKETLESS_LEASE_REAP_MS &&
    await probeSocketOwnership(paths.socketPath) === "unowned";
  if (socketlessOwner) {
    const releasedLease = await leaseStore.release({
      pid: heldLease.pid,
      startTime: heldLease.start_time,
    }).catch(() => false);
    if (releasedLease) {
      await machineClaimStore.release({
        pid: heldClaim.pid,
        startTime: heldClaim.start_time,
        uid: heldClaim.uid,
      }).catch(() => false);
    }
  }

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
    // The two records that already name this socket's holder. Consulted only to
    // REFUSE — an absent, stale or unreadable record decides nothing and falls
    // through to the bind, which is the arbiter it always was.
    server = await bindExclusive(paths.socketPath, async () => {
      const [lease, claim] = await Promise.all([
        leaseStore.read().catch(() => undefined),
        machineClaimStore.read().catch(() => undefined),
      ]);
      if (lease != null && lease.pid !== owner.pid && isPidAlive(lease.pid)) return true;
      return claim != null && claim.socket_path === paths.socketPath &&
        claim.pid !== machineOwner.pid && isPidAlive(claim.pid);
    });
  } catch (err) {
    await leaseStore.release(owner).catch(() => undefined);
    await machineClaimStore.release(machineOwner).catch(() => undefined);
    throw err;
  }

  const startedAt = clock();
  const eventLane = options.eventLane ?? createRedskilledEventLane(paths.eventLanePath);
  const registrationIntentStore = options.registrationIntentStore ??
    createRedskilledRegistrationIntentStore(paths.registrationIntentPath);
  const liveness = options.liveness ?? detectWorkerLiveness;
  const livenessGraceMs = options.livenessGraceMs ?? REDSKILLED_LIVENESS_GRACE_MS;
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
  const leaseRenewMs = options.leaseRenewMs ?? DEFAULT_REDSKILLED_LEASE_RENEW_MS;
  const registrationSustainMs = options.registrationSustainMs ?? DEFAULT_REDSKILLED_REGISTRATION_SUSTAIN_MS;
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
  const balanceRegistration = options.githubBalance;
  const queueRegistration = options.queueDiscovery;
  // Not `const`: an unarmed poller asks again before every poll, so the daemon
  // that was spawned from a session without a credential still counts once one
  // exists (#3056).
  let queueTransport = queueRegistration?.transport ?? activityRegistration?.transport;
  // What a poll says when it cannot run. Stated by the caller that knows WHY —
  // the CLI knows which credential it looked for — and given a sentence of its
  // own here so a daemon nobody told still names the missing thing rather than
  // reporting a bare absence.
  let queueUnconfiguredReason = queueRegistration?.unconfiguredReason ??
    REDSKILLED_QUEUE_UNCONFIGURED_REASON;
  const queueMs = queueRegistration?.intervalMs ?? DEFAULT_REDSKILLED_QUEUE_MS;
  const demandMs = options.demandMs ?? DEFAULT_REDSKILLED_DEMAND_MS;
  const demandBackoffMs = options.demandBackoffMs ?? REDSKILLED_DEMAND_BACKOFF_MS;
  const workers = new Map<string, RedskilledWorkerView>();
  // Concurrent socket admissions for the same trunk join one in-flight fetch.
  // A demand burst additionally retains its resolved promise for the whole tick.
  const trunkRefreshes = new Map<string, Promise<string>>();
  // Re-attached Workers have no child handle to deliver an exit, so their death
  // is discovered by asking the host rather than by being told.
  const reattached = new Set<string>();
  // The last line each Worker published, by Worker id. Held in memory only: it is
  // a live progress note, and a durable copy would be a third authority on a
  // Worker's story next to the tracker and git (ADR 0130).
  const logLines = new Map<string, RedskilledWorkerLogLine>();
  // What each project says a surface should SHOW about its Workers, by Worker id.
  // In memory beside the log lines and for the same reason: a display record is a
  // live progress note, and a durable copy would outlive the Worker it describes.
  const displays = new Map<string, RedskilledWorkerDisplayRecord>();
  // What the daemon has SEEN, kept only as long as a window can ask about it.
  // The displays map holds the latest record per Worker and nothing else, so a
  // rate — which is a difference between two instants — has no ingredient there;
  // these two lanes are that ingredient. In memory beside the displays and for
  // the same reason: they are live progress notes, and a durable copy would be a
  // third authority on a Worker's story (ADR 0130). The outcome marks are the one
  // exception that is already durable — they mirror the host event lane, which is
  // replayed into them at boot.
  let observations: RedskilledWorkerMetricObservation[] = [];
  let outcomeMarks: RedskilledWorkerOutcomeMark[] = [];
  // Boot attributions and deaths this daemon observed share one surface feed.
  // The latter stay durable through the host event lane and are replayed below;
  // keeping a second on-disk death record would create two authorities for the
  // same Worker exit. `undefined` remains until either source has answered,
  // because a daemon that never reaped and never observed a death must not render
  // a calm zero in place of an absent instrument.
  let deathAttributions: RedskilledDeathObservation[] | undefined =
    options.deaths === undefined ? undefined : [...options.deaths];
  // What each project asked the host to hold for it, by project label. The
  // snapshot preserves that opaque intent across daemon replacement; its lease
  // deadline still decides whether the successor may keep using it.
  const restoredRegistrations = await registrationIntentStore.read().catch(() => []);
  const restoredAtMs = Date.parse(startedAt);
  const registrations = new Map<string, RedskilledProjectRegistration>();
  // A lapsed record is retained for one more window so the next queue poll can
  // prove that work still exists and restore it without a person restating the
  // selector and launch. Bounded: a drained or one-window-old record is dropped.
  const recoverableRegistrations = new Map<string, RedskilledProjectRegistration>();
  for (const restored of restoredRegistrations) {
    const renewByMs = Date.parse(restored.renew_by);
    if (!Number.isFinite(restoredAtMs) || !Number.isFinite(renewByMs) || renewByMs >= restoredAtMs) {
      registrations.set(restored.project_label, restored);
    } else if (restoredAtMs - renewByMs <= restored.renew_within_ms) {
      recoverableRegistrations.set(restored.project_label, restored);
    }
  }
  const projectHooks = createRedskilledProjectHookRuntime({
    registration: (label) => registrations.get(label),
    liveWorkerIds: () => workers.keys(),
    admit,
    start: (spec, admission) => startWorker(spec, { admission, hook: true }).worker,
    refuse: (projectLabel, detail) => {
      void eventLane.recordDemandRefusal({ ts: clock(), projectLabel, detail }).catch(() => undefined);
    },
  });
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
  // The last balance the TOKEN answered with — the only copy on this host, and
  // not a number this process maintains. It is `null` until something has been
  // asked, because "nobody asked yet" and "the budget is full" are opposite facts
  // and the second one admits every call (ADR 0132 Amendment 2).
  let lastBalance: GithubBalance | null = null;
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
  // A deliberate stop is not a lapse and not an absence nobody can explain.
  // Retained on the same bounded tail as lapses so `project_stop` remains visible
  // without turning live registration state into a durable second authority.
  const stops: RedskilledRegistrationStop[] = [];
  const orphanedRegistrations = new Map(
    (options.orphanedRegistrations ?? []).map((record) => [record.project_label, record]),
  );
  let demandBackoffUntilMs: number | null = null;
  // Per project, its record of Workers that died before they could work. In
  // memory rather than durable on purpose: it answers "can a Worker boot here
  // right now", and a fresh daemon has no business inheriting a verdict about a
  // machine it has not tried yet.
  const birthHealth: Record<string, RedskilledBirthHealth> = {};
  let demandTicking = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let sampleTimer: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  let registrationTimer: NodeJS.Timeout | undefined;
  let demandTimer: NodeJS.Timeout | undefined;
  let replaceTimer: NodeJS.Timeout | undefined;
  let replaceBootTimer: NodeJS.Timeout | undefined;
  let activityTimer: NodeJS.Timeout | undefined;
  // A timeout rather than an interval: the window between two balance asks is
  // recomputed from the answer each time, so the poller re-arms itself instead of
  // running on a constant it would have to choose in advance.
  let balanceTimer: NodeJS.Timeout | undefined;
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
   * Called from the independent registration belt and from each surface that
   * reads the set. A registration therefore stops being polled, stops being
   * reported and stops holding the daemon alive at one authoritative sweep,
   * without depending on the queue poller's adaptive cadence.
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
      const lastObserved = lastQueue?.projects.find((project) => project.project_label === lapsed.project_label);
      const hasLiveWorker = [...workers.values()].some((worker) => worker.project_label === lapsed.project_label);
      // Only a project the daemon has already observed draining earns a recovery
      // poll. A never-counted or counted-empty registration still stops polling
      // at its deadline, keeping the bounded-intent contract intact.
      if ((lastObserved?.outcome === "counted" && (lastObserved.depth ?? 0) > 0) || hasLiveWorker) {
        recoverableRegistrations.set(lapsed.project_label, lapsed);
      }
      rememberLapse(lapsed, nowMs);
    }
    if (swept.lapsed.length > 0) persistRegistrationIntent();
    return swept.lapsed;
  }

  /** Persist the live set plus the bounded recovery set, in mutation order. */
  function persistRegistrationIntent(): void {
    const durable = new Map(recoverableRegistrations);
    for (const [label, registration] of registrations) durable.set(label, registration);
    void registrationIntentStore.replace([...durable.values()]).catch(() => undefined);
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
      registered_at: registration.registered_at,
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
    const pollAt = lastQueue == null ? Number.NaN : Date.parse(lastQueue.fetched_at);
    const polled = new Map((lastQueue?.projects ?? []).map((project) => [project.project_label, project]));
    let changed = false;
    for (const held of [...registrations.values()]) {
      // A read is not a new observation. Reusing a positive depth forever would
      // let status reads keep a closed project alive; one registration window is
      // the most an observed queue may speak for without another poll.
      const pollFresh = Number.isFinite(pollAt) && nowMs - pollAt <= held.renew_within_ms;
      const poll = pollFresh ? polled.get(held.project_label) : undefined;
      const sustained = sustainProjectRegistration(held, {
        now,
        ...(poll == null ? {} : { queue: { outcome: poll.outcome, depth: poll.depth } }),
        liveWorkers: live[held.project_label] ?? 0,
      });
      if (sustained.registration !== held) {
        registrations.set(held.project_label, sustained.registration);
        changed = true;
      }
    }
    if (changed) persistRegistrationIntent();
  }

  /** Restore a just-lapsed project when a fresh poll proves its queue is non-empty. */
  function recoverRegistrations(now: string): void {
    if (recoverableRegistrations.size === 0) return;
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return;
    const polled = new Map((lastQueue?.projects ?? []).map((project) => [project.project_label, project]));
    let changed = false;
    for (const [label, lapsed] of [...recoverableRegistrations]) {
      // Recovery is a belt, not immortal intent. After one original window there
      // is no live statement left to restore, so the extra polling stops.
      if (nowMs - Date.parse(lapsed.renew_by) > lapsed.renew_within_ms) {
        recoverableRegistrations.delete(label);
        changed = true;
        continue;
      }
      const poll = polled.get(label);
      const recovered = sustainProjectRegistration(lapsed, {
        now,
        ...(poll == null ? {} : { queue: { outcome: poll.outcome, depth: poll.depth } }),
        liveWorkers: [...workers.values()].filter((worker) => worker.project_label === label).length,
      });
      if (recovered.verdict === "open-work" || recovered.verdict === "live-worker") {
        registrations.set(label, recovered.registration);
        recoverableRegistrations.delete(label);
        changed = true;
      } else if (recovered.verdict === "drained") {
        recoverableRegistrations.delete(label);
        changed = true;
      }
    }
    if (changed) persistRegistrationIntent();
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
      ceiling,
      scope: describeMachineScope(machineClaimStore.claimPath, claimLabels, machineOwner),
      workers: [...workers.values()],
      registrations: [...registrations.values()],
      demand: lastDemand,
      // The ones that stopped, beside the ones that stand: a project missing from
      // the set is either one that never registered or one whose drain ended, and
      // only the second is something an operator has to act on.
      lapses,
      stops,
      orphanedRegistrations: [...orphanedRegistrations.values()],
      birthLatches: describeBirthLatches(birthHealth, Date.parse(now)),
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
      displays: Object.fromEntries(displays),
      now: clock(),
      reattachedWorkerIds: [...reattached],
      repositoryActivity: lastActivity,
      githubBalance: lastBalance,
      ...(deathAttributions === undefined ? {} : { deaths: deathAttributions }),
      // Derived here, once, for every surface: the observation history belongs
      // to this process, so a statusline dividing its own counters would be a
      // second authority on a number that has one answer.
      metrics: deriveRedskilledLiveMetrics({ observations, outcomes: outcomeMarks, now: clock() }),
    });
  }

  /**
   * Keep one heartbeat's counters, so a later read can take a difference.
   *
   * The display map holds only the latest record per Worker, which is enough to
   * PRINT a count and can never yield a rate — a rate is the distance between two
   * instants, and the map keeps one. The history is bounded by age and by count
   * on every append, because an unbounded one is a leak measured in days.
   */
  function observeWorkerCounters(
    published: RedskilledWorkerDisplayRecord,
    worker: RedskilledWorkerView,
  ): void {
    const appended = appendRedskilledMetricObservation(observations, published, worker, clock());
    observations = appended.observations;
    // The host event lane is the daemon's one durable history. Persist the
    // projection needed for rates there, never in a metrics sidecar.
    void eventLane.recordWorker(appended.record).catch(() => undefined);
  }

  /** Keep one Worker's ending, so the outcome rate rests on the same facts the lane does. */
  function markWorkerOutcome(mark: RedskilledWorkerOutcomeMark): void {
    outcomeMarks = pruneRedskilledMetricHistory([...outcomeMarks, mark], (entry) => entry.ts, { now: clock() });
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
   * Ask the token what it has left. ONE request, and one poller host-wide.
   *
   * The answer replaces the stored one whatever it says, including when it says
   * nothing: a refusal that left the last good balance standing would keep
   * admitting convenience reads against a number the token stopped confirming.
   */
  async function pollGithubBalance(): Promise<GithubBalance | null> {
    if (balanceRegistration == null) return null;
    lastBalance = await fetchGithubBalance({ transport: balanceRegistration.transport, now: clock() });
    return lastBalance;
  }

  /**
   * Arm the balance poller, and let the BALANCE choose when it runs again.
   *
   * Rare above half, tightening as the balance falls, continuous once spent —
   * because asking is free of primary quota and a fixed cadence would have to
   * choose between being slow at the edge and wasting polls in the middle. The
   * re-arm is a timeout the poll itself schedules, so the window is a function of
   * the answer rather than a constant chosen before any answer existed.
   *
   * The floor lives in `@reddb-io/github`: `GET /rate_limit` is free of PRIMARY
   * quota only, and GitHub's secondary limits still meter request rate, so this
   * stays a cadence in seconds and never becomes a check per call.
   */
  function armBalanceTimer(): void {
    if (stopping || balanceTimer != null || balanceRegistration == null) return;
    const tick = (): void => {
      balanceTimer = undefined;
      void pollGithubBalance()
        .catch(() => undefined)
        .then(() => {
          if (stopping) return;
          const nextMs = balanceRegistration.intervalMsOverride ??
            githubBalanceCadenceMs(lastBalance ?? unaskedBalance(), { now: clock() });
          balanceTimer = setTimeout(tick, nextMs);
          balanceTimer.unref();
        });
    };
    tick();
  }

  /** The balance a daemon that has asked nothing holds — never a full budget. */
  function unaskedBalance(): GithubBalance {
    return unaskedGithubBalance(clock());
  }

  /**
   * Try to arm the poller, once per poll, for as long as it is unarmed.
   *
   * **The attempt is the only thing that knows why it failed**, so its reason
   * replaces the one an earlier attempt left behind — an operator reading
   * `last_poll` sees why THIS poll could not ask rather than why the daemon's
   * first one could not. A thrower is treated as an attempt that found nothing:
   * the credential lookup shells out, and a host whose tracker CLI hangs or dies
   * must keep polling nothing rather than losing the poll loop to an exception.
   */
  function armQueueTransport(): void {
    if (queueTransport != null || queueRegistration?.armTransport == null) return;
    try {
      const armed = queueRegistration.armTransport();
      if (armed.transport != null) {
        queueTransport = armed.transport;
        return;
      }
      if (armed.unconfiguredReason != null) queueUnconfiguredReason = armed.unconfiguredReason;
    } catch (err) {
      queueUnconfiguredReason =
        `this host could not resolve a tracker credential: ${err instanceof Error ? err.message : String(err)}`;
    }
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
    const now = clock();
    // Swept before the set is snapshotted, so a lapsed project is absent from the
    // very poll that would otherwise have asked the tracker about it again.
    expireLapsedRegistrations(now);
    const nowMs = Date.parse(now);
    for (const [label, lapsed] of [...recoverableRegistrations]) {
      if (Number.isFinite(nowMs) && nowMs - Date.parse(lapsed.renew_by) > lapsed.renew_within_ms) {
        recoverableRegistrations.delete(label);
      }
    }
    const candidates = new Map<string, RedskilledProjectRegistration>([
      ...recoverableRegistrations,
      ...registrations,
    ]);
    const projects = [...candidates.values()]
      .map((registration) => ({
        project_label: registration.project_label,
        selector: registration.selector,
        ...(registration.queue_poll == null ? {} : { poll: registration.queue_poll }),
      }))
      // By label, like every other list the daemon reports: the order a client
      // happened to register in is not a fact about the host.
      .sort((left, right) => left.project_label.localeCompare(right.project_label));
    if (projects.length === 0) return null;
    // Asked again while unarmed, and never once armed: the credential is resolved
    // in the environment of whichever session happened to auto-spawn this daemon,
    // and that session is gone (#3056). A host that could not arm at start is
    // re-asked here rather than staying blind for the life of the process.
    armQueueTransport();
    // A host that cannot ask SAYS SO, on every registration it holds (#2974).
    // Returning here without a document is what let a machine with a valid
    // registration, a stated target and a full queue report itself healthy and
    // birth nothing: the absence read exactly like "nobody has counted yet".
    if (queueTransport == null) {
      lastQueue = unconfiguredQueueDiscovery(projects, now, queueUnconfiguredReason);
      return lastQueue;
    }
    lastQueue = await fetchQueueDiscovery({
      projects,
      transport: queueTransport,
      now,
      ...(queueRegistration?.batchSize == null ? {} : { batchSize: queueRegistration.batchSize }),
    });
    // The depth this poll just counted is the renewal a project with open work
    // gets (Amendment 7), applied here rather than at the next read so a deadline
    // is never judged against a poll the daemon had already superseded.
    const observedAt = clock();
    recoverRegistrations(observedAt);
    sustainRegistrations(observedAt);
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
      // Swept BEFORE the live count is taken (#3123). A record whose Worker is
      // gone occupies a slot the planner then declines to fill, so a queue with
      // work sits undrained beside a machine that is entirely free — and the
      // idle timer, five minutes away, is not the cadence a birth decision runs at.
      await sweepWorkerLiveness().catch(() => undefined);
      const live: Record<string, number> = {};
      for (const worker of workers.values()) {
        live[worker.project_label] = (live[worker.project_label] ?? 0) + 1;
      }
      const queue: Record<string, number | null> = {};
      for (const project of lastQueue?.projects ?? []) queue[project.project_label] = project.depth;

      const nowMs = Date.parse(at);
      const demandNowMs = Number.isFinite(nowMs) ? nowMs : 0;
      // A half-open Worker closes the latch only after proving it survived the
      // same short-life window that opened it. Until then it is the sole probe.
      for (const [projectLabel, health] of Object.entries(birthHealth)) {
        if (health.probeWorkerId == null) continue;
        const probe = workers.get(health.probeWorkerId);
        if (probe != null && demandNowMs - Date.parse(probe.started_at) >= REDSKILLED_SHORT_LIFE_MS) {
          birthHealth[projectLabel] = resetBirthHealth();
        }
      }
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
        nowMs: demandNowMs,
        backoffUntilMs: demandBackoffUntilMs,
        birthHealth,
      });

      const granted: RedskilledDemandGrant[] = [];
      const burstForks = new Map<string, Promise<string>>();
      let refusal: string | null = null;
      for (const birth of plan.births) {
        let launched: LaunchedWorker;
        // The id is minted HERE rather than inside the launch, because the launch
        // template may mention it: an id substituted into an argv, an env or a log
        // path and a different id on the record would be one Worker the host and
        // the work disagree about.
        const workerId = mintHostWorkerId(workers.keys());
        const registration = registrations.get(birth.project_label);
        const spec = workerSpecFromLaunch(
          // The argv comes from the plan (it is the registration's, copied), and
          // the env and the log path from the registration itself: the planner
          // reads three integers per project and was never given the launch.
          {
            argv: birth.argv,
            ...(registration?.env == null ? {} : { env: registration.env }),
            ...(registration?.log_path == null ? {} : { log_path: registration.log_path }),
          },
          { worker_id: workerId, slot: birth.index, workspace_path: birth.workspace_path },
          { project_label: birth.project_label },
        );
        try {
          if (registration?.trunk == null) {
            launched = startWorker(spec);
          } else {
            const trunk = { workspace_path: birth.workspace_path, trunk: registration.trunk };
            const admission = admit(spec);
            if (!admission.admitted) throw new RedskilledAdmissionError(admission.reason, admission);
            const key = redskilledTrunkRefreshKey(trunk);
            let fork = burstForks.get(key);
            if (fork == null) {
              fork = refreshFork(trunk);
              burstForks.set(key, fork);
            }
            launched = await admitAndStartWorker(spec, trunk, fork, admission);
          }
        } catch (err) {
          refusal = err instanceof Error ? err.message : String(err);
          const retryNextCycle = err instanceof RedskilledAdmissionError &&
            err.admission?.verdict === "refused-unreachable-trunk-remote";
          if (!retryNextCycle) {
            demandBackoffUntilMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) + demandBackoffMs;
          }
          break;
        }
        granted.push({
          project_label: birth.project_label,
          worker_id: launched.worker.worker_id,
          pid: launched.worker.pid,
          ...(launched.fork_sha == null ? {} : { fork_sha: launched.fork_sha }),
          // Loud where it used to be silent (#3079): a registration that declared
          // no log path produces a Worker no surface can ever show the output of,
          // and the four layers between here and that surface each read the
          // absence as legitimate. The grant says so once, where the operator who
          // asked for the Worker is already reading.
          warnings: spec.log_path == null
            ? [
              ...launched.warnings,
              `project ${JSON.stringify(birth.project_label)} declared no log path, so no surface can show what ` +
                `Worker ${JSON.stringify(launched.worker.worker_id)} logs unless it publishes a line on its heartbeat`,
            ]
            : launched.warnings,
        });
        const health = birthHealth[birth.project_label];
        if (health?.haltUntilMs != null && demandNowMs >= health.haltUntilMs) {
          birthHealth[birth.project_label] = beginBirthProbe(health, launched.worker.worker_id);
        }
      }
      // A tick that asked and was never refused clears the hold, so the room a
      // dying Worker freed is spent on the next tick rather than on the timer
      // the last refusal set.
      if (refusal == null && plan.births.length > 0) demandBackoffUntilMs = null;

      // A counted positive queue and free project slots is birth-eligible. If
      // this tick granted that project nothing, the host lane must state why —
      // otherwise the silent three-hour stall from #3267 is indistinguishable
      // from a healthy idle daemon.
      const grantedProjects = new Set(granted.map((worker) => worker.project_label));
      for (const intent of plan.intents) {
        if (intent.queue_depth == null || intent.queue_depth <= 0 || intent.live >= intent.target) continue;
        if (grantedProjects.has(intent.project_label)) continue;
        const detail = refusal != null && (intent.outcome === "asking" || intent.outcome === "half-open-probe")
          ? `project ${JSON.stringify(intent.project_label)} was birth-eligible but the host refused it: ${refusal}`
          : intent.detail;
        await eventLane.recordDemandRefusal({ ts: at, projectLabel: intent.project_label, detail }).catch(() => undefined);
      }

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
   * The rendered line, for a client that cannot draw one itself.
   *
   * **The layout is no longer this process's** (ADR 0132 decision 1): this calls
   * `@reddb-io/redskilled-render`, the one implementation every surface shares,
   * on the payload the other op returns. The op survives the move because a
   * plugin pinned to an older bundle still asks for it (ADR 0130 rule 3), and a
   * daemon that answered "render it yourself" would blank that plugin's pane.
   *
   * The request carries taste already settled by the client — mode, project and
   * the count budgets — because a daemon that resolved a config would have to
   * know what a `.red/config.yaml` is, and rule 3 keeps repository layout out of
   * this process entirely. An absent field takes the shared default, so a bare
   * read still renders.
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
   * The same payload, given the vertical dimension a pane has and a line has not.
   *
   * **THE DAEMON COMPOSES; THE RENDER MODULE DRAWS.** A herdr pane and an editor
   * panel that each did their own Worker math would be two dashboards lying in
   * two different ways about one instant, and what stops that is now shared code
   * rather than a shared string: this is one call of
   * `@reddb-io/redskilled-render`, which every other surface also calls. As with
   * the line, the request carries taste the client already resolved, because a
   * daemon that looked up a config would have to know what a `.red/config.yaml`
   * is.
   */
  function statuslineDashboard(render?: RedskilledDashboardRenderRequest): RedskilledDashboard {
    return renderRedskilledDashboard(statuslinePayload(), {
      mode: render?.mode ?? REDSKILLED_DASHBOARD_DEFAULTS.mode,
      project: render?.project ?? REDSKILLED_DASHBOARD_DEFAULTS.project,
      maxWidth: render?.max_width ?? REDSKILLED_DASHBOARD_DEFAULTS.maxWidth,
      maxRows: render?.max_rows ?? REDSKILLED_DASHBOARD_DEFAULTS.maxRows,
      maxHeight: render?.max_height ?? REDSKILLED_DASHBOARD_DEFAULTS.maxHeight,
      showDeathDetails: render?.show_death_details ?? REDSKILLED_DASHBOARD_DEFAULTS.showDeathDetails,
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
    displays.delete(workerId);
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
    // Shape-checked and stored, exactly as the line above it is. A record whose
    // fields the daemon cannot recognise degrades field by field rather than
    // failing the heartbeat: a project shipping a newer bundle than its neighbour
    // is the ordinary state of a host-scoped daemon (ADR 0130 rule 3).
    const display = request.display === undefined ? null : coerceWorkerDisplay(request.display);
    if (display != null) {
      const previous = displays.get(request.worker_id)?.display;
      const stored = { display, published_at: publishedAt };
      displays.set(request.worker_id, stored);
      // Kept as well as stored: the map answers "what is it doing now" and the
      // history answers "how fast", and one cannot be recovered from the other.
      observeWorkerCounters(stored, target);
      if (display.phase !== previous?.phase || display.step !== previous?.step) {
        record("worker-activity", target, null, { phase: display.phase, step: display.step });
      }
    }
    if (request.mechanical_heal?.heal_kind === "mechanical-regeneration") {
      record(
        "worker-heal",
        target,
        `${request.mechanical_heal.cause}; cycle ${request.mechanical_heal.cycle}/${request.mechanical_heal.cap}; ` +
          `free=${request.mechanical_heal.free}`,
        { healKind: request.mechanical_heal.heal_kind },
      );
    }
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
    const refusal = worker.log_path == null
      ? null
      : bootRefusalFromLog(await readLogTail(worker.log_path).catch(() => null));
    forgetWorker(worker.worker_id);
    record("worker-death", worker, refusal == null ? ended : `session-error: ${refusal}`, {
      exitCode: code,
      signal,
      refusal,
    });
    armIdleTimer();
  }

  /**
   * Fold one death into its project's birth health.
   *
   * An unreadable lifetime is treated as long, never as short: the breaker
   * exists to stop a loop it can prove, and halting a project on a clock it
   * could not parse would be the same silent overreach in the other direction.
   */
  function foldBirthHealth(projectLabel: string, lifetimeMs: number): void {
    if (!Number.isFinite(lifetimeMs) || lifetimeMs < 0) {
      birthHealth[projectLabel] = EMPTY_BIRTH_HEALTH;
      return;
    }
    const before = birthHealth[projectLabel] ?? EMPTY_BIRTH_HEALTH;
    const after = foldWorkerDeath(before, lifetimeMs, Date.parse(clock()));
    birthHealth[projectLabel] = after;
    if (after.haltUntilMs != null && before.haltUntilMs == null) {
      // Said once, when the breaker opens rather than on every death after it:
      // a loop that logs per cycle is the second thing filling a disk.
      process.stderr.write(
        `redskilled: project ${JSON.stringify(projectLabel)} lost ${after.shortLifeStreak} Workers in a row ` +
          `inside ${REDSKILLED_SHORT_LIFE_MS}ms of birth; not asking for another until ` +
          `${new Date(after.haltUntilMs).toISOString()}\n`,
      );
    }
  }

  /** Clear one project's birth breaker after project-scoped reach permits it. */
  function resetProjectBirthBreaker(projectLabel: string, sessionProject?: string): RedskilledProjectReset {
    const reach = authorize("project-reset", sessionProject, projectLabel);
    if (!reach.permitted) throw new Error(reach.reason);
    const reset = birthHealth[projectLabel]?.haltUntilMs != null || birthHealth[projectLabel]?.probeWorkerId != null;
    birthHealth[projectLabel] = resetBirthHealth();
    return {
      version: 1,
      project_label: projectLabel,
      latch: "project-birth-breaker",
      reset,
      reach,
      detail: reset
        ? `redskilled cleared project ${JSON.stringify(projectLabel)}'s birth breaker; the next demand tick may birth normally`
        : `redskilled found no open birth breaker for project ${JSON.stringify(projectLabel)}; nothing changed`,
    };
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
    persistRegistrationIntent();
    // A current registration outranks every historical absence. Remove the old
    // tail now so a later deliberate stop cannot uncover an older lapse and lie
    // about which transition happened most recently.
    removeRegistrationHistory(registration.project_label);
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
    if (held == null) {
      if (orphanedRegistrations.has(projectLabel)) {
        throw new RedskilledProjectUnregisteredError(projectLabel, { kind: "orphaned" });
      }
      const stopped = [...stops].reverse().find((record) => record.project_label === projectLabel);
      if (stopped != null) {
        throw new RedskilledProjectUnregisteredError(projectLabel, { kind: "stopped", at: stopped.at });
      }
      const lapsed = [...lapses].reverse().find((record) => record.project_label === projectLabel);
      if (lapsed != null) {
        throw new RedskilledProjectUnregisteredError(projectLabel, {
          kind: "lapsed",
          at: lapsed.at,
          ...(lapsed.registered_at == null ? {} : { registered_at: lapsed.registered_at }),
        });
      }
      throw new RedskilledProjectUnregisteredError(projectLabel);
    }
    const registration = renewProjectRegistration(held, {
      now,
      ...(options.renewWithinMs == null ? {} : { renew_within_ms: options.renewWithinMs }),
      ...(options.launch == null ? {} : { launch: options.launch }),
    });
    registrations.set(registration.project_label, registration);
    persistRegistrationIntent();
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
    const held = registrations.get(projectLabel) ?? recoverableRegistrations.get(projectLabel);
    const releasedCurrent = registrations.delete(projectLabel);
    const releasedRecoverable = recoverableRegistrations.delete(projectLabel);
    const released = releasedCurrent || releasedRecoverable;
    if (held != null) {
      const detail = `redskilled released the registration for project ${JSON.stringify(projectLabel)}`;
      removeRegistrationHistory(projectLabel);
      stops.push({ project_label: projectLabel, registered_at: held.registered_at, at: clock(), detail });
      if (stops.length > REDSKILLED_LAPSE_MEMORY) stops.splice(0, stops.length - REDSKILLED_LAPSE_MEMORY);
    }
    if (released) persistRegistrationIntent();
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

  /** Forget an older absence when a newer registration transition supersedes it. */
  function removeRegistrationHistory(projectLabel: string): void {
    recoverableRegistrations.delete(projectLabel);
    for (let index = lapses.length - 1; index >= 0; index -= 1) {
      if (lapses[index]!.project_label === projectLabel) lapses.splice(index, 1);
    }
    for (let index = stops.length - 1; index >= 0; index -= 1) {
      if (stops[index]!.project_label === projectLabel) stops.splice(index, 1);
    }
    orphanedRegistrations.delete(projectLabel);
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
      ...(spec.reservation == null ? {} : { reservation: spec.reservation }),
    });
  }

  function refreshFork(input: RedskilledTrunkRefreshInput): Promise<string> {
    const key = redskilledTrunkRefreshKey(input);
    const inFlight = trunkRefreshes.get(key);
    if (inFlight != null) return inFlight;
    const pending = refreshTrunk(input).finally(() => {
      if (trunkRefreshes.get(key) === pending) trunkRefreshes.delete(key);
    });
    trunkRefreshes.set(key, pending);
    return pending;
  }

  async function admitAndStartWorker(
    spec: RedskilledWorkerSpec,
    trunk: RedskilledTrunkRefreshInput,
    fork?: Promise<string>,
    judgedAdmission?: RedskilledAdmissionVerdict,
  ): Promise<LaunchedWorker> {
    const admission = judgedAdmission ?? admit(spec);
    if (!admission.admitted) throw new RedskilledAdmissionError(admission.reason, admission);
    let forkSha: string;
    try {
      forkSha = await (fork ?? refreshFork(trunk));
    } catch (error) {
      const refusal = unreachableTrunkAdmission(admission, trunk, error);
      throw new RedskilledAdmissionError(refusal.reason, refusal);
    }
    // The fetch is asynchronous. Re-judge against Workers born while it was in
    // flight so concurrent socket admissions cannot all spend the same slot.
    const finalAdmission = admit(spec);
    if (!finalAdmission.admitted) {
      throw new RedskilledAdmissionError(finalAdmission.reason, finalAdmission);
    }
    return startWorker(spec, { admission: finalAdmission, forkSha });
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
  function startWorker(
    spec: RedskilledWorkerSpec,
    grant: {
      readonly admission?: RedskilledAdmissionVerdict;
      readonly forkSha?: string;
      readonly hook?: boolean;
    } = {},
  ): LaunchedWorker {
    // The ceiling is the host's to state, not the client's to remember: it comes
    // out of the same accounting admission was judged against, so every Worker is
    // born inside a scope with a stated wall and a host-pressure kill lands on
    // the Worker that earned it rather than on the terminal's biggest bystander
    // (#3029). Derived from the live Worker set at THIS instant, exactly as the
    // admission verdict is.
    const memoryCeiling = deriveWorkerScopeCeiling({
      ceiling,
      workers: [...workers.values()],
      budget: spec.budget,
    });
    const launched = launch({
      spec,
      admission: grant.admission ?? admit(spec),
      ...(grant.forkSha == null ? {} : { forkSha: grant.forkSha }),
      memoryCeiling,
      liveWorkerIds: workers.keys(),
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
    const forkSha = grant.forkSha ?? launched.fork_sha ?? launched.worker.fork_sha;
    const worker = forkSha == null || forkSha === ""
      ? launched.worker
      : { ...launched.worker, fork_sha: forkSha };
    const tracked: LaunchedWorker = {
      ...launched,
      worker,
      ...(forkSha == null || forkSha === "" ? {} : { fork_sha: forkSha }),
    };
    workers.set(worker.worker_id, worker);
    if (grant.hook === true) projectHooks.track(worker.worker_id);
    record("worker-birth", worker, null, {
      admissionVerdict: grant.admission?.verdict ?? launched.admission.verdict,
    });
    armIdleTimer();
    return tracked;
  }

  /**
   * Append one event, without making the caller wait for the disk.
   *
   * The lane serialises its own appends, so ordering survives the fire-and-
   * forget; what a failed write must not do is take down the daemon that still
   * holds the live Worker the event was about.
   */
  function record(
    kind: RedskilledWorkerEventKind,
    worker: RedskilledWorkerView,
    detail: string | null,
    facts: Omit<RecordWorkerEventInput, "kind" | "worker" | "ts" | "detail"> & {
      readonly refusal?: string | null;
    } = {},
  ): void {
    // A stopped daemon writes nothing. Its beliefs about who is alive stopped
    // being authoritative when it let go of the session, and the next daemon
    // re-derives every one of them by asking the host directly.
    if (stopping) return;
    const ts = clock();
    // The same instant the lane records, so the outcome rate and the lane never
    // describe the same ending at two different times.
    const input: RecordWorkerEventInput = { kind, worker, ts, detail, ...facts };
    if (kind === "worker-death" || kind === "worker-budget-kill") {
      markWorkerOutcome({ worker_id: worker.worker_id, ts, outcome: kind });
      rememberObservedDeath(
        buildHostEvent(input),
        { startedAt: worker.started_at, ...(facts.refusal == null ? {} : { refusal: facts.refusal }) },
      );
      // Every death reaches here, which is why the breaker folds here rather
      // than at the five call sites that end a Worker. What it reads is a
      // lifetime, never a cause: the daemon is not owed a reason (rule 3), and
      // a Worker dead in seconds is spent whatever the reason was.
      foldBirthHealth(worker.project_label, Date.parse(ts) - Date.parse(worker.started_at));
    }
    void eventLane
      .recordWorker(input)
      .catch(() => undefined);
    projectHooks.onEvent(kind, worker);
  }

  /** Put one host-observed loss on every surface, newest observation winning. */
  function rememberObservedDeath(
    event: RedskilledHostEvent,
    context: { readonly startedAt?: string; readonly refusal?: string } = {},
  ): void {
    const attribution = observedWorkerDeath(event, context);
    if (attribution == null) return;
    const merged = [
      attribution,
      ...(deathAttributions ?? []).filter(
        (existing) =>
          existing.kind !== attribution.kind || existing.id !== attribution.id || existing.ts !== attribution.ts,
      ),
    ].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
    // The badge describes the same rolling day as the daemon's outcome feed,
    // rather than turning an append-only lane's lifetime total into current
    // health. The generic pruner also caps an unreadable clock safely.
    deathAttributions = pruneRedskilledMetricHistory(merged, (death) => death.ts, { now: clock() });
  }

  /**
   * Ask the host about EVERY Worker it holds, and retire the ones it no longer
   * confirms. Returns the Workers that were retired.
   *
   * **Every record, not just the re-attached ones (#3123).** The narrow sweep
   * trusted a child handle to deliver each birth's death, and a record whose
   * launch client died without one — its pid reclaimed, its unit gone — then held
   * a slot for two hours with no verb able to release it: the daemon's statusline
   * said `1w` while the project's own read said none, and the machine refused to
   * birth anything at `target: 1`. Two hours is not a race.
   *
   * The grace window is what keeps that from becoming the opposite bug: a Worker
   * born a moment ago has not necessarily reached the init system, so probing it
   * would reap a Worker mid-birth. Younger than {@link REDSKILLED_LIVENESS_GRACE_MS}
   * is left to the child handle, which is authoritative for exactly that window.
   */
  async function sweepWorkerLiveness(): Promise<readonly RedskilledWorkerView[]> {
    const nowMs = Date.parse(clock());
    const held = [...workers.values()].filter((worker) => {
      if (reattached.has(worker.worker_id)) return true;
      const bornMs = Date.parse(worker.started_at);
      return !Number.isFinite(bornMs) || nowMs - bornMs >= livenessGraceMs;
    });
    if (held.length === 0) return [];
    const { dead } = await reattachWorkers(held, liveness);
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
    const prepared = prepareRedskilledReplacement(decision, replacementIO, paths, idleMs);
    replacementState = "in-progress";
    await eventLane.flush().catch(() => undefined);
    await registrationIntentStore.flush().catch(() => undefined);
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

  /**
   * Say the lease is still ours, on its own window.
   *
   * `renew()` shipped with the lease and had ZERO callers, so `renewed_at` was a
   * field that only ever equalled `acquired_at` — a record that looked stale on a
   * daemon in perfect health (#3092). A failure costs the renewal and never the
   * daemon: a lease another owner has taken is a fact to report, not a reason for
   * a serving process to fall over.
   */
  async function renewLease(): Promise<RedskilledLease | null> {
    return await leaseStore.renew(owner).catch(() => null);
  }

  function armLeaseTimer(): void {
    if (stopping || leaseTimer != null || leaseRenewMs <= 0) return;
    leaseTimer = setInterval(() => {
      void renewLease();
    }, leaseRenewMs);
    leaseTimer.unref();
  }

  function armRegistrationTimer(): void {
    if (stopping || registrationTimer != null || registrationSustainMs <= 0) return;
    registrationTimer = setInterval(() => {
      // One independent cadence owns both sides of the decision: renew what a
      // fresh observation still speaks for, then make every lapse visible.
      expireLapsedRegistrations(clock());
    }, registrationSustainMs);
    registrationTimer.unref();
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
   *
   * **Armed without a transport too**, for the same reason the unconfigured
   * document exists: a host that cannot ask has to keep saying so on whatever is
   * registered NOW, and a timer that stood down would leave the one machine that
   * needs the sentence the one machine that never prints it. It costs no request.
   */
  function armQueueTimer(): void {
    if (stopping || queueTimer != null) return;
    if (queueMs <= 0) return;
    const schedule = (delayMs: number): void => {
      queueTimer = setTimeout(() => {
        queueTimer = undefined;
        void refreshRegisteredTrunks()
          .then(() => pollQueueDiscovery())
          .catch(() => undefined)
          .finally(() => {
            if (stopping) return;
            const nowMs = Date.parse(clock());
            schedule(nextQueuePollMs(lastQueue, queueMs, Number.isFinite(nowMs) ? nowMs : Date.now()));
          });
      }, delayMs);
      queueTimer.unref();
    };
    schedule(queueMs);
  }

  async function refreshRegisteredTrunks(): Promise<void> {
    await Promise.allSettled(
      [...registrations.values()]
        .filter((registration) => registration.trunk != null)
        .map(async (registration) => {
          const headSha = await refreshFork({
            workspace_path: registration.workspace_path,
            trunk: registration.trunk!,
          });
          const live = [...workers.values()].filter((worker) =>
            worker.project_label === registration.project_label && worker.fork_sha != null && worker.fork_sha !== ""
          );
          await Promise.allSettled(live.map(async (worker) => {
            const commitsAhead = await countBaseMovement({
              workspace_path: registration.workspace_path,
              fork_sha: worker.fork_sha!,
              head_sha: headSha,
            });
            const current = workers.get(worker.worker_id);
            if (current == null || current.fork_sha !== worker.fork_sha) return;
            const updated = {
              ...current,
              base_head_sha: headSha,
              base_commits_ahead: commitsAhead,
            };
            workers.set(worker.worker_id, updated);
            if (current.base_head_sha !== headSha || current.base_commits_ahead !== commitsAhead) {
              record("worker-drift", updated, null, {
                baseHeadSha: headSha,
                baseCommitsAhead: commitsAhead,
              });
            }
          }));
        }),
    );
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
      void sweepWorkerLiveness()
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
    if (leaseTimer) clearInterval(leaseTimer);
    if (registrationTimer) clearInterval(registrationTimer);
    if (replaceTimer) clearInterval(replaceTimer);
    if (replaceBootTimer) clearTimeout(replaceBootTimer);
    if (activityTimer) clearInterval(activityTimer);
    if (balanceTimer) clearTimeout(balanceTimer);
    if (queueTimer) clearTimeout(queueTimer);
    if (demandTimer) clearInterval(demandTimer);
    // Every event already handed over reaches the lane before the daemon lets go
    // of the session: a birth still in flight would leave the next daemon with a
    // Worker it holds a budget for and no record of.
    await eventLane.flush().catch(() => undefined);
    await registrationIntentStore.flush().catch(() => undefined);
    // Ownership records go first while the socket still proves this daemon is
    // reachable. If either release stalls or fails, the old daemon stays bound
    // and no successor mistakes a live, socketless pid for the singleton.
    await leaseStore.release(owner);
    await machineClaimStore.release(machineOwner);
    server.close();
    for (const socket of activeSockets) socket.destroy();
    await new Promise<void>((resolve) => server.once("close", () => resolve()));
    await rm(paths.socketPath, { force: true });
    resolveClosed();
    return await closed;
  }

  // Rehydrate BEFORE the socket starts answering: a client that read host state
  // in the window between binding and replay would be told this session holds
  // nothing, and would then birth a second Worker for work already running.
  const laneEvents = await eventLane.read().catch(() => []);
  // A successor must render yesterday's loss too. The event lane is the durable
  // host witness, so replaying it here restores the exact feed a live exit updates
  // above without asking a project artifact that an early Worker never created.
  const birthInstants = new Map<string, string>();
  for (const event of laneEvents) {
    if (event.event === "worker-birth") {
      birthInstants.set(event.worker_id, event.ts);
      continue;
    }
    const refusal = bootRefusalFromLog(event.detail);
    rememberObservedDeath(event, {
      ...(birthInstants.get(event.worker_id) == null ? {} : { startedAt: birthInstants.get(event.worker_id)! }),
      ...(refusal == null ? {} : { refusal }),
    });
    if (event.event === "worker-death" || event.event === "worker-budget-kill") {
      birthInstants.delete(event.worker_id);
    }
  }
  // The outcomes a predecessor recorded are this host's history too: a daemon
  // that restarted mid-day and reported an empty 24h window would tell an
  // operator the machine finished nothing, when what happened is that the
  // process holding the count was replaced.
  outcomeMarks = pruneRedskilledMetricHistory(
    laneEvents
      .filter((event) => event.event === "worker-death" || event.event === "worker-budget-kill")
      .map((event) => ({ worker_id: event.worker_id, ts: event.ts, outcome: event.event })),
    (mark) => mark.ts,
    { now: clock() },
  );
  observations = replayRedskilledMetricObservations(laneEvents, clock());
  const replayed = rehydrateWorkers(laneEvents);
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
  // A successor can prove an expired-but-recoverable intent immediately from a
  // Worker the predecessor left running; no queue round-trip or human restart is
  // needed before that project is registered again.
  recoverRegistrations(clock());
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
      if (request.op === "shutdown") {
        setImmediate(() => void stop({ reason: "requested" }).catch(() => undefined));
      }
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
        //
        // The SKELETON — Workers, projects and budget — is served whatever the
        // request says, because rule 9 already entitles a session to the whole
        // machine and withholding it would buy only a second round trip (ADR
        // 0132 decision 2). What scales with Worker count travels on request,
        // and a request that names no extras is a client pinned to a bundle
        // that predates them: it asked for everything by saying nothing.
        return { id: request.id, ok: true, value: withholdStatuslineExtras(statuslinePayload(), request.extras) };
      }
      if (request.op === "statusline-string") {
        // The same host read, already rendered. The daemon renders it from the
        // payload the other op returns — one call of a pure function — so the
        // two surfaces are the same answer twice and never two answers.
        return { id: request.id, ok: true, value: statuslineString(request.render) };
      }
      if (request.op === "statusline-dashboard") {
        // The third of the statusline family, and the same host read again: one
        // call of a pure function on the payload the first op returns, so a pane
        // and a line are the same answer twice and never two answers.
        return { id: request.id, ok: true, value: statuslineDashboard(request.dashboard) };
      }
      if (request.op === "worker-heartbeat") {
        return { id: request.id, ok: true, value: publishWorkerHeartbeat(request.heartbeat) };
      }
      if (request.op === "project-register") {
        const value = registerProject(request.registration, request.session_project);
        await registrationIntentStore.flush();
        return { id: request.id, ok: true, value };
      }
      if (request.op === "project-renew") {
        const value = renewProject(request.project_label, {
          ...(request.session_project == null ? {} : { sessionProject: request.session_project }),
          ...(request.renew_within_ms == null ? {} : { renewWithinMs: request.renew_within_ms }),
          ...(request.launch == null ? {} : { launch: request.launch }),
        });
        await registrationIntentStore.flush();
        return {
          id: request.id,
          ok: true,
          value,
        };
      }
      if (request.op === "project-deregister") {
        const value = deregisterProject(request.project_label, request.session_project);
        await registrationIntentStore.flush();
        return { id: request.id, ok: true, value };
      }
      if (request.op === "project-reset") {
        return {
          id: request.id,
          ok: true,
          value: resetProjectBirthBreaker(request.project_label, request.session_project),
        };
      }
      if (request.op === "worker-command") {
        return { id: request.id, ok: true, value: await runWorkerCommand(request.command) };
      }
      if (request.op === "worker-start") {
        const reach = authorize("worker-start", request.session_project, request.spec.project_label);
        if (!reach.permitted) return { id: request.id, ok: false, error: reach.reason };
        // A spec without trunk coordinates is an older client inside the same
        // one-release compatibility window as a grant without `fork_sha`.
        const launched = request.spec.trunk == null
          ? startWorker(request.spec)
          : await admitAndStartWorker(request.spec, {
            workspace_path: request.spec.workspace_path,
            trunk: request.spec.trunk,
          });
        // The acknowledgement waits for the birth to reach the lane. A client told
        // "your Worker exists" by a daemon that is then replaced a millisecond
        // later — the ordinary operation — would otherwise leave a live Worker
        // whose birth nothing recorded, and no successor can re-attach to a Worker
        // it was never told about (#2917).
        await eventLane.flush().catch(() => undefined);
        return {
          id: request.id,
          ok: true,
          value: {
            worker: launched.worker,
            admission: launched.admission,
            fork_sha: launched.fork_sha,
            warnings: launched.warnings,
          },
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
  armLeaseTimer();
  armRegistrationTimer();
  armReplaceTimer();
  armActivityTimer();
  armBalanceTimer();
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
    renewLease,
    pollRepositoryActivity,
    pollGithubBalance,
    githubBalance: () => lastBalance,
    pollQueueDiscovery,
    queueDiscovery: () => lastQueue,
    driveDemand,
    demand: () => lastDemand,
    sweepWorkerLiveness,
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
      displays.delete(workerId);
      if (worker) record("worker-death", worker, "released by the daemon");
      armIdleTimer();
      return removed;
    },
    workerCount: () => workers.size,
    registerProject,
    renewProject,
    resetProjectBirthBreaker,
    deregisterProject,
    registrations: () => hostState().registrations ?? [],
    hostState,
    refreshRegisteredTrunks,
    statuslinePayload,
    evaluateIdle,
    observePublishedVersion,
    checkForReplacement,
    stopReport,
    stop,
  };
}
