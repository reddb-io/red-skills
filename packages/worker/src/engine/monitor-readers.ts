import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateLiveness,
  type LivenessVerdict,
} from "../LivenessEvaluator.js";
import type {
  CastleStateSnapshot,
} from "./contracts/index.js";
import {
  castleLanePath,
  castleStateSnapshotPath,
  readCastleHistoryRecords,
  readCastleLaneRecords,
  readCastleStateSnapshot,
} from "./lane-writers.js";
import type { EnginePaths } from "./paths.js";
import type {
  CompactCurrent,
  CompactState,
  CompactWorker,
  FleetState,
  HistoryRecord,
} from "./monitor.js";

export const CASTLE_MONITOR_LIVENESS_IDLE_MS = 180_000;

export interface CastleMonitorReadOptions {
  readonly nowMs?: number;
  readonly kill?: (pid: number, signal: 0) => boolean;
}

async function childDirNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(
  rec: Record<string, unknown>,
  field: string,
  fallback = "",
): string {
  const value = rec[field];
  return typeof value === "string" ? value : fallback;
}

function numberField(
  rec: Record<string, unknown>,
  field: string,
  fallback = 0,
): number {
  const value = rec[field];
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function currentIssue(
  snapshot: CastleStateSnapshot,
  current: Record<string, unknown>,
): number | string {
  const explicit = current.number ?? current.issue;
  if (typeof explicit === "number" || typeof explicit === "string") {
    return explicit;
  }
  return snapshot.queue?.[0] ?? "";
}

function currentFromSnapshot(
  snapshot: CastleStateSnapshot,
): CompactCurrent {
  const current = asRecord(snapshot.current);
  return {
    number: currentIssue(snapshot, current),
    title: stringField(current, "title", stringField(current, "slug")),
    activity: stringField(current, "activity"),
    phase: stringField(current, "phase"),
    slug: stringField(current, "slug") || undefined,
    started_at: stringField(
      current,
      "started_at",
      snapshot.started_at ?? snapshot.updated_at,
    ),
    model: stringField(current, "model") || undefined,
    model_tier: stringField(current, "model_tier") || undefined,
    effort: stringField(current, "effort") || undefined,
    input_tokens: numberField(current, "input_tokens"),
    output_tokens: numberField(current, "output_tokens"),
    cost_usd: numberField(current, "cost_usd"),
    tools_called_count: numberField(current, "tools_called_count"),
    text_chunk_count: numberField(current, "text_chunk_count"),
    reasoning_events: numberField(current, "reasoning_events"),
    waiting_count: numberField(current, "waiting_count"),
  };
}

function compactStateFromSnapshot(
  snapshot: CastleStateSnapshot,
): CompactState {
  const current = asRecord(snapshot.current);
  const completed = snapshot.completed ?? [];
  const queued = snapshot.queue ?? [];
  const done = numberField(current, "done", completed.length);
  const total = numberField(current, "total", done + queued.length);
  return {
    worker_id: snapshot.worker_id ?? snapshot.id,
    pid: snapshot.pid ?? 0,
    runner: snapshot.runner ?? "",
    started_at: snapshot.started_at ?? snapshot.updated_at,
    origin: stringField(current, "origin", stringField(current, "kind")) || undefined,
    fleet: snapshot.supervisor_id || undefined,
    total,
    done,
    blocked: numberField(current, "blocked"),
    failed: numberField(current, "failed"),
    current: currentFromSnapshot(snapshot),
  };
}

async function newestLivenessAtMs(
  paths: EnginePaths,
  workerId: string,
): Promise<number | undefined> {
  const records = await readCastleLaneRecords(
    castleLanePath(paths, "liveness", workerId),
  );
  let newest: number | undefined;
  for (const record of records) {
    const at = Date.parse(record.at);
    if (Number.isFinite(at) && (newest === undefined || at > newest)) {
      newest = at;
    }
  }
  return newest;
}

function pidLive(
  pid: number | undefined,
  kill: (pid: number, signal: 0) => boolean,
): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    return kill(pid, 0);
  } catch {
    return false;
  }
}

function defaultKill(pid: number, signal: 0): boolean {
  process.kill(pid, signal);
  return true;
}

