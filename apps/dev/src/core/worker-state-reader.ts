// core/worker-state-reader.ts — the ONE owner for reading afk.state.json.
//
// Every consumer that turns an `afk.state.json` on disk into a usable worker
// record — the monitor/statusline collectors, the mirror feed, boot facts, and
// the fleet supervisor's reaper — goes through here, so there is a SINGLE parse
// path: JSON.parse → `parseState` (schema + the ADR 0065 legacy-key shim) →
// liveness via the red-castle `evaluateLiveness` evaluator (ADR 0083 §3).
//
// `readWorkerState(path)` is SYNCHRONOUS on purpose: the supervisor reaper
// (runtime/supervisor-fs.ts) resolves issue/worker identity from a state file
// inside sync closures and must not pay an await. `readWorkerStates(root)` is the
// async fan-out the collectors use (glob → read each).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AfkState } from "../types/state.js";
import { parseState, type PidStartTimeProbe } from "./state.js";
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
} from "@reddb-io/red-castle";

export type WorkerLivenessVerdict = "active" | "quiet-but-live" | "dead";

/** One normalized, liveness-tagged worker state read. */
export interface WorkerStateRecord {
  /** Absolute path of the `afk.state.json` this record was read from. */
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
 * Read and normalize ONE `afk.state.json`. Synchronous so the supervisor reaper
 * can call it inside its sync closures. Returns `null` when the file is missing,
 * unreadable, not valid JSON, or fails the schema — the safe value every caller
 * already degrades to (issue null / worker skipped). A present-but-partial file
 * (e.g. `{ "current": { "number": 42 } }`) parses fine: the schema fills every
 * default and the legacy-key shim runs, so the read is identical to every other
 * path.
 */
export function readWorkerState(path: string, opts: WorkerStateReadOpts = {}): WorkerStateRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let state: AfkState;
  try {
    state = parseState(JSON.parse(text));
  } catch {
    return null;
  }
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

  const liveness = verdictToLiveness(livenessVerdict);
  // live: true when the evaluator does NOT say "stalled" (includes "alive" and "unknown"/container).
  // Replaces the old isStateLive-only pid check; the evaluator's cross-check already reads
  // the process tree so a pid-alive but descendant-less worker is correctly marked dead.
  const live = livenessVerdict.status !== "stalled";
  // active: lane fresh only (laneFresh=true), NOT just any "alive" status. A worker whose lane
  // is idle but has live descendants is "quiet-but-live" — it holds resources but is not actively
  // iterating, so surfaces show it as inactive (no [live] badge in the monitor/statusline).
  const active = liveness === "active";

  return {
    path,
    state,
    live,
    active,
    liveness,
    livenessVerdict,
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
