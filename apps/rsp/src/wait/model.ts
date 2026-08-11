/**
 * model.ts — the shared vocabulary of the wait lifecycle.
 *
 * Every other module in `wait/` speaks these types; keeping them dependency-free
 * is what lets the registry, the probes, the capture spool, and the completion
 * transaction be tested in isolation.
 */
import type { JsonObject } from "@reddb-io/toon";

/** What a wait is waiting ON. */
export type WaitKind = "cmd" | "pr" | "run" | "job" | "release";

/**
 * Where a wait stands. `running` is the only non-terminal value; the other four
 * map onto the exit semaphore through {@link exitCodeFor}.
 */
export type WaitStatus = "running" | "success" | "failure" | "timeout" | "indeterminate";

/** The exit semaphore: 0 success, 1 failure, 2 timeout or indeterminate. */
export type WaitExitCode = 0 | 1 | 2;

/** A verdict about the TARGET — never about hook delivery. */
export interface Verdict {
  status: WaitStatus;
  exitCode: WaitExitCode;
  summary: string;
  details?: JsonObject;
}

/**
 * Whether the completion hooks reached their destination. Kept separate from
 * {@link Verdict} so "the PR passed but we could not wake you" can never be
 * read as "the PR failed".
 */
export interface DeliveryResult {
  status: "success" | "failure";
  errors?: JsonObject[];
}

export interface WaitOptions {
  timeoutMs: number;
  reason: string;
  signalPid?: number;
  /**
   * The signal target's start time, pinned when `--signal-pid` was validated.
   * Re-checked before the signal fires so a PID recycled during a long wait
   * cannot be mistaken for the original sleeper.
   */
  signalPidStartTime?: string;
  signal: NodeJS.Signals;
  notifyCmd?: string;
  notifyTimeoutMs: number;
  terminateGraceMs: number;
  probeTimeoutMs: number;
  resultFile?: string;
  format: "toon" | "json";
  captureBytes: number;
}

/** The `rsp.wait.registry` v1 record — the only shape new waits write. */
export interface WaitRegistryEntry {
  schema: "rsp.wait.registry";
  version: 1;
  id: string;
  kind: WaitKind;
  target: string;
  reason: string;
  pid: number;
  /**
   * The PID's start ticks. A PID alone is not an identity — the OS reuses it —
   * so a reader that finds a live PID with a DIFFERENT start time knows the
   * original wait is gone and must not treat the record as live.
   */
  pid_start_time?: string;
  started_at: string;
  deadline_at: string;
  timeout_ms: number;
  poll_tier: string;
  status: WaitStatus;
  attempts: number;
  last_observation?: JsonObject;
  last_poll_at?: string;
  /**
   * Whether this wait is using webhook acceleration ("webhook") or falling back to
   * pure polling ("polling"). Set for `pr` and `run` kinds; absent for others.
   * Transitions from "polling" → "webhook" once the forwarder confirms live
   * deliveries; never goes the other direction within a single wait lifetime.
   */
  webhook_mode?: "webhook" | "polling";
}

export interface ParsedWait {
  kind?: WaitKind | "ls" | "help";
  target?: string;
  branch?: string;
  latest?: boolean;
  tagGlob?: string;
  existing?: boolean;
  commandLine?: string;
  options: WaitOptions;
}

export const WAIT_RESULT_SCHEMA = "rsp.wait.result";
export const WAIT_REGISTRY_SCHEMA = "rsp.wait.registry";
export const WAIT_LIST_SCHEMA = "rsp.wait.list";
export const WAIT_SCHEMA_VERSION = 1;

export const DEFAULT_TIMEOUT_MS: Record<WaitKind, number> = {
  cmd: 30 * 60_000,
  pr: 45 * 60_000,
  run: 45 * 60_000,
  job: 45 * 60_000,
  release: 2 * 60 * 60_000,
};

export const DEFAULT_CAPTURE_BYTES = 16 * 1024;
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_TERMINATE_GRACE_MS = 2_000;

/**
 * The upper bound on ONE GitHub probe. A hung `gh` call must not consume the
 * whole wait: the probe is cancelled at this bound, reported as indeterminate,
 * and the poll loop tries again until the real deadline.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

export const POLL_TIERS: Record<WaitKind, string> = {
  cmd: "local-cmd:event-driven",
  pr: "github-pr:15-20s-backoff-jitter",
  run: "github-run:15-20s-backoff-jitter",
  job: "github-job:15-20s-backoff-jitter",
  release: "release:60s",
};

/** Map a terminal status onto the exit semaphore. */
export function exitCodeFor(status: Exclude<WaitStatus, "running">): WaitExitCode {
  if (status === "success") return 0;
  if (status === "failure") return 1;
  return 2;
}

export function isWaitKind(kind: unknown): kind is WaitKind {
  return kind === "cmd" || kind === "pr" || kind === "run" || kind === "job" || kind === "release";
}

export function verdictOf(status: "success" | "failure", summary: string, details?: JsonObject): Verdict {
  return { status, exitCode: exitCodeFor(status), summary, ...(details ? { details } : {}) };
}

export function indeterminate(summary: string, details?: JsonObject): Verdict {
  return { status: "indeterminate", exitCode: 2, summary, ...(details ? { details } : {}) };
}

export function running(summary: string, details?: JsonObject): Verdict {
  return { status: "running", exitCode: 2, summary, ...(details ? { details } : {}) };
}
