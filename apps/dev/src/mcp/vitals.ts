// Lane logs and worker vitals — what a liveness surface reads.
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  castleLanePath,
  createEnginePaths,
  readCastleLaneRecords,
} from "@reddb-io/red-castle/engine";
import type { LivenessStatus } from "@reddb-io/red-castle";
import type {
  LogsInput,
  WorkerVitalsOutput,
} from "@reddb-io/red-castle/mcp-server";
import { detectWedgedOrchestrator } from "../core/wedged-orchestrator.js";
import {
  publishWorkerLiveness,
  readDaemonWorkerSet,
  resolveWorkerLiveness,
  type DaemonWorkerSet,
} from "../runtime/liveness-anchor.js";
import {
  afkPaths,
} from "../runtime/wire.js";
import { readAllWorkerStates } from "../core/worker-state-reader.js";


const LOGS_DEFAULT_LIMIT = 200;

export async function laneLogs(root: string, input: LogsInput) {
  const paths = createEnginePaths(join(root, ".red"));
  const laneRoot =
    input.lane === "supervisor"
      ? paths.supervisorsRoot
      : input.lane === "monitor"
        ? paths.monitorsRoot
        : paths.workersRoot;
  const path = resolve(castleLanePath(paths, input.lane, input.id));
  const rel = relative(resolve(laneRoot), path);
  if (rel.startsWith("..") || resolve(laneRoot) === path) {
    throw new Error("log lane id escapes its Castle lane root");
  }
  const records = await readCastleLaneRecords(path);
  const filtered =
    input.kind !== undefined
      ? records.filter((r) => r.kind === input.kind)
      : records;
  const limit = input.limit ?? LOGS_DEFAULT_LIMIT;
  return filtered.length <= limit ? filtered : filtered.slice(-limit);
}

export async function workerVitals(
  root: string,
  opts: { live_only?: boolean } = {},
): Promise<WorkerVitalsOutput> {
  const paths = createEnginePaths(join(root, ".red"));
  // Process liveness comes from the DAEMON, the single anchor: it owns birth and
  // death, so it is the only authority on whether a Worker is still running. One
  // read serves every Worker in the answer, and an unreachable daemon yields
  // `unknown` rather than a Worker reported dead beside evidence of life.
  const [records, workerDirs, hostAnswer] = await Promise.all([
    readAllWorkerStates(afkPaths(root).tmpDir),
    readdir(paths.workersRoot, { withFileTypes: true }).catch(() => []),
    readDaemonWorkerSet().catch((): DaemonWorkerSet | null => null),
  ]);
  const alerts = new Map<string, { type: string; at: string; message: string }>();
  await Promise.all(workerDirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const lane = await readCastleLaneRecords(castleLanePath(paths, "worker", entry.name));
    const latest = [...lane].reverse().find((record) => record.kind === "worker.session-error");
    const payload = latest?.payload;
    if (
      latest && payload &&
      typeof payload.type === "string" &&
      typeof payload.message === "string"
    ) {
      alerts.set(entry.name, {
        type: payload.type,
        at: typeof payload.at === "string" ? payload.at : latest.at,
        message: payload.message,
      });
    }
  }));
  const nowIso = new Date().toISOString();
  const all = records.map(({ state, ...record }) => {
    // The post-DONE hang the liveness lane cannot see (#2985): alive, no child,
    // orchestrator-owned phase, silent for minutes. A session-error alert is a
    // harder fact and always wins; this fills the gap where there is none.
    const wedged = detectWedgedOrchestrator({
      live: record.live,
      phase: state.current.phase,
      laneAgeMs: record.livenessVerdict?.laneAgeMs,
      liveDescendants: record.livenessVerdict?.liveDescendants,
      blockedOn: state.current.blocked_on,
      blockedDetail: state.current.blocked_detail,
    });
    return {
    worker: {
      id: state.worker_id,
      pid: state.pid,
      runner: state.runner,
      origin: state.origin,
      started_at: state.started_at,
      done: state.done,
      total: state.total,
      blocked: state.blocked,
      failed: state.failed,
      current: {
        number: state.current.number,
        runner: state.current.runner,
        retries: state.current.retries,
        model: state.current.model,
        effort: state.current.effort,
        phase: state.current.phase,
        iteration: state.current.iteration,
        activity: state.current.activity,
        loc_added: state.current.loc_added,
        loc_removed: state.current.loc_removed,
        last_commit_at: state.current.last_commit_at,
        tools_called_count: state.current.tools_called_count,
        text_chunk_count: state.current.text_chunk_count,
        reasoning_events: state.current.reasoning_events,
        reasoning_tokens: state.current.reasoning_tokens,
        last_event_at: state.current.last_event_at,
        waiting_count: state.current.waiting_count,
        input_tokens: state.current.input_tokens,
        output_tokens: state.current.output_tokens,
        cost_usd: state.current.cost_usd,
        wait_kind: state.current.wait_kind,
        wait_subject: state.current.wait_subject,
        wait_pid: state.current.wait_pid,
        wait_started_at: state.current.wait_started_at,
        wait_deadline: state.current.wait_deadline,
        wait_escalation: state.current.wait_escalation,
      },
    },
    live: record.live,
    active: record.active,
    renderable_live: record.renderableLive,
    liveness: record.liveness,
    liveness_verdict: record.livenessVerdict,
    alert:
      alerts.get(state.worker_id) ??
      (wedged ? { type: wedged.type, at: nowIso, message: wedged.message } : undefined),
    // The record's own live flag can only WITHHOLD a death claim (see the
    // anchor): it never becomes an `alive` verdict of its own, so this payload
    // stays one anchor deep while refusing to call a visibly running Worker gone.
    daemon_liveness: publishWorkerLiveness(
      resolveWorkerLiveness(hostAnswer, state.worker_id, { evidenceOfLife: record.live }),
    ),
    };
  });
  const represented = new Set(all.map((record) => record.worker.id));
  for (const [workerId, alert] of alerts) {
    if (represented.has(workerId)) continue;
    all.push({
      worker: {
        id: workerId,
        pid: 0,
        runner: "",
        origin: "",
        started_at: alert.at,
        done: 0,
        total: 0,
        blocked: 0,
        failed: 1,
        current: {
          number: "",
          runner: "",
          retries: 0,
          phase: "blocked",
          iteration: "",
          model: "",
          effort: "",
          activity: "session-error",
          loc_added: 0,
          loc_removed: 0,
          last_commit_at: "",
          tools_called_count: 0,
          text_chunk_count: 0,
          reasoning_events: 0,
          reasoning_tokens: 0,
          last_event_at: alert.at,
          waiting_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          wait_kind: "",
          wait_subject: "",
          wait_pid: 0,
          wait_started_at: "",
          wait_deadline: "",
          wait_escalation: "",
        },
      },
      live: false,
      active: false,
      renderable_live: false,
      liveness: "dead",
      liveness_verdict: {
        // Widened to the shared union so the synthetic session-error record
        // stays assignable as `LivenessStatus` grows (#2701 added `capped`).
        status: "stalled" as LivenessStatus,
        reason: "session-error",
        laneFresh: false,
        crossCheckArmed: false,
      },
      alert,
      // Asked of the same read as every other record, so a worker known only by
      // its session error still carries the daemon's verdict rather than a gap.
      daemon_liveness: publishWorkerLiveness(resolveWorkerLiveness(hostAnswer, workerId)),
    });
  }
  return boundWorkerVitals(filterWorkerVitalsLiveOnly(all, opts.live_only !== false));
}

