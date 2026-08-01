/**
 * statusline-payload — one answer to "what is this machine doing".
 *
 * **Every fact here originates from the daemon.** It is the only process that
 * holds the Worker set across projects, so a consumer that kept a private source
 * — a pid file, its own `/proc` read, a per-repository profile — would be a
 * second authority on a question that has one answer, and two surfaces would
 * eventually report different states of the same instant.
 *
 * **Staleness travels inside the payload.** The daemon measures on its own tick,
 * so a read can always land between ticks; a consumer that had to date the answer
 * itself would need the sample interval, the daemon's clock and the read's own
 * latency, and would get it subtly wrong in a different way per surface. Here the
 * age is a field, and rendering it is the whole of a consumer's job.
 *
 * **A total shape, and never a zero standing in for an absence.** An unmeasured
 * Worker carries `null` vitals and is named in `unmeasured_workers`; it never
 * reads as an idle one, because "nothing measured it" and "it is using nothing"
 * are opposite facts about a busy machine.
 *
 * PURE: the host state, the ceiling, the reading and both instants are inputs.
 */
import { measureHostConsumption, type RedskilledHostCeiling, type RedskilledHostConsumption } from "./admission.js";
import type { RedskilledBudgetAccounting } from "./budget-accounting.js";
import type { RedskilledHostState, RedskilledWorkerView } from "./host-state.js";
import { resolveEnforcedBudget, type RedskilledBudgetName, type RedskilledRssReading } from "./memory-sampler.js";
import {
  buildActivityReport,
  isRedskilledActivityReport,
  type RedskilledActivityReport,
  type RedskilledRepositoryActivity,
} from "./repository-activity.js";
import type { RedskilledWorkerLogLine } from "./worker-log.js";

/**
 * How old a sample may be before the payload calls itself stale.
 *
 * Two of the daemon's default sample windows: one missed tick is the jitter of a
 * busy host, and two is a sampler that stopped — the first must not cry wolf and
 * the second must not pass for current.
 */
export const REDSKILLED_STALENESS_MS = 30_000;

/** What a Worker is doing, as the daemon knows it. */
export type RedskilledWorkerState = "running" | "reattached";

/**
 * One Worker's measured consumption, or the honest absence of it.
 *
 * `fresh` is stated rather than left to a consumer's subtraction: it is the one
 * thing every renderer needs and the one thing each would compute differently.
 */
export interface RedskilledStatuslineVitals {
  /** Tree RSS at the last sample, in bytes; `null` when nothing measured it. */
  readonly rss_bytes: number | null;
  readonly sampled_at: string | null;
  readonly age_ms: number | null;
  /** True when this Worker was measured within the staleness window. */
  readonly fresh: boolean;
}

/** What this Worker was promised, and how much of it the daemon has seen it take. */
export interface RedskilledStatuslineWorkerBudget {
  /** The budget the floor enforces, by its own name; `null` when there is none. */
  readonly name: RedskilledBudgetName | null;
  /** The budget exactly as the client declared it, unparsed. */
  readonly declared: string | null;
  readonly bytes: number | null;
  readonly used_bytes: number | null;
  /** Observed over declared; `null` whenever either half is missing. */
  readonly used_fraction: number | null;
  /** False when no ceiling could be reduced to bytes for this Worker. */
  readonly enforceable: boolean;
}

/**
 * The last line this Worker logged, as the daemon received it.
 *
 * It rides on the payload because that is what makes the verbose view ONE read:
 * a consumer that had to open each Worker's log would pay a disk read per Worker
 * per render and would cross a project boundary to do it. `last_line` is `null`
 * for a Worker that has published nothing — never `""`, because a consumer
 * printing an empty second line is the broken render this field exists to avoid.
 */
export interface RedskilledStatuslineWorkerLog {
  readonly last_line: string | null;
  readonly published_at: string | null;
  /** How the daemon came by the line; `null` when it has none. */
  readonly source: "heartbeat" | "rehydrated" | null;
}

