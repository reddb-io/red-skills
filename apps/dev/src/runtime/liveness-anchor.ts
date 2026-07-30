// liveness-anchor.ts — THE single liveness anchor (issue #2704, Spec #2772).
//
// One anchor, one read, one verdict. `project_status`, `project_stop`, `monitor`,
// `worker_vitals` and the statusline resolve liveness through this module and
// hold NO private source of their own. Two anchors is the bug class behind #2679
// and #2698 — a writer that maintains one and a reader that trusts another
// produced `alive: false` in the same payload as a 13-second-old heartbeat and
// two busy slots.
//
// **A WORKER'S PROCESS LIVENESS RESOLVES THROUGH THE DAEMON, NEVER A PID FILE.**
// The host daemon owns birth and death, so it is the only authority that can
// answer "is this Worker still running" — a stronger one than the attempt record
// this replaced, which could only say what it had last been told. Keying that
// question on a pid file is what deleted the live lane and kept the dead ones.
//
// Three invariants make the contradictory payload unrepresentable rather than
// merely unlikely:
//
//  1. LIVENESS AND FRESHNESS COME FROM ONE RESOLUTION. The observation is
//     computed by the same function that decides the verdict, from the same read,
//     so the two can never disagree.
//  2. AN UNATTRIBUTABLE OBSERVATION IS STALE, WHATEVER ITS AGE. When no anchor
//     names a live writer, the heartbeat has nobody to vouch for it, so it is
//     `orphaned` — stale by construction. `alive: false` therefore implies
//     `stale: true` at the TYPE level for the supervisor lane.
//  3. `dead` IS ONLY REPRESENTABLE BESIDE A FRESH READ. A Worker the daemon did
//     not name is dead only when the daemon answered and its answer is current;
//     an unreachable or stale daemon answers `unknown`. So no payload can report
//     a Worker dead beside fresh evidence that it is alive.
//
// Staleness travels INSIDE the payload: every consumer receives the observation
// and renders it, so a stale read can never be presented as current and no
// consumer re-derives the verdict from an age and a threshold of its own.

import { isLivePid as defaultIsLivePid } from "./kill-tree.js";
import { readPidStartTime } from "../core/state.js";
import {
  discoverLiveSupervisorPid,
  isSupervisorIdentityLive,
  readSupervisorIdentity,
  type SupervisorPidDiscovery,
} from "./supervisor-state.js";

// The reaper is a MUTATOR, not a reader: it is re-exported here so a migrated
// reader never has to reach into `supervisor-state.js` for it and re-open the
// private-source door the ratchet closes.
export { reapStaleSupervisorState } from "./supervisor-state.js";
// The forced-teardown identity (#2714) is the one reader allowed to accept a pid
// without its process-start proof. It travels through the anchor too, so
// `project_stop` keeps ONE liveness import and the ratchet stays closed.
export { readRecordedLiveSupervisorPid } from "./supervisor-state.js";
export type { SupervisorStateReapResult, SupervisorPidDiscovery } from "./supervisor-state.js";

/** Which anchor named the supervisor. `none` when no anchor named a live one. */
export type LivenessAnchorSource = SupervisorPidDiscovery["source"] | "none";

/** Why a heartbeat is or is not presentable as current. */
export type HeartbeatStalenessReason =
  /** Observed within the window, by a supervisor proven live. */
  | "fresh"
  /** Observed by a live supervisor, but older than the staleness window. */
  | "aged-out"
  /** No heartbeat has ever been observed on this lane. */
  | "never-observed"
  /** A heartbeat with no live writer to vouch for it — stale at any age. */
  | "orphaned";

/**
 * The staleness that travels inside every payload. `age_s` is -1 when no
 * heartbeat was ever observed; `stale` is the verdict a renderer must honour,
 * never a threshold the renderer re-derives for itself.
 */
export type HeartbeatObservation = {
  age_s: number;
  stale: boolean;
  stale_after_s: number;
  reason: HeartbeatStalenessReason;
};

/**
 * The resolved supervisor. A discriminated union, so the incoherent report is
 * rejected by the compiler: the dead branch pins `stale: true`, which means a
 * fresh heartbeat literally cannot be typed alongside `alive: false`.
 */
export type SupervisorLiveness =
  | {
      alive: true;
      pid: number;
      anchor: SupervisorPidDiscovery["source"];
      anchor_path: string;
      heartbeat: HeartbeatObservation;
    }
  | {
      alive: false;
      pid: 0;
      anchor: "none";
      anchor_path: null;
      heartbeat: HeartbeatObservation & { stale: true; reason: Exclude<HeartbeatStalenessReason, "fresh"> };
    };

