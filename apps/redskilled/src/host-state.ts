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
import type { RedskilledHostCeiling } from "./admission.js";
import { isRedskilledScopeState, type RedskilledScopeState } from "./machine-scope.js";
import {
  isRedskilledProjectRegistration,
  registrationRenewalStatus,
  type RedskilledProjectRegistration,
  type RedskilledRenewalStatus,
} from "./project-registration.js";
import { REDSKILLED_PROTOCOL_VERSION } from "./protocol.js";
import type { RedskilledQueueDiscovery, RedskilledQueueOutcome } from "./queue-discovery.js";
import type { RedskilledMajorHold, RedskilledReplacementHoldReason } from "./self-replace.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

/**
 * Which instrument produced an RSS reading.
 *
 * `cgroup` is the kernel's own charge for the unit and cannot miss a descendant;
 * `process-tree` is a ppid walk over the host's process table and misses anything
 * that reparented out of the tree. Named as a value rather than left implicit so
 * a surface can show the weaker guarantee instead of presenting both as one
 * number (#3080).
 */
export type RedskilledRssSource = "cgroup" | "process-tree";

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
   * The budget the placement really handed the kernel, recorded at launch.
   *
   * Distinct from `budget` because they answer different questions and a single
   * field made one of them unanswerable (#3080): `budget` is what the CLIENT
   * declared and is what admission charges, while this is what the unit CARRIES
   * — the `--property=MemoryMax=…` systemd was actually given, derived ceiling
   * included. The host accounting totals THIS, so the number on screen is the
   * number the machine is holding.
   */
  readonly applied_budget?: RedskilledWorkerBudget;
  /**
   * Where this Worker's last RSS reading came from — the kernel, or a walk.
   *
   * Present because the two carry different guarantees and the weaker one must
   * not pass for the stronger: a cgroup's `memory.current` cannot miss a
   * descendant by construction, while a ppid walk misses anything that reparented
   * away, which is how a 5.38 GiB tree once reported 14.6M (#3080).
   */
  readonly rss_source?: RedskilledRssSource;
  /**
   * The memory ceiling this Worker's scope carries, however it was arrived at.
   *
   * Distinct from `budget`, which is what the CLIENT declared and what the
   * host-wide accounting charges: this is the wall the Worker actually runs
   * under, derived from the accounting when the client declared nothing (#3029).
   * Keeping them apart is what stops a derived wall from being read as memory
   * the host set aside — the first Worker born would otherwise commit the whole
   * machine's accounting and have every Worker after it refused.
   */
  readonly memory_ceiling?: string;
  /** Where that ceiling came from, in one sentence. Present with the ceiling. */
  readonly memory_ceiling_reason?: string;
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
 *
 * A third number joins them for the same reason: `published_version` is capped at
 * the running major, so on its own it cannot distinguish a current daemon from
 * one holding at a major boundary. `newest_published_version` is that horizon,
 * and `major_hold` is the daemon saying out loud that not crossing it is a
 * decision (#2926).
 */
export interface RedskilledUpgradeState {
  /** Identical to `daemon_version`, from the same value — never re-derived. */
  readonly running_version: string;
  /** The newest IN-MAJOR published version last resolved; null when it never was. */
  readonly published_version: string | null;
  /** 1 when the published answer could not be resolved at all. */
  readonly published_unknown: number;
  /** 1 when a newer version was resolved and this daemon is not it. */
  readonly newer_published: number;
  /** Where the replacement stands: nothing to do, decided, or under way. */
  readonly replacement: "none" | "pending" | "in-progress";
  /** When the published answer was last observed; null when it never was. */
  readonly checked_at: string | null;
  /**
   * How many published reads this daemon has COMPLETED — zero means never.
   *
   * The number that tells a stale daemon's two diseases apart. A daemon holding
   * a registration reports the same `published_version: null` whether its check
   * has fired and resolved nothing or has never fired at all, and those are
   * different defects with different cures — a whole investigation went to
   * distinguishing them by hand (#2975). `checks: 0` is "the check never ran";
   * `checks: 2` beside a `hold_reason` is "it ran and decided".
   */
  readonly checks: number;
  /**
   * Why the last check did not replace; null when it decided to, or never ran.
   *
   * Paired with `checks` on purpose: the count says the mechanism is alive and
   * this says what it concluded, so "the registry is unreachable from this host"
   * is never again read as "the timer is broken".
   */
  readonly hold_reason: RedskilledReplacementHoldReason | null;
  /** The newest version published across every major; null when unresolved. */
  readonly newest_published_version: string | null;
  /** 1 when a newer major exists and this daemon is deliberately not on it. */
  readonly major_held: number;
  /** The held major with its reason and the operator's step; null when none. */
  readonly major_hold: RedskilledMajorHold | null;
}

/**
 * One registration as the host reports it: the record, plus how it is being held.
 *
 * `renewal` is DERIVED at the instant of the read and never stored, because it is
 * a fact about silence rather than a fact about the record: the same registration
 * is `renewing` a second after its session spoke and `running-on` a minute later,
 * with nothing about it having changed. A stored copy would be a second answer
 * waiting to disagree with the clock.
 */
export interface RedskilledRegistrationView extends RedskilledProjectRegistration {
  /** Whether a session is still renewing this; absent when the read stated no instant. */
  readonly renewal?: RedskilledRenewalStatus;
  /**
   * The last poll that covered this project; absent when none has yet.
   *
   * Reported per registration rather than as one queue document, because "why is
   * nothing happening here" is asked about a project and answered by the poll that
   * project was in — and an absent block says *nobody has counted this yet*, which
   * is a different answer from a depth of zero and sends an operator somewhere else.
   */
  readonly last_poll?: RedskilledRegistrationPoll;
}

/**
 * What the last poll said about one project.
 *
 * `request_count` rides along because the whole of Amendment 3 is the claim that N
 * projects cost ONE request: a reader that could see the depth but not the cost
 * could not tell the batched shape from the per-project one it replaced.
 */
export interface RedskilledRegistrationPoll {
  /** When the poll this project was in answered — the fetch's instant, not the read's. */
  readonly at: string;
  readonly outcome: RedskilledQueueOutcome;
  /** How many items the selector matched; `null` for every outcome but `counted`. */
  readonly depth: number | null;
  /** What that whole interval cost, however many projects it covered. */
  readonly request_count: number;
  readonly detail: string;
}

/**
 * One registration this daemon dropped, and why it dropped it.
 *
 * A lapse is otherwise reported as an absence, and an absence is indistinguishable
 * from a project that never registered — which is exactly how a drain that stopped
 * on its own renders as a host that is simply idle (#2973). Stated as a record
 * with an instant and a reason, it is a fact a reader can act on.
 */
export interface RedskilledRegistrationLapse {
  readonly project_label: string;
  /** When the registration began; absent on records from older daemons. */
  readonly registered_at?: string;
  /** When the daemon noticed — a lapse is observed at a read, never at a timer. */
  readonly at: string;
  /** The deadline the record actually stood on. */
  readonly renew_by: string;
  /** How many deadline renewals occurred before the registration lapsed. */
  readonly renewals: number;
  /** How many times the project's own work had held it up (Amendment 7). */
  readonly sustains: number;
  readonly detail: string;
}

/** One registration an operator deliberately released. */
export interface RedskilledRegistrationStop {
  readonly project_label: string;
  readonly registered_at: string;
  readonly at: string;
  readonly detail: string;
}

/** One registration known to remain on a live daemon beyond this socket. */
export interface RedskilledOrphanedRegistration {
  readonly project_label: string;
  readonly registered_at?: string;
}

export interface RedskilledHostState {
  readonly version: 1;
  readonly protocol_version: number;
  readonly daemon_version: string;
  readonly machine_id_hash: string;
  readonly session_key_hash: string;
  readonly pid: number;
  readonly started_at: string;
  /** The machine-wide limits this daemon enforces, including each origin. */
  readonly ceiling?: RedskilledHostCeiling;
  /**
   * The scope this daemon believes it holds, and the record that proves it.
   *
   * Reported rather than assumed: "one per machine" is a property an operator has
   * to be able to SEE without reading the source, and a daemon that could not
   * state its own scope would leave a second one detectable only by its damage.
   */
  readonly scope?: RedskilledScopeState;
  readonly workers: readonly RedskilledWorkerView[];
  readonly projects: readonly RedskilledProjectView[];
  /**
   * The projects this daemon holds a registration for, ordered by label.
   *
   * Beside `projects` rather than folded into it, because the two are different
   * kinds of fact: `projects` is DERIVED from the live Worker set, while a
   * registration is a record a project contributed and the host stores. A project
   * with a registration and no Worker is real, and so is a Worker whose project
   * registered nothing — collapsing them would make each one unsayable.
   */
  readonly registrations?: readonly RedskilledRegistrationView[];
  /**
   * The registrations this daemon dropped, oldest first; absent when it dropped none.
   *
   * Beside `registrations` because it answers the question that set cannot: a
   * project is missing from it either because it never registered or because its
   * registration lapsed, and only one of those is a drain that stopped.
   */
  readonly lapsed_registrations?: readonly RedskilledRegistrationLapse[];
  /** Registrations deliberately released through `project_stop`, oldest first. */
  readonly stopped_registrations?: readonly RedskilledRegistrationStop[];
  /** Registrations held by another live daemon which this socket cannot reach. */
  readonly orphaned_registrations?: readonly RedskilledOrphanedRegistration[];
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
  /** The resolved host policy. Older callers may still provide only its bytes. */
  readonly ceiling?: RedskilledHostCeiling;
  /** The scope block; absent leaves the document without one rather than inventing it. */
  readonly scope?: RedskilledScopeState;
  readonly workers?: readonly RedskilledWorkerView[];
  /**
   * The host memory ceiling the accounting is judged against; `null` is unbounded.
   *
   * Absent leaves the totals unjudged rather than judged against a guess — but a
   * daemon that HAS a ceiling must pass it, because an over-commitment nobody
   * states is the promise this document exists to keep (#3080).
   */
  readonly hostCeilingBytes?: number | null;
  /** The registrations the daemon holds; absent is a host with none, not an error. */
  readonly registrations?: readonly RedskilledProjectRegistration[];
  /** The ones it dropped, in the order it dropped them; absent when none lapsed. */
  readonly lapses?: readonly RedskilledRegistrationLapse[];
  /** Deliberate registration releases, oldest first. */
  readonly stops?: readonly RedskilledRegistrationStop[];
  /** Registrations proved to remain behind another live daemon. */
  readonly orphanedRegistrations?: readonly RedskilledOrphanedRegistration[];
  /**
   * The last queue poll, as the poller left it; absent when none has run.
   *
   * Passed whole and attached per project here, so the daemon states the poll in
   * one place and this document reports it where a reader is already looking.
   */
  readonly queue?: RedskilledQueueDiscovery | null;
  /**
   * The instant the document is dated at, for judging renewal against.
   *
   * Optional, and its absence is honest rather than defaulted: a caller that
   * states no instant gets each registration reported without a renewal verdict,
   * because a judgement made up from the daemon's start time would call a
   * registration nobody has renewed in an hour `renewing`.
   */
  readonly now?: string;
  /** The version observation; a daemon that never checked reports unknown. */
  readonly published?: {
    readonly version: string | null;
    readonly checkedAt: string | null;
    /** Whether the observed version supersedes the running one — the daemon decides. */
    readonly newer?: boolean;
    readonly replacement?: RedskilledUpgradeState["replacement"];
    /** The newest version resolved across every major; absent leaves it unknown. */
    readonly newest?: string | null;
    /** The major this daemon is holding at — the daemon decides, this echoes it. */
    readonly majorHold?: RedskilledMajorHold | null;
    /** How many reads have COMPLETED; absent is none, which is what never-ran reports. */
    readonly checks?: number;
    /** The last hold's reason; absent leaves it null, as a replace and a never-ran do. */
    readonly holdReason?: RedskilledReplacementHoldReason | null;
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
    ...(input.ceiling == null ? {} : { ceiling: input.ceiling }),
    ...(input.scope == null ? {} : { scope: input.scope }),
    workers,
    projects: [...counts.entries()]
      .map(([project_label, worker_count]) => ({ project_label, worker_count }))
      .sort((a, b) => a.project_label.localeCompare(b.project_label)),
    // Ordered by the one field the daemon is allowed to read. A document ordered
    // by anything a selector says would be the daemon having read one.
    registrations: buildRegistrationViews(input),
    // Absent rather than empty: a host that has dropped nothing has no lapse
    // block at all, so a reader never has to tell an empty list from a daemon too
    // old to keep one.
    ...(input.lapses == null || input.lapses.length === 0 ? {} : { lapsed_registrations: [...input.lapses] }),
    ...(input.stops == null || input.stops.length === 0 ? {} : { stopped_registrations: [...input.stops] }),
    ...(input.orphanedRegistrations == null || input.orphanedRegistrations.length === 0
      ? {}
      : { orphaned_registrations: [...input.orphanedRegistrations] }),
    budget_accounting: buildBudgetAccounting(workers, {
      hostCeilingBytes: input.ceiling?.memory_bytes ?? input.hostCeilingBytes ?? null,
    }),
    upgrade: buildUpgradeState(input),
  };
}

/**
 * The registration block: every record, each judged against the read's instant. PURE.
 *
 * Ordered by the one field the daemon is allowed to read. A document ordered by
 * anything a selector says would be the daemon having read one.
 */
function buildRegistrationViews(input: BuildHostStateInput): readonly RedskilledRegistrationView[] {
  const nowMs = input.now == null ? Number.NaN : Date.parse(input.now);
  const judged = Number.isFinite(nowMs);
  const queue = input.queue ?? null;
  const polls = new Map(queue == null ? [] : queue.projects.map((project) => [project.project_label, project]));
  return [...(input.registrations ?? [])]
    .map((registration): RedskilledRegistrationView => {
      const polled = polls.get(registration.project_label);
      return {
        ...registration,
        ...(judged ? { renewal: registrationRenewalStatus(registration, nowMs) } : {}),
        ...(queue == null || polled == null
          ? {}
          : {
            last_poll: {
              at: queue.fetched_at,
              outcome: polled.outcome,
              depth: polled.depth,
              request_count: queue.request_count,
              detail: polled.detail,
            },
          }),
      };
    })
    .sort((a, b) => a.project_label.localeCompare(b.project_label));
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
  const hold = input.published?.majorHold ?? null;
  return {
    running_version: running,
    published_version: published,
    published_unknown: Number(published === null),
    newer_published: Number(input.published?.newer === true),
    replacement: input.published?.replacement ?? "none",
    checked_at: input.published?.checkedAt ?? null,
    checks: input.published?.checks ?? 0,
    hold_reason: input.published?.holdReason ?? null,
    newest_published_version: input.published?.newest ?? null,
    major_held: Number(hold !== null),
    major_hold: hold,
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
    (state.ceiling === undefined || isHostCeiling(state.ceiling)) &&
    Array.isArray(state.workers) &&
    Array.isArray(state.projects) &&
    isRedskilledBudgetAccounting(state.budget_accounting) &&
    // Same tolerance the upgrade block gets, for the same reason: a daemon from a
    // bundle that predates the scope block still answers completely.
    (state.scope === undefined || isRedskilledScopeState(state.scope)) &&
    // The same tolerance again, and for the same reason: a daemon from a bundle
    // that predates Amendment 4 answers completely without a registrations block,
    // while a block that IS there and is the wrong shape still fails closed.
    (state.registrations === undefined ||
      (Array.isArray(state.registrations) && state.registrations.every(isRedskilledProjectRegistration))) &&
    (state.lapsed_registrations === undefined ||
      (Array.isArray(state.lapsed_registrations) && state.lapsed_registrations.every(isRegistrationLapse))) &&
    (state.stopped_registrations === undefined ||
      (Array.isArray(state.stopped_registrations) && state.stopped_registrations.every(isRegistrationStop))) &&
    (state.orphaned_registrations === undefined ||
      (Array.isArray(state.orphaned_registrations) && state.orphaned_registrations.every(isOrphanedRegistration))) &&
    // Checked only when present. One daemon serves checkouts pinned to different
    // bundle versions (ADR 0130 rule 3), so a field this bundle added must not
    // make an older daemon's complete answer read as malformed — while a field
    // that IS there and is the wrong shape still fails closed.
    (state.upgrade === undefined || isRedskilledUpgradeState(state.upgrade));
}

function isRegistrationLapse(value: unknown): value is RedskilledRegistrationLapse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.project_label === "string" &&
    (record.registered_at === undefined || typeof record.registered_at === "string") &&
    typeof record.at === "string" &&
    typeof record.renew_by === "string" &&
    Number.isInteger(record.renewals) &&
    Number.isInteger(record.sustains) &&
    typeof record.detail === "string";
}

function isRegistrationStop(value: unknown): value is RedskilledRegistrationStop {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.project_label === "string" &&
    typeof record.registered_at === "string" &&
    typeof record.at === "string" &&
    typeof record.detail === "string";
}

function isOrphanedRegistration(value: unknown): value is RedskilledOrphanedRegistration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.project_label === "string" &&
    (record.registered_at === undefined || typeof record.registered_at === "string");
}

function isHostCeiling(value: unknown): value is RedskilledHostCeiling {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ceiling = value as Record<string, unknown>;
  const origins = new Set(["flag", "environment", "home-config", "derived-default"]);
  return (ceiling.memory_bytes === null || typeof ceiling.memory_bytes === "number") &&
    (ceiling.worker_count === null || typeof ceiling.worker_count === "number") &&
    (ceiling.source === "declared" || ceiling.source === "host-fraction") &&
    (ceiling.memory_source === undefined || origins.has(String(ceiling.memory_source))) &&
    (ceiling.worker_source === undefined || origins.has(String(ceiling.worker_source)));
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
    (upgrade.checked_at === null || typeof upgrade.checked_at === "string") &&
    // Checked only when present, exactly as the block itself is on the document:
    // a daemon from a bundle that predates the major-hold report still answers
    // completely, while a block that IS there and is the wrong shape fails closed.
    (upgrade.newest_published_version === undefined ||
      upgrade.newest_published_version === null ||
      typeof upgrade.newest_published_version === "string") &&
    (upgrade.major_held === undefined || typeof upgrade.major_held === "number") &&
    (upgrade.checks === undefined || typeof upgrade.checks === "number") &&
    (upgrade.hold_reason === undefined ||
      upgrade.hold_reason === null ||
      typeof upgrade.hold_reason === "string") &&
    (upgrade.major_hold === undefined ||
      upgrade.major_hold === null ||
      isRedskilledMajorHold(upgrade.major_hold));
}

/** True when `value` is a complete major-hold report — a client's fail-closed check. */
export function isRedskilledMajorHold(value: unknown): value is RedskilledMajorHold {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const hold = value as Record<string, unknown>;
  return typeof hold.version === "string" &&
    Number.isInteger(hold.running_major) &&
    Number.isInteger(hold.held_major) &&
    typeof hold.reason === "string" &&
    // The step is the whole point of the report: a hold that named no way across
    // would be the silent hold again, wearing a field name.
    typeof hold.action === "string" &&
    hold.action.trim() !== "";
}
