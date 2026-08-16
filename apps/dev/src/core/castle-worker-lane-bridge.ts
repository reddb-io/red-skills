import { join } from "node:path";
import {
  createCastleLaneWriters,
  createEnginePaths,
  castleStateSnapshotPath,
  writeCastleStateSnapshot,
  type CastleLaneKind,
  type CastleStateSnapshot,
} from "@reddb-io/red-castle/engine";
import { LivenessLane, LIVENESS_LANE_FILENAME } from "@reddb-io/red-castle";
import type { RedskilledWorkerDisplay } from "@reddb-io/redskilled/worker-display";
import type { RedskilledMechanicalHealStamp } from "@reddb-io/redskilled/protocol";
import { workerStatePath } from "./state.js";
import { readWorkerStateDocument } from "./worker-state-reader.js";
import { AFK_COSTED_PHASE_ORDER, macroPhase } from "./mirror.js";
import { createPhaseDurationTracker, phaseDurationsPath, type PhaseDurationTracker } from "./phase-durations.js";
import { workerDisplayFromState } from "./worker-display-record.js";
import type { AfkState } from "../types/state.js";
import type { ValidationMoments } from "./config.js";
import { type ValidationGateContext, validationMomentLogPayload } from "./validation-moments.js";

export type WorkerLifecycleKind =
  | "worker.claimed"
  | "worker.steered"
  | "worker.validated"
  | "worker.landed"
  | "worker.blocked"
  | "worker.heartbeat"
  | (string & {});

export interface CastleWorkerLaneBridge {
  record(kind: WorkerLifecycleKind, payload?: Record<string, unknown>, message?: string): Promise<void>;
  /** Append human-readable narration to the Worker's one structured log. */
  log(message: string): Promise<void>;
  snapshot(): Promise<void>;
}

export interface CastleWorkerLaneBridgeOptions {
  redRoot: string;
  workerId: string;
  attemptDir: () => string;
  nowIso?: () => string;
  nowMs?: () => number;
  /** Supervisor lane this worker belongs to. When set, stamped as `supervisor_id`
   * in every castle state snapshot so `fleet_status` can partition workers by
   * fleet without relying solely on the supervisor's slot-pid map. */
  supervisorLane?: string;
  /**
   * Where this worker's last line goes on the host, when it was born on one (#3079).
   *
   * Injected rather than reached for, because this module knows the castle lanes
   * and nothing about a daemon: what it owns is the beat, and the publisher is
   * one more thing that happens on it. Absent — a directly-invoked `run`, a test
   * — the bridge behaves exactly as it did before.
   */
  publishHostLogLine?: (
    line: string,
    display?: RedskilledWorkerDisplay,
    mechanicalHeal?: RedskilledMechanicalHealStamp,
  ) => Promise<void>;
  /**
   * The per-phase duration model this Worker measures into and estimates from.
   *
   * Defaulted to the durable castle lane beside the ledger; injectable so a test
   * can hold the whole model in a temp directory. Measuring lives HERE because
   * this is the one place that sees `current.phase` on every beat: the phase is
   * stamped by five different writers (`boot`, the stream sink's `coding`, the
   * gate, each landing step, the exit patch), and instrumenting each of them
   * would be five chances to add a sixth that nobody measures.
   */
  phaseDurations?: PhaseDurationTracker;
}

function currentIssue(state: AfkState): number | undefined {
  const raw = state.current.number;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  return undefined;
}

function compactCurrent(state: AfkState): Record<string, unknown> {
  return {
    ...state.current,
    origin: state.origin || state.current.kind,
  };
}

function snapshotFromState(
  workerId: string,
  state: AfkState,
  updatedAt: string,
  supervisorLane?: string,
): CastleStateSnapshot {
  return {
    kind: "worker",
    id: workerId,
    version: 1,
    updated_at: updatedAt,
    worker_id: state.worker_id || workerId,
    runner: state.runner || undefined,
    pid: state.pid,
    started_at: state.started_at || state.current.started_at || updatedAt,
    current: compactCurrent(state),
    envelope: state.envelope,
    ...(supervisorLane ? { supervisor_id: supervisorLane } : {}),
  };
}

/**
 * One lane record as one line a human reads. PURE.
 *
 * Flat and short on purpose: this is what a statusline prints under a Worker and
 * what a plugin shows beside it, so a nested payload rendered as an object would
 * be a line nobody can read at that width. Scalars only — a payload value that is
 * itself a structure is named and not unfolded.
 */
export function workerLogLine(
  kind: WorkerLifecycleKind,
  issue: number | undefined,
  payload: Record<string, unknown>,
): string {
  const facts = Object.entries(payload)
    .filter(([, value]) => value != null && (typeof value !== "object" || Array.isArray(value)))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`);
  return [kind, ...(issue == null ? [] : [`#${issue}`]), ...facts].join(" ");
}

function readAttemptState(attemptDir: string): AfkState | null {
  if (!attemptDir) return null;
  return readWorkerStateDocument(workerStatePath(attemptDir));
}

