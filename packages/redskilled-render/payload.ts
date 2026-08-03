/**
 * payload — the document this module draws, declared by the reader.
 *
 * **The render is a consumer of a wire document, not of the daemon's internals.**
 * One daemon serves checkouts pinned to different bundle versions (ADR 0130 rule
 * 3), so the shape a surface may rely on is the shape it can still read when the
 * writer is a release ahead or behind. That is why the contract is declared here,
 * on the reading side, and why it names only the fields a layout actually draws:
 * a renderer that demanded the daemon's whole internal record would blank a pane
 * over a field it never prints.
 *
 * **Every block the daemon may not carry is optional, and absence is never zero.**
 * A missing `deaths` block is a daemon that never reaped; an empty one is a
 * reaping that attributed nothing. A missing `metrics` block is a daemon that
 * derives none; a null rate inside one is a window nobody measured. Collapsing
 * either pair is how a broken observer renders as a calm machine.
 *
 * The daemon's own `RedskilledStatuslinePayload` is a superset of this and is
 * assignable to it — `apps/redskilled/tests/render-payload-contract.test.ts` is
 * the ratchet that fails the moment it stops being.
 */

/** Which Workers a surface is about. */
export type RedskilledStatuslineMode = "local" | "global";

/** Which instrument produced a memory figure; `null` when the daemon named none. */
export type RedskilledRenderRssSource = "cgroup" | "process-tree" | (string & {});

/** One Worker's measured consumption, or the honest absence of it. */
export interface RedskilledRenderVitals {
  /** Tree RSS at the last sample, in bytes; `null` when nothing measured it. */
  readonly rss_bytes: number | null;
  readonly sampled_at: string | null;
  readonly age_ms: number | null;
  readonly fresh: boolean;
  readonly rss_source?: RedskilledRenderRssSource | null;
}

/** What a Worker was promised, and how much of it the daemon has seen it take. */
export interface RedskilledRenderWorkerBudget {
  readonly declared: string | null;
  readonly bytes: number | null;
  readonly used_bytes: number | null;
  readonly used_fraction: number | null;
  readonly enforceable: boolean;
}

/** The last line a Worker logged, as the daemon received it. */
export interface RedskilledRenderWorkerLog {
  readonly last_line: string | null;
  readonly published_at: string | null;
}

/** What a Worker's project says a surface should SHOW about it. */
export interface RedskilledRenderWorkerDisplay {
  readonly runner: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly origin: string | null;
  readonly issue: string | null;
  readonly phase: string | null;
  readonly step: string | null;
  readonly phase_index: number | null;
  readonly phase_total: number | null;
  readonly failed: boolean;
  readonly heartbeat: string | null;
  readonly wait_kind: string | null;
  readonly wait_subject: string | null;
  readonly wait_pid: number | null;
  readonly wait_started_at: string | null;
  readonly wait_deadline: string | null;
  readonly wait_escalation: string | null;
  /** When the work started, ISO-8601. `elapsed` is derived from it, never published. */
  readonly started_at: string | null;
  /** Input-side tokens on the last turn — the context window's occupancy. */
  readonly context: number | null;
  /** Seconds the project expects the work still to take; `null` when it will not say. */
  readonly eta: number | null;
  readonly added: number | null;
  readonly removed: number | null;
  readonly tokens: number | null;
  readonly tools: number | null;
  readonly reasoning: number | null;
  readonly text: number | null;
}

/** A display record that says nothing — the honest shape of an unpublished row. */
export const REDSKILLED_RENDER_DISPLAY_ABSENT: RedskilledRenderWorkerDisplay = {
  runner: null,
  model: null,
  effort: null,
  origin: null,
  issue: null,
  phase: null,
  step: null,
  phase_index: null,
  phase_total: null,
  failed: false,
  heartbeat: null,
  wait_kind: null,
  wait_subject: null,
  wait_pid: null,
  wait_started_at: null,
  wait_deadline: null,
  wait_escalation: null,
  started_at: null,
  context: null,
  eta: null,
  added: null,
  removed: null,
  tokens: null,
  tools: null,
  reasoning: null,
  text: null,
};

export interface RedskilledRenderWorker {
  readonly worker_id: string;
  readonly project_label: string;
  readonly pid: number;
  readonly started_at: string;
  readonly uptime_ms: number | null;
  readonly vitals: RedskilledRenderVitals;
  readonly budget: RedskilledRenderWorkerBudget;
  readonly log: RedskilledRenderWorkerLog;
  readonly display?: RedskilledRenderWorkerDisplay | null;
  readonly display_published_at?: string | null;
}

