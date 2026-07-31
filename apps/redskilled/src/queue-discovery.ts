/**
 * queue-discovery — every registered project's queue depth, in one request.
 *
 * ADR 0130 Amendment 3: **the daemon fetches every registered project's queue in
 * one aliased request per interval, alongside the activity counts it already
 * batches.** The reasoning is the one Amendment 1 already accepted for activity:
 * GitHub quota is per token, not per process, so several projects polling with one
 * credential already share a budget and splitting the poller saves nothing — what
 * saves is one request instead of N.
 *
 * **The bigger half was the one left outside.** Queue depth is the same fetch
 * against the same token, and it is the larger consumer: activity moves at human
 * speed, while the queue is read every tick. Batching the smaller half and leaving
 * the larger one per-project was an inconsistency, not a boundary.
 *
 * **Two cadences, not one.** Activity and queue keep their own intervals. Forcing
 * the slow half onto the fast half's rhythm would spend more quota than the
 * batching saves, which is the opposite of the point — so the interval lives with
 * the caller and nothing here assumes the two ever tick together.
 *
 * **A selector is carried, never read.** The daemon asks whether it holds a
 * non-empty string and hands that string to the tracker verbatim; it still does
 * not know what an Issue, a label, a Spec, a gate or a Landing *is* (rule 3). The
 * frontier moved by a query string and no further.
 *
 * **Never a zero standing in for an absence.** A selector the token cannot resolve
 * and a spent quota each carry a `null` depth and their own outcome, because "this
 * project cannot be reached", "the quota is spent" and "this queue has drained"
 * are three different facts and only the last of them is a zero — and the last one
 * is the one that deregisters a project, so mistaking the other two for it would
 * retire a project that still has work.
 *
 * PURE, apart from `fetchQueueDiscovery`, whose transport is injected.
 */

/**
 * How many selectors one aliased query may span.
 *
 * A bound rather than a limit: a host with more registered projects than this is
 * covered by further requests, never truncated to the first batch. A truncation
 * would report a drained queue for every project past the cut — the exact zero
 * this module refuses everywhere else.
 */
export const REDSKILLED_QUEUE_BATCH_SIZE = 50;

/**
 * Default window between queue polls — the fast cadence of the two.
 *
 * The queue is what the demand loop reads to decide whether to ask for a Worker,
 * so it is sampled at loop speed rather than at the human speed activity moves at.
 */
export const DEFAULT_REDSKILLED_QUEUE_MS = 15_000;

/** How old a depth may be before a consumer calls it stale: two poll windows. */
export const REDSKILLED_QUEUE_STALENESS_MS = 2 * DEFAULT_REDSKILLED_QUEUE_MS;

/** One registered project and the opaque query that names its work. */
export interface RedskilledProjectSelector {
  readonly project_label: string;
  /** The query, carried verbatim to the tracker and never parsed here. */
  readonly selector: string;
}

/** How one project's queue read came out. */
export type RedskilledQueueOutcome = "counted" | "unreachable" | "rate-limited";

export interface RedskilledProjectQueue {
  readonly project_label: string;
  readonly outcome: RedskilledQueueOutcome;
  /** How many items the selector matched; `null` for every outcome but `counted`. */
  readonly depth: number | null;
  /**
   * The last depth this selector actually returned, carried across the failures
   * that followed it; `null` until it has answered once.
   *
   * A failed fetch replaces the stored document, so without this a spent quota
   * would erase the depth the poll before it counted — and a consumer holding
   * nothing behaves exactly like a consumer holding a zero, which is the whole
   * confusion this module exists to refuse.
   */
  readonly last_counted_depth: number | null;
  /** When that depth was counted, so its age is read rather than guessed. */
  readonly last_counted_at: string | null;
  readonly detail: string;
}

/** What the token had left when the query answered; `null` when it did not say. */
export interface RedskilledQueueRateLimit {
  readonly remaining: number | null;
  readonly reset_at: string | null;
  readonly exhausted: boolean;
}