export interface ResolveSupervisorLivenessInput {
  /** The anchor's verdict on which pid owns this lane, or null when none does. */
  discovered: SupervisorPidDiscovery | null;
  /** Epoch seconds of the last heartbeat tick, or null when never observed. */
  heartbeatEpoch: number | null;
  nowS: number;
  staleAfterS: number;
}

/**
 * Resolve liveness AND freshness in one step. Every field of the returned
 * verdict is derived from the same input, which is what makes the contradiction
 * impossible: there is no second place for a disagreeing answer to come from.
 */
export function resolveSupervisorLiveness(
  input: ResolveSupervisorLivenessInput,
): SupervisorLiveness {
  const ageS =
    input.heartbeatEpoch === null ? -1 : Math.max(0, input.nowS - input.heartbeatEpoch);

  if (input.discovered === null) {
    // No live writer — the heartbeat, however recent, vouches for nobody.
    return {
      alive: false,
      pid: 0,
      anchor: "none",
      anchor_path: null,
      heartbeat: {
        age_s: ageS,
        stale: true,
        stale_after_s: input.staleAfterS,
        reason: input.heartbeatEpoch === null ? "never-observed" : "orphaned",
      },
    };
  }

  const stale = ageS < 0 || ageS > input.staleAfterS;
  return {
    alive: true,
    pid: input.discovered.pid,
    anchor: input.discovered.source,
    anchor_path: input.discovered.path,
    heartbeat: {
      age_s: ageS,
      stale,
      stale_after_s: input.staleAfterS,
      reason: ageS < 0 ? "never-observed" : stale ? "aged-out" : "fresh",
    },
  };
}

export interface ReadSupervisorLivenessOptions {
  /** The heartbeat tick the caller already read, when it has one. */
  heartbeatEpoch?: number | null;
  /** Seconds past which a heartbeat stops being presentable as current. */
  staleAfterS?: number;
  nowS?: number;
  isLivePid?: (pid: number) => boolean;
  pidStartTime?: (pid: number) => string | null;
}

/** Fallback staleness window, used when the caller supplies no supervisor config. */
export const DEFAULT_HEARTBEAT_STALE_AFTER_S = 300;

/**
 * The one call every migrated reader makes. It performs the anchor read and
 * returns the verdict; a reader that needs slots, churn or runner reads the
 * snapshot for THOSE, never for a second opinion on liveness.
 */
export async function readSupervisorLiveness(
  supervisorRuntimeDir: string,
  options: ReadSupervisorLivenessOptions = {},
): Promise<SupervisorLiveness> {
  const nowS = options.nowS ?? Math.floor(Date.now() / 1_000);
  const discovered = await discoverLiveSupervisorPid(
    supervisorRuntimeDir,
    options.isLivePid ?? defaultIsLivePid,
    {
      ...(options.pidStartTime !== undefined ? { pidStartTime: options.pidStartTime } : {}),
      nowS,
    },
  );
  return resolveSupervisorLiveness({
    discovered,
    heartbeatEpoch: options.heartbeatEpoch ?? null,
    nowS,
    staleAfterS: options.staleAfterS ?? DEFAULT_HEARTBEAT_STALE_AFTER_S,
  });
}

/**
 * The supervisor watchdog's own process identity, resolved through the same seam
 * so `project_stop` keeps one import for every liveness question it asks.
 */
export async function readWatchdogLiveness(
  pidPath: string,
  pidStartPath: string,
  isLivePid: (pid: number) => boolean = defaultIsLivePid,
  pidStartTime: (pid: number) => string | null = readPidStartTime,
): Promise<{ alive: boolean; pid: number } | null> {
  const identity = await readSupervisorIdentity(pidPath, pidStartPath);
  if (identity === null) return null;
  return {
    alive: isSupervisorIdentityLive(identity, isLivePid, pidStartTime),
    pid: identity.pid,
  };
}

/**
 * The anchor's verdict in the shape every payload publishes it. One projection
 * for every consumer, so `fleet_status`, `monitor` and the CLI report cannot
 * drift into three spellings of the same fact.
 */
export function publishSupervisorLiveness(liveness: SupervisorLiveness): {
  pid: number;
  alive: boolean;
  identity_anchor: LivenessAnchorSource;
  heartbeat: HeartbeatObservation;
} {
  return {
    pid: liveness.pid,
    alive: liveness.alive,
    identity_anchor: liveness.anchor,
    heartbeat: liveness.heartbeat,
  };
}

// ---------------------------------------------------------------------------
// a Worker's process liveness — resolved through the daemon, never a pid file
// ---------------------------------------------------------------------------

