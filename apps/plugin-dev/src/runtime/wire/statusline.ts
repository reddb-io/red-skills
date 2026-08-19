import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CompactWorker } from "../../core/monitor.js";
import type {
  AfkInput,
  FleetInput,
  ValidationGateInput,
} from "../../core/statusline.js";
import {
  readRedskilledHostConfig,
  resolveRedskilledHostSettings,
} from "@reddb-io/redskilled/host-config";
import type { WorkerVitals } from "../../types/state.js";
import { readSupervisorLiveness } from "../liveness-anchor.js";
import { isLivePid } from "../kill-tree.js";
import {
  castleLanePath,
  castleStateSnapshotPath,
  createEnginePaths,
  readCastleLaneRecords,
  readCastleStateSnapshot,
  type CastleLaneRecord,
  type CastleStateSnapshot,
  type EnginePaths,
} from "@reddb-io/worker/engine";
import {
  readAllWorkerStates,
  currentObservableWorkerRecords,
  currentRenderableWorkerRecords,
} from "../../core/worker-state-reader.js";
import { allWorkersRoots } from "../../core/worker-paths.js";
import { afkPaths, type RepoContext } from "./paths.js";
import { readFleetState } from "./monitor.js";

/**
 * Aggregate the live /afk workers under the workers root into the statusline's
 * block-4 input: count live workers, sum blocked + the writer-stamped diffstat,
 * and collect the in-progress issue numbers in directory order. Returns null when
 * there are no live workers, so the caller drops the whole AFK block.
 *
 * **Local worker state only.** The `rdy=` / `hmn=` queue counts used to be
 * fetched here by `gh` under a 15-minute cache; they are the daemon's now (ADR
 * 0141 decision 2), served dated on the statusline payload, and this collector
 * reaches no network at all — the counts it does not hold are absent rather than
 * zero.
 */
export async function collectStatuslineAfk(ctx: RepoContext): Promise<AfkInput | null> {
  const paths = afkPaths(ctx.root);
  // Same single owner as the monitor (core/worker-state-reader).
  const nowMs = Date.now();
  // Namespace-blind union across the fleet, `/go`, and `--scout` lanes so the
  // statusline counts a live `/go`/`--scout` worker (rendered per-origin via
  // state.origin), not only the `.red/tmp/workers` fleet lane.
  const records = currentRenderableWorkerRecords(await readAllWorkerStates(paths.tmpDir, { nowMs }));

  let workers = 0;
  let blocked = 0;
  let added = 0;
  let removed = 0;
  let locIsPeak = false;
  let waiting = 0;
  let tokens = 0;
  let costUsd = 0;
  // `runner`/`model`/`effort` come from the first live worker (fleets are
  // single-runner in practice). `resolved` is maxed across workers since they
  // all mirror the same supervisor's done count.
  let runner = "";
  let model = "";
  let effort = "";
  let resolved = 0;
  const issues: Array<number | string> = [];
  const phases: Array<string | undefined> = [];
  const aliveMsList: number[] = [];
  const sourceMap = new Map<string, number>();

  for (const { state } of records) {
    // Shared with the monitor/per-worker statusline collectors: renderable rows
    // are already gated and collapsed to one current attempt per worker.
    workers += 1;
    blocked += state.blocked;
    if (runner === "" && state.runner) runner = state.runner;
    if (model === "" && state.current.model) model = state.current.model;
    if (effort === "" && state.current.effort) effort = state.current.effort;
    if (state.done > resolved) resolved = state.done;
    // Per-source count: read origin from the single state field (issue #930).
    if (state.origin) sourceMap.set(state.origin, (sourceMap.get(state.origin) ?? 0) + 1);
    // Alive time: elapsed ms since this worker's top-level started_at, or 0
    // when the timestamp is absent (pre-schema state files).
    const startedAt = state.started_at || state.current.started_at;
    const workerAliveMs = startedAt ? Math.max(0, nowMs - Date.parse(startedAt)) : 0;
    // Read the worker's signals through the canonical WorkerVitals contract
    // (ADR 0065) rather than ad-hoc field access — `current` satisfies it.
    const vitals: WorkerVitals = state.current;
    // Silent-agent signal: cumulative heartbeat windows with no new stream
    // event. Summed across the fleet and shown as wtN so a wedged-but-not-dead
    // worker is visible.
    waiting += vitals.waiting_count;
    // Cost group: per-worker token spend + USD, summed for the fleet.
    tokens += vitals.input_tokens + vitals.output_tokens;
    costUsd += vitals.cost_usd;

    let a = vitals.loc_added;
    let r = vitals.loc_removed;
    // #1210 Part B: the render NEVER shells out to git. LOC ownership moved to
    // the writers (the per-attempt heartbeat stamps loc_added/loc_removed for
    // ALL runners via the commit-anchored memo), so the old `git diff
    // --shortstat` render fallback is gone. When the writer's live value is 0/0
    // the sticky per-attempt peak below keeps `loc=` visible without git.
    // Sticky fallback: if the live diff is still 0 but a prior non-zero value
    // was seen this attempt, use the peak so `loc=` stays visible with a `~`
    // prefix instead of disappearing (which looks alarming even when intact).
    if (a === 0 && r === 0) {
      const pa = state.current.loc_peak_added ?? 0;
      const pr = state.current.loc_peak_removed ?? 0;
      if (pa > 0 || pr > 0) {
        a = pa;
        r = pr;
        locIsPeak = true;
      }
    }
    added += a;
    removed += r;

    const number = state.current.number;
    if (number !== "" && number !== undefined && number !== null) {
      issues.push(number);
      // Aligned by index with `issues`: phase + alive time suffix each `#N` token.
      phases.push(state.current.phase || undefined);
      aliveMsList.push(workerAliveMs);
    }
  }

  if (workers <= 0) return null;

  // Build the per-source count array sorted by origin for a deterministic order.
  // Both statusline and monitor read from state.origin via readAllWorkerStates —
  // this is the one derived form; nothing else derives source counts independently.
  const sourceCounts =
    sourceMap.size > 0
      ? [...sourceMap.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([origin, count]) => ({ origin, count }))
      : undefined;

  return {
    workers, blocked, added, removed,
    locIsPeak: locIsPeak || undefined,
    waiting, tokens, costUsd,
    runner, resolved, issues, phases,
    aliveMs: aliveMsList.length > 0 ? aliveMsList : undefined,
    model: model || undefined,
    effort: effort || undefined,
    sourceCounts,
  };
}

