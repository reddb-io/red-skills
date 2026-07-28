// liveness-anchor.ts — THE single liveness anchor (ADR 0128 §5, issue #2704).
//
// One anchor, one read, one verdict. `fleet_status`, `fleet_stop`, `monitor`,
// `worker_vitals` and the statusline all resolve supervisor identity, liveness
// and attempt history through this module and hold NO private source of their
// own. Two anchors is the bug class behind #2679 and #2698 — a writer that
// maintains one and a reader that trusts another produced `alive: false` in the
// same payload as a 13-second-old heartbeat and two busy slots.
//
// Two invariants make that payload unrepresentable rather than merely unlikely:
//
//  1. LIVENESS AND FRESHNESS COME FROM ONE RESOLUTION. The heartbeat observation
//     is computed by the same function that decides `alive`, from the same read,
//     so the two can never disagree.
//  2. AN UNATTRIBUTABLE HEARTBEAT IS STALE, WHATEVER ITS AGE. When no anchor
//     names a live supervisor, the heartbeat has no live writer to vouch for it,
//     so it is `orphaned` — stale by construction. `alive: false` therefore
//     implies `stale: true` at the TYPE level, and a fresh heartbeat can only
//     ever appear beside `alive: true`.
//
// Staleness travels INSIDE the payload (ADR 0128 §6): every consumer receives
// the observation, so a stale read can never be presented as current.

import { join } from "node:path";
import {
  createEnginePaths,
  readCastleAttemptRecords,
  type CastleAttemptRecord,
} from "@reddb-io/red-castle/engine";
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
  /** Named fleet, carried through to discovery for call-site compatibility. */
  fleet?: string;
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
      ...(options.fleet !== undefined ? { fleet: options.fleet } : {}),
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
 * The fleet watchdog's own process identity, resolved through the same seam so
 * `fleet_stop` keeps one import for every liveness question it asks.
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

// ---------------------------------------------------------------------------
// attempt history — the record's derived views (ADR 0128 §1)
// ---------------------------------------------------------------------------

/**
 * A ticket's history and a worker's history are FILTERS over the folded attempt
 * record, never separately maintained state. Readers ask this view; none of them
 * reconstructs history from worker directories, tracker comments or git refs.
 */
export interface AttemptHistoryView {
  /** Every attempt on the lane, in first-seen order. */
  records: readonly CastleAttemptRecord[];
  forWorker(workerId: string): CastleAttemptRecord[];
  forIssue(issue: number): CastleAttemptRecord[];
  /** The worker's most recent attempt — the one a live reader is looking at. */
  latestForWorker(workerId: string): CastleAttemptRecord | undefined;
}

function historyView(records: readonly CastleAttemptRecord[]): AttemptHistoryView {
  return {
    records,
    forWorker: (workerId) => records.filter((record) => record.worker_id === workerId),
    forIssue: (issue) => records.filter((record) => record.issue === issue),
    latestForWorker(workerId) {
      let latest: CastleAttemptRecord | undefined;
      for (const record of records) {
        if (record.worker_id !== workerId) continue;
        if (latest === undefined || record.try >= latest.try) latest = record;
      }
      return latest;
    },
  };
}

/**
 * Read the attempt record for a repo root. An unreadable or absent lane yields
 * an EMPTY history rather than an error: the record is diagnostic, and a reader
 * must never fail because the narrative is missing (ADR 0128, consequences).
 */
export async function readAttemptHistory(root: string): Promise<AttemptHistoryView> {
  const paths = createEnginePaths(join(root, ".red"));
  try {
    return historyView(await readCastleAttemptRecords(paths.castleAttempts));
  } catch {
    return historyView([]);
  }
}

/** The attempt facts a reader publishes alongside a live worker. */
export interface AttemptSummary {
  id: string;
  try: number;
  issue: number;
  branch: string | null;
  pr: number | null;
  commits: number;
  outcome: string | null;
  closed: boolean;
  updated_at: string;
}

export function summarizeAttempt(record: CastleAttemptRecord): AttemptSummary {
  return {
    id: record.attempt_id,
    try: record.try,
    issue: record.issue,
    branch: record.branch ?? null,
    pr: record.pr ?? null,
    commits: record.commits.length,
    outcome: record.outcome?.kind ?? null,
    closed: record.closed,
    updated_at: record.updated_at,
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
