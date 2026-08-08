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
import type {
  AttributionConfidence,
  DeathAttribution,
  DeathSenderClass,
} from "@reddb-io/shared/death-attribution.js";
import {
  buildGithubBalanceReport,
  isGithubBalanceReport,
  type GithubBalance,
  type GithubBalanceReport,
} from "@reddb-io/github";
import type { ProcessDeathKind } from "@reddb-io/shared/death-record.js";
import { measureHostConsumption, type RedskilledHostCeiling, type RedskilledHostConsumption } from "./admission.js";
import type { RedskilledBudgetAccounting } from "./budget-accounting.js";
import type { RedskilledHostState, RedskilledRssSource, RedskilledWorkerView } from "./host-state.js";
import { isRedskilledStatuslineMetrics, type RedskilledStatuslineMetrics } from "./live-metrics.js";
import { resolveEnforcedBudget, type RedskilledBudgetName, type RedskilledRssReading } from "./memory-sampler.js";
import {
  buildActivityReport,
  isRedskilledActivityReport,
  type RedskilledActivityReport,
  type RedskilledRepositoryActivity,
} from "./repository-activity.js";
import type { RedskilledWorkerDisplay, RedskilledWorkerDisplayRecord } from "./worker-display.js";
import type { RedskilledWorkerLogLine } from "./worker-log.js";

/**
 * How old a sample may be before the payload calls itself stale.
 *
 * Two of the daemon's default sample windows: one missed tick is the jitter of a
 * busy host, and two is a sampler that stopped — the first must not cry wolf and
 * the second must not pass for current.
 */
export const REDSKILLED_STALENESS_MS = 30_000;

/** A Worker dead by this age never reached work; repeated refusals are a boot loop. */
export const REDSKILLED_BOOT_REFUSAL_MAX_UPTIME_S = 2;
/** One refusal can be incidental and two can be a retry; three establishes repetition. */
export const REDSKILLED_BOOT_LOOP_MIN_DEATHS = 3;

/** Host-observed facts that enrich a generic death attribution when they exist. */
export interface RedskilledDeathObservation extends DeathAttribution {
  readonly project_label?: string;
  readonly uptime_s?: number;
  readonly detail?: string | null;
  /** The daemon witnessed an exit status or signal, rather than discovering absence in a later sweep. */
  readonly observed_exit?: boolean;
}

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
  /**
   * Which instrument produced `rss_bytes`; `null` when the daemon named none.
   *
   * A surface shows it because the two instruments do not carry the same
   * guarantee: `cgroup` is the kernel's charge for the unit, `process-tree` is a
   * ppid walk that misses whatever reparented away. Rendering both as one
   * unlabelled number is how a 5.38 GiB host displayed `14.6M` (#3080). OPTIONAL
   * on the wire, because one daemon serves checkouts pinned to different bundle
   * versions and a consumer finding it absent must render an unnamed source
   * rather than reject the Worker.
   */
  readonly rss_source?: RedskilledRssSource | null;
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
  /** Host-computed movement from this Worker's granted fork to refreshed trunk. */
  readonly base_commits_ahead?: number;
  readonly uptime_ms: number | null;
  readonly state: RedskilledWorkerState;
  readonly isolated: boolean;
  readonly unit: string | null;
  readonly warnings: readonly string[];
  readonly vitals: RedskilledStatuslineVitals;
  readonly budget: RedskilledStatuslineWorkerBudget;
  readonly log: RedskilledStatuslineWorkerLog;
  /**
   * What this Worker's project says a surface should SHOW about it.
   *
   * It rides on the payload for the same reason `log` does: the dashboard is ONE
   * read, and a surface that had to ask each project for its own Worker rows
   * would cross a project boundary per render and become a second authority on a
   * question this document already answers.
   *
   * `null` — never a record of zeros — for a Worker whose project publishes none,
   * because "nothing was published" and "it has done nothing" are opposite facts
   * about a busy Worker. OPTIONAL on the wire for the reason `known_projects` is:
   * one daemon serves checkouts pinned to different bundle versions (ADR 0130
   * rule 3), and a consumer finding it absent must render an unpublished row, not
   * reject the Worker set.
   */
  readonly display?: RedskilledWorkerDisplay | null;
  /** When the display record landed; `null` when none has. */
  readonly display_published_at?: string | null;
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