export interface RedskilledQueueDiscovery {
  readonly version: 1;
  readonly fetched_at: string;
  /** How many requests this interval cost — one per batch, not one per project. */
  readonly request_count: number;
  readonly project_count: number;
  readonly batch_size: number;
  readonly rate_limit: RedskilledQueueRateLimit;
  readonly projects: readonly RedskilledProjectQueue[];
}

export interface RedskilledQueueAlias {
  readonly alias: string;
  readonly project: RedskilledProjectSelector;
}

export interface RedskilledQueueOperation {
  readonly query: string;
  readonly aliases: readonly RedskilledQueueAlias[];
}

/**
 * Split every registered project into batches the bound allows. PURE.
 *
 * Coverage, not truncation: N projects cost `ceil(N / size)` requests, which is
 * one for every host this bound was chosen for and still an honest answer for a
 * host that outgrows it.
 */
export function planQueueDiscoveryBatches(
  projects: readonly RedskilledProjectSelector[],
  batchSize: number = REDSKILLED_QUEUE_BATCH_SIZE,
): readonly (readonly RedskilledProjectSelector[])[] {
  assertQueueProjects(projects);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`redskilled queue discovery needs a whole, positive batch size, not ${JSON.stringify(batchSize)}`);
  }
  const batches: RedskilledProjectSelector[][] = [];
  for (let index = 0; index < projects.length; index += batchSize) {
    batches.push(projects.slice(index, index + batchSize));
  }
  return batches;
}

/**
 * One aliased query spanning every selector in a batch. PURE.
 *
 * One alias per project against `search`, which is the shape a selector already
 * has: the daemon hands the string over and reads back an integer. The alias
 * machinery is the activity batch's, with the parameter widened from a repository
 * identity to a query string.
 */
export function buildQueueDiscoveryQuery(
  projects: readonly RedskilledProjectSelector[],
  options: { readonly batchSize?: number } = {},
): RedskilledQueueOperation {
  const batchSize = options.batchSize ?? REDSKILLED_QUEUE_BATCH_SIZE;
  assertQueueProjects(projects);
  if (projects.length > batchSize) {
    throw new Error(
      `redskilled queue discovery spans at most ${batchSize} selectors in one query, and this batch holds ` +
        `${projects.length}: split it with planQueueDiscoveryBatches rather than dropping the remainder`,
    );
  }
  const aliases: RedskilledQueueAlias[] = projects.map((project, index) => ({ alias: `q${index}`, project }));
  const fields = aliases.map(({ alias, project }) =>
    `  ${alias}: search(query: ${JSON.stringify(project.selector)}, type: ISSUE, first: 1) { issueCount }`,
  );
  const query = ["query RedskilledQueueDiscovery {", "  rateLimit { remaining resetAt }", ...fields, "}"].join("\n");
  return { query, aliases };
}

/** What a previous fetch already knew, so a failure loses no fact it held. */
export interface QueueDiscoveryHistory {
  /** The instant this answer belongs to; dates a fresh count. */
  readonly now?: string | null;
  /** The projects of the last fetch, whatever its outcomes were. */
  readonly previous?: readonly RedskilledProjectQueue[];
}

/**
 * Turn one answer into one document. PURE.
 *
 * Each project is judged on its own alias: a selector the token cannot resolve
 * fails alone while its neighbours still count, because one refused query is a
 * fact about that project and not about the host. A project that fails inherits
 * the last depth it counted — inheriting a NEIGHBOUR's would be the same lie in
 * the other direction, so the carry is keyed by project label and nothing else.
 */