/**
 * The verdict on one Worker's PROCESS.
 *
 * Three values, not two, and the third is the load-bearing one: `unknown` is
 * what an unreachable or stale daemon yields, and it is NOT `dead`. Collapsing
 * the two would let a reader that could not reach the authority report a running
 * Worker as gone — which is how a janitor came to delete a live lane (#2679).
 */
export type WorkerLivenessKind = "alive" | "dead" | "unknown";

/**
 * How current the daemon's answer is, as the daemon itself measured it.
 *
 * Every field is carried, none is derived here: the daemon samples on its own
 * tick, so a consumer that dated the answer itself would need the sample
 * interval, the daemon's clock and its own read latency — and would get it
 * subtly wrong in a different way per surface.
 */
export interface DaemonStaleness {
  stale: boolean;
  /** Age of the daemon's last sample in ms, or null when it never sampled. */
  age_ms: number | null;
  /** The window the daemon judges its own answer against, in ms. */
  threshold_ms: number | null;
  /** The daemon's own sentence about this answer's currency. */
  reason: string;
}

/**
 * One Worker's process liveness, as a discriminated union.
 *
 * `dead` pins `stale: false`, so "this Worker is gone" cannot be typed beside a
 * stale read — the compiler rejects the payload the criterion forbids rather
 * than a test catching it after the fact.
 */
export type WorkerLiveness =
  | {
      verdict: "alive";
      anchor: "daemon";
      worker_id: string;
      pid: number;
      project_label: string;
      staleness: DaemonStaleness & { stale: false };
    }
  | {
      verdict: "dead";
      anchor: "daemon";
      worker_id: string;
      pid: null;
      project_label: null;
      staleness: DaemonStaleness & { stale: false };
    }
  | {
      verdict: "unknown";
      anchor: "none";
      worker_id: string;
      pid: null;
      project_label: null;
      staleness: DaemonStaleness & { stale: true };
    };

/**
 * The daemon's host-wide answer, narrowed to what liveness needs.
 *
 * Structural on purpose: the anchor consumes the daemon's published payload
 * without owning its shape, so widening the daemon's contract never drags a
 * change through this module.
 */
export interface DaemonWorkerSet {
  readonly staleness: {
    readonly stale: boolean;
    readonly age_ms: number | null;
    readonly threshold_ms: number;
    readonly reason: string;
  };
  readonly workers: readonly {
    readonly worker_id: string;
    readonly project_label: string;
    readonly pid: number;
  }[];
}

/**
 * What an absent daemon read reports: unknown, and honest about why.
 *
 * Exported because it is the ONE sentence in a published payload that means
 * "the socket boundary is broken": every other `unknown` was reached WITH the
 * daemon's participation. The MCP lane canary reads it to tell a reachable tool
 * over an unreachable daemon from a daemon that simply never birthed the Worker.
 */
export const DAEMON_SILENCE_REASON =
  "the daemon did not answer, so nothing here can vouch for this Worker's process";

/**
 * True when this verdict was reached WITHOUT the daemon answering. PURE.
 *
 * A predicate rather than a bare comparison at the call site, so the sentinel
 * has one reader and a rewording of the sentence cannot leave a surface
 * silently believing every unreachable daemon is a reachable one.
 */
export function isDaemonSilence(reason: string): boolean {
  return reason === DAEMON_SILENCE_REASON;
}

/**
 * Why a fresh answer that does not name the Worker still is not a death.
 *
 * Exported because since the ADR 0130 cutover (#2851) this sentence names a
 * DEFECT rather than a tolerated gap: every Worker is born by the daemon, so a
 * Worker the caller can see running and the host cannot vouch for was spawned
 * behind the host's back — an unbudgeted birth no admission verdict judged. It
 * is still not a death, which is why the verdict stays `unknown`; what changed
 * is that a lane probe reading this reason has found something wrong.
 */
export const DAEMON_UNCOVERED_REASON =
  "the daemon holds no record of this Worker while the caller still sees it running, " +
  "so its silence is ignorance about a Worker it never birthed, not evidence of death";

/**
 * True when the daemon answered, and does not hold a Worker something still
 * sees running. PURE — one reader for the sentinel, exactly as
 * {@link isDaemonSilence}.
 */
export function isDaemonUncovered(reason: string): boolean {
  return reason === DAEMON_UNCOVERED_REASON;
}

const UNCOVERED_REASON = DAEMON_UNCOVERED_REASON;

function unknownLiveness(workerId: string, reason: string): WorkerLiveness {
  return {
    verdict: "unknown",
    anchor: "none",
    worker_id: workerId,
    pid: null,
    project_label: null,
    staleness: { stale: true, age_ms: null, threshold_ms: null, reason },
  };
}