/**
 * One posed death, reduced to what a surface prints.
 *
 * The lane's verdict carries its whole receipt — every source consulted, every
 * line of evidence — and none of that fits a statusline. What survives here is
 * the answer to "why did it die": who ended it, how sure the reaper is, and the
 * one piece of evidence the verdict rests on. The receipt stays on the lane, and
 * `id` is the handle that reaches it.
 */
export interface RedskilledStatuslineDeath {
  readonly kind: ProcessDeathKind;
  readonly id: string;
  readonly pid: number;
  /** When the reaper concluded — NOT when the process died, which nobody saw. */
  readonly ts: string;
  /** The last moment the dead process is known to have lived. */
  readonly last_seen: string;
  readonly last_phase: string;
  readonly sender_class: DeathSenderClass;
  readonly confidence: AttributionConfidence;
  /** The signal, when a source NAMED one; never inferred from the class alone. */
  readonly signal: string | null;
  /** The first fact the verdict rests on; `null` exactly when the class is unknown. */
  readonly evidence: string | null;
}

/**
 * What this host could not explain, as of the last reaping.
 *
 * `count` is stated beside `recent` rather than left to a consumer's `.length`,
 * because the list is capped: a statusline that printed `†2` from a truncated
 * array would under-report a machine that killed a dozen processes, and "how many
 * died" is the number that decides whether an operator looks further.
 *
 * An empty block is a REAPING THAT FOUND NOTHING and is never the same fact as an
 * absent one, which is a daemon that never reaped — the distinction #3028 exists
 * to keep, carried the one hop to the surfaces.
 */
export interface RedskilledStatuslineDeaths {
  readonly count: number;
  /** Deaths in the window whose evidence names a sender; this is the statusline head's count. */
  readonly sender_attributed_count: number;
  /** The newest verdicts first, capped — `count` is the whole number. */
  readonly recent: readonly RedskilledStatuslineDeath[];
  /** The newest verdict, or `null` when the reaping attributed nothing. */
  readonly latest: RedskilledStatuslineDeath | null;
  /** The newest verdict whose evidence names a sender, independent of the capped receipt list. */
  readonly latest_sender_attributed: RedskilledStatuslineDeath | null;
  /** When the reaper concluded; `null` when it attributed nothing. */
  readonly reaped_at: string | null;
  /** A repeated same-project boot refusal, absent when the deaths do not establish one. */
  readonly boot_loop?: RedskilledStatuslineBootLoop;
}

/** The actionable shape hidden by a flat death count. */
export interface RedskilledStatuslineBootLoop {
  readonly project_label: string;
  readonly count: number;
  readonly span_ms: number;
  readonly latest_refusal: string;
}

/**
 * Which engine is answering, and whether it is the current one.
 *
 * Two versions, never one: `running` is the code answering this read and
 * `published` is a resolved observation about the world, and folding them is how
 * a stale process reports a confident zero skew (#2809). `current` is stated
 * rather than left to a string compare, because an unresolved published answer is
 * NOT "up to date" — it is unknown, and `null` says so.
 *
 * It rides on the payload rather than staying on `host-state` because the
 * statusline reads exactly one document (ADR 0130 rule 10): a header that had to
 * fetch a second one to name its own version would be a second read per render,
 * which is how the herdr pane came to make two.
 */
export interface RedskilledStatuslineEngine {
  readonly running_version: string;
  /** The newest IN-MAJOR published version last resolved; `null` when unresolved. */
  readonly published_version: string | null;
  /** True when a newer version was resolved and this daemon is not it. */
  readonly newer_published: boolean;
  /** True when a newer MAJOR exists and this daemon deliberately holds behind it. */
  readonly major_held: boolean;
  /** True/false when the published answer is known; `null` when it never resolved. */
  readonly current: boolean | null;
}