export interface RedskilledStatuslineWorker {
  readonly worker_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly pid: number;
  readonly started_at: string;
  readonly uptime_ms: number | null;
  readonly state: RedskilledWorkerState;
  readonly isolated: boolean;
  readonly unit: string | null;
  readonly warnings: readonly string[];
  readonly vitals: RedskilledStatuslineVitals;
  readonly budget: RedskilledStatuslineWorkerBudget;
  readonly log: RedskilledStatuslineWorkerLog;
}

/** One project's share of the machine. */
export interface RedskilledStatuslineProject {
  readonly project_label: string;
  readonly worker_count: number;
  /** Sum of this project's declared charges, in bytes. */
  readonly declared_memory_bytes: number;
  /** Sum of the measured RSS of this project's Workers, in bytes. */
  readonly observed_rss_bytes: number;
  readonly measured_worker_count: number;
}

/** The host aggregate — the numbers an operator feels before an incident. */
export interface RedskilledStatuslineHost {
  readonly worker_count: number;
  readonly project_count: number;
  readonly ceiling: RedskilledHostCeiling;
  readonly consumption: RedskilledHostConsumption;
  readonly budget_accounting: RedskilledBudgetAccounting;
  /** Sum of every measured Worker's RSS, in bytes. */
  readonly observed_rss_bytes: number;
  readonly measured_worker_count: number;
  /** Declared charge over the memory ceiling; `null` when the ceiling is lifted. */
  readonly ceiling_used_fraction: number | null;
}

/** How current this answer is, decided by the daemon and rendered by the consumer. */
export interface RedskilledStatuslineStaleness {
  readonly sampled_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  readonly stale: boolean;
  readonly measured_worker_count: number;
  /** Live Workers the last sample did not measure, by id. */
  readonly unmeasured_workers: readonly string[];
  readonly reason: string;
}

/** Which daemon answered, so two answers can be told apart rather than averaged. */
export interface RedskilledStatuslineDaemon {
  readonly pid: number;
  readonly daemon_version: string;
  readonly protocol_version: number;
  readonly started_at: string;
  readonly machine_id_hash: string;
  readonly session_key_hash: string;
}

export interface RedskilledStatuslinePayload {
  readonly version: 1;
  readonly generated_at: string;
  readonly daemon: RedskilledStatuslineDaemon;
  readonly staleness: RedskilledStatuslineStaleness;
  readonly host: RedskilledStatuslineHost;
  readonly projects: readonly RedskilledStatuslineProject[];
  /**
   * Every project label this host knows: registered, or holding a Worker.
   *
   * Beside `projects` rather than folded into it, because a project with a
   * registration and no Worker is real. Without this field a consumer could not
   * tell "this directory belongs to a project the host knows, which happens to be
   * idle" from "this directory matches no project at all", and both collapse into
   * the same idle zero — the answer #2928 was filed about.
   *
   * OPTIONAL on the wire: one daemon serves checkouts pinned to different bundle
   * versions (ADR 0130 rule 3), so a daemon older than this field still answers
   * completely, and a consumer that finds it absent must not invent a mismatch.
   */
  readonly known_projects?: readonly string[];
  /**
   * Every project label this host holds a REGISTRATION for.
   *
   * A strict subset of `known_projects`, and separate from it on purpose: a
   * project the host knows only because a Worker of its own is still running is
   * known **by name**, not registered, and nothing will be born for it again. A
   * line that could not tell the two apart rendered a lapsed registration as a
   * calm, healthy project label — which is what #2973 turned out to be.
   *
   * OPTIONAL on the wire for the same reason `known_projects` is: one daemon
   * serves checkouts pinned to different bundle versions (ADR 0130 rule 3), and a
   * consumer that finds it absent must not invent a lapse.
   */
  readonly registered_projects?: readonly string[];
  readonly workers: readonly RedskilledStatuslineWorker[];
  /**
   * Each registered project's repository counts, dated on their own clock.
   *
   * They ride here rather than being fetched per surface because the counts are
   * quota the whole host shares (ADR 0130 Amendment 1): a statusline that polled
   * the tracker itself would spend the same token again per render. Their age is
   * carried separately from the sampler's because they are polled on a different
   * interval, and one number ageing does not make the other one old.
   */
  readonly repository_activity: RedskilledActivityReport;
}

