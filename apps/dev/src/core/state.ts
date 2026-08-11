import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { type JsonValue as ToonValue } from "@reddb-io/toon";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "./toon-snapshot.js";
import { AfkStateSchema, type AfkState } from "../types/state.js";

export function defaultState(): AfkState {
  return AfkStateSchema.parse({});
}

/**
 * Filename of the Worker state document inside a Worker workspace. Named ONCE
 * here so no consumer re-spells it: the document is TOON on disk (written by
 * {@link writeStateAtomic} / {@link initStateSync} through the TOON encoder,
 * never a JSON serializer) and read back through the sniffing decoder.
 */
export const WORKER_STATE_FILENAME = "afk.state.toon";

/** Path of the Worker state document inside a Worker workspace dir. */
export function workerStatePath(workspaceDir: string): string {
  return join(workspaceDir, WORKER_STATE_FILENAME);
}

/**
 * The write-once identity sidecar filename in an attempt dir (issue #1219).
 * Canonical bytes and the extension agree: current writers emit TOON only.
 */
export const IDENTITY_FILENAME = "identity.toon";
const LEGACY_IDENTITY_FILENAME = "identity.json";

/**
 * The immutable spawn-time identity of one attempt (issue #1219). Written once by
 * {@link writeIdentitySync} beside `afk.state.toon` and NEVER clobbered by the
 * vitals `updateState` read-modify-writes. It is the durable source the isolation
 * fallback in {@link readWorkerState} reads to render a live worker's real
 * `worker_id`/`runner`/`origin`/`started_at`/issue number when the host-side
 * `afk.state.toon` is still zeroed (pid 0, empty identity) pre-sync — so a live
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
 * as {@link initStateSync}) and write-once: an existing `identity.toon` is left
 * untouched so a re-entered attempt keeps its original identity. A pre-cutover
 * JSON sidecar is converted once, then removed. Best-effort at the call site —
 * a failed write must never block the worker's actual work.
 */