const STATUSLINE_FLEET_MAX_AGE_S = 120;

/** Read the host-wide Validation semaphore without acquiring or modifying it. */
export async function collectStatuslineValidationGate(
  root: string,
  declaredCapacity?: number,
): Promise<ValidationGateInput> {
  const total = declaredCapacity ?? (
    resolveRedskilledHostSettings({ config: await readRedskilledHostConfig() })
      .ceiling.validation_count ?? 1
  );
  const capacity = Number.isSafeInteger(total) && total > 0 ? total : 1;
  const base = join(root, ".red", "state", "validation-gate.lock");
  let occupied = 0;
  for (let index = 0; index < capacity; index += 1) {
    const path = index === 0
      ? base
      : `${base.slice(0, -".lock".length)}.${index + 1}.lock`;
    if (existsSync(path)) occupied += 1;
  }
  return { occupied, total: capacity };
}

/**
 * Repo-summary fleet segment input. It is intentionally independent of live
 * worker rows: the supervisor can be landing, validating, merging, or idle
 * between worker loops while zero worker records are renderable.
 */
export async function collectStatuslineFleet(
  ctx: RepoContext,
  maxAgeS: number = STATUSLINE_FLEET_MAX_AGE_S,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<FleetInput | undefined> {
  const paths = afkPaths(ctx.root);
  // The crashloop breaker (#2527) used to be read here and rendered whatever the
  // liveness gates said, because an OPEN breaker meant the project's own
  // supervisor was deliberately dead. ADR 0148 deleted that supervisor, so
  // nothing in this checkout opens or writes that ledger any more: the daemon
  // owns the birth breaker (`project-birth-breaker`) and reports it over ACP.
  const state = await readFleetState(paths.fleetStatePath);
  if (!state) return undefined;
  // ONE anchor decides identity, liveness AND freshness (ADR 0128 §5), and the
  // verdict travels into the render so a stale read is drawn as stale, never as
  // current (ADR 0128 §6).
  const supervisor = await readSupervisorLiveness(paths.supervisorRuntimeDir, {
    heartbeatEpoch: state.epoch,
    staleAfterS: maxAgeS,
    nowS,
  });
  if (!supervisor.alive || supervisor.heartbeat.stale) {
    // The lane still HAS a snapshot; what it lacks is a live writer. The chip
    // carries that verdict so a consumer reads "fleet, but stale" instead of
    // "no fleet" — and the compact line, which cannot qualify a number without
    // it still reading as live occupancy, renders nothing (renderFleetBlock).
    return {
      runner: state.runner,
      busy: state.slotsBusy,
      total: state.slotsTotal,
      queue: state.readyForAgent,
      parked: state.slotsParked,
      stale: true,
      staleAgeS: supervisor.heartbeat.age_s,
      bundleVersion: state.bundleVersion,
    };
  }
  const workers = currentRenderableWorkerRecords(
    await readAllWorkerStates(paths.tmpDir, { nowMs: nowS * 1000 }),
  );
  const freshWorkers = workers.filter((worker) => worker.active).length;

  return {
    runner: state.runner,
    busy: state.slotsBusy,
    total: state.slotsTotal,
    queue: state.readyForAgent,
    parked: state.slotsParked,
    degraded: state.slotsBusy > 0 && freshWorkers === 0,
    churnDeaths: state.churnDeaths,
    churnRespawns: state.churnRespawns,
    churnWindowS: state.churnWindowS,
    bundleVersion: state.bundleVersion,
  };
}

/**
 * Per-worker records for the themed Claude Code statusline's multi-line layout
 * (issue #1165): one {@link CompactWorker} per LIVE worker, each rendered on its
 * own line by the SAME `renderWorkerCompactLine` formatter `/afk monitor --once`
 * uses (single source of truth — the two never drift). Mirrors the liveness
 * filter of {@link collectStatuslineAfk} (only "stalled" workers are dropped) and
 * its diff-fallback (a live `git diff --shortstat` when the state file's counts
 * are both 0). Sorted by worker start for a deterministic line order. Returns []
 * when no live workers, so the styled render emits the header line alone.
 *
 * The aggregate counts (queue/human + their gh cache) stay in
 * collectStatuslineAfk — this collector is per-worker only; the command runs both
 * (each a cheap handful of file reads) and feeds the aggregate to the plain form
 * and the per-worker records to the themed form.
 */
export async function collectStatuslineWorkers(ctx: RepoContext): Promise<CompactWorker[]> {
  const paths = afkPaths(ctx.root);
  const nowMs = Date.now();
  const records = currentObservableWorkerRecords(await readAllWorkerStates(paths.tmpDir, { nowMs }));
  const workers: CompactWorker[] = [];
  const enginePaths = createEnginePaths(join(ctx.root, ".red"));
  for (const { state, active, pidIdentityLive: pidLive, liveness, livenessVerdict } of records) {
    // The shared current-worker selector applies the `renderableLive` gate and
    // collapses retained sibling attempt dirs to one row per worker.
    // #1210 Part B: no per-render git subprocess — read the writer-stamped LOC
    // straight from the state file (the heartbeat owns it for every runner).
    const added = state.current.loc_added;
    const removed = state.current.loc_removed;
    const observability = await readWorkerObservability(enginePaths, state.worker_id);
    workers.push({
      state: {
        worker_id: state.worker_id,
        pid: state.pid,
        runner: state.runner,
        started_at: state.started_at,
        origin: state.origin || undefined,
        fleet: observability.snapshot?.supervisor_id || observability.fleet,
        total: state.total,
        done: state.done,
        blocked: state.blocked,
        failed: state.failed,
        current: {
          number: state.current.number,
          title: state.current.title,
          activity: state.current.activity,
          phase: state.current.phase,
          started_at: state.current.started_at,
          model: state.current.model,
          effort: state.current.effort,
          input_tokens: state.current.input_tokens,
          output_tokens: state.current.output_tokens,
          cost_usd: state.current.cost_usd,
          tools_called_count: state.current.tools_called_count,
          text_chunk_count: state.current.text_chunk_count,
          reasoning_events: state.current.reasoning_events,
          waiting_count: state.current.waiting_count,
          wait_kind: state.current.wait_kind,
          wait_subject: state.current.wait_subject,
          wait_pid: state.current.wait_pid,
          wait_started_at: state.current.wait_started_at,
        },
      },
      liveness,
      livenessVerdict,
      live: active,
      pidLive,
      diffAdded: added,
      diffRemoved: removed,
    });
  }
  const represented = new Set(workers.map((worker) => worker.state.worker_id));
  for (const workersRoot of allWorkersRoots(paths.tmpDir)) {
    for (const entry of workerDirectories(workersRoot)) {
      if (represented.has(entry.name)) continue;
      const worker = await bootWorkerFromDirectory(
        join(workersRoot, entry.name),
        entry.name,
        enginePaths,
        nowMs,
      );
      if (!worker) continue;
      workers.push(worker);
      represented.add(entry.name);
    }
  }
  // Deterministic order: oldest worker first (by top-level start, then per-attempt).
  workers.sort((a, b) => {
    const ka = a.state.started_at || a.state.current.started_at || "";
    const kb = b.state.started_at || b.state.current.started_at || "";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return workers;
}

function workerDirectories(workersRoot: string): Array<{ name: string }> {
  try {
    return readdirSync(workersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name }));
  } catch {
    return [];
  }
}

function stringField(
  record: Record<string, unknown> | undefined,
  ...fields: string[]
): string | undefined {
  if (!record) return undefined;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

interface WorkerObservability {
  snapshot?: CastleStateSnapshot;
  latest?: CastleLaneRecord;
  heartbeatAt?: string;
  fleet?: string;
}

async function readWorkerObservability(
  paths: EnginePaths,
  workerId: string,
): Promise<WorkerObservability> {
  const [snapshot, lane, liveness] = await Promise.all([
    readCastleStateSnapshot(castleStateSnapshotPath(paths, "worker", workerId)).catch(() => undefined),
    readCastleLaneRecords(castleLanePath(paths, "worker", workerId)).catch(() => []),
    readCastleLaneRecords(castleLanePath(paths, "liveness", workerId)).catch(() => []),
  ]);
  const latest = lane.at(-1);
  return {
    snapshot,
    latest,
    heartbeatAt: liveness.at(-1)?.at,
    fleet:
      latest?.supervisor_id ||
      stringField(latest?.payload, "supervisor_id", "fleet"),
  };
}

function liveWorkerPid(workerDir: string): { pid: number; startedAt: string } | null {
  const path = join(workerDir, "worker.pid");
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || !isLivePid(pid)) return null;
    return { pid, startedAt: statSync(path).mtime.toISOString() };
  } catch {
    return null;
  }
}

