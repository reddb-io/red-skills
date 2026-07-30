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
  /**
   * What the last sample measured this Worker's tree burning, beside its budget.
   *
   * It rides here for the same reason the budget does — a number stated once at
   * launch is a number no later reader can ask for — and it is a MEASUREMENT, not
   * a verdict: the daemon reports the CPU a tree accumulated and says nothing
   * about whether the project's task is going well (ADR 0130 rule 3).
   */
  readonly cpu?: RedskilledWorkerCpuSample;
  /** Non-empty whenever the launch was a downgrade; never silently absent. */
  readonly warnings: readonly string[];
}

/**
 * One reading of a Worker tree's accumulated CPU time.
 *
 * The instant travels WITH the number rather than beside it, because one dated
 * reading answers nothing on its own: "is this Worker working?" is two dated
 * readings compared, and a value whose age a reader had to infer is a value that
 * will one day be read as fresh long after the tick that took it.
 */
export interface RedskilledWorkerCpuSample {
  /** `utime + stime` summed over the whole tree, in seconds. */
  readonly cpu_seconds: number;
  /** When the daemon took this reading — the daemon's clock, never the reader's. */
  readonly sampled_at: string;
}

/** One project with at least one Worker on this host. Empty in this slice. */
export interface RedskilledProjectView {
  readonly project_label: string;
  readonly worker_count: number;
}

/**
 * What the daemon is running, and what it has observed being published.
 *
 * Two fields rather than one, and never collapsed: `running_version` is the code
 * answering this read, `published_version` is a resolved observation about the
 * world. Folding the second into the first is how a stale process reports a
 * confident zero skew while every Worker halts on the version it claimed to
 * measure (#2809), so the daemon states both and compares them out loud.
 */
export interface RedskilledUpgradeState {
  /** Identical to `daemon_version`, from the same value — never re-derived. */
  readonly running_version: string;
  /** The published version last resolved; null when it never was. */
  readonly published_version: string | null;
  /** 1 when the published answer could not be resolved at all. */
  readonly published_unknown: number;
  /** 1 when a newer version was resolved and this daemon is not it. */
  readonly newer_published: number;
  /** Where the replacement stands: nothing to do, decided, or under way. */
  readonly replacement: "none" | "pending" | "in-progress";
  /** When the published answer was last observed; null when it never was. */
  readonly checked_at: string | null;
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
  /** Running version against published version, and what is being done about it. */
  readonly upgrade: RedskilledUpgradeState;
}

export interface BuildHostStateInput {
  readonly daemonVersion: string;
  readonly machineIdHash: string;
  readonly sessionKeyHash: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly workers?: readonly RedskilledWorkerView[];
  /** The version observation; a daemon that never checked reports unknown. */
  readonly published?: {
    readonly version: string | null;
    readonly checkedAt: string | null;
    /** Whether the observed version supersedes the running one — the daemon decides. */
    readonly newer?: boolean;
    readonly replacement?: RedskilledUpgradeState["replacement"];
  };
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
    upgrade: buildUpgradeState(input),
  };
}

/**
 * The version block. PURE.
 *
 * `running_version` is the SAME value the document reports as `daemon_version`,
 * read from one input: a second source for "what am I running" is a second answer
 * waiting to disagree with the first.
 */
export function buildUpgradeState(input: BuildHostStateInput): RedskilledUpgradeState {
  const running = input.daemonVersion;
  const published = input.published?.version ?? null;
  return {
    running_version: running,
    published_version: published,
    published_unknown: Number(published === null),
    newer_published: Number(input.published?.newer === true),
    replacement: input.published?.replacement ?? "none",
    checked_at: input.published?.checkedAt ?? null,
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
    Array.isArray(worker.warnings) &&
    // Checked only when present, exactly as the upgrade block is: a daemon that
    // has not sampled yet, or one older than the reading, is complete without it.
    (worker.cpu === undefined || isRedskilledWorkerCpuSample(worker.cpu));
}

/** True when `value` is a complete CPU reading — a client's fail-closed check. */
export function isRedskilledWorkerCpuSample(value: unknown): value is RedskilledWorkerCpuSample {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const sample = value as Record<string, unknown>;
  return typeof sample.cpu_seconds === "number" &&
    Number.isFinite(sample.cpu_seconds) &&
    typeof sample.sampled_at === "string";
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
    isRedskilledBudgetAccounting(state.budget_accounting) &&
    // Checked only when present. One daemon serves checkouts pinned to different
    // bundle versions (ADR 0130 rule 3), so a field this bundle added must not
    // make an older daemon's complete answer read as malformed — while a field
    // that IS there and is the wrong shape still fails closed.
    (state.upgrade === undefined || isRedskilledUpgradeState(state.upgrade));
}

/** True when `value` is a complete version block. */
export function isRedskilledUpgradeState(value: unknown): value is RedskilledUpgradeState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const upgrade = value as Record<string, unknown>;
  return typeof upgrade.running_version === "string" &&
    (upgrade.published_version === null || typeof upgrade.published_version === "string") &&
    typeof upgrade.published_unknown === "number" &&
    typeof upgrade.newer_published === "number" &&
    (upgrade.replacement === "none" || upgrade.replacement === "pending" || upgrade.replacement === "in-progress") &&
    (upgrade.checked_at === null || typeof upgrade.checked_at === "string");
}