export interface BuildStatuslinePayloadInput {
  readonly hostState: RedskilledHostState;
  readonly ceiling: RedskilledHostCeiling;
  /** The last reading the daemon took; empty when it has taken none. */
  readonly rss: RedskilledRssReading;
  /** When that reading was taken; `null` when nothing has been sampled yet. */
  readonly sampledAt: string | null;
  /**
   * The last line each Worker published, by Worker id.
   *
   * Passed in rather than read here: the lines belong to the daemon that received
   * the heartbeats, and this document stays a pure function of its inputs.
   */
  readonly logLines?: Readonly<Record<string, RedskilledWorkerLogLine>>;
  readonly now: string;
  /** Workers this daemon adopted at start rather than birthing itself, by id. */
  readonly reattachedWorkerIds?: readonly string[];
  readonly stalenessMs?: number;
  /**
   * The last activity fetch, or `null` when the daemon polls no repository.
   *
   * Passed in for the same reason the log lines are: the counts belong to the
   * daemon that spent the request for them, and this document stays a pure
   * function of its inputs.
   */
  readonly repositoryActivity?: RedskilledRepositoryActivity | null;
  readonly activityStalenessMs?: number;
}

/** The payload document. PURE — every aggregate is derived from the Worker set. */
export function buildStatuslinePayload(input: BuildStatuslinePayloadInput): RedskilledStatuslinePayload {
  const threshold = input.stalenessMs ?? REDSKILLED_STALENESS_MS;
  const nowMs = instant(input.now);
  const sampledMs = input.sampledAt == null ? null : instant(input.sampledAt);
  const ageMs = nowMs == null || sampledMs == null ? null : Math.max(0, nowMs - sampledMs);
  const sampleFresh = ageMs != null && ageMs <= threshold;
  const reattached = new Set(input.reattachedWorkerIds ?? []);

  const workers = input.hostState.workers.map((worker) =>
    buildWorker(worker, {
      rss: input.rss,
      sampledAt: input.sampledAt,
      ageMs,
      sampleFresh,
      nowMs,
      log: input.logLines?.[worker.worker_id],
      state: reattached.has(worker.worker_id) ? "reattached" : "running",
    })
  );

  const unmeasured = workers.filter((w) => w.vitals.rss_bytes == null).map((w) => w.worker_id).sort();
  const measuredCount = workers.length - unmeasured.length;
  const observed = workers.reduce((total, w) => total + (w.vitals.rss_bytes ?? 0), 0);
  const consumption = measureHostConsumption(input.hostState.workers);

  return {
    version: 1,
    generated_at: input.now,
    daemon: {
      pid: input.hostState.pid,
      daemon_version: input.hostState.daemon_version,
      protocol_version: input.hostState.protocol_version,
      started_at: input.hostState.started_at,
      machine_id_hash: input.hostState.machine_id_hash,
      session_key_hash: input.hostState.session_key_hash,
    },
    staleness: buildStaleness({
      sampledAt: input.sampledAt,
      ageMs,
      threshold,
      workerCount: workers.length,
      measuredCount,
      unmeasured,
    }),
    host: {
      worker_count: workers.length,
      project_count: input.hostState.projects.length,
      ceiling: input.ceiling,
      consumption,
      budget_accounting: input.hostState.budget_accounting,
      observed_rss_bytes: observed,
      measured_worker_count: measuredCount,
      ceiling_used_fraction: input.ceiling.memory_bytes == null || input.ceiling.memory_bytes <= 0
        ? null
        : consumption.memory_bytes / input.ceiling.memory_bytes,
    },
    projects: buildProjects(workers),
    known_projects: knownProjects(input.hostState),
    registered_projects: (input.hostState.registrations ?? [])
      .map((registration) => registration.project_label)
      .sort((a, b) => a.localeCompare(b)),
    workers,
    repository_activity: buildActivityReport({
      activity: input.repositoryActivity ?? null,
      now: input.now,
      stalenessMs: input.activityStalenessMs,
    }),
  };
}