function workspaceIssue(workerDir: string): number | undefined {
  try {
    return readdirSync(workerDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
      .map((entry) => ({
        issue: Number(entry.name),
        mtimeMs: statSync(join(workerDir, entry.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.issue - a.issue)[0]?.issue;
  } catch {
    return undefined;
  }
}

function issueField(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

async function bootWorkerFromDirectory(
  workerDir: string,
  workerId: string,
  paths: EnginePaths,
  nowMs: number,
): Promise<CompactWorker | null> {
  const anchor = liveWorkerPid(workerDir);
  if (!anchor) return null;
  const { snapshot, latest, heartbeatAt, fleet } = await readWorkerObservability(paths, workerId);
  const current = snapshot?.current;
  const payload = latest?.payload;
  const issue =
    workspaceIssue(workerDir) ??
    issueField(current?.number ?? current?.issue) ??
    latest?.issue ??
    "";
  const heartbeat = heartbeatAt || latest?.at || snapshot?.updated_at || anchor.startedAt;
  const laneAgeMs = Math.max(0, nowMs - Date.parse(heartbeat));
  const laneFresh = laneAgeMs <= 180_000;
  const namespace = basename(dirname(workerDir));
  const origin =
    stringField(payload, "origin", "kind") ||
    stringField(current, "origin", "kind") ||
    (namespace === "go-workers" ? "go" : namespace === "scout-workers" ? "scout" : undefined);

  return {
    state: {
      worker_id: workerId,
      pid: anchor.pid,
      runner:
        snapshot?.runner ||
        stringField(payload, "runner") ||
        stringField(current, "runner") ||
        "",
      started_at: snapshot?.started_at || anchor.startedAt,
      origin,
      fleet: snapshot?.supervisor_id || fleet,
      total: issue === "" ? 0 : 1,
      done: 0,
      blocked: 0,
      failed: 0,
      current: {
        number: issue,
        title: stringField(current, "title", "slug") || "",
        phase: stringField(payload, "phase") || stringField(current, "phase") || "boot",
        activity:
          stringField(payload, "activity", "stage", "probe", "task") ||
          stringField(current, "activity") ||
          (latest?.kind === "worker.heartbeat"
            ? ""
            : latest?.kind.replace(/^worker\./, "") || ""),
        started_at: heartbeat,
        model: stringField(payload, "model") || stringField(current, "model"),
        effort: stringField(payload, "effort") || stringField(current, "effort"),
      },
    },
    liveness: laneFresh ? "active" : "quiet-but-live",
    live: laneFresh,
    pidLive: true,
    diffAdded: 0,
    diffRemoved: 0,
  };
}
