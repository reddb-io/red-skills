/**
 * host-state — what the daemon knows about the machine, in one document.
 *
 * At this slice the answer is legitimately **empty**: no Worker is born yet, so
 * `workers` and `projects` are empty arrays. Empty is not the same as absent,
 * and the difference is the point — a client must be able to tell "the daemon is
 * up and nothing is running" from "the daemon did not answer". So the shape is
 * total from the first slice: every field is present, the collections are always
 * arrays, and a reader written today keeps working when the arrays fill.
 *
 * Read the host, write the project (ADR 0130 rule 9): this document is the read
 * half, and it is host-wide on purpose.
 */
import { REDSKILLED_PROTOCOL_VERSION } from "./protocol.js";

/** One Worker process, as the daemon sees it. Empty in this slice by construction. */
export interface RedskilledWorkerView {
  readonly worker_id: string;
  readonly project_label: string;
  readonly pid: number;
  readonly started_at: string;
}

/** One project with at least one Worker on this host. Empty in this slice. */
export interface RedskilledProjectView {
  readonly project_label: string;
  readonly worker_count: number;
}

export interface RedskilledHostState {
  readonly version: 1;
  readonly protocol_version: number;
  readonly daemon_version: string;
  readonly machine_id_hash: string;
  readonly session_key_hash: string;
  readonly pid: number;
  readonly started_at: string;
  readonly workers: readonly RedskilledWorkerView[];
  readonly projects: readonly RedskilledProjectView[];
}

export interface BuildHostStateInput {
  readonly daemonVersion: string;
  readonly machineIdHash: string;
  readonly sessionKeyHash: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly workers?: readonly RedskilledWorkerView[];
}

/** The host state document. PURE — projects are derived, never separately tracked. */
export function buildHostState(input: BuildHostStateInput): RedskilledHostState {
  const workers = [...(input.workers ?? [])];
  const counts = new Map<string, number>();
  for (const worker of workers) counts.set(worker.project_label, (counts.get(worker.project_label) ?? 0) + 1);
  return {
    version: 1,
    protocol_version: REDSKILLED_PROTOCOL_VERSION,
    daemon_version: input.daemonVersion,
    machine_id_hash: input.machineIdHash,
    session_key_hash: input.sessionKeyHash,
    pid: input.pid,
    started_at: input.startedAt,
    workers,
    projects: [...counts.entries()]
      .map(([project_label, worker_count]) => ({ project_label, worker_count }))
      .sort((a, b) => a.project_label.localeCompare(b.project_label)),
  };
}

/** True when `value` is a complete host-state document — a client's fail-closed check. */
export function isRedskilledHostState(value: unknown): value is RedskilledHostState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 &&
    typeof state.protocol_version === "number" &&
    typeof state.daemon_version === "string" &&
    typeof state.machine_id_hash === "string" &&
    typeof state.session_key_hash === "string" &&
    Number.isInteger(state.pid) &&
    typeof state.started_at === "string" &&
    Array.isArray(state.workers) &&
    Array.isArray(state.projects);
}
