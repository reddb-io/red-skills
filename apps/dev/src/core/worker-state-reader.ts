// core/worker-state-reader.ts — the ONE owner for reading afk.state.json.
//
// Every consumer that turns an `afk.state.json` on disk into a usable worker
// record — the monitor/statusline collectors, the mirror feed, boot facts, and
// the fleet supervisor's reaper — goes through here, so there is a SINGLE parse
// path: JSON.parse → `parseState` (schema + the ADR 0065 legacy-key shim) →
// liveness via the canonical `isStateLive` / `isStateActive`. Before this, the
// supervisor reaper hand-rolled its own `JSON.parse` and the wire collectors each
// re-globbed + re-parsed + re-derived liveness independently; a legacy-keyed file
// could read differently through those bypass paths than through `parseState`.
//
// `readWorkerState(path)` is SYNCHRONOUS on purpose: the supervisor reaper
// (runtime/supervisor-fs.ts) resolves issue/worker identity from a state file
// inside sync closures and must not pay an await. `readWorkerStates(root)` is the
// async fan-out the collectors use (glob → read each).

import { readFileSync } from "node:fs";
import type { AfkState } from "../types/state.js";
import { isStateActive, isStateLive, parseState } from "./state.js";
import { globWorkerStates } from "../runtime/fs.js";

/** One normalized, liveness-tagged worker state read. */
export interface WorkerStateRecord {
  /** Absolute path of the `afk.state.json` this record was read from. */
  path: string;
  /** Parsed state with the schema + ADR 0065 legacy-key shim applied. */
  state: AfkState;
  /**
   * pid-only liveness ({@link isStateLive}). The reaper/cap signal: a slow
   * worker whose pid still resolves is live even when briefly quiet — so it is
   * never reaped on freshness.
   */
  live: boolean;
  /**
   * pid + recent-activity liveness ({@link isStateActive}). The display `[live]`
   * badge the monitor/statusline use: a finished worker whose pid is shared with
   * the supervisor or recycled by the OS stops rendering as live.
   */
  active: boolean;
}

/** Liveness injection for {@link readWorkerState} (tests / determinism). */
export interface WorkerStateReadOpts {
  /** Activity-freshness clock (ms). Defaults to `Date.now()`. */
  nowMs?: number;
  /** pid-resolution probe. Defaults to `process.kill(pid, 0)`. */
  kill?: (pid: number, signal?: 0) => boolean;
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
  return {
    path,
    state,
    live: opts.kill ? isStateLive(state, opts.kill) : isStateLive(state),
    active: opts.kill ? isStateActive(state, nowMs, opts.kill) : isStateActive(state, nowMs),
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
    const rec = readWorkerState(file, { nowMs, kill: opts.kill });
    if (rec !== null) out.push(rec);
  }
  return out;
}