/** How many verdicts a payload carries before the rest are counted instead. */
export const REDSKILLED_RECENT_DEATH_LIMIT = 4;

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
  /**
   * Recent registration lapses, with the daemon's timestamp and reason.
   *
   * A label in `known_projects` says only that the host has heard the name. This
   * block lets the shared renderer say `lapsed` rather than the less actionable
   * `unregistered`, and lets a re-registration outrank an older lapse record.
   */
  readonly lapsed_projects?: readonly {
    readonly project_label: string;
    readonly at: string;
    readonly registered_at?: string;
    readonly reason: string;
  }[];
  /** Registrations deliberately released through `project_stop`. */
  readonly stopped_projects?: readonly {
    readonly project_label: string;
    readonly at: string;
  }[];
  /** Registrations held by a live daemon beyond the socket that answered. */
  readonly orphaned_projects?: readonly string[];
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
  /**
   * What the TOKEN has left, asked rather than counted, with its own age.
   *
   * It rides beside the counts deliberately: `"the queue looks empty"` and
   * `"we are out of quota"` must never be the same screen, and a payload that
   * carried only counts gives a surface no way to tell them apart. The posture is
   * the graduated breaker's state made observable — `open`, `reserved`, `spent`,
   * or `unknown` when nothing has answered (ADR 0132 Amendment 2, #3095).
   */
  readonly github_balance: GithubBalanceReport;
  /**
   * What this host could not explain, so every surface can answer "why did it die".
   *
   * Here rather than fetched per surface for the reason the activity counts are:
   * the verdicts belong to the process that reaped them, and three surfaces each
   * reading the lane themselves would be three readers of one file, drifting the
   * moment one of them cached.
   *
   * OPTIONAL on the wire (ADR 0130 rule 3): a daemon older than the reaper answers
   * completely without it, and a consumer that finds it absent must not render a
   * calm zero — nothing reaped is not the same fact as nothing died.
   */
  readonly deaths?: RedskilledStatuslineDeaths;
  /**
   * Which engine answered and whether it is current.
   *
   * OPTIONAL on the wire for the same reason: a daemon that predates this field
   * still states its own version under `daemon.daemon_version`, and a consumer
   * that finds the block absent must not read it as "up to date".
   */
  readonly engine?: RedskilledStatuslineEngine;
  /**
   * The rates this daemon derived from the facts it alone holds.
   *
   * Here rather than computed per surface for the reason the activity counts and
   * the death verdicts are: a rate has one answer, and three surfaces each
   * dividing their own counters would print three of them for the same instant.
   *
   * OPTIONAL on the wire (ADR 0130 rule 3): a daemon that predates the metrics
   * answers completely without them, and a consumer that finds the block absent
   * must render nothing rather than a calm zero — a machine nobody measured is
   * not an idle one.
   */
  readonly metrics?: RedskilledStatuslineMetrics;
  /**
   * Which count-scaling extras this response deliberately left out.
   *
   * **Stated, because a withheld fact and a missing one are opposite things**
   * (ADR 0132 decision 2). The skeleton — Workers, projects, budget — is served
   * on every response, since ADR 0130 rule 9 already entitles a session to the
   * whole machine and withholding it buys only a second round trip. What scales
   * with Worker count travels on request; a Worker whose vitals were not asked
   * for carries the same `rss_bytes: null` a Worker nobody measured carries, and
   * without this field a consumer would read a cheap read as a broken sampler.
   *
   * Absent — never `[]` — on a full response, so the field's presence alone means
   * something was left out.
   */
  readonly withheld?: readonly RedskilledStatuslineExtra[];
}

/**
 * One block that scales with Worker count, and so travels on request.
 *
 * Named individually rather than as one `verbose` boolean because the surfaces
 * want different subsets: a statusline wants vitals and no logs, a dashboard
 * wants the display records, and a health probe wants none of the three.
 */
export type RedskilledStatuslineExtra = "logs" | "vitals" | "display";

/** Every extra there is, so a caller can ask for the skeleton by subtracting. */
export const REDSKILLED_STATUSLINE_EXTRAS: readonly RedskilledStatuslineExtra[] = ["logs", "vitals", "display"];

/**
 * Which extras a reader wants; an omitted flag is a block it does not need.
 *
 * A record of opt-INS rather than opt-outs: the expensive direction should be
 * the one a caller had to type.
 */