function buildWorker(
  worker: RedskilledWorkerView,
  ctx: {
    readonly rss: RedskilledRssReading;
    readonly sampledAt: string | null;
    readonly ageMs: number | null;
    readonly sampleFresh: boolean;
    readonly nowMs: number | null;
    /** What this Worker published, when it has published anything. */
    readonly log?: RedskilledWorkerLogLine;
    readonly state: RedskilledWorkerState;
  },
): RedskilledStatuslineWorker {
  const measured = ctx.rss[worker.worker_id];
  const rssBytes = typeof measured === "number" && Number.isFinite(measured) ? measured : null;
  const enforced = resolveEnforcedBudget(worker);
  const declaredOnly = worker.budget?.memory_max ?? worker.budget?.memory_high ?? null;
  const startedMs = instant(worker.started_at);

  return {
    worker_id: worker.worker_id,
    project_label: worker.project_label,
    workspace_path: worker.workspace_path,
    pid: worker.pid,
    started_at: worker.started_at,
    uptime_ms: ctx.nowMs == null || startedMs == null ? null : Math.max(0, ctx.nowMs - startedMs),
    state: ctx.state,
    isolated: worker.isolated,
    unit: worker.unit ?? null,
    warnings: [...worker.warnings],
    vitals: {
      rss_bytes: rssBytes,
      sampled_at: rssBytes == null ? null : ctx.sampledAt,
      age_ms: rssBytes == null ? null : ctx.ageMs,
      fresh: rssBytes != null && ctx.sampleFresh,
    },
    budget: {
      name: enforced?.name ?? null,
      declared: enforced?.declared ?? declaredOnly,
      bytes: enforced?.bytes ?? null,
      used_bytes: rssBytes,
      used_fraction: enforced == null || enforced.bytes <= 0 || rssBytes == null ? null : rssBytes / enforced.bytes,
      enforceable: enforced != null,
    },
    log: workerLog(ctx.log),
  };
}

/**
 * The published line, echoed and never parsed. PURE.
 *
 * The one judgement made about the content is whether there is any: a line of
 * spaces is the same absence as no line at all, and reporting it as present
 * would hand every consumer a blank second line to render.
 */
function workerLog(log: RedskilledWorkerLogLine | undefined): RedskilledStatuslineWorkerLog {
  const absent = { last_line: null, published_at: null, source: null } as const;
  if (log == null || log.line.trim() === "") return absent;
  return { last_line: log.line, published_at: log.published_at, source: log.source };
}

/**
 * Every project this host has heard of, by label, ordered and deduplicated. PURE.
 *
 * The union of the two ways a host comes to know a project: a registration it was
 * handed, and a Worker it is holding. Either one alone is a real project, so
 * either one alone answers "yes, this host knows you" — and a project it knows
 * neither way is the only kind a consumer may call unmatched.
 */
/** Every label the host knows at all: registered, or carrying a Worker. */
function knownProjects(hostState: RedskilledHostState): readonly string[] {
  const labels = new Set<string>();
  for (const registration of hostState.registrations ?? []) labels.add(registration.project_label);
  for (const project of hostState.projects) labels.add(project.project_label);
  return [...labels].sort((a, b) => a.localeCompare(b));
}

function buildProjects(workers: readonly RedskilledStatuslineWorker[]): readonly RedskilledStatuslineProject[] {
  const byProject = new Map<string, { workers: number; declared: number; observed: number; measured: number }>();
  for (const worker of workers) {
    const entry = byProject.get(worker.project_label) ?? { workers: 0, declared: 0, observed: 0, measured: 0 };
    entry.workers += 1;
    entry.declared += worker.budget.bytes ?? 0;
    entry.observed += worker.vitals.rss_bytes ?? 0;
    entry.measured += worker.vitals.rss_bytes == null ? 0 : 1;
    byProject.set(worker.project_label, entry);
  }
  return [...byProject.entries()]
    .map(([project_label, entry]) => ({
      project_label,
      worker_count: entry.workers,
      declared_memory_bytes: entry.declared,
      observed_rss_bytes: entry.observed,
      measured_worker_count: entry.measured,
    }))
    .sort((a, b) => a.project_label.localeCompare(b.project_label));
}

