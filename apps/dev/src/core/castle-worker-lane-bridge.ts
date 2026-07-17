import { readFileSync } from "node:fs";
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
import { parseStateDocument } from "./state.js";
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
}

function currentIssue(state: AfkState): number | undefined {
  const raw = state.current.number;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  return undefined;
}

function currentAttempt(attemptDir: string): number | undefined {
  const match = /-a([1-9][0-9]*)$/.exec(attemptDir);
  return match ? Number(match[1]) : undefined;
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
  };
}

function readAttemptState(attemptDir: string): AfkState | null {
  if (!attemptDir) return null;
  try {
    return parseStateDocument(readFileSync(join(attemptDir, "afk.state.json"), "utf8"));
  } catch {
    return null;
  }
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
      snapshotFromState(options.workerId, state, nowIso()),
    );
  }

  async function record(
    kind: WorkerLifecycleKind,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const attemptDir = options.attemptDir();
    const state = readAttemptState(attemptDir);
    const issue = state ? currentIssue(state) : undefined;
    const attempt = currentAttempt(attemptDir);
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
    await snapshot();
  }

  return { record, snapshot };
}