export interface RedskilledStatuslineExtrasRequest {
  readonly logs?: boolean;
  readonly vitals?: boolean;
  readonly display?: boolean;
}

/**
 * The same payload with the extras nobody asked for removed. PURE.
 *
 * **A withheld block is replaced by its own honest absence, never deleted**: the
 * shape stays total, so a consumer written against the full document renders a
 * skeleton response without a single existence check. What it must not do is
 * read the absence as a measurement — which is exactly what `withheld` is for.
 *
 * `undefined` extras means the whole document, because that is what every client
 * pinned to an older bundle asks for by saying nothing (ADR 0130 rule 3). A
 * caller that wants less says so.
 */
export function withholdStatuslineExtras(
  payload: RedskilledStatuslinePayload,
  extras: RedskilledStatuslineExtrasRequest | undefined,
): RedskilledStatuslinePayload {
  if (extras === undefined) return payload;
  const withheld = REDSKILLED_STATUSLINE_EXTRAS.filter((extra) => extras[extra] !== true);
  if (withheld.length === 0) return payload;
  const keep = (extra: RedskilledStatuslineExtra) => extras[extra] === true;
  return {
    ...payload,
    workers: payload.workers.map((worker) => ({
      ...worker,
      ...(keep("vitals") ? {} : { vitals: WITHHELD_VITALS, budget: { ...worker.budget, used_bytes: null, used_fraction: null } }),
      ...(keep("logs") ? {} : { log: WITHHELD_LOG }),
      ...(keep("display") ? {} : { display: null, display_published_at: null }),
    })),
    withheld,
  };
}

/** The vitals of a Worker nobody asked about — total in shape, empty in fact. */
const WITHHELD_VITALS: RedskilledStatuslineVitals = {
  rss_bytes: null,
  sampled_at: null,
  age_ms: null,
  fresh: false,
  rss_source: null,
};

/** The log of a Worker nobody asked about. `null`, exactly as an unpublished one. */
const WITHHELD_LOG: RedskilledStatuslineWorkerLog = {
  last_line: null,
  published_at: null,
  source: null,
};

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
  /**
   * The display record each Worker's project published, by Worker id.
   *
   * Passed in for the same reason the log lines are: the records belong to the
   * daemon that received the heartbeats, and this document stays a pure function
   * of its inputs.
   */
  readonly displays?: Readonly<Record<string, RedskilledWorkerDisplayRecord>>;
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
  /**
   * The last balance the token answered with, or `null` when none was asked for.
   *
   * Passed in for the same reason the counts are: the balance belongs to the
   * daemon that spent the request for it, and this document stays a pure function
   * of its inputs.
   */
  readonly githubBalance?: GithubBalance | null;
  /** The reserved fraction this host holds back; the package default when absent. */
  readonly reservedFraction?: number;
  /**
   * The verdicts this host's boot reaper posed, or absent when it never reaped.
   *
   * Passed in for the same reason the log lines are: the lane belongs to the
   * process that read it, and this document stays a pure function of its inputs.
   * An empty array is a reaping that found nothing — a real answer — and absent is
   * a reaper that never ran; the two must not collapse.
   */
  readonly deaths?: readonly RedskilledDeathObservation[];
  /** How many verdicts the payload lists before the rest are counted instead. */
  readonly recentDeathLimit?: number;
  /**
   * The rates the daemon derived, or absent when it derived none.
   *
   * Derived by the caller and passed in, for the same reason the log lines are:
   * the observation history belongs to the daemon that received the heartbeats,
   * and this document stays a pure function of its inputs.
   */
  readonly metrics?: RedskilledStatuslineMetrics;
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
      display: input.displays?.[worker.worker_id],
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
    lapsed_projects: (input.hostState.lapsed_registrations ?? []).map((lapse) => ({
      project_label: lapse.project_label,
      at: lapse.at,
      ...(lapse.registered_at == null ? {} : { registered_at: lapse.registered_at }),
      reason: lapse.detail,
    })),
    stopped_projects: (input.hostState.stopped_registrations ?? []).map((stopped) => ({
      project_label: stopped.project_label,
      at: stopped.at,
    })),
    orphaned_projects: (input.hostState.orphaned_registrations ?? []).map((record) => record.project_label),
    workers,
    github_balance: buildGithubBalanceReport({
      balance: input.githubBalance ?? null,
      now: input.now,
      ...(input.reservedFraction === undefined ? {} : { reservedFraction: input.reservedFraction }),
    }),
    repository_activity: buildActivityReport({
      activity: input.repositoryActivity ?? null,
      now: input.now,
      stalenessMs: input.activityStalenessMs,
    }),
    ...(input.deaths === undefined
      ? {}
      : { deaths: buildDeaths(input.deaths, input.recentDeathLimit ?? REDSKILLED_RECENT_DEATH_LIMIT) }),
    engine: buildEngine(input.hostState),
    // Echoed, never recomputed: the rates rest on a history only the daemon
    // holds, and a second derivation here would be a second authority on them.
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
  };
}

