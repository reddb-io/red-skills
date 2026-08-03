import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readPublishedBundleVersion } from "../../core/published-version.js";
import { decodeDevSnapshotSniff } from "../../core/toon-snapshot.js";
import type { CompactWorker, FleetState, SlotDetail } from "../../core/monitor.js";
import {
  readAllWorkerStates,
  currentRenderableWorkerRecords,
  type WorkerStateRecord,
} from "../../core/worker-state-reader.js";
import { planLivenessReclaim, type LivenessReclaimInput } from "../../core/reclaim.js";
import type { WorkerProcessVerdict } from "../../core/worker-reclaim.js";
import { readWorkerLivenessForTmpPath } from "../tmp-janitor.js";
import { readHistoryRecords, type HistoryRecord } from "../../core/history.js";
import { LABEL_HUMAN } from "../../core/triage-labels.js";
import {
  createEnginePaths,
  readCastleMonitorFleetState,
  readCastleMonitorHistoryEvents,
  readCastleMonitorWorkers,
} from "@reddb-io/red-castle/engine";
import * as ghx from "../gh.js";
import * as gitx from "../git.js";
import * as fsx from "../fs.js";
import { collectLogLineCounts } from "../log-cursor.js";
import { reapableWorktreeUnder } from "../supervisor-fs.js";
import { afkPaths } from "./paths.js";
import { readStatuslineCache } from "./statusline-cache.js";

export interface MonitorInputs {
  workers: CompactWorker[];
  events: Array<Pick<HistoryRecord, "event" | "epoch">>;
  fleet: FleetState | null;
  /** GitHub queue/human counts read passively from the statusline TTL cache.
   * Absent when the cache file has never been written (no statusline run yet). */
  remoteQueue?: number;
  remoteHuman?: number;
  remoteQuarantine?: number;
  /** Age of the statusline cache in seconds. Undefined when no cache file exists.
   * The monitor render shows a stale marker when this exceeds the resolved
   * statusline cache TTL ({@link resolveStatuslineCacheTtl}). */
  remoteCacheAgeS?: number;
}

const SLOT_STATUSES = new Set<SlotDetail["status"]>(["open", "half-open", "idle-parked"]);