/**
 * How long this Worker has been on the work it is showing. PURE.
 *
 * **The work's span, when the project stated one; the process's otherwise.** A
 * Worker that finished one item and took another is one process and two spans,
 * and `uptime_ms` — dated by the daemon, which is not told what a work item is —
 * can only ever describe the first. `display.started_at` is the project saying
 * when THIS span began, so it wins wherever it exists.
 *
 * **Derived here, never published.** Two surfaces that each carried their own
 * elapsed figure would disagree about now within one sampling interval; both read
 * this instead, against the one clock the payload was dated by.
 */
export function workerElapsedMs(worker: RedskilledRenderWorker, generatedAt: string): number | null {
  const startedAt = worker.display?.started_at;
  if (startedAt != null && startedAt !== "") {
    const started = Date.parse(startedAt);
    const now = Date.parse(generatedAt);
    if (Number.isFinite(started) && Number.isFinite(now)) return Math.max(0, now - started);
  }
  return worker.uptime_ms;
}

/** One project's share of the machine. */
export interface RedskilledRenderProject {
  readonly project_label: string;
  readonly worker_count: number;
  readonly observed_rss_bytes: number;
  readonly measured_worker_count: number;
}

/** The ceilings this host enforces; `null` on any dimension it does not. */
export interface RedskilledRenderCeiling {
  readonly memory_bytes: number | null;
  readonly worker_count: number | null;
}

/** What the host is charged with right now. */
export interface RedskilledRenderConsumption {
  readonly memory_bytes: number;
}

/** The host aggregate — the numbers an operator feels before an incident. */
export interface RedskilledRenderHost {
  readonly worker_count: number;
  readonly project_count: number;
  readonly ceiling: RedskilledRenderCeiling;
  readonly consumption: RedskilledRenderConsumption;
  readonly observed_rss_bytes: number;
  readonly measured_worker_count: number;
  readonly ceiling_used_fraction: number | null;
}

/** How current this answer is, decided by the daemon and rendered by a surface. */
export interface RedskilledRenderStaleness {
  readonly sampled_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  readonly stale: boolean;
  readonly measured_worker_count: number;
  readonly unmeasured_workers: readonly string[];
  readonly reason: string;
}

/** Which daemon answered, so two answers can be told apart rather than averaged. */
export interface RedskilledRenderDaemon {
  readonly pid: number;
  readonly daemon_version: string;
  readonly protocol_version: number;
  readonly started_at: string;
}

/** One posed death, reduced to what a surface prints. */
export interface RedskilledRenderDeath {
  readonly kind: string;
  readonly id: string;
  readonly pid: number;
  readonly ts: string;
  readonly last_seen: string;
  readonly last_phase: string;
  readonly sender_class: string;
  readonly confidence: string;
  readonly signal: string | null;
  readonly evidence: string | null;
}

/** What this host could not explain, as of the last reaping. */
export interface RedskilledRenderDeaths {
  readonly count: number;
  readonly recent: readonly RedskilledRenderDeath[];
  readonly latest: RedskilledRenderDeath | null;
  readonly reaped_at: string | null;
}

/** Which engine is answering, and whether it is the current one. */
export interface RedskilledRenderEngine {
  readonly running_version: string;
  readonly published_version: string | null;
  readonly newer_published: boolean;
  readonly major_held: boolean;
  readonly current: boolean | null;
}

/** One derived figure, with the reason it has no value. */
export interface RedskilledRenderMetricValue {
  readonly value: number | null;
  readonly absent_reason: string | null;
  readonly samples: number;
}

/** One key's share of a window — a runner name, or a model name. */
export interface RedskilledRenderUsageShare {
  readonly key: string;
  readonly worker_count: number;
  readonly share: number;
}

/** How a window's Workers divide over one dimension. */
export interface RedskilledRenderUsageShares {
  readonly attributed_workers: number;
  readonly unattributed_workers: number;
  readonly shares: readonly RedskilledRenderUsageShare[];
  readonly absent_reason: string | null;
}