export function parseQueueDiscoveryResponse(
  operation: RedskilledQueueOperation,
  payload: unknown,
  history: QueueDiscoveryHistory = {},
): { readonly projects: readonly RedskilledProjectQueue[]; readonly rate_limit: RedskilledQueueRateLimit } {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const errors = Array.isArray(root.errors) ? root.errors.map(asRecord) : [];
  const rateLimit = readRateLimit(data.rateLimit, errors);

  const projects = operation.aliases.map(({ alias, project }): RedskilledProjectQueue => {
    const held = heldCount(history, project.project_label);
    const depth = issueCount(data[alias]);
    if (depth != null) {
      return {
        project_label: project.project_label,
        outcome: "counted",
        depth,
        last_counted_depth: depth,
        last_counted_at: history.now ?? null,
        detail: `project ${JSON.stringify(project.project_label)} has ${depth} item(s) matching its selector`,
      };
    }
    const aliasError = errors.find((candidate) => pathIncludes(candidate.path, alias));
    if (rateLimit.exhausted || isRateLimitError(aliasError)) {
      return {
        project_label: project.project_label,
        outcome: "rate-limited",
        depth: null,
        ...held,
        detail:
          `the host token's quota was spent before project ${JSON.stringify(project.project_label)} answered, so this ` +
          `queue has no depth rather than a depth of zero` +
          (rateLimit.reset_at == null ? "" : `; the quota resets at ${rateLimit.reset_at}`),
      };
    }
    return {
      project_label: project.project_label,
      outcome: "unreachable",
      depth: null,
      ...held,
      detail:
        `project ${JSON.stringify(project.project_label)} could not be counted with the host token: ` +
        `${stringValue(aliasError?.message) || "the query returned no count for this selector"}`,
    };
  });

  return { projects, rate_limit: rateLimit };
}

/** The document a host with nothing registered has: total, and honestly empty. */
export function emptyQueueDiscovery(fetchedAt: string): RedskilledQueueDiscovery {
  return {
    version: 1,
    fetched_at: fetchedAt,
    request_count: 0,
    project_count: 0,
    batch_size: REDSKILLED_QUEUE_BATCH_SIZE,
    rate_limit: { remaining: null, reset_at: null, exhausted: false },
    projects: [],
  };
}

/** How a fetch reaches the tracker; injected so nothing here opens a socket. */
export type RedskilledQueueTransport = (query: string) => Promise<unknown>;

export interface FetchQueueDiscoveryInput {
  readonly projects: readonly RedskilledProjectSelector[];
  readonly transport: RedskilledQueueTransport;
  readonly now: string;
  readonly batchSize?: number;
  /**
   * The document this fetch replaces, so a failure keeps what the last one knew.
   *
   * Optional and never required: a first fetch has no history, and a caller that
   * forgets to pass one gets honest nulls rather than a wrong number.
   */
  readonly previous?: RedskilledQueueDiscovery | null;
}

/**
 * One interval's queue fetch: ONE request, however many projects are registered.
 *
 * Batches are issued in order rather than at once, because a host past the bound
 * is spending one token's quota either way and a burst is the shape that trips a
 * secondary limit. A transport that throws is not swallowed into zeros: every
 * project of that batch comes back with no depth and the thrown sentence as its
 * detail, and the batches around it still answer for themselves.
 */
