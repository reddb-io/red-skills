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
import { workerStatePath } from "./state.js";
import { readWorkerStateDocument } from "./worker-state-reader.js";
import type { AfkState } from "../types/state.js";

export type WorkerLifecycleKind =
  | "worker.claimed"
  | "worker.steered"
  | "worker.validated"
  | "worker.landed"
  | "worker.blocked"
  | "worker.heartbeat"
  | (string & {});

export interface CastleWorkerLaneBridge {
  record(kind: WorkerLifecycleKind, payload?: Record<string, unknown>): Promise<void>;
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
  publishHostLogLine?: (line: string) => Promise<void>;
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

  async function snapshot(): Promise<void> {
    const state = readAttemptState(options.attemptDir());
    if (!state) return;
    await writeCastleStateSnapshot(
      castleStateSnapshotPath(paths, "worker", options.workerId),
      snapshotFromState(options.workerId, state, nowIso(), options.supervisorLane),
    );
  }

  async function record(
    kind: WorkerLifecycleKind,
    payload: Record<string, unknown> = {},
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
    await options.publishHostLogLine?.(workerLogLine(kind, issue, payload));
    await snapshot();
  }

  return { record, snapshot };
}
