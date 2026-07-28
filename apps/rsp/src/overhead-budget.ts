import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";
import { decode, encode, type JsonValue } from "@reddb-io/toon";

/**
 * The overhead budget rsp holds itself to (#2746).
 *
 * rsp measured the savings it produced and never the cost it imposed, so a
 * wrapper that taxed every command — a fat self-state file read per call, a
 * resident that never answered — looked exactly like a wrapper that worked.
 * Fail-open stays the invariant; silence does not. Every invocation records the
 * wall clock rsp itself added and the bytes it read from its own state, and a
 * family that breaks the ceiling for N consecutive invocations self-disables
 * and says why where an operator sees it.
 */

export const RSP_OVERHEAD_LEDGER_FILE = "overhead-budget.toon";
export const RSP_OVERHEAD_SCHEMA_VERSION = "red.rsp.overhead.v1";

/** Wall clock rsp may add on top of the command it wraps, per invocation. */
export const DEFAULT_RSP_MAX_OVERHEAD_MS = 250;
/** Bytes rsp may read from its own state per invocation; #2745 read 10 MB. */
export const DEFAULT_RSP_MAX_SELF_STATE_BYTES = 1024 * 1024;
/** Below this, self-state reads are too small to be worth calling a net loss. */
export const DEFAULT_RSP_OVERHEAD_NET_LOSS_FLOOR_BYTES = 64 * 1024;
export const DEFAULT_RSP_OVERHEAD_CONSECUTIVE_BREACHES = 3;
/** A self-disabled family re-arms after this long instead of staying off forever. */
export const DEFAULT_RSP_OVERHEAD_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Every wrapper family that must carry overhead accounting, not just savings. */
export const RSP_OVERHEAD_FAMILIES = [
  "git",
  "gh",
  "gh-api-json",
  "vitest",
  "cargo",
  "cat",
  "exec",
  "proxy",
] as const;

export type RspOverheadFamily = (typeof RSP_OVERHEAD_FAMILIES)[number];

export type RspOverheadBreachReason =
  | "wall-clock-ceiling"
  | "self-state-byte-ceiling"
  | "overhead-exceeds-savings";

export interface RspOverheadCeiling {
  maxOverheadMs: number;
  maxSelfStateBytes: number;
  netLossFloorBytes: number;
  consecutiveBreaches: number;
  cooldownMs: number;
}

export const DEFAULT_RSP_OVERHEAD_CEILING: RspOverheadCeiling = {
  maxOverheadMs: DEFAULT_RSP_MAX_OVERHEAD_MS,
  maxSelfStateBytes: DEFAULT_RSP_MAX_SELF_STATE_BYTES,
  netLossFloorBytes: DEFAULT_RSP_OVERHEAD_NET_LOSS_FLOOR_BYTES,
  consecutiveBreaches: DEFAULT_RSP_OVERHEAD_CONSECUTIVE_BREACHES,
  cooldownMs: DEFAULT_RSP_OVERHEAD_COOLDOWN_MS,
};

export interface RspOverheadSample {
  family: string;
  /** Wall clock of the whole rsp invocation, child process included. */
  wrapperMs: number;
  /** Wall clock owned by the wrapped command; rsp never charges itself for it. */
  childMs: number;
  /** Bytes read from rsp's own state (caches, spools, ledgers) this invocation. */
  selfStateBytesRead: number;
  /** Bytes the elision actually removed from the agent's context. */
  bytesSaved: number;
}

export interface RspOverheadVerdict {
  overhead_ms: number;
  breached: boolean;
  reasons: RspOverheadBreachReason[];
}

export interface RspOverheadFamilyState {
  family: string;
  invocations: number;
  breaches: number;
  consecutive_breaches: number;
  breached: boolean;
  reasons: RspOverheadBreachReason[];
  disabled: boolean;
  disabled_at: string | null;
  disabled_until: string | null;
  disabled_reason: string | null;
  last_overhead_ms: number;
  last_self_state_bytes_read: number;
  last_bytes_saved: number;
  updated_at: string;
}