/** The death block a surface prints, newest verdict first. PURE. */
function buildDeaths(
  attributions: readonly RedskilledDeathObservation[],
  limit: number,
): RedskilledStatuslineDeaths {
  const ordered = [...attributions].sort((a, b) => (instant(b.ts) ?? 0) - (instant(a.ts) ?? 0));
  const recent = ordered.slice(0, Math.max(0, Math.floor(limit))).map(statuslineDeath);
  const senderAttributed = ordered.filter(
    (attribution) =>
      attribution.observed_exit === true ||
      (attribution.sender_class !== "unknown" && attribution.confidence !== "none"),
  );
  const bootLoop = buildBootLoop(ordered);
  return {
    count: ordered.length,
    sender_attributed_count: senderAttributed.length,
    recent,
    latest: recent[0] ?? null,
    latest_sender_attributed: senderAttributed[0] == null ? null : statuslineDeath(senderAttributed[0]),
    reaped_at: recent[0]?.ts ?? null,
    ...(bootLoop == null ? {} : { boot_loop: bootLoop }),
  };
}

/** Reduce one full attribution to the receipt every rendering density shares. PURE. */
function statuslineDeath(attribution: RedskilledDeathObservation): RedskilledStatuslineDeath {
  return {
    kind: attribution.kind,
    id: attribution.id,
    pid: attribution.pid,
    ts: attribution.ts,
    last_seen: attribution.last_seen,
    last_phase: attribution.last_phase,
    sender_class: attribution.sender_class,
    confidence: attribution.confidence,
    signal: attribution.signal,
    evidence: attribution.evidence[0] ?? null,
  };
}

/** Reduce the rolling death window to its strongest same-project boot loop. PURE. */
function buildBootLoop(
  ordered: readonly RedskilledDeathObservation[],
): RedskilledStatuslineBootLoop | null {
  const byProject = new Map<string, RedskilledDeathObservation[]>();
  for (const death of ordered) {
    if (
      death.sender_class !== "boot-refused" ||
      death.uptime_s == null ||
      death.uptime_s > REDSKILLED_BOOT_REFUSAL_MAX_UPTIME_S ||
      death.project_label == null ||
      death.project_label === "" ||
      instant(death.ts) == null
    ) continue;
    const grouped = byProject.get(death.project_label) ?? [];
    grouped.push(death);
    byProject.set(death.project_label, grouped);
  }

  const loops = [...byProject.entries()]
    .filter(([, deaths]) => deaths.length >= REDSKILLED_BOOT_LOOP_MIN_DEATHS)
    .map(([projectLabel, deaths]): RedskilledStatuslineBootLoop | null => {
      const newest = deaths[0]!;
      const newestAt = instant(newest.ts)!;
      const oldestAt = Math.min(...deaths.map((death) => instant(death.ts)!));
      const refusal = newest.detail?.trim() || newest.evidence[0]?.trim();
      if (refusal == null || refusal === "") return null;
      return {
        project_label: projectLabel,
        count: deaths.length,
        span_ms: Math.max(0, newestAt - oldestAt),
        latest_refusal: refusal,
      };
    })
    .filter((loop): loop is RedskilledStatuslineBootLoop => loop != null)
    .sort((left, right) => right.count - left.count || right.span_ms - left.span_ms);
  return loops[0] ?? null;
}

