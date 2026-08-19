// core/worker-state-reader.ts — the ONE owner for reading afk.state.toon.
//
// Every consumer that turns an `afk.state.toon` on disk into a usable worker
// record — the monitor/statusline collectors, the mirror feed, boot facts, and
// the fleet supervisor's reaper — goes through here, so there is a SINGLE parse
// path: JSON.parse → `parseState` (schema + the ADR 0065 legacy-key shim) →
// liveness via the red-castle `evaluateLiveness` evaluator (ADR 0083 §3).
//
// `readWorkerState(path)` is SYNCHRONOUS on purpose: the supervisor reaper
// (runtime/supervisor-fs.ts) resolves issue/worker identity from a state file
// inside sync closures and must not pay an await. `readWorkerStates(root)` is the
// async fan-out the collectors use (glob → read each).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { AfkState } from "../types/state.js";
import { parseStateDocument, isStateLive, parseIdentity, readIdentitySync, type PidStartTimeProbe } from "./state.js";
import { globWorkerStates } from "../runtime/fs.js";
import { allWorkersRoots } from "./worker-paths.js";
import {
  evaluateLiveness,
  resolveLivenessCrossCheckArming,
  createProcessDescendantProbe,
  parseLivenessRecords,
  LIVENESS_LANE_FILENAME,
  type LivenessVerdict,
  type SandboxTag,
} from "@reddb-io/worker";

export type WorkerLivenessVerdict = "active" | "quiet-but-live" | "dead";

/** One normalized, liveness-tagged worker state read. */
export interface WorkerStateRecord {
  /** Absolute path of the `afk.state.toon` this record was read from. */
  path: string;
  /** Parsed state with the schema + ADR 0065 legacy-key shim applied. */
  state: AfkState;
  /**
   * Process-identity gate (not stalled in evaluator sense). True for "alive" or
   * "unknown" evaluator status. Used by boot-cap / companion to exclude workers
   * that may still hold OS resources.
   */
  live: boolean;
  /**
   * True when the liveness lane is fresh (evaluator "alive" + laneFresh=true).
   * Quiet-but-live workers (stale lane, live descendants) have `active: false`.
   * The `[live]` badge the monitor/statusline show.
   */
  active: boolean;
  /** Explicit three-way verdict derived from the evaluator:
   * - `"active"` — lane fresh (evaluator status "alive" + laneFresh=true)
   * - `"quiet-but-live"` — alive via cross-check, or unknown (container)
   * - `"dead"` — evaluator status "stalled" */
  liveness: WorkerLivenessVerdict;
  /** Raw red-castle evaluator verdict (ADR 0083 §3). The single source of truth
   * every rendering surface and the fleet reaper consume. */
  livenessVerdict: LivenessVerdict;
  /**
   * True when the state's OWN pid is genuinely alive per {@link isStateLive}
   * (pid > 0 AND `kill(pid, 0)` AND, when recorded, `pid_start_time` matches).
   * Distinct from the lane/cross-check verdict above: a finished/retained attempt
   * is stamped `pid: 0` by the completion sweep, yet its per-attempt liveness lane
   * can still read fresh during the post-mortem retention window — so the verdict
   * alone would call it "alive". The statusline worker-line filter requires this
   * pid-identity signal so a finished attempt (pid 0) never renders a phantom
   * live-worker line beside the same worker's live successor attempt (issue #1177).
   */
  pidIdentityLive: boolean;
  /**
   * True only when `state.pid` is 0 but the host-side `worker.pid` file resolves
   * to a live process (the isolation pre-sync fallback synthesized an "alive"
   * verdict). Lets the statusline keep a genuinely-running container worker whose
   * host-visible pid is legitimately 0, while still dropping finished/retained
   * local attempts (pid 0, no live host pid).
   */
  hostPidLive: boolean;
  /**
   * The SINGLE render-gate every observability surface shares (issue #1219):
   * `livenessVerdict.status !== "stalled" && (pidIdentityLive || hostPidLive)`.
   * Computed ONCE here so the statusline aggregate, the statusline per-worker
   * lines, and the monitor dashboard all agree on who becomes a rendered row —
   * no surface inlines its own copy of the gate. Also exported as the pure
   * {@link isRenderableLive} helper for callers that hold a partial record.
   */
  renderableLive: boolean;
}