function parseFleetState(raw: unknown): FleetState | null {
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as {
    ts?: unknown;
    epoch?: unknown;
    last_progress_epoch?: unknown;
    target?: unknown;
    runner?: unknown;
    shrink_mode?: unknown;
    bundle_version?: unknown;
    ready_for_agent?: unknown;
    slots?: {
      busy?: unknown;
      free?: unknown;
      total?: unknown;
      parked?: unknown;
      interactive_reservation?: unknown;
    };
    spawns_this_tick?: unknown;
    churn?: { deaths?: unknown; respawns?: unknown; window_s?: unknown };
    trunk_freshness?: {
      status?: unknown;
      refreshed_at_epoch?: unknown;
      interval_s?: unknown;
      next_due_epoch?: unknown;
      remote_ref?: unknown;
      mirror_ref?: unknown;
      sha?: unknown;
      message?: unknown;
    };
    slot_details?: unknown;
    slot_pids?: unknown;
  };
  const epoch = Number(rec.epoch ?? 0);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const rawProgress = Number(rec.last_progress_epoch ?? 0);
  const target = Number(rec.target ?? 0);
  const shrinkMode =
    rec.shrink_mode === "hard-kill" || rec.shrink_mode === "drain-then-retire"
      ? rec.shrink_mode
      : undefined;

  let slotDetails: SlotDetail[] | undefined;
  if (Array.isArray(rec.slot_details)) {
    slotDetails = [];
    for (const d of rec.slot_details as unknown[]) {
      if (d === null || typeof d !== "object") continue;
      const entry = d as { index?: unknown; status?: unknown; retry_at?: unknown };
      const idx = Number(entry.index ?? -1);
      if (!Number.isFinite(idx) || idx < 0) continue;
      const status = entry.status;
      if (typeof status !== "string" || !SLOT_STATUSES.has(status as SlotDetail["status"])) continue;
      const rawRetry = entry.retry_at !== undefined ? Number(entry.retry_at) : undefined;
      const retryAt = rawRetry !== undefined && Number.isFinite(rawRetry) ? rawRetry : undefined;
      slotDetails.push({ index: idx, status: status as SlotDetail["status"], ...(retryAt !== undefined ? { retryAt } : {}) });
    }
  }

  let slotPids: FleetState["slotPids"] | undefined;
  if (Array.isArray(rec.slot_pids)) {
    slotPids = [];
    const seen = new Set<number>();
    for (const p of rec.slot_pids as unknown[]) {
      if (p === null || typeof p !== "object") continue;
      const entry = p as { slot?: unknown; pid?: unknown };
      const slot = Number(entry.slot);
      const pid = Number(entry.pid);
      if (!Number.isSafeInteger(slot) || slot < 0 || seen.has(slot)) continue;
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      seen.add(slot);
      slotPids.push({ slot, pid });
    }
  }

  let trunkFreshness: FleetState["trunkFreshness"] | undefined;
  if (rec.trunk_freshness !== undefined && rec.trunk_freshness !== null) {
    const raw = rec.trunk_freshness;
    const status = raw.status;
    const refreshedAtEpoch = Number(raw.refreshed_at_epoch ?? 0);
    const intervalS = Number(raw.interval_s ?? 0);
    if (
      (status === "refreshed" || status === "failed" || status === "throttled") &&
      Number.isFinite(refreshedAtEpoch) &&
      refreshedAtEpoch > 0 &&
      Number.isFinite(intervalS) &&
      intervalS > 0
    ) {
      const nextDueEpoch = Number(raw.next_due_epoch);
      trunkFreshness = {
        status,
        refreshedAtEpoch,
        intervalS,
        ...(Number.isFinite(nextDueEpoch) && nextDueEpoch > 0 ? { nextDueEpoch } : {}),
        ...(typeof raw.remote_ref === "string" ? { remoteRef: raw.remote_ref } : {}),
        ...(typeof raw.mirror_ref === "string" ? { mirrorRef: raw.mirror_ref } : {}),
        ...(typeof raw.sha === "string" ? { sha: raw.sha } : {}),
        ...(typeof raw.message === "string" ? { message: raw.message } : {}),
      };
    }
  }

  return {
    ts: typeof rec.ts === "string" ? rec.ts : "",
    epoch,
    lastProgressEpoch: Number.isFinite(rawProgress) && rawProgress > 0 ? rawProgress : undefined,
    runner: typeof rec.runner === "string" ? rec.runner : "",
    target: Number.isFinite(target) && target >= 0 ? target : undefined,
    ...(shrinkMode !== undefined ? { shrinkMode } : {}),
    bundleVersion: typeof rec.bundle_version === "string" ? rec.bundle_version : undefined,
    readyForAgent: Number(rec.ready_for_agent ?? 0) || 0,
    slotsBusy: Number(rec.slots?.busy ?? 0) || 0,
    slotsFree: Number(rec.slots?.free ?? 0) || 0,
    slotsTotal: Number(rec.slots?.total ?? 0) || 0,
    slotsParked: Number(rec.slots?.parked ?? 0) || 0,
    ...(Number.isFinite(Number(rec.slots?.interactive_reservation))
      ? { interactiveReservation: Math.max(0, Number(rec.slots?.interactive_reservation)) }
      : {}),
    spawnsThisTick: Number(rec.spawns_this_tick ?? 0) || 0,
    churnDeaths: Number(rec.churn?.deaths ?? 0) || 0,
    churnRespawns: Number(rec.churn?.respawns ?? 0) || 0,
    churnWindowS: Number(rec.churn?.window_s ?? 0) || 0,
    ...(trunkFreshness !== undefined ? { trunkFreshness } : {}),
    ...(slotDetails !== undefined ? { slotDetails } : {}),
    ...(slotPids !== undefined ? { slotPids } : {}),
  };
}

export async function readFleetState(path: string): Promise<FleetState | null> {
  const text = await fsx.readText(path);
  if (text === null) return null;
  try {
    return parseFleetState(decodeDevSnapshotSniff(text));
  } catch {
    return null;
  }
}

