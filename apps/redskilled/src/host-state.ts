/**
 * host-state — what the daemon knows about the machine, in one document.
 *
 * A client must be able to tell "the daemon is up and nothing is running" from
 * "the daemon did not answer", so the shape is total: every field is present and
 * the collections are always arrays, empty included.
 *
 * Read the host, write the project (ADR 0130 rule 9): this document is the read
 * half, and it is host-wide on purpose.
 */
import {
  buildBudgetAccounting,
  isRedskilledBudgetAccounting,
  type RedskilledBudgetAccounting,
} from "./budget-accounting.js";
import { REDSKILLED_PROTOCOL_VERSION } from "./protocol.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

/**
 * One Worker process, as the daemon sees it.
 *
 * `project_label` and `workspace_path` are the client's own opaque strings,
 * echoed back untouched — the daemon stores what it was given and interprets
 * nothing. `isolated` and `warnings` travel WITH the Worker rather than being
 * reported once at birth, so a reader of host state can still see that a
 * long-lived Worker never got a unit of its own.
 */
export interface RedskilledWorkerView {
  readonly worker_id: string;
  readonly project_label: string;
  readonly pid: number;
  readonly started_at: string;
  /** The path the client handed over, used verbatim as the Worker's workspace. */
  readonly workspace_path: string;
  /**
   * Where this Worker's log is, when the client said so at spawn.
   *
   * Given, never derived: the daemon reads it only to rehydrate a Worker it holds
   * no heartbeat for after a restart, and a daemon that guessed a filename inside
   * the workspace would have learned a repository's layout (ADR 0130 rule 3).
   */
  readonly log_path?: string;
  /** True when the Worker runs inside a transient unit of its own. */
  readonly isolated: boolean;
  /** The transient unit's name, present only when `isolated`. */
  readonly unit?: string;
  /**
   * The budget this Worker was born under, carried for its whole life.
   *
   * It travels WITH the Worker because the host-wide accounting is derived from
   * the Worker set: a budget known only at launch would be a number the daemon
   * could state once and never again after a restart.
   */
  readonly budget?: RedskilledWorkerBudget;
  /** Non-empty whenever the launch was a downgrade; never silently absent. */
  readonly warnings: readonly string[];
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
  /** What the daemon has promised the machine, derived from `workers`. */
  readonly budget_accounting: RedskilledBudgetAccounting;
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
    budget_accounting: buildBudgetAccounting(workers),
  };
}

/** True when `value` is a complete Worker view — a client's fail-closed check. */
export function isRedskilledWorkerView(value: unknown): value is RedskilledWorkerView {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const worker = value as Record<string, unknown>;
  return typeof worker.worker_id === "string" &&
    typeof worker.project_label === "string" &&
    Number.isInteger(worker.pid) &&
    typeof worker.started_at === "string" &&
    typeof worker.workspace_path === "string" &&
    typeof worker.isolated === "boolean" &&
    Array.isArray(worker.warnings);
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
    Array.isArray(state.projects) &&
    isRedskilledBudgetAccounting(state.budget_accounting);
}
