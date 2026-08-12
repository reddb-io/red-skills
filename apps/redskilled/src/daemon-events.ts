/** Daemon-owned host-lane records that deliberately name no Worker. */
import type { RedskilledHostEvent } from "./event-lane.js";

export interface RecordDaemonStopInput {
  readonly ts: string;
  readonly pid: number;
  readonly socketPath: string;
  readonly reason: string;
  readonly detail: string;
  readonly signal?: string | null;
}

export interface RecordDaemonStartInput {
  readonly ts: string;
  readonly pid: number;
  readonly socketPath: string;
  readonly detail: string;
}

export interface RecordDaemonDeathInput {
  readonly ts: string;
  readonly pid: number;
  readonly socketPath: string;
  readonly detail: string;
  readonly reason?: "silent-death";
}

export const REDSKILLED_DAEMON_EVENT_PREFIX = "daemon:";

export function buildDaemonStopEvent(input: RecordDaemonStopInput): RedskilledHostEvent {
  return buildDaemonLifecycleEvent("daemon-stop", input, input.reason, input.signal);
}

export function buildDaemonStartEvent(input: RecordDaemonStartInput): RedskilledHostEvent {
  return buildDaemonLifecycleEvent("daemon-start", input, "started", null);
}

export function buildDaemonDeathEvent(input: RecordDaemonDeathInput): RedskilledHostEvent {
  return buildDaemonLifecycleEvent("daemon-death", input, input.reason ?? "silent-death", null);
}

function buildDaemonLifecycleEvent(
  kind: "daemon-start" | "daemon-death" | "daemon-stop",
  input: RecordDaemonStartInput | RecordDaemonDeathInput | RecordDaemonStopInput,
  reason: string,
  signal: string | null | undefined,
): RedskilledHostEvent {
  return {
    version: 1,
    ts: input.ts,
    kind,
    event: kind,
    worker_id: `${REDSKILLED_DAEMON_EVENT_PREFIX}${input.pid}`,
    project_label: "",
    pid: input.pid,
    workspace_path: input.socketPath,
    fork_sha: null,
    log_path: null,
    isolated: false,
    unit: null,
    memory_high: null,
    memory_max: null,
    cpu_weight: null,
    admission_verdict: null,
    phase: null,
    step: null,
    tokens: null,
    tools: null,
    runner: null,
    model: null,
    base_head_sha: null,
    base_commits_ahead: null,
    heal_kind: null,
    detail: input.detail,
    exit_code: null,
    signal: signal ?? null,
    reason,
  };
}