/**
 * The ONE render-gate predicate (issue #1219): a record becomes a rendered
 * worker row only when the evaluator does NOT call it stalled AND its own pid
 * (or, for isolation workers, the host-side `worker.pid`) is genuinely alive.
 * Every read surface routes through this so a finished/retained pid-0 attempt or
 * a stalled worker never renders a phantom live line, and all three surfaces
 * agree on liveness.
 */
export function isRenderableLive(
  rec: Pick<WorkerStateRecord, "livenessVerdict" | "pidIdentityLive" | "hostPidLive">,
): boolean {
  return rec.livenessVerdict.status !== "stalled" && (rec.pidIdentityLive || rec.hostPidLive);
}

function attemptMtimeMs(path: string): number {
  try {
    return statSync(dirname(path)).mtimeMs;
  } catch {
    return 0;
  }
}

function attemptStartedMs(rec: Pick<WorkerStateRecord, "path" | "state">): number {
  const raw = rec.state.current.started_at || rec.state.started_at;
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return attemptMtimeMs(rec.path);
}

function workerKey(rec: Pick<WorkerStateRecord, "path" | "state">): string {
  return rec.state.worker_id || basename(dirname(dirname(rec.path)));
}

function compareWorkerAttempts(a: Pick<WorkerStateRecord, "path" | "state">, b: Pick<WorkerStateRecord, "path" | "state">): number {
  const started = attemptStartedMs(a) - attemptStartedMs(b);
  if (started !== 0) return started;
  return a.path.localeCompare(b.path);
}

/** Collapse a batch of read records to the single current renderable attempt per
 * Worker. The current attempt is the newest started/mtime record for the worker,
 * with the numeric `aN` suffix as a stable tie-breaker. */
export function currentRenderableWorkerRecords(records: readonly WorkerStateRecord[]): WorkerStateRecord[] {
  return currentWorkerRecords(records, (rec) => rec.renderableLive);
}

/**
 * Collapse to the current OS-running record per Worker for proof-of-life
 * surfaces. Unlike {@link currentRenderableWorkerRecords}, this keeps an
 * evaluator-stalled record while its own PID identity is still live, so the
 * statusline can render the wedged `!age` verdict instead of silently deleting
 * the row. Finished/retained PID-zero attempts remain excluded.
 */
export function currentObservableWorkerRecords(records: readonly WorkerStateRecord[]): WorkerStateRecord[] {
  return currentWorkerRecords(records, (rec) => rec.pidIdentityLive || rec.hostPidLive);
}

function currentWorkerRecords(
  records: readonly WorkerStateRecord[],
  include: (record: WorkerStateRecord) => boolean,
): WorkerStateRecord[] {
  const byWorker = new Map<string, WorkerStateRecord>();
  for (const rec of records) {
    if (!include(rec)) continue;
    const key = workerKey(rec);
    const prev = byWorker.get(key);
    if (prev === undefined || compareWorkerAttempts(rec, prev) > 0) {
      byWorker.set(key, rec);
    }
  }
  return [...byWorker.values()];
}

function isNewestAttemptDirForWorker(path: string): boolean {
  const attemptDir = dirname(path);
  const workerDir = dirname(attemptDir);
  let entries: string[];
  try {
    entries = readdirSync(workerDir);
  } catch {
    return true;
  }
  let newest: string | null = null;
  let newestMtime = -1;
  for (const entry of entries) {
    const dir = join(workerDir, entry);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      const mtime = st.mtimeMs;
      if (mtime > newestMtime || (mtime === newestMtime && dir > (newest ?? ""))) {
        newestMtime = mtime;
        newest = dir;
      }
    } catch {
      // Ignore raced-away entries.
    }
  }
  return newest === null || newest === attemptDir;
}

/** Display threshold: lane records this old → not "active". Matches the old
 * WORKER_LIVE_MAX_AGE_S semantics used by the monitor/statusline. */
export const LIVENESS_LANE_IDLE_MS = 180_000;