/** Everything one rolling window has to say. */
export interface RedskilledRenderMetricsWindow {
  readonly window_ms: number;
  readonly from: string;
  readonly to: string;
  readonly tokens_per_min: RedskilledRenderMetricValue;
  readonly tools_per_min: RedskilledRenderMetricValue;
  readonly issues_per_hour: RedskilledRenderMetricValue;
  readonly runner_share: RedskilledRenderUsageShares;
  readonly model_share: RedskilledRenderUsageShares;
  readonly unavailable: readonly string[];
}

/** The metrics block, as it travels on the aggregate payload. */
export interface RedskilledRenderMetrics {
  readonly generated_at: string;
  readonly hour: RedskilledRenderMetricsWindow;
  readonly day: RedskilledRenderMetricsWindow;
}

/** One project's repository counts; `null` for every outcome but a count. */
export interface RedskilledRenderActivityCounts {
  readonly open_pull_requests: number;
  readonly open_issues: number;
  readonly recently_closed: number;
}

export interface RedskilledRenderActivityProject {
  readonly project_label: string;
  readonly repository: string;
  readonly counts: RedskilledRenderActivityCounts | null;
  readonly stale?: boolean;
}

/** Each registered project's repository counts, dated on their own clock. */
export interface RedskilledRenderActivity {
  readonly fetched_at: string | null;
  readonly age_ms: number | null;
  readonly stale: boolean;
  readonly projects: readonly RedskilledRenderActivityProject[];
  readonly reason: string;
}

/** The graduated breaker's state, made observable. */
export type RedskilledRenderBalancePosture = "open" | "reserved" | "spent" | "unknown";

/** What the TOKEN has left, asked rather than counted, with its own age. */
export interface RedskilledRenderBalance {
  readonly asked_at: string | null;
  readonly age_ms: number | null;
  readonly stale: boolean;
  readonly posture: RedskilledRenderBalancePosture;
  readonly reserved_fraction: number;
  readonly reason: string;
}

/**
 * One decoded answer to "what is this machine doing".
 *
 * Every optional block is one a daemon of another version may not carry, and a
 * surface that finds it absent draws nothing rather than a zero.
 */
export interface RedskilledRenderPayload {
  readonly version: 1;
  readonly generated_at: string;
  readonly daemon: RedskilledRenderDaemon;
  readonly staleness: RedskilledRenderStaleness;
  readonly host: RedskilledRenderHost;
  readonly projects: readonly RedskilledRenderProject[];
  readonly workers: readonly RedskilledRenderWorker[];
  readonly known_projects?: readonly string[];
  readonly registered_projects?: readonly string[];
  readonly lapsed_projects?: readonly {
    readonly project_label: string;
    readonly at: string;
    readonly reason: string;
  }[];
  readonly repository_activity?: RedskilledRenderActivity;
  readonly github_balance?: RedskilledRenderBalance;
  readonly deaths?: RedskilledRenderDeaths;
  readonly engine?: RedskilledRenderEngine;
  readonly metrics?: RedskilledRenderMetrics;
  /**
   * Which count-scaling extras the composer deliberately left out.
   *
   * A withheld block and a missing measurement are opposite facts wearing the
   * same `null`: a Worker whose vitals nobody asked for and a Worker nobody
   * measured both carry `rss_bytes: null`, and only this field tells them apart.
   * Absent — never `[]` — on a full response, so its presence alone means
   * something was left out.
   */
  readonly withheld?: readonly ("logs" | "vitals" | "display")[];
}

/**
 * True when `value` is a payload this module can draw — fail-closed. PURE.
 *
 * The check stops at the skeleton every density needs, because a daemon that grew
 * a field this reader has never heard of still serves a drawable answer and
 * rejecting it would blank a surface over version skew (ADR 0130 rule 3).
 */
export function isRedskilledRenderPayload(value: unknown): value is RedskilledRenderPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (payload.version !== 1 || typeof payload.generated_at !== "string") return false;
  if (!Array.isArray(payload.workers) || !Array.isArray(payload.projects)) return false;
  const host = payload.host as Record<string, unknown> | undefined;
  const staleness = payload.staleness as Record<string, unknown> | undefined;
  const daemon = payload.daemon as Record<string, unknown> | undefined;
  return host != null && typeof host === "object" && typeof host.worker_count === "number" &&
    staleness != null && typeof staleness === "object" && typeof staleness.stale === "boolean" &&
    daemon != null && typeof daemon === "object" && typeof daemon.daemon_version === "string";
}
