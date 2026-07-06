import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AfkStateSchema, type AfkState } from "../types/state.js";

export function defaultState(): AfkState {
  return AfkStateSchema.parse({});
}

/** The write-once identity sidecar filename in an attempt dir (issue #1219). */
export const IDENTITY_FILENAME = "identity.json";

/**
 * The immutable spawn-time identity of one attempt (issue #1219). Written once by
 * {@link writeIdentitySync} beside `afk.state.json` and NEVER clobbered by the
 * vitals `updateState` read-modify-writes. It is the durable source the isolation
 * fallback in {@link readWorkerState} reads to render a live worker's real
 * `worker_id`/`runner`/`origin`/`started_at`/issue number when the host-side
 * `afk.state.json` is still zeroed (pid 0, empty identity) pre-sync — so a live
 * worker can never render as the `?  run=-  00:00:00` ghost.
 */
export interface WorkerIdentity {
  worker_id: string;
  runner: string;
  origin: string;
  number: number | string;
  started_at: string;
}

/**
 * Write the attempt's {@link WorkerIdentity} sidecar ONCE. Synchronous (same seam
 * as {@link initStateSync}) and write-once: an existing `identity.json` is left
 * untouched so a re-entered attempt keeps its original identity. Best-effort at
 * the call site — a failed write must never block the worker's actual work.
 */
export function writeIdentitySync(attemptDir: string, identity: WorkerIdentity): void {
  const path = join(attemptDir, IDENTITY_FILENAME);
  if (existsSync(path)) return;
  mkdirSync(attemptDir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.sync`;
  writeFileSync(tmp, `${JSON.stringify(identity)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Parse a {@link WorkerIdentity} from raw JSON text, or `null` when absent /
 * malformed. Only string/number fields are honoured; anything else is dropped to
 * the empty default so a partial file never throws. */
export function parseIdentity(raw: string | null | undefined): WorkerIdentity | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<WorkerIdentity>;
    if (typeof p !== "object" || p === null) return null;
    return {
      worker_id: typeof p.worker_id === "string" ? p.worker_id : "",
      runner: typeof p.runner === "string" ? p.runner : "",
      origin: typeof p.origin === "string" ? p.origin : "",
      number:
        typeof p.number === "number" || typeof p.number === "string" ? p.number : "",
      started_at: typeof p.started_at === "string" ? p.started_at : "",
    };
  } catch {
    return null;
  }
}

/** Synchronous read of the {@link WorkerIdentity} sidecar from an attempt dir, or
 * `null` when the file is missing/unreadable/malformed. */
export function readIdentitySync(attemptDir: string): WorkerIdentity | null {
  try {
    return parseIdentity(readFileSync(join(attemptDir, IDENTITY_FILENAME), "utf8"));
  } catch {
    return null;
  }
}

/**
 * One-release back-compat read shim (ADR 0065): map legacy worker-vitals keys on
 * `current` onto their canonical names when the canonical key is absent, so a NEW
 * bundle reads an OLD afk.state.json without losing the value. The state file is
 * ephemeral (rewritten each ~60s heartbeat), so this only bridges the upgrade
 * window. Remove the shim — and the legacy keys — one release after S1 lands.
 */
function migrateLegacyCurrentKeys(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const cur = (data as Record<string, unknown>).current;
  if (typeof cur !== "object" || cur === null) return data;
  const c = cur as Record<string, unknown>;
  const alias = (canon: string, legacy: string): void => {
    if (c[canon] === undefined && c[legacy] !== undefined) c[canon] = c[legacy];
  };
  alias("loc_added", "diff_added");
  alias("loc_removed", "diff_removed");
  alias("reasoning_events", "thinking_called_count");
  alias("last_commit_at", "last_progress_at");
  return data;
}

export function parseState(data: unknown): AfkState {
  return AfkStateSchema.parse(migrateLegacyCurrentKeys(data ?? {}));
}

export async function readState(path: string): Promise<AfkState> {
  try {
    const text = await readFile(path, "utf8");
    return parseState(JSON.parse(text));
  } catch {
    return defaultState();
  }
}

function setDotted(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("empty state field");
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export async function writeStateAtomic(path: string, state: AfkState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(AfkStateSchema.parse(state))}
`, "utf8");
  await rename(tmp, path);
}

export async function initState(path: string, updates: Record<string, unknown> = {}): Promise<AfkState> {
  const state = defaultState() as unknown as Record<string, unknown>;
  state.version = 1;
  state.envelope = { posted: false };
  for (const [key, value] of Object.entries(updates)) setDotted(state, key, value);
  const parsed = parseState(state);
  await writeStateAtomic(path, parsed);
  return parsed;
}

/**
 * Synchronous {@link initState}. Use this to seed an attempt's state BEFORE any
 * async `updateState` can run against the same path. The async `initState` was
 * fire-and-forget at the attempt-start seam (run.ts buildProcessInput), so a
 * concurrent `updateState` (the agent-event sink / heartbeat) could read the
 * not-yet-written file, get the schema DEFAULT (empty identity: pid 0, number
 * "", worker_id ""), patch only its vitals, and write that back — stranding the
 * worker with vitals but no identity, so `monitor`/`statusline` rendered it as a
 * pid-0 `?`/idle ghost. A synchronous seed completes before the sink starts, so
 * every later read-modify-write preserves the identity.
 */
export function initStateSync(path: string, updates: Record<string, unknown> = {}): AfkState {
  const state = defaultState() as unknown as Record<string, unknown>;
  state.version = 1;
  state.envelope = { posted: false };
  for (const [key, value] of Object.entries(updates)) setDotted(state, key, value);
  const parsed = parseState(state);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.sync`;
  writeFileSync(tmp, `${JSON.stringify(AfkStateSchema.parse(parsed))}\n`, "utf8");
  renameSync(tmp, path);
  return parsed;
}

export async function updateState(path: string, updates: Record<string, unknown>): Promise<AfkState> {
  const state = (await readState(path)) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) setDotted(state, key, value);
  const parsed = parseState(state);
  await writeStateAtomic(path, parsed);
  return parsed;
}