/** Liveness injection for {@link readWorkerState} (tests / determinism). */
export interface WorkerStateReadOpts {
  /** Activity-freshness clock (ms). Defaults to `Date.now()`. */
  nowMs?: number;
  /** pid-resolution probe. Defaults to `process.kill(pid, 0)`. */
  kill?: (pid: number, signal?: 0) => boolean;
  /** pid identity probe. Defaults to Linux `/proc`; empty legacy state falls
   * back to pid-only liveness. */
  pidStartTime?: PidStartTimeProbe;
  /**
   * Sandbox provider tag for cross-check arming. Defaults to `"none"` (arms
   * the descendant probe for local, no-sandbox workers). Pass `"bind-mount"` or
   * `"isolated"` to disarm it for container workers where the host process tree
   * is blind to the agent.
   */
  sandboxTag?: SandboxTag;
  /**
   * Override for the liveness lane newest-record epoch (ms). When provided, the
   * reader skips the disk read and uses this value directly — useful in tests to
   * drive the evaluator without writing real lane files.
   */
  laneRecencyMs?: number;
  /**
   * Override for the `ps -eo pid=,ppid=` snapshot the descendant probe reads.
   * Injected in tests so the cross-check can be driven without real process
   * trees.
   */
  psSnapshot?: () => string;
  /**
   * Raw text content of the per-worker `worker.pid` file, for injection in
   * tests. When omitted and `state.pid === 0`, the reader reads
   * `{dirname(dirname(path))}/worker.pid` from disk. Only consulted when
   * `state.pid === 0` and the primary evaluator returns "stalled" — this is
   * the host-side liveness signal for isolation workers (docker/podman) where
   * the host's `afk.state.toon.pid` is never populated during the run.
   */
  workerPidContent?: string;
  /**
   * Raw text content of the per-attempt `identity.toon` sidecar, for injection in
   * tests. When omitted and the isolation fallback fires (state.pid 0 + a live
   * host worker.pid), the reader reads `{dirname(path)}/identity.toon` from disk.
   * The durable write-once identity (issue #1219) that lets a live isolation
   * worker render its real worker_id/runner/origin/started_at instead of the
   * `?  run=-  00:00:00` ghost.
   */
  identityContent?: string;
}

/** Sync read of the newest liveness lane record timestamp (epoch-ms), or
 * `undefined` when the lane file is absent / empty / unreadable. */
function readLivenessRecencySync(lanePath: string): number | undefined {
  try {
    const raw = readFileSync(lanePath, "utf-8");
    const records = parseLivenessRecords(raw);
    if (records.length === 0) return undefined;
    return records.reduce((max, r) => (r.at > max ? r.at : max), records[0]!.at);
  } catch {
    return undefined;
  }
}

/** Map evaluator status to the three-way `WorkerLivenessVerdict` display field. */
function verdictToLiveness(v: LivenessVerdict): WorkerLivenessVerdict {
  if (v.status === "stalled") return "dead";
  if (v.status === "alive" && v.laneFresh) return "active";
  return "quiet-but-live";
}

/**
 * Read ONE Worker state document into its parsed {@link AfkState}, or `null`
 * when the file is missing, unreadable, or fails the schema. This is the seam
 * every consumer that only wants the document — not the liveness-tagged record
 * {@link readWorkerState} builds — routes through, so the read/decode pair is
 * spelled exactly once: no consumer reads the bytes and parses them privately.
 */
export function readWorkerStateDocument(path: string): AfkState | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return parseStateDocument(text);
  } catch {
    return null;
  }
}

/**
 * Read and normalize ONE `afk.state.toon`. Synchronous so the supervisor reaper
 * can call it inside its sync closures. Returns `null` when the file is missing,
 * unreadable, not valid JSON, or fails the schema — the safe value every caller
 * already degrades to (issue null / worker skipped). A present-but-partial file
 * (e.g. `{ "current": { "number": 42 } }`) parses fine: the schema fills every
 * default and the legacy-key shim runs, so the read is identical to every other
 * path.
 */