export async function fetchQueueDiscovery(input: FetchQueueDiscoveryInput): Promise<RedskilledQueueDiscovery> {
  if (input.projects.length === 0) return emptyQueueDiscovery(input.now);
  const batchSize = input.batchSize ?? REDSKILLED_QUEUE_BATCH_SIZE;
  const batches = planQueueDiscoveryBatches(input.projects, batchSize);

  const projects: RedskilledProjectQueue[] = [];
  const history: QueueDiscoveryHistory = { now: input.now, previous: input.previous?.projects ?? [] };
  let rateLimit: RedskilledQueueRateLimit = { remaining: null, reset_at: null, exhausted: false };
  for (const batch of batches) {
    const operation = buildQueueDiscoveryQuery(batch, { batchSize });
    try {
      const payload = await input.transport(operation.query);
      const parsed = parseQueueDiscoveryResponse(operation, payload, history);
      projects.push(...parsed.projects);
      rateLimit = mergeRateLimit(rateLimit, parsed.rate_limit);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const rateLimited = /rate limit|secondary rate|429/i.test(reason);
      rateLimit = mergeRateLimit(rateLimit, { remaining: null, reset_at: null, exhausted: rateLimited });
      for (const project of batch) {
        projects.push({
          project_label: project.project_label,
          outcome: rateLimited ? "rate-limited" : "unreachable",
          depth: null,
          ...heldCount(history, project.project_label),
          detail: `the queue fetch failed before project ${JSON.stringify(project.project_label)} answered: ${reason}`,
        });
      }
    }
  }

  return {
    version: 1,
    fetched_at: input.now,
    request_count: batches.length,
    project_count: projects.length,
    batch_size: batchSize,
    rate_limit: rateLimit,
    projects,
  };
}

/** One project's depth, dated — the shape a consumer reads. */
export interface RedskilledQueueView extends RedskilledProjectQueue {
  readonly fetched_at: string;
  readonly age_ms: number | null;
  readonly stale: boolean;
  /**
   * How old the last SUCCESSFUL count is, which is not how old the fetch is.
   *
   * A poll that came back rate-limited is current and knows nothing; the depth a
   * consumer would act on came from an earlier one, and this is the only number
   * that says whether it is still worth acting on. `null` when the selector has
   * never answered.
   */
  readonly last_counted_age_ms: number | null;
}

export interface RedskilledQueueReport {
  readonly version: 1;
  readonly fetched_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  readonly stale: boolean;
  readonly request_count: number;
  readonly rate_limit: RedskilledQueueRateLimit;
  readonly projects: readonly RedskilledQueueView[];
  readonly reason: string;
}

/**
 * Date the depths so the consumer reads the age instead of inventing it. PURE.
 *
 * The same posture the activity report takes, for the same reason: a surface that
 * dated the answer itself would need the poll interval, the daemon's clock and its
 * own read latency, and would get it wrong differently on every surface.
 */
export function buildQueueReport(input: {
  readonly discovery: RedskilledQueueDiscovery | null;
  readonly now: string;
  readonly stalenessMs?: number;
}): RedskilledQueueReport {
  const threshold = input.stalenessMs ?? REDSKILLED_QUEUE_STALENESS_MS;
  const discovery = input.discovery;
  if (discovery == null) {
    return {
      version: 1,
      fetched_at: null,
      age_ms: null,
      threshold_ms: threshold,
      stale: false,
      request_count: 0,
      rate_limit: { remaining: null, reset_at: null, exhausted: false },
      projects: [],
      reason: "the daemon polls no selector, so there are no queue depths to age",
    };
  }
  const nowMs = Date.parse(input.now);
  const fetchedMs = Date.parse(discovery.fetched_at);
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(fetchedMs) ? Math.max(0, nowMs - fetchedMs) : null;
  const stale = ageMs == null || ageMs > threshold;
  return {
    version: 1,
    fetched_at: discovery.fetched_at,
    age_ms: ageMs,
    threshold_ms: threshold,
    stale: discovery.projects.length > 0 && stale,
    request_count: discovery.request_count,
    rate_limit: discovery.rate_limit,
    projects: discovery.projects.map((project) => ({
      ...project,
      fetched_at: discovery.fetched_at,
      age_ms: ageMs,
      stale,
      last_counted_age_ms: countedAge(nowMs, project.last_counted_at),
    })),
    reason: discovery.projects.length === 0
      ? "the daemon polls no selector, so there are no queue depths to age"
      : ageMs == null
        ? "these depths carry no readable instant, so they cannot be presented as current"
        : stale
          ? `these depths are ${ageMs}ms old, past the ${threshold}ms window`
          : `fetched ${ageMs}ms ago, within the ${threshold}ms window`,
  };
}