/** Injected seams for {@link reclaimDeadWorkers} (real defaults wire gh/git/fs). */
export interface DeadWorkerSweepDeps {
  /** The DAEMON's verdict on the Worker owning a dir (Spec #2772 US 46). Default
   * asks the daemon through the single liveness anchor; there is deliberately no
   * pid-file seam here, because keying reclaim on a pid file is what deleted a
   * live lane and kept the dead ones (#2679). */
  workerLiveness?: (workerDir: string) => Promise<WorkerProcessVerdict>;
  /** Whether an issue is in a post-mortem preservation state (blocked:* /
   * ready-for-human). Default `gh issue view --json labels`. Returns `true`
   * (conservative — keep the JSONL) whenever it cannot resolve. */
  isPreserved?: (issue: number) => Promise<boolean>;
  /** `git worktree remove --force`. Default runtime git against `root`. */
  removeWorktree?: (worktreePath: string) => Promise<void>;
  /** `rm -rf`. Default `fsx.removeDir`. */
  removeDir?: (dir: string) => Promise<void>;
  /** Path existence probe. Default `existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * Read-time liveness-gated teardown (issue #1219): as workers finish/crash, take
 * them out of context — remove the heavy local `worktree/` and reclaim the
 * attempt dir immediately, without waiting for the boot TTLs (reclaim.ts). Runs
 * across the SAME namespace union the reader uses (workers/go-workers/
 * scout-workers) since it consumes {@link readAllWorkerStates} records.
 *
 * Safety rules (see {@link planLivenessReclaim}):
 *   - NEVER touch a dir whose OWNING Worker the daemon has not called dead — the
 *     verdict is per-Worker (shared across its attempts), so a Worker live on a
 *     later attempt keeps ALL its dirs.
 *   - A dead worker's disposable `worktree/` is ALWAYS removed.
 *   - The whole attempt dir is reclaimed UNLESS the issue is preserved
 *     (blocked:* / ready-for-human), where the JSONL/handoff stay for post-mortem.
 *
 * Best-effort throughout: every fs/git/gh failure is swallowed so the sweep never
 * breaks the read it rides on. Returns the reclaimed attempt-dir paths.
 */
export async function reclaimDeadWorkers(
  root: string,
  records: ReadonlyArray<WorkerStateRecord>,
  repo = "",
  deps: DeadWorkerSweepDeps = {},
): Promise<string[]> {
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const workerLiveness =
    deps.workerLiveness ??
    ((workerDir: string): Promise<WorkerProcessVerdict> =>
      readWorkerLivenessForTmpPath(afkPaths(root).tmpDir, workerDir));
  const isPreserved =
    deps.isPreserved ??
    (async (issue: number): Promise<boolean> => {
      try {
        const labels = await ghx.viewLabels({ cwd: root, repo }, issue);
        // Empty labels (gh failed) → conservative: keep the JSONL.
        if (labels.length === 0) return true;
        return labels.some((l) => l === LABEL_HUMAN || l.startsWith("blocked:"));
      } catch {
        return true;
      }
    });
  const removeWorktree =
    deps.removeWorktree ??
    (async (worktreePath: string): Promise<void> => {
      await gitx.worktreeRemove({ cwd: root }, worktreePath);
    });
  const removeDir = deps.removeDir ?? ((dir: string) => fsx.removeDir(dir));

  // The daemon's verdict per Worker, memoized so a Worker's several attempt dirs
  // ask once. An unreachable daemon answers `unknown`, which spares the dir.
  const verdictCache = new Map<string, WorkerProcessVerdict>();
  const workerVerdict = async (workerDir: string): Promise<WorkerProcessVerdict> => {
    const cached = verdictCache.get(workerDir);
    if (cached !== undefined) return cached;
    const verdict = await workerLiveness(workerDir).catch((): WorkerProcessVerdict => "unknown");
    verdictCache.set(workerDir, verdict);
    return verdict;
  };

  // Build the pure planner inputs, resolving preservation only for dead workers.
  const inputs: LivenessReclaimInput[] = [];
  for (const rec of records) {
    const attemptDir = dirname(rec.path);
    const workerDir = dirname(attemptDir);
    // A renderable-live record is EVIDENCE the Worker still runs: it withholds
    // the death claim, and never asserts a life the daemon did not.
    const liveness = rec.renderableLive ? "unknown" : await workerVerdict(workerDir);
    const num = rec.state.current.number;
    const issue = typeof num === "number" ? num : Number.parseInt(String(num), 10);
    const preserved =
      Number.isFinite(issue) && issue > 0 ? await isPreserved(issue) : true;
    inputs.push({
      attemptDir,
      // Current workers use the conventional direct child. During rollout,
      // hygiene may still discover a legacy nested worktree for removal only.
      worktreePath: reapableWorktreeUnder(attemptDir) ?? join(attemptDir, "worktree"),
      liveness,
      preserved,
    });
  }

  const reclaimed: string[] = [];
  for (const action of planLivenessReclaim(inputs)) {
    if (action.removeWorktree && exists(action.worktreePath)) {
      await removeWorktree(action.worktreePath).catch(() => undefined);
    }
    if (action.reclaimDir) {
      await removeDir(action.attemptDir).catch(() => undefined);
      reclaimed.push(action.attemptDir);
    }
  }
  return reclaimed;
}

/** Read castle monitor lanes into the pure renderer's inputs. During the
 * migration window, fall back to legacy worker/history files only when the
 * castle lanes are absent so current fleets keep rendering with parity. */
export async function collectMonitorInputs(root = process.cwd(), repo = ""): Promise<MonitorInputs> {
  const paths = afkPaths(root);
  const castlePaths = createEnginePaths(join(root, ".red"));
  let workers = await readCastleMonitorWorkers(castlePaths);
  if (workers.length === 0) {
    const records = await readAllWorkerStates(paths.tmpDir);
    // Read-time liveness-gated teardown (issue #1219): reclaim dead-worker
    // worktrees/dirs immediately, not on the boot TTL. Best-effort — a failure
    // here never blocks the render. Live-worker dirs and blocked/ready-for-human
    // post-mortem artifacts are preserved (planLivenessReclaim).
    await reclaimDeadWorkers(root, records, repo).catch(() => undefined);
    await fsx.reapDeadEmptyWorkerShells(paths.tmpDir).catch(() => undefined);
    const currentRecords = currentRenderableWorkerRecords(records);
    const logPaths = currentRecords.map(({ path, state }) => state.log || join(dirname(path), "afk.log"));
    const logCounts = await collectLogLineCounts(paths.monitorLogCursorPath, logPaths);
    workers = currentRecords.map(({ path, state, active, live: pidLive, liveness, livenessVerdict }) => {
      // The shared current-worker selector applies the `renderableLive` gate and
      // collapses retained sibling attempt dirs to one row per worker.
      const logPath = state.log || join(dirname(path), "afk.log");
      const counts = logCounts.get(logPath);
      return {
        state: {
          worker_id: state.worker_id,
          pid: state.pid,
          runner: state.runner,
          started_at: state.started_at,
          origin: state.origin || undefined,
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
        diffAdded: state.current.loc_added,
        diffRemoved: state.current.loc_removed,
        ...(counts !== undefined ? { logLines: counts.lines, logNewLines: counts.newLines } : {}),
      };
    });
  }

  const castleEvents = await readCastleMonitorHistoryEvents(castlePaths);
  const events = castleEvents.length > 0
    ? castleEvents
    : (await readHistoryRecords(paths.historyPath, { read: fsx.readText })).map((r) => ({ event: r.event, epoch: r.epoch }));
  const fleet =
    (await readCastleMonitorFleetState(castlePaths)) ??
    (await readFleetState(paths.fleetStatePath));
  if (fleet?.bundleVersion) {
    // Same owner as the boot probe and the status surfaces (#2809) — the render
    // never derives its own notion of what is published.
    fleet.latestBundleVersion = readPublishedBundleVersion().version ?? undefined;
  }

  // Remote facts: read the statusline TTL cache passively (no refresh — the monitor
  // is read-only; the statusline owns the cache lifecycle). Include queue/human counts
  // and the cache age so the render can show a stale marker when the data is old.
  const cached = readStatuslineCache(paths.statuslineCachePath);
  const nowS = Math.floor(Date.now() / 1000);
  const remoteExtra = cached !== null
    ? {
        remoteQueue: cached.queue,
        remoteHuman: cached.human,
        remoteQuarantine: cached.quarantine ?? 0,
        remoteCacheAgeS: nowS - cached.ts,
      }
    : {};

  return { workers, events, fleet, ...remoteExtra };
}