/**
 * The engine block, from the version state the daemon already holds. PURE.
 *
 * Never re-resolved here: the published answer is a probe this process spent a
 * request on, and a second derivation would be a second authority on the one
 * question the block exists to settle.
 */
function buildEngine(hostState: RedskilledHostState): RedskilledStatuslineEngine {
  const upgrade = hostState.upgrade as RedskilledHostState["upgrade"] | undefined;
  const running = upgrade?.running_version ?? hostState.daemon_version;
  const published = upgrade?.published_version ?? null;
  const newest = upgrade?.newest_published_version ?? null;
  const newer = (upgrade?.newer_published ?? 0) > 0;
  const majorHeld = (upgrade?.major_held ?? 0) > 0;
  return {
    running_version: running,
    published_version: published,
    newer_published: newer,
    major_held: majorHeld,
    // Unknown stays unknown: with nothing resolved in either horizon there is no
    // comparison to report, and `false` here would read as "behind" while `true`
    // would read as "current" — both inventions.
    current: published == null && newest == null ? null : !newer && !majorHeld,
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
    /** What this Worker's project says a surface should show about it. */
    readonly display?: RedskilledWorkerDisplayRecord;
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
    ...(worker.base_commits_ahead == null ? {} : { base_commits_ahead: worker.base_commits_ahead }),
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
      rss_source: rssBytes == null ? null : worker.rss_source ?? null,
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
    display: ctx.display?.display ?? null,
    display_published_at: ctx.display?.published_at ?? null,
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
  for (const lapse of hostState.lapsed_registrations ?? []) labels.add(lapse.project_label);
  for (const stopped of hostState.stopped_registrations ?? []) labels.add(stopped.project_label);
  for (const orphaned of hostState.orphaned_registrations ?? []) labels.add(orphaned.project_label);
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
    (payload.lapsed_projects === undefined ||
      (Array.isArray(payload.lapsed_projects) && payload.lapsed_projects.every(isStatuslineLapse))) &&
    (payload.stopped_projects === undefined ||
      (Array.isArray(payload.stopped_projects) && payload.stopped_projects.every(isStatuslineStop))) &&
    (payload.orphaned_projects === undefined ||
      (Array.isArray(payload.orphaned_projects) &&
        payload.orphaned_projects.every((label) => typeof label === "string"))) &&
    // Absent is accepted, malformed is not: a daemon older than the activity
    // poller answers a newer client's read, and rejecting its whole payload over
    // a field this consumer did not ask for would lose the Worker set — the very
    // version skew one host-scoped daemon exists to stop managing (ADR 0130).
    (payload.repository_activity === undefined || isRedskilledActivityReport(payload.repository_activity)) &&
    // Absent is accepted for the same reason: a daemon older than the balance
    // poller answers completely without it, and a consumer that rejected the
    // whole payload would lose the Worker set over a badge.
    (payload.github_balance === undefined || isGithubBalanceReport(payload.github_balance)) &&
    // Absent is accepted for the reason the two project lists are: a daemon that
    // predates the reaper, or the engine block, answers completely without them,
    // and rejecting the whole payload would lose the Worker set over a field this
    // consumer only needed for a badge (ADR 0130 rule 3).
    (payload.deaths === undefined || isStatuslineDeaths(payload.deaths)) &&
    (payload.engine === undefined || isStatuslineEngine(payload.engine)) &&
    (payload.metrics === undefined || isRedskilledStatuslineMetrics(payload.metrics));
}

function isStatuslineLapse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const lapse = value as Record<string, unknown>;
  return typeof lapse.project_label === "string" &&
    typeof lapse.at === "string" &&
    (lapse.registered_at === undefined || typeof lapse.registered_at === "string") &&
    typeof lapse.reason === "string";
}

function isStatuslineStop(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const stopped = value as Record<string, unknown>;
  return typeof stopped.project_label === "string" && typeof stopped.at === "string";
}

function isStatuslineDeaths(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const deaths = value as Record<string, unknown>;
  return Number.isInteger(deaths.count) && Array.isArray(deaths.recent);
}

function isStatuslineEngine(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const engine = value as Record<string, unknown>;
  return typeof engine.running_version === "string" &&
    (engine.published_version === null || typeof engine.published_version === "string");
}