/**
 * How long a dead worker's alert keeps it on the DEFAULT (live) read.
 *
 * An alert is a page: a boot death must surface on the very next read, or a
 * fast-dying worker is invisible (the case the session-error lane exists for).
 * But a page ages — past this window it has either been acted on or superseded
 * by a respawn, and keeping it on the live read is how 344 corpses buried the
 * one live worker under 559KB of payload. `live_only: false` still returns
 * every record, however old.
 */
export const WORKER_VITALS_ALERT_FRESH_MS = 30 * 60 * 1000;

/**
 * `live_only` means live — plus deaths fresh enough to still be a page.
 * The unconditional alert arm let every stalled corpse through forever,
 * because nothing reclaims the records (#2978).
 */
export function filterWorkerVitalsLiveOnly<
  T extends { live?: boolean; alert?: { at?: string } | undefined },
>(records: readonly T[], liveOnly: boolean, nowMs = Date.now()): T[] {
  if (!liveOnly) return [...records];
  return records.filter((r) => {
    if (r.live === true) return true;
    const at = r.alert?.at === undefined ? NaN : Date.parse(r.alert.at);
    return Number.isFinite(at) && nowMs - at <= WORKER_VITALS_ALERT_FRESH_MS;
  });
}

/**
 * The ceiling on how many rows one `worker_vitals` answer may carry.
 *
 * The reclaim (#2978) is what keeps the record lane small; this is what keeps
 * the PAYLOAD small while a pile exists at all — a surface must stay correct
 * during the window between a Worker dying and the retention releasing its
 * record, and on a `live_only: false` read that deliberately asks for the dead
 * ones. Thirty-two rows is an order of magnitude above any real fleet width on
 * one host, so a bounded answer never truncates a live fleet, and it holds the
 * payload near the ~1KB-per-row this record shape costs instead of the 559KB
 * that 345 corpses produced.
 */
export const WORKER_VITALS_MAX_RECORDS = 32;

/**
 * Bound the answer, LIVE ROWS FIRST.
 *
 * The ordering is the whole point, not a tidiness preference: when the pile
 * buried the one live Worker, the first row a reader saw was a corpse whose
 * `loc 0` read as "the worker produced nothing". Live rows sort ahead of dead
 * ones and recent ahead of old, so the rows a bound can ever drop are the
 * oldest dead ones — the rows whose evidence the Worker's own lane log and the
 * castle history still carry.
 */
export function boundWorkerVitals<
  T extends {
    live?: boolean;
    worker?: { started_at?: string; current?: { last_event_at?: string } };
  },
>(records: readonly T[], limit = WORKER_VITALS_MAX_RECORDS): T[] {
  if (records.length <= limit) return [...records];
  const recency = (record: T): number => {
    const last = Date.parse(record.worker?.current?.last_event_at ?? "");
    if (Number.isFinite(last)) return last;
    const started = Date.parse(record.worker?.started_at ?? "");
    return Number.isFinite(started) ? started : 0;
  };
  return [...records]
    .sort((a, b) => {
      if (a.live !== b.live) return a.live === true ? -1 : 1;
      return recency(b) - recency(a);
    })
    .slice(0, limit);
}

export function projectFields(
  records: Array<Record<string, unknown>>,
  fields: string[] | undefined,
): unknown[] {
  if (!fields || fields.length === 0) return records;
  const fieldSet = new Set(fields);
  return records.map((r) => {
    const out: Record<string, unknown> = {};
    for (const key of fieldSet) {
      if (Object.prototype.hasOwnProperty.call(r, key)) out[key] = r[key];
    }
    return out;
  });
}

/**
 * The `queue_status` payload, built from the two candidate lists. Pure and
 * exported so the declared output contract is round-trippable over fixture
 * candidates — the GitHub reads stay in the dependency wiring above.
 *
 * The ready-for-agent bodies are dropped: the queue answer is "which issues",
 * and a full body per candidate would dwarf the rest of the payload.
 */