export function writeIdentitySync(attemptDir: string, identity: WorkerIdentity): void {
  const path = join(attemptDir, IDENTITY_FILENAME);
  if (existsSync(path)) return;
  const legacyPath = join(attemptDir, LEGACY_IDENTITY_FILENAME);
  let value = identity;
  if (existsSync(legacyPath)) {
    try {
      value = parseIdentity(readFileSync(legacyPath, "utf8")) ?? identity;
    } catch {
      value = identity;
    }
  }
  mkdirSync(attemptDir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.sync`;
  writeFileSync(tmp, encodeDevSnapshotToon(value as unknown as ToonValue), "utf8");
  renameSync(tmp, path);
  if (existsSync(legacyPath)) {
    try {
      unlinkSync(legacyPath);
    } catch {
      // The canonical file is already durable; stale legacy cleanup is best-effort.
    }
  }
}

/** Parse a {@link WorkerIdentity} from a sidecar's text (TOON, with a raw-JSON
 * sniff fallback for pre-migration sidecars), or `null` when absent / malformed.
 * Only string/number fields are honoured; anything else is dropped to the empty
 * default so a partial file never throws. */
export function parseIdentity(raw: string | null | undefined): WorkerIdentity | null {
  if (!raw) return null;
  try {
    const p = decodeDevSnapshotSniff(raw) as Partial<WorkerIdentity>;
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
    try {
      const identity = parseIdentity(readFileSync(join(attemptDir, LEGACY_IDENTITY_FILENAME), "utf8"));
      if (identity) writeIdentitySync(attemptDir, identity);
      return identity;
    } catch {
      return null;
    }
  }
}

/**
 * One-release back-compat read shim (ADR 0065): map legacy worker-vitals keys on
 * `current` onto their canonical names when the canonical key is absent, so a NEW
 * bundle reads an OLD afk.state.toon without losing the value. The state file is
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
  alias("activity", "stage");
  alias("loc_added", "diff_added");
  alias("loc_removed", "diff_removed");
  alias("reasoning_events", "thinking_called_count");
  alias("last_commit_at", "last_progress_at");
  return data;
}

export function parseState(data: unknown): AfkState {
  return AfkStateSchema.parse(migrateLegacyCurrentKeys(data ?? {}));
}

export function parseStateDocument(text: string): AfkState {
  return parseState(decodeDevSnapshotSniff(text));
}

export async function readState(path: string): Promise<AfkState> {
  try {
    const text = await readFile(path, "utf8");
    return parseStateDocument(text);
  } catch {
    return defaultState();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const existing = target[key];
    if (isRecord(existing) && isRecord(value)) {
      mergeInto(existing, value);
    } else {
      target[key] = value;
    }
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
  const leaf = parts[parts.length - 1]!;
  const existing = cursor[leaf];
  if (isRecord(existing) && isRecord(value)) {
    mergeInto(existing, value);
  } else {
    cursor[leaf] = value;
  }
}

function isStampedIdentityValue(value: unknown): boolean {
  if (typeof value === "string") return value !== "";
  if (typeof value === "number") return value !== 0;
  return value !== undefined && value !== null;
}

function restoreStampedDotted(
  target: Record<string, unknown>,
  previous: Record<string, unknown>,
  key: string,
): void {
  const parts = key.split(".").filter(Boolean);
  let prev: unknown = previous;
  for (const part of parts) {
    if (!isRecord(prev)) return;
    prev = prev[part];
  }
  if (!isStampedIdentityValue(prev)) return;
  setDotted(target, key, prev);
}

function dottedValue(target: Record<string, unknown>, key: string): unknown {
  let value: unknown = target;
  for (const part of key.split(".").filter(Boolean)) {
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

const IMMUTABLE_STATE_FIELDS = [
  "worker_id",
  "pid_start_time",
  "started_at",
  "origin",
  "runner",
  "current.kind",
  "current.number",
  "current.started_at",
  "current.runner",
] as const;

const STICKY_NONEMPTY_STATE_FIELDS = ["current.model_tier", "current.model", "current.effort"] as const;

export interface UpdateStateOptions {
  /** Only true at real attempt teardown, when the worker is no longer live. */
  allowPidReset?: boolean;
}

const stateUpdateQueues = new Map<string, Promise<void>>();

function preserveStampedIdentity(
  next: Record<string, unknown>,
  previous: AfkState,
  options: UpdateStateOptions,
): void {
  const prev = previous as unknown as Record<string, unknown>;
  for (const key of IMMUTABLE_STATE_FIELDS) restoreStampedDotted(next, prev, key);
  for (const key of STICKY_NONEMPTY_STATE_FIELDS) {
    if (!isStampedIdentityValue(dottedValue(next, key))) restoreStampedDotted(next, prev, key);
  }
  if (previous.pid > 0 && !options.allowPidReset) {
    next.pid = previous.pid;
  } else if (previous.pid > 0 && next.pid !== 0) {
    next.pid = previous.pid;
  }
}

export async function writeStateAtomic(path: string, state: AfkState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, encodeDevSnapshotToon(AfkStateSchema.parse(state) as unknown as ToonValue), "utf8");
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
  writeFileSync(tmp, encodeDevSnapshotToon(AfkStateSchema.parse(parsed) as unknown as ToonValue), "utf8");
  renameSync(tmp, path);
  return parsed;
}

async function updateStateUnlocked(
  path: string,
  updates: Record<string, unknown>,
  options: UpdateStateOptions = {},
): Promise<AfkState> {
  const previous = await readState(path);
  const state = structuredClone(previous) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) setDotted(state, key, value);
  preserveStampedIdentity(state, previous, options);
  const parsed = parseState(state);
  await writeStateAtomic(path, parsed);
  return parsed;
}

export async function updateState(
  path: string,
  updates: Record<string, unknown>,
  options: UpdateStateOptions = {},
): Promise<AfkState> {
  const previous = stateUpdateQueues.get(path) ?? Promise.resolve();
  const op = previous.catch(() => undefined).then(() => updateStateUnlocked(path, updates, options));
  const tail = op.then(
    () => undefined,
    () => undefined,
  );
  stateUpdateQueues.set(path, tail);
  tail.finally(() => {
    if (stateUpdateQueues.get(path) === tail) stateUpdateQueues.delete(path);
  });
  return op;
}

export type PidStartTimeProbe = (pid: number) => string | null;

export interface PidStartTimeSources {
  readProcStat?(pid: number): string;
  readPsStart?(pid: number): string | null;
}

function portablePsStartTime(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim().replace(/\s+/g, " ");
  return value || null;
}

export function readPidStartTime(pid: number, sources: PidStartTimeSources = {}): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = (sources.readProcStat ?? ((candidate) => readFileSync(`/proc/${candidate}/stat`, "utf8")))(pid);
    const commEnd = stat.lastIndexOf(")");
    if (commEnd === -1) return null;
    const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    const psStart = (sources.readPsStart ?? portablePsStartTime)(pid)?.trim().replace(/\s+/g, " ");
    return psStart ? `ps:${psStart}` : null;
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