export function readWorkerState(path: string, opts: WorkerStateReadOpts = {}): WorkerStateRecord | null {
  const parsed = readWorkerStateDocument(path);
  if (parsed === null) return null;
  const state: AfkState = parsed;
  const nowMs = opts.nowMs ?? Date.now();

  // Liveness lane recency — injected directly in tests, read from disk otherwise.
  const laneRecencyMs =
    opts.laneRecencyMs !== undefined
      ? opts.laneRecencyMs
      : readLivenessRecencySync(join(dirname(path), LIVENESS_LANE_FILENAME));

  // Cross-check arming: host process tree is visible only for local (no-sandbox) workers.
  const { crossCheckArmed } = resolveLivenessCrossCheckArming({ sandboxTag: opts.sandboxTag ?? "none" });

  // Descendant probe: armed only when cross-check is enabled and the pid is valid.
  const hasLiveDescendants =
    crossCheckArmed && state.pid > 0
      ? createProcessDescendantProbe({ agentPid: state.pid, snapshot: opts.psSnapshot })
      : undefined;

  const livenessVerdict = evaluateLiveness({
    laneRecencyMs,
    now: nowMs,
    laneIdleMs: LIVENESS_LANE_IDLE_MS,
    crossCheckArmed,
    hasLiveDescendants,
  });

  // Isolation fallback: when state.pid is 0 (docker/podman workers never
  // populate the host-side pid during the run) and the primary evaluator marks
  // the attempt stalled (empty lane + no descendants), probe the per-worker
  // worker.pid file instead. The supervisor writes it on the host regardless of
  // sandbox mode, so it is the reliable host-side liveness signal for isolation
  // workers even before afk.state.toon syncs back at run end.
  let finalVerdict = livenessVerdict;
  let hostPidLive = false;
  if (livenessVerdict.status === "stalled" && state.pid === 0 && isNewestAttemptDirForWorker(path)) {
    // worker.pid lives one directory above the attempt dir:
    // {workersRoot}/{workerId}/{N}-a{n}/afk.state.toon → {workersRoot}/{workerId}/worker.pid
    const workerPidPath = join(dirname(dirname(path)), "worker.pid");
    let hostPidText: string | null;
    if (opts.workerPidContent !== undefined) {
      hostPidText = opts.workerPidContent;
    } else {
      try {
        hostPidText = readFileSync(workerPidPath, "utf8");
      } catch {
        hostPidText = null;
      }
    }
    const hostPid = hostPidText ? parseInt(hostPidText.trim(), 10) : NaN;
    if (Number.isFinite(hostPid) && hostPid > 0) {
      const killFn = opts.kill ?? ((pid: number) => { process.kill(pid, 0); return true; });
      let hostPidAlive = false;
      try {
        hostPidAlive = killFn(hostPid, 0);
      } catch {
        hostPidAlive = false;
      }
      if (hostPidAlive) {
        hostPidLive = true;
        // Synthesize a "quiet-but-live" verdict: the orchestrator is running on
        // the host but afk.state.toon has not synced yet (isolation pre-sync).
        finalVerdict = {
          status: "alive",
          laneFresh: false,
          crossCheckArmed: false,
          reason: `state.pid=0 but worker.pid=${hostPid} is alive (isolation worker)`,
        };
        // Durable identity fallback (issue #1219): a live isolation worker whose
        // host-side afk.state.toon is still zeroed (pid 0, empty worker_id/runner)
        // must NOT render as the `?  run=-  00:00:00` ghost. Read the write-once
        // identity.toon sidecar and populate the zeroed identity fields from it —
        // never overwriting a value the state file already carries.
        const identity =
          opts.identityContent !== undefined
            ? parseIdentity(opts.identityContent)
            : readIdentitySync(dirname(path));
        if (identity) {
          if (!state.worker_id && identity.worker_id) state.worker_id = identity.worker_id;
          if (!state.runner && identity.runner) state.runner = identity.runner;
          if (!state.origin && identity.origin) state.origin = identity.origin;
          if (!state.started_at && identity.started_at) state.started_at = identity.started_at;
          if (!state.current.started_at && identity.started_at) state.current.started_at = identity.started_at;
          if (
            (state.current.number === "" || state.current.number === undefined || state.current.number === null) &&
            identity.number !== "" &&
            identity.number !== undefined &&
            identity.number !== null
          ) {
            state.current.number = identity.number;
          }
        }
        // Derive the issue number from the issue-dir basename when neither the
        // state nor the identity sidecar carries a current.number (empty
        // pre-sync). Workspaces are keyed workers/{id}/{issue} — flat, no
        // attempt ordinal (ADR 0103).
        if (state.current.number === "" || state.current.number === undefined || state.current.number === null) {
          const issueBasename = basename(dirname(path));
          const m = /^([1-9][0-9]*)$/.exec(issueBasename);
          if (m) state.current.number = Number(m[1]);
        }
      }
    }
  }

  const liveness = verdictToLiveness(finalVerdict);
  // live: true when the evaluator does NOT say "stalled" (includes "alive" and "unknown"/container).
  // Replaces the old isStateLive-only pid check; the evaluator's cross-check already reads
  // the process tree so a pid-alive but descendant-less worker is correctly marked dead.
  const live = finalVerdict.status !== "stalled";
  // active: lane fresh only (laneFresh=true), NOT just any "alive" status. A worker whose lane
  // is idle but has live descendants is "quiet-but-live" — it holds resources but is not actively
  // iterating, so surfaces show it as inactive (no [live] badge in the monitor/statusline).
  const active = liveness === "active";

  // pid-identity liveness: the state's OWN pid resolves to a live process. Uses
  // the same probes the evaluator/reaper share (kill + pid_start_time), so it is
  // consistent with every other liveness read. A finished/retained attempt
  // (pid 0) is false here even when its lane still reads fresh — the signal the
  // statusline worker-line filter needs (issue #1177).
  const pidIdentityLive = isStateLive(state, opts.kill, opts.pidStartTime);

  // The ONE shared render-gate (issue #1219), computed once so all three
  // surfaces route through the same predicate.
  const renderableLive =
    finalVerdict.status !== "stalled" && (pidIdentityLive || hostPidLive);

  return {
    path,
    state,
    live,
    active,
    liveness,
    livenessVerdict: finalVerdict,
    pidIdentityLive,
    hostPidLive,
    renderableLive,
  };
}