export interface RspOverheadLedger {
  version: 1;
  families: Record<string, RspOverheadFamilyState>;
}

export interface RspOverheadHealth {
  schema_version: typeof RSP_OVERHEAD_SCHEMA_VERSION;
  verdict: "green" | "red";
  summary: string;
  ceiling: RspOverheadCeiling;
  breaching_families: RspOverheadFamilyState[];
  disabled_families: RspOverheadFamilyState[];
  families: RspOverheadFamilyState[];
}

/** rsp's own added wall clock: total minus the time the wrapped command owned. */
export function overheadMsOf(sample: RspOverheadSample): number {
  const added = sample.wrapperMs - sample.childMs;
  return Number.isFinite(added) ? Math.max(0, round3(added)) : 0;
}

export function classifyOverheadSample(
  sample: RspOverheadSample,
  ceiling: RspOverheadCeiling = DEFAULT_RSP_OVERHEAD_CEILING,
): RspOverheadVerdict {
  const overhead = overheadMsOf(sample);
  const reasons: RspOverheadBreachReason[] = [];
  if (overhead > ceiling.maxOverheadMs) reasons.push("wall-clock-ceiling");
  if (sample.selfStateBytesRead > ceiling.maxSelfStateBytes) reasons.push("self-state-byte-ceiling");
  // A wrapper that reads more of its own state than it removed from the agent's
  // context is taxing the command it claims to optimise. The floor keeps a
  // handful of bookkeeping bytes from reading as a defect.
  if (
    sample.selfStateBytesRead > ceiling.netLossFloorBytes &&
    sample.selfStateBytesRead > sample.bytesSaved
  ) {
    reasons.push("overhead-exceeds-savings");
  }
  return { overhead_ms: overhead, breached: reasons.length > 0, reasons };
}

/** The overhead fields every wrapper family writes alongside its savings. */
export function overheadTelemetryFields(
  sample: RspOverheadSample,
  ceiling: RspOverheadCeiling = DEFAULT_RSP_OVERHEAD_CEILING,
): {
  wrapper_ms: number;
  overhead_ms: number;
  child_ms: number;
  self_state_bytes_read: number;
  bytes_saved: number;
  overhead_breached: boolean;
  overhead_breach_reasons: string;
} {
  const verdict = classifyOverheadSample(sample, ceiling);
  return {
    wrapper_ms: round3(sample.wrapperMs),
    overhead_ms: verdict.overhead_ms,
    child_ms: round3(Math.max(0, sample.childMs)),
    self_state_bytes_read: Math.max(0, Math.trunc(sample.selfStateBytesRead)),
    bytes_saved: Math.max(0, Math.trunc(sample.bytesSaved)),
    overhead_breached: verdict.breached,
    overhead_breach_reasons: verdict.reasons.join(","),
  };
}

export function overheadLedgerPath(root: string): string {
  return join(rspStateDir(root), RSP_OVERHEAD_LEDGER_FILE);
}

export function readOverheadLedger(root: string): RspOverheadLedger {
  try {
    const raw = readFileSync(overheadLedgerPath(root), "utf8");
    const parsed = decodeLedger(raw);
    if (isLedger(parsed)) return parsed;
  } catch {}
  return { version: 1, families: {} };
}

/**
 * Fold one invocation into the ledger and return the family's new state.
 *
 * Best-effort by construction: an unwritable ledger degrades to accounting the
 * sample in memory. A budget that breaks the build is worse than a budget that
 * misses a sample.
 */