export type PidStartTimeProbe = (pid: number) => string | null;

export function readPidStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd === -1) return null;
    const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

export function isStateLive(
  state: Pick<AfkState, "pid"> & Partial<Pick<AfkState, "pid_start_time">>,
  kill: (pid: number, signal?: 0) => boolean = defaultKill0,
  pidStartTime: PidStartTimeProbe = readPidStartTime,
): boolean {
  if (!Number.isInteger(state.pid) || state.pid <= 0 || !kill(state.pid, 0)) return false;
  const expected = state.pid_start_time ?? "";
  if (!expected) return true;
  const actual = pidStartTime(state.pid);
  return actual === null || actual === expected;
}

/**
 * Wall-clock staleness ceiling for the per-worker "live" badge. A worker whose
 * most-recent activity timestamp is older than this is treated as NOT active
 * even when its recorded pid identity still matches. Generous on purpose: a
 * working agent advances `last_event_at` every few seconds and commits/
 * heartbeats well inside this window, so a real-but-briefly-quiet worker is
 * never mis-flagged stale (the monitor false-negative this must avoid).
 */
export const WORKER_LIVE_MAX_AGE_S = 180;

/** Most-recent activity instant (ms) across a worker's vitals timestamps, or 0
 * when none parse. `last_event_at` is the honest liveness clock (ADR 0065);
 * `last_commit_at` and `started_at` are fallbacks so a committing-but-quiet or
 * just-started worker still reads as fresh. */
function latestActivityMs(state: Pick<AfkState, "current">): number {
  let latest = 0;
  for (const ts of [state.current.last_event_at, state.current.last_commit_at, state.current.started_at]) {
    const t = ts ? Date.parse(ts) : Number.NaN;
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest;
}

/**
 * True when a worker is BOTH process-live (its pid resolves and, when present,
 * pid_start_time matches) AND recently active (latest activity within
 * {@link WORKER_LIVE_MAX_AGE_S}). This is what the monitor/statusline use for
 * the `[live]` badge; pid-identity liveness without freshness renders `[quiet]`.
 * Reaper/cap logic deliberately keeps using the identity-only `isStateLive` so
 * a slow worker is never reaped on freshness.
 */
export function isStateActive(
  state: Pick<AfkState, "pid" | "current"> & Partial<Pick<AfkState, "pid_start_time">>,
  nowMs: number = Date.now(),
  kill: (pid: number, signal?: 0) => boolean = defaultKill0,
  maxAgeS: number = WORKER_LIVE_MAX_AGE_S,
  pidStartTime: PidStartTimeProbe = readPidStartTime,
): boolean {
  if (!isStateLive(state, kill, pidStartTime)) return false;
  const latest = latestActivityMs(state);
  return latest > 0 && nowMs - latest <= maxAgeS * 1000;
}

function defaultKill0(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