/** Liveness + glob injection for {@link readWorkerStates}. */
export interface WorkerStatesReadOpts extends WorkerStateReadOpts {
  /** Worker-state glob. Defaults to the runtime `globWorkerStates`. */
  glob?: (workersRoot: string) => Promise<string[]>;
}

/**
 * Glob every worker state file under a workers root and read each through
 * {@link readWorkerState}. Records that fail to read (missing/malformed/raced
 * away) are dropped, matching the per-file `continue` every collector already
 * did. A single `nowMs` is shared across the batch so every record's liveness is
 * measured against the same instant.
 */
export async function readWorkerStates(root: string, opts: WorkerStatesReadOpts = {}): Promise<WorkerStateRecord[]> {
  const glob = opts.glob ?? globWorkerStates;
  const nowMs = opts.nowMs ?? Date.now();
  const files = await glob(root);
  const out: WorkerStateRecord[] = [];
  for (const file of files) {
    const rec = readWorkerState(file, {
      nowMs,
      kill: opts.kill,
      pidStartTime: opts.pidStartTime,
      sandboxTag: opts.sandboxTag,
      psSnapshot: opts.psSnapshot,
      workerPidContent: opts.workerPidContent,
      identityContent: opts.identityContent,
    });
    if (rec !== null) out.push(rec);
  }
  return out;
}

/**
 * Read-only UNION discovery across every worker-lane namespace
 * ({@link WORKER_NAMESPACES}: `workers`, `go-workers`, `scout-workers`) under a
 * `.red/tmp` dir. Globs each namespace root through {@link readWorkerStates} and
 * concatenates every record, so a live `/go` or `--scout` worker counts as one
 * more live worker on the observability surfaces. A missing namespace directory
 * contributes nothing (its glob returns `[]`), never an error. Lane provenance
 * is preserved on each record via `state.origin`, so per-source breakdowns still
 * render each lane distinctly.
 *
 * This is the AGGREGATION seam every read-only surface (statusline/monitor/
 * dashboard) uses. It is deliberately namespace-blind — it does NOT consult
 * `RED_AFK_WORKERS_NAMESPACE`, unlike the single-lane {@link readWorkerStates}
 * that the run-time write paths rely on for isolation. A single `nowMs` is
 * shared across the whole batch so every record's liveness is measured against
 * the same instant.
 */
export async function readAllWorkerStates(
  tmpDir: string,
  opts: WorkerStatesReadOpts = {},
): Promise<WorkerStateRecord[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const out: WorkerStateRecord[] = [];
  for (const root of allWorkersRoots(tmpDir)) {
    out.push(...(await readWorkerStates(root, { ...opts, nowMs })));
  }
  return out;
}