export function recordOverheadSample(
  root: string,
  sample: RspOverheadSample,
  ceiling: RspOverheadCeiling = DEFAULT_RSP_OVERHEAD_CEILING,
  nowMs: number = Date.now(),
): RspOverheadFamilyState {
  const ledger = readOverheadLedger(root);
  const verdict = classifyOverheadSample(sample, ceiling);
  const previous = ledger.families[sample.family] ?? emptyFamilyState(sample.family, nowMs);
  const rearmed = expiredCooldown(previous, nowMs) ? clearDisabled(previous) : previous;
  const consecutive = verdict.breached ? rearmed.consecutive_breaches + 1 : 0;
  const next: RspOverheadFamilyState = {
    ...rearmed,
    family: sample.family,
    invocations: rearmed.invocations + 1,
    breaches: rearmed.breaches + (verdict.breached ? 1 : 0),
    consecutive_breaches: consecutive,
    breached: verdict.breached,
    reasons: verdict.reasons,
    last_overhead_ms: verdict.overhead_ms,
    last_self_state_bytes_read: Math.max(0, Math.trunc(sample.selfStateBytesRead)),
    last_bytes_saved: Math.max(0, Math.trunc(sample.bytesSaved)),
    updated_at: new Date(nowMs).toISOString(),
  };
  if (!verdict.breached) {
    next.disabled = false;
    next.disabled_at = null;
    next.disabled_until = null;
    next.disabled_reason = null;
  } else if (consecutive >= ceiling.consecutiveBreaches) {
    next.disabled = true;
    next.disabled_at = new Date(nowMs).toISOString();
    next.disabled_until = new Date(nowMs + ceiling.cooldownMs).toISOString();
    next.disabled_reason = disabledReason(sample.family, consecutive, verdict, ceiling);
  }
  ledger.families[sample.family] = next;
  writeOverheadLedger(root, ledger);
  return next;
}

/**
 * The disabled state a wrapper must honour before it runs, or null when the
 * family is in budget (or its cooldown has lapsed and it may probe again).
 */
export function overheadFamilyDisabled(
  root: string,
  family: string,
  nowMs: number = Date.now(),
): RspOverheadFamilyState | null {
  const state = readOverheadLedger(root).families[family];
  if (!state?.disabled) return null;
  if (expiredCooldown(state, nowMs)) return null;
  return state;
}

export function resetOverheadLedger(root: string, family?: string): RspOverheadLedger {
  const ledger = readOverheadLedger(root);
  if (family) delete ledger.families[family];
  else ledger.families = {};
  writeOverheadLedger(root, ledger);
  return ledger;
}

/** The operator-facing verdict: red the moment a ceiling is being breached. */
export function overheadHealth(
  root: string,
  ceiling: RspOverheadCeiling = DEFAULT_RSP_OVERHEAD_CEILING,
  nowMs: number = Date.now(),
): RspOverheadHealth {
  const families = Object.values(readOverheadLedger(root).families)
    .map((state) => (expiredCooldown(state, nowMs) ? clearDisabled(state) : state))
    .sort((a, b) => a.family.localeCompare(b.family));
  const disabled = families.filter((state) => state.disabled);
  const breaching = families.filter((state) => state.consecutive_breaches > 0);
  const verdict: "green" | "red" = disabled.length > 0 || breaching.length > 0 ? "red" : "green";
  return {
    schema_version: RSP_OVERHEAD_SCHEMA_VERSION,
    verdict,
    summary: healthSummary(verdict, disabled, breaching),
    ceiling,
    breaching_families: breaching,
    disabled_families: disabled,
    families,
  };
}

// ---------------------------------------------------------------------------
// Per-invocation counters
//
// The overhead of one rsp process is ambient: any module that reads rsp's own
// state or waits on a child reports it here, and the invocation seam consumes
// the total once, at the point it already knows its wall clock.
// ---------------------------------------------------------------------------

let selfStateBytesRead = 0;
let childProcessMs = 0;

export function noteSelfStateBytesRead(bytes: number): void {
  if (Number.isFinite(bytes) && bytes > 0) selfStateBytesRead += bytes;
}

export function noteChildProcessMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) childProcessMs += ms;
}

export function overheadCounters(): { selfStateBytesRead: number; childMs: number } {
  return { selfStateBytesRead, childMs: childProcessMs };
}