/** True when `value` is a complete queue report — a client's fail-closed check. */
export function isRedskilledQueueReport(value: unknown): value is RedskilledQueueReport {
  if (!isRecord(value)) return false;
  const report = value as Record<string, unknown>;
  return report.version === 1 &&
    (report.fetched_at === null || typeof report.fetched_at === "string") &&
    (report.age_ms === null || typeof report.age_ms === "number") &&
    typeof report.threshold_ms === "number" &&
    typeof report.stale === "boolean" &&
    Number.isInteger(report.request_count) &&
    isRecord(report.rate_limit) &&
    Array.isArray(report.projects) &&
    typeof report.reason === "string";
}

function assertQueueProjects(projects: readonly RedskilledProjectSelector[]): void {
  if (projects.length === 0) throw new Error("redskilled queue discovery needs at least one registered project");
  const seen = new Set<string>();
  for (const project of projects) {
    if (typeof project.project_label !== "string" || project.project_label === "") {
      throw new Error("redskilled queue discovery needs a project label for every registered project");
    }
    // Shape, not meaning: an empty selector names no work, and that is the last
    // question this module ever asks about what a selector says.
    if (typeof project.selector !== "string" || project.selector === "") {
      throw new Error(
        `redskilled queue discovery needs a selector for project ${JSON.stringify(project.project_label)}: a project ` +
          `that names no work has no queue to discover`,
      );
    }
    if (seen.has(project.project_label)) {
      throw new Error(
        `redskilled holds one selector per project, and ${JSON.stringify(project.project_label)} is registered twice`,
      );
    }
    seen.add(project.project_label);
  }
}

/**
 * What this project last counted, by label. PURE.
 *
 * Absent history is nulls rather than a zero: a selector that has never answered
 * has no depth to hold, and inventing one would be the confusion in miniature.
 */
function heldCount(
  history: QueueDiscoveryHistory,
  projectLabel: string,
): { readonly last_counted_depth: number | null; readonly last_counted_at: string | null } {
  const held = history.previous?.find((candidate) => candidate.project_label === projectLabel);
  return {
    last_counted_depth: held?.last_counted_depth ?? null,
    last_counted_at: held?.last_counted_at ?? null,
  };
}

/** Milliseconds since the last successful count, or `null` when there is none. */
function countedAge(nowMs: number, countedAt: string | null): number | null {
  if (countedAt == null || !Number.isFinite(nowMs)) return null;
  const countedMs = Date.parse(countedAt);
  return Number.isFinite(countedMs) ? Math.max(0, nowMs - countedMs) : null;
}

function mergeRateLimit(held: RedskilledQueueRateLimit, next: RedskilledQueueRateLimit): RedskilledQueueRateLimit {
  const remaining = next.remaining == null
    ? held.remaining
    : held.remaining == null ? next.remaining : Math.min(held.remaining, next.remaining);
  return {
    remaining,
    reset_at: next.reset_at ?? held.reset_at,
    exhausted: held.exhausted || next.exhausted,
  };
}

function readRateLimit(value: unknown, errors: readonly Record<string, unknown>[]): RedskilledQueueRateLimit {
  const node = asRecord(value);
  const remaining = typeof node.remaining === "number" && Number.isFinite(node.remaining) ? node.remaining : null;
  const resetAt = typeof node.resetAt === "string" ? node.resetAt : null;
  return { remaining, reset_at: resetAt, exhausted: errors.some(isRateLimitError) || remaining === 0 };
}

function isRateLimitError(error: Record<string, unknown> | undefined): boolean {
  if (error == null) return false;
  return stringValue(error.type) === "RATE_LIMITED" || /rate limit/i.test(stringValue(error.message));
}

function pathIncludes(path: unknown, alias: string): boolean {
  return Array.isArray(path) && path.includes(alias);
}

function issueCount(value: unknown): number | null {
  const node = asRecord(value);
  return Number.isInteger(node.issueCount) ? (node.issueCount as number) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
