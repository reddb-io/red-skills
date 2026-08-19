import { dirname, join } from "node:path";
import { readPublishedBundleVersion } from "../../core/published-version.js";
import { decodeDevSnapshotSniff } from "../../core/toon-snapshot.js";
import type { CompactWorker, FleetState, SlotDetail } from "../../core/monitor.js";
import {
  readAllWorkerStates,
  currentRenderableWorkerRecords,
  } from "../../core/worker-state-reader.js";
import { readHistoryRecords, type HistoryRecord } from "../../core/history.js";
import {
  createEnginePaths,
  readCastleMonitorFleetState,
  readCastleMonitorHistoryEvents,
  readCastleMonitorWorkers,
} from "@reddb-io/worker/engine";
import * as fsx from "../fs.js";
import { collectLogLineCounts } from "../log-cursor.js";
import { afkPaths } from "./paths.js";

export interface MonitorInputs {
  workers: CompactWorker[];
  events: Array<Pick<HistoryRecord, "event" | "epoch">>;
  fleet: FleetState | null;
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

/**
 * Read-time liveness-gated teardown (issue #1219): as workers finish/crash,
 * enforce the CLOSED-immediate / OPEN-two-stage policy from the pure planner. Runs
 * across the SAME namespace union the reader uses (workers/go-workers/
 * scout-workers) since it consumes {@link readAllWorkerStates} records.
 *
 * Safety rules (see {@link planLivenessReclaim}):
 *   - NEVER touch a dir whose OWNING Worker the daemon has not called dead — the
 *     verdict is per-Worker (shared across its attempts), so a Worker live on a
 *     later attempt keeps ALL its dirs.
 *   - CLOSED issue dirs go immediately; OPEN issue dirs strip at 14 days and go
 *     at 45 days; UNKNOWN issue state is retained.
 *
 * Best-effort throughout: every fs/git/gh failure is swallowed so the sweep never
 * breaks the read it rides on. Returns the reclaimed attempt-dir paths.
 */

/** Read castle monitor lanes into the pure renderer's inputs. During the
 * migration window, fall back to legacy worker/history files only when the
 * castle lanes are absent so current fleets keep rendering with parity. */
export async function collectMonitorInputs(root = process.cwd(), repo = ""): Promise<MonitorInputs> {
  const paths = afkPaths(root);
  const castlePaths = createEnginePaths(join(root, ".red"));
  let workers = await readCastleMonitorWorkers(castlePaths);
  if (workers.length === 0) {
    const records = await readAllWorkerStates(paths.tmpDir);
    // #4032 removed the read-time teardown that used to run here: the monitor
    // RENDERS, and a renderer that deletes is how a stale read became a
    // deletion. Workers live in daemon-placed storage now (ADR 0149), so the
    // daemon reaps what it births and this path only reads.
    const currentRecords = currentRenderableWorkerRecords(records);
    const logPaths = currentRecords.map(({ path, state }) =>
      state.log || join(dirname(dirname(path)), "worker.log.toonl")
    );
    const logCounts = await collectLogLineCounts(paths.monitorLogCursorPath, logPaths);
    workers = currentRecords.map(({ path, state, active, live: pidLive, liveness, livenessVerdict }) => {
      // The shared current-worker selector applies the `renderableLive` gate and
      // collapses retained sibling attempt dirs to one row per worker.
      const logPath = state.log || join(dirname(dirname(path)), "worker.log.toonl");
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

  // The remote queue counts are NOT here. They used to be read out of the
  // statusline's local `gh` count cache; that cache is gone (ADR 0141 decision 2)
  // and the counts are the daemon's, so the monitor states the facts it owns and
  // leaves the ones it does not to the surface that reads the payload.
  return { workers, events, fleet };
}