export function createCastleWorkerLaneBridge(
  options: CastleWorkerLaneBridgeOptions,
): CastleWorkerLaneBridge {
  const paths = createEnginePaths(options.redRoot);
  const writers = createCastleLaneWriters(paths, { clock: options.nowIso });
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const nowMs = options.nowMs ?? (() => Date.now());
  const phaseDurations = options.phaseDurations
    ?? createPhaseDurationTracker({
      path: phaseDurationsPath(options.redRoot),
      order: AFK_COSTED_PHASE_ORDER,
    });

  /**
   * Watch the phase, and measure the one that just ended.
   *
   * The MACRO phase, so the four landing steps accumulate into one `merging`
   * span: a model that held a median for `push-pr` would be describing a step
   * whose whole cost is a network round-trip, and would have no median at all for
   * the phase the bar actually draws.
   *
   * Best-effort to the last line — a duration nobody could write is a worse
   * estimate later, never a failed beat now.
   */
  async function measurePhase(state: AfkState): Promise<void> {
    try {
      await phaseDurations.observe({
        phase: macroPhase(state.current.phase ?? ""),
        identity: {
          worker: state.worker_id || options.workerId,
          issue: currentIssue(state) ?? 0,
          runner: state.runner || state.current.runner || "",
        },
        nowEpoch: Math.floor(nowMs() / 1000),
        nowIso: nowIso(),
      });
    } catch {
      /* the model is evidence; losing evidence must never cost the work */
    }
  }

  async function snapshot(): Promise<void> {
    const state = readAttemptState(options.attemptDir());
    if (!state) return;
    await measurePhase(state);
    await writeCastleStateSnapshot(
      castleStateSnapshotPath(paths, "worker", options.workerId),
      snapshotFromState(options.workerId, state, nowIso(), options.supervisorLane),
    );
  }

  async function record(
    kind: WorkerLifecycleKind,
    payload: Record<string, unknown> = {},
    message?: string,
  ): Promise<void> {
    const attemptDir = options.attemptDir();
    const state = readAttemptState(attemptDir);
    const issue = state ? currentIssue(state) : undefined;
    // The attempt ordinal is retired (ADR 0103); a worker runs one attempt.
    const attempt = 1;
    await writers.worker(options.workerId).append({
      kind: kind as CastleLaneKind,
      worker_id: options.workerId,
      issue,
      attempt,
      ...(message == null ? {} : { msg: message }),
      payload,
    });
    await writers.liveness(options.workerId).append({
      kind: "worker.heartbeat",
      worker_id: options.workerId,
      issue,
      attempt,
      payload: { signal: kind },
    });
    if (attemptDir) {
      await new LivenessLane({
        path: join(attemptDir, LIVENESS_LANE_FILENAME),
        clock: nowMs,
      }).record("iteration-start");
    }
    // The same record, said once more to the host — the beat this bridge already
    // keeps is the cadence the heartbeat asked for, so nothing new is scheduled
    // and nothing is polled. What the host receives is the line just written,
    // rendered flat: it stores the string without reading it.
    //
    // The display record rides the same beat and for the same reason. It is built
    // HERE and not by the daemon because every field in it is a castle fact — what
    // a phase is, which of five, how long the work has left — and ADR 0130 rule 3
    // keeps those out of the host lane entirely.
    if (options.publishHostLogLine != null) {
      if (state != null) await measurePhase(state);
      const display = state == null
        ? undefined
        : workerDisplayFromState(state, {
          etaSeconds: phaseDurations.etaSeconds(Math.floor(nowMs() / 1000)),
          nowMs: nowMs(),
          phaseStartedAt: phaseDurations.phaseStartedAt(),
        });
      const mechanicalHeal: RedskilledMechanicalHealStamp | undefined =
        kind === "worker.mechanical_regeneration_cure"
          ? {
              heal_kind: "mechanical-regeneration",
              cause: typeof payload.cause === "string" ? payload.cause : "stale-base-drift",
              cycle: typeof payload.cycle === "number" ? payload.cycle : 0,
              cap: typeof payload.cap === "number" ? payload.cap : 0,
              free: payload.free === true,
            }
          : undefined;
      await options.publishHostLogLine(workerLogLine(kind, issue, payload), display, mechanicalHeal);
    }
    await snapshot();
  }

  async function log(message: string): Promise<void> {
    const state = readAttemptState(options.attemptDir());
    await writers.worker(options.workerId).append({
      kind: "worker.log",
      worker_id: options.workerId,
      issue: state ? currentIssue(state) : undefined,
      attempt: 1,
      msg: message,
    });
  }

  return { record, log, snapshot };
}

/**
 * Construct the Worker's lane bridge and make the schedule its first record.
 *
 * This is the boot seam rather than a later lifecycle callback so even a
 * Worker that fails before claiming a Ticket leaves the schedule it intended
 * to obey as the opening structured log fixture.
 */
export async function createBootCastleWorkerLaneBridge(
  options: CastleWorkerLaneBridgeOptions,
  schedule: ValidationMoments,
  gate: ValidationGateContext = {},
): Promise<CastleWorkerLaneBridge> {
  const bridge = createCastleWorkerLaneBridge(options);
  await bridge.record("worker.validation_schedule", validationMomentLogPayload(schedule, gate));
  return bridge;
}