/**
 * What the caller can already see about this Worker, and the ONLY thing it is
 * allowed to contribute.
 *
 * The asymmetry is the whole point: evidence of life may WITHHOLD a death claim,
 * and may never manufacture an `alive` one. So the daemon stays the single source
 * of every positive verdict — a caller cannot promote its own observation into
 * one — while a payload can still never say "gone" about a Worker something else
 * can see running. That contradiction, published in one document, is the bug
 * class behind #2698.
 */
export interface WorkerLivenessEvidence {
  /**
   * True when the caller holds FRESH evidence this Worker's process is alive.
   *
   * It is load-bearing until every birth goes through the daemon: a Worker the
   * project launched itself was never in the daemon's set, so the daemon's
   * silence about it says nothing at all.
   */
  readonly evidenceOfLife?: boolean;
}

/**
 * Resolve one Worker's process liveness from ONE daemon read. PURE.
 *
 * A stale answer is `unknown`, never `dead`: the Worker set the daemon last
 * measured is history, and a Worker missing from history has not been shown to
 * have died. The staleness the daemon stated is carried through untouched.
 */
export function resolveWorkerLiveness(
  hostAnswer: DaemonWorkerSet | null,
  workerId: string,
  evidence: WorkerLivenessEvidence = {},
): WorkerLiveness {
  if (hostAnswer === null) return unknownLiveness(workerId, DAEMON_SILENCE_REASON);
  if (hostAnswer.staleness.stale) return unknownLiveness(workerId, hostAnswer.staleness.reason);

  const fresh = {
    stale: false as const,
    age_ms: hostAnswer.staleness.age_ms,
    threshold_ms: hostAnswer.staleness.threshold_ms,
    reason: hostAnswer.staleness.reason,
  };
  const worker = hostAnswer.workers.find((candidate) => candidate.worker_id === workerId);
  if (worker === undefined) {
    if (evidence.evidenceOfLife === true) return unknownLiveness(workerId, UNCOVERED_REASON);
    return {
      verdict: "dead",
      anchor: "daemon",
      worker_id: workerId,
      pid: null,
      project_label: null,
      staleness: fresh,
    };
  }
  return {
    verdict: "alive",
    anchor: "daemon",
    worker_id: workerId,
    pid: worker.pid,
    project_label: worker.project_label,
    staleness: fresh,
  };
}

/** How the anchor reaches the daemon. Injected, so every consumer is testable
 * and so the READ never starts a daemon: a liveness question must not change
 * the machine it is asking about. */
export type DaemonWorkerSetReader = () => Promise<DaemonWorkerSet | null>;

/**
 * Read the daemon's Worker set for this session, or null when it does not answer.
 *
 * Deliberately NOT the auto-spawning client call: spawning a daemon to ask
 * whether a Worker is alive would make a read a mutation, and a host with no
 * daemon would answer "alive" about the very process it just started.
 */
export const readDaemonWorkerSet: DaemonWorkerSetReader = async () => {
  try {
    const [{ resolveRedskilledPaths }, { sendRedskilledRequest, isRedskilledStatuslinePayload }] =
      await Promise.all([
        import("@reddb-io/redskilled/paths"),
        import("@reddb-io/redskilled/protocol"),
      ]);
    const paths = resolveRedskilledPaths();
    const response = await sendRedskilledRequest(
      { socketPath: paths.socketPath, timeoutMs: 2_000 },
      { id: `liveness-${process.pid}-${process.hrtime.bigint()}`, op: "statusline-payload" },
    );
    if (!response.ok) return null;
    return isRedskilledStatuslinePayload(response.value) ? response.value : null;
  } catch {
    // No daemon, no socket, or a malformed answer: `unknown`, never a guess.
    return null;
  }
};

/** The one call a reader makes to ask whether a Worker's process is alive. */
export async function readWorkerLiveness(
  workerId: string,
  read: DaemonWorkerSetReader = readDaemonWorkerSet,
  evidence: WorkerLivenessEvidence = {},
): Promise<WorkerLiveness> {
  let hostAnswer: DaemonWorkerSet | null;
  try {
    hostAnswer = await read();
  } catch {
    hostAnswer = null;
  }
  return resolveWorkerLiveness(hostAnswer, workerId, evidence);
}

/**
 * The Worker verdict in the shape every payload publishes it (the castle
 * `daemon_liveness` block). One projection for every consumer, so two surfaces
 * cannot drift into two spellings of the same fact.
 */
export function publishWorkerLiveness(liveness: WorkerLiveness): {
  verdict: WorkerLivenessKind;
  anchor: "daemon" | "none";
  project_label: string | null;
  pid: number | null;
  staleness: DaemonStaleness;
} {
  return {
    verdict: liveness.verdict,
    anchor: liveness.anchor,
    project_label: liveness.project_label,
    pid: liveness.pid,
    staleness: liveness.staleness,
  };
}