/**
 * Date the answer, in a sentence a surface can render unchanged.
 *
 * A host holding no Workers is never stale: there is nothing to measure, and
 * calling that state old would put a warning on every idle machine.
 */
function buildStaleness(input: {
  readonly sampledAt: string | null;
  readonly ageMs: number | null;
  readonly threshold: number;
  readonly workerCount: number;
  readonly measuredCount: number;
  readonly unmeasured: readonly string[];
}): RedskilledStatuslineStaleness {
  const common = {
    sampled_at: input.sampledAt,
    age_ms: input.ageMs,
    threshold_ms: input.threshold,
    measured_worker_count: input.measuredCount,
    unmeasured_workers: input.unmeasured,
  };
  if (input.workerCount === 0) {
    return { ...common, stale: false, reason: "the host holds no Workers, so there is nothing to measure and nothing to age" };
  }
  if (input.sampledAt == null || input.ageMs == null) {
    return {
      ...common,
      stale: true,
      reason: `this answer is stale: the daemon has taken no measurement of its ${input.workerCount} live Worker(s) yet`,
    };
  }
  if (input.ageMs > input.threshold) {
    return {
      ...common,
      stale: true,
      reason: `this answer is stale: its measurement is ${input.ageMs}ms old, past the ${input.threshold}ms staleness window`,
    };
  }
  return {
    ...common,
    stale: false,
    reason: `measured ${input.ageMs}ms ago, within the ${input.threshold}ms staleness window`,
  };
}

/** An ISO instant in milliseconds, or `null` when it is not one. PURE. */
function instant(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** True when `value` is a complete payload — a client's fail-closed check. */
export function isRedskilledStatuslinePayload(value: unknown): value is RedskilledStatuslinePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const daemon = payload.daemon as Record<string, unknown> | undefined;
  const staleness = payload.staleness as Record<string, unknown> | undefined;
  const host = payload.host as Record<string, unknown> | undefined;
  return payload.version === 1 &&
    typeof payload.generated_at === "string" &&
    daemon != null && typeof daemon === "object" &&
    Number.isInteger(daemon.pid) &&
    typeof daemon.daemon_version === "string" &&
    typeof daemon.protocol_version === "number" &&
    staleness != null && typeof staleness === "object" &&
    typeof staleness.stale === "boolean" &&
    typeof staleness.threshold_ms === "number" &&
    Array.isArray(staleness.unmeasured_workers) &&
    host != null && typeof host === "object" &&
    Number.isInteger(host.worker_count) &&
    Number.isInteger(host.project_count) &&
    typeof host.observed_rss_bytes === "number" &&
    Array.isArray(payload.projects) &&
    Array.isArray(payload.workers) &&
    // Absent is accepted for the same reason the activity report's is: a daemon
    // older than this field answers completely without it, and a consumer that
    // rejected the whole payload would lose the Worker set over a fact it only
    // needed to tell an idle project from an unknown one.
    (payload.known_projects === undefined ||
      (Array.isArray(payload.known_projects) && payload.known_projects.every((label) => typeof label === "string"))) &&
    (payload.registered_projects === undefined ||
      (Array.isArray(payload.registered_projects) &&
        payload.registered_projects.every((label) => typeof label === "string"))) &&
    // Absent is accepted, malformed is not: a daemon older than the activity
    // poller answers a newer client's read, and rejecting its whole payload over
    // a field this consumer did not ask for would lose the Worker set — the very
    // version skew one host-scoped daemon exists to stop managing (ADR 0130).
    (payload.repository_activity === undefined || isRedskilledActivityReport(payload.repository_activity));
}