export function resetOverheadCounters(): void {
  selfStateBytesRead = 0;
  childProcessMs = 0;
}

/** Time a spawned child so its runtime is never charged to rsp's own overhead. */
export function startChildProcessTimer(): () => void {
  const started = process.hrtime.bigint();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    noteChildProcessMs(Number(process.hrtime.bigint() - started) / 1_000_000);
  };
}

/** Read one of rsp's own state files, charging its bytes to this invocation. */
export async function readSelfStateFile(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  noteSelfStateBytesRead(Buffer.byteLength(text));
  return text;
}

export function readSelfStateFileSync(path: string): string {
  const text = readFileSync(path, "utf8");
  noteSelfStateBytesRead(Buffer.byteLength(text));
  return text;
}

function disabledReason(
  family: string,
  consecutive: number,
  verdict: RspOverheadVerdict,
  ceiling: RspOverheadCeiling,
): string {
  const detail = verdict.reasons.map((reason) => {
    if (reason === "wall-clock-ceiling") return `added ${verdict.overhead_ms}ms > ${ceiling.maxOverheadMs}ms`;
    if (reason === "self-state-byte-ceiling") return `self-state read > ${ceiling.maxSelfStateBytes}B`;
    return "self-state read exceeded bytes saved";
  }).join("; ");
  return `rsp ${family} exceeded its overhead ceiling on ${consecutive} consecutive invocations (${detail}); wrapper self-disabled, commands pass through raw`;
}

function healthSummary(
  verdict: "green" | "red",
  disabled: RspOverheadFamilyState[],
  breaching: RspOverheadFamilyState[],
): string {
  if (verdict === "green") return "every wrapper family is inside its overhead ceiling";
  const parts: string[] = [];
  if (disabled.length > 0) {
    parts.push(`self-disabled: ${disabled.map((state) => `${state.family} (${state.reasons.join(",") || "ceiling"})`).join(", ")}`);
  }
  if (breaching.length > 0) {
    parts.push(`breaching: ${breaching.map((state) => `${state.family} x${state.consecutive_breaches}`).join(", ")}`);
  }
  return parts.join("; ");
}

function expiredCooldown(state: RspOverheadFamilyState, nowMs: number): boolean {
  if (!state.disabled || !state.disabled_until) return false;
  const until = Date.parse(state.disabled_until);
  return Number.isFinite(until) && until <= nowMs;
}

function clearDisabled(state: RspOverheadFamilyState): RspOverheadFamilyState {
  return {
    ...state,
    disabled: false,
    disabled_at: null,
    disabled_until: null,
    disabled_reason: null,
    consecutive_breaches: 0,
    breached: false,
    reasons: [],
  };
}

function emptyFamilyState(family: string, nowMs: number): RspOverheadFamilyState {
  return {
    family,
    invocations: 0,
    breaches: 0,
    consecutive_breaches: 0,
    breached: false,
    reasons: [],
    disabled: false,
    disabled_at: null,
    disabled_until: null,
    disabled_reason: null,
    last_overhead_ms: 0,
    last_self_state_bytes_read: 0,
    last_bytes_saved: 0,
    updated_at: new Date(nowMs).toISOString(),
  };
}

function writeOverheadLedger(root: string, ledger: RspOverheadLedger): void {
  try {
    const path = overheadLedgerPath(root);
    // rsp never mints `.red/` (ADR 0067): no repo opt-in, no ledger.
    if (!existsSync(join(root, ".red"))) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${encode(ledger as unknown as JsonValue)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch {}
}

function decodeLedger(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return decode(raw);
  }
}

function isLedger(value: unknown): value is RspOverheadLedger {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.families)) return false;
  return Object.values(value.families).every(isFamilyState);
}

function isFamilyState(value: unknown): value is RspOverheadFamilyState {
  return isRecord(value) &&
    typeof value.family === "string" &&
    typeof value.consecutive_breaches === "number" &&
    typeof value.disabled === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round3(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}