function verdictToLiveness(
  verdict: LivenessVerdict,
): "active" | "quiet-but-live" | "dead" {
  if (verdict.status === "stalled") return "dead";
  if (verdict.status === "alive" && verdict.laneFresh) return "active";
  return "quiet-but-live";
}

async function workerFromSnapshot(
  paths: EnginePaths,
  snapshot: CastleStateSnapshot,
  options: Required<CastleMonitorReadOptions>,
): Promise<CompactWorker | null> {
  if (snapshot.kind !== "worker") return null;
  const state = compactStateFromSnapshot(snapshot);
  const laneRecencyMs = await newestLivenessAtMs(paths, state.worker_id);
  const livePid = pidLive(snapshot.pid, options.kill);
  const livenessVerdict = evaluateLiveness({
    laneRecencyMs,
    now: options.nowMs,
    laneIdleMs: CASTLE_MONITOR_LIVENESS_IDLE_MS,
    crossCheckArmed: false,
  });
  const liveness = verdictToLiveness(livenessVerdict);
  if (liveness === "dead" && !livePid) return null;
  const current = asRecord(snapshot.current);
  return {
    state,
    liveness,
    livenessVerdict,
    live: liveness === "active",
    pidLive: livePid,
    diffAdded: numberField(current, "loc_added", numberField(current, "diff_added")),
    diffRemoved: numberField(current, "loc_removed", numberField(current, "diff_removed")),
  };
}

export async function readCastleMonitorWorkers(
  paths: EnginePaths,
  options: CastleMonitorReadOptions = {},
): Promise<CompactWorker[]> {
  const resolved = {
    nowMs: options.nowMs ?? Date.now(),
    kill: options.kill ?? defaultKill,
  };
  const ids = await childDirNames(join(paths.castleStateRoot, "workers"));
  const workers: CompactWorker[] = [];
  for (const id of ids) {
    const snapshot = await readCastleStateSnapshot(
      castleStateSnapshotPath(paths, "worker", id),
    );
    if (!snapshot) continue;
    const worker = await workerFromSnapshot(paths, snapshot, resolved);
    if (worker) workers.push(worker);
  }
  return workers;
}

export async function readCastleMonitorHistoryEvents(
  paths: EnginePaths,
): Promise<Array<Pick<HistoryRecord, "event" | "epoch">>> {
  return (await readCastleHistoryRecords(paths.castleHistory)).map((record) => ({
    event: record.event,
    epoch: record.epoch,
  }));
}

function fleetFromSupervisorSnapshot(
  snapshot: CastleStateSnapshot,
): FleetState | null {
  if (snapshot.kind !== "supervisor") return null;
  const current = asRecord(snapshot.current);
  const slots = asRecord(current.slots);
  const churn = asRecord(current.churn);
  const epoch = numberField(
    current,
    "epoch",
    Math.floor(Date.parse(snapshot.updated_at) / 1000),
  );
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return {
    ts: snapshot.updated_at,
    epoch,
    lastProgressEpoch: numberField(current, "last_progress_epoch") || undefined,
    runner: snapshot.runner ?? stringField(current, "runner"),
    bundleVersion: snapshot.bundle_version ?? stringField(current, "bundle_version"),
    readyForAgent: numberField(
      current,
      "ready_for_agent",
      snapshot.queue?.length ?? 0,
    ),
    slotsBusy: numberField(slots, "busy"),
    slotsFree: numberField(slots, "free"),
    slotsTotal: numberField(slots, "total"),
    slotsParked: numberField(slots, "parked"),
    spawnsThisTick: numberField(current, "spawns_this_tick"),
    churnDeaths: numberField(churn, "deaths"),
    churnRespawns: numberField(churn, "respawns"),
    churnWindowS: numberField(churn, "window_s"),
  };
}

export async function readCastleMonitorFleetState(
  paths: EnginePaths,
): Promise<FleetState | null> {
  const ids = await childDirNames(join(paths.castleStateRoot, "supervisors"));
  const snapshots: CastleStateSnapshot[] = [];
  for (const id of ids) {
    const snapshot = await readCastleStateSnapshot(
      castleStateSnapshotPath(paths, "supervisor", id),
    );
    if (snapshot) snapshots.push(snapshot);
  }
  snapshots.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  for (const snapshot of snapshots) {
    const fleet = fleetFromSupervisorSnapshot(snapshot);
    if (fleet) return fleet;
  }
  return null;
}
