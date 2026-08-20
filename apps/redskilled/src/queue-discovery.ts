/**
 * queue-discovery — every registered project's conditionally revalidated depth.
 *
 * ADR 0130 Amendment 3 keeps one host-scoped poller over every registration.
 * ADR 0133 changes its production transport: one conditional REST list per
 * project, whose unchanged 304 costs no API budget, replaces a charged aliased
 * GraphQL query. N round trips are the deliberate latency trade.
 *
 * **A 304 is a depth, not zero.** The ETag store retains the body with its
 * validator, so unchanged is indistinguishable from a fresh identical count.
 * Quota refusal and transport failure still carry null and their own outcome.
 *
 * **Two cadences, not one.** Activity and queue keep their own intervals. Forcing
 * the slow half onto the fast half's rhythm would spend more quota than the
 * batching saves, which is the opposite of the point — so the interval lives with
 * the caller and nothing here assumes the two ever tick together.
 *
 * **A selector is carried, never read.** The project also supplies the equivalent
 * repository-list parameters because it understands selector facets. The daemon
 * carries both shapes to the transport and derives neither, so it still does not
 * know what an Issue, a label, a Spec, a gate or a Landing *is* (rule 3).
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

import {
  githubRateLimitResetAt,
  isGithubRateLimitError,
  type GithubAttributedOperation,
  type GithubResponseHeaders,
} from "@reddb-io/github";

import type { RedskilledActivityTransport } from "./repository-activity.js";
import type { RedskilledQueuePollPlan } from "./project-registration.js";

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
  /** Typed list parameters supplied by the project; carried, never derived here. */
  readonly poll?: RedskilledQueuePollPlan;
}

/**
 * How one project's queue read came out.
 *
 * `unconfigured` is the fourth because a daemon with no transport used to answer
 * with nothing at all (#2974): the poll returned before it asked, every tick,
 * and a reader saw the same silence a host with nothing registered shows. "No
 * credential names a tracker" is a fact about the HOST, and it is the one an
 * operator staring at a valid registration and zero Workers needs first.
 */
export type RedskilledQueueOutcome = "counted" | "unreachable" | "rate-limited" | "unconfigured";

export interface RedskilledProjectQueue {
  readonly project_label: string;
  readonly outcome: RedskilledQueueOutcome;
  /** How many items the selector matched; `null` for every outcome but `counted`. */
  readonly depth: number | null;
  readonly detail: string;
  /**
   * The identifiers this poll counted, when the transport returned them.
   *
   * **A poll that counts and then discards has to be asked again.** The REST
   * lane already holds every item it counted; throwing the identifiers away
   * left a birth with a depth and nothing to hand a Worker (Spec #4097). These
   * are OPAQUE strings: carrying what a poll returned is not reading it (ADR
   * 0130 rule 3), and no code may branch on their content.
   *
   * Absent — never `[]` — when the transport counted without listing, because
   * an unknown list is not an empty one. The GraphQL lane asks for a count and
   * gets a number, so it says nothing here.
   */
  readonly items?: readonly string[];
  /**
   * What each counted item is, as the handoff needs it (#4118's first drain).
   *
   * The Worker's Ticket loop is entered only through a handoff, and that
   * contract names the Ticket, its labels and its trunk — so a poll that kept
   * only numbers left the daemon able to plan a birth it could not brief. These
   * are opaque like every other project-authored string here: carried into the
   * handoff verbatim, never read. Same order and same cap as `items`.
   */
  readonly tickets?: readonly RedskilledQueueTicket[];
}

/** One counted item, in the three facts a Ticket handoff has to state. */
export interface RedskilledQueueTicket {
  readonly id: string;
  readonly title: string;
  readonly labels: readonly string[];
}

/**
 * How many identifiers one poll keeps.
 *
 * Enough to feed a target's worth of births with margin, and no more: a record
 * that grew with the backlog would put an unbounded list in a document every
 * status read carries.
 */
export const REDSKILLED_QUEUE_ITEM_CAP = 32;

/**
 * Carry the identifiers a previous poll saw across one that could not list.
 *
 * **An unreachable queue is not an empty one.** A poll that fails says nothing
 * about what is queued, so erasing the last list would tell every later reader
 * that the backlog emptied at the moment the network did. A `counted` poll
 * always replaces — including with an empty list, which is a real answer. PURE.
 */
export function carryQueueItems(
  next: RedskilledQueueDiscovery,
  previous: RedskilledQueueDiscovery | null,
): RedskilledQueueDiscovery {
  if (previous == null) return next;
  const held = new Map(previous.projects
    .filter((project) => project.items != null)
    .map((project) => [project.project_label, { items: project.items!, tickets: project.tickets ?? [] }] as const));
  return {
    ...next,
    projects: next.projects.map((project) => {
      if (project.items != null) return project;
      const carried = held.get(project.project_label);
      return carried == null ? project : { ...project, items: [...carried.items], tickets: [...carried.tickets] };
    }),
  };
}

/**
 * The identifiers a REST answer listed, as opaque strings. PURE.
 *
 * An item the transport returned without one is skipped rather than given an
 * invented name: a birth handed a fabricated identifier is worse than a birth
 * the daemon declines to plan.
 */
export function queueItemIdentifiers(items: readonly Record<string, unknown>[]): readonly string[] {
  return queueTickets(items).map((ticket) => ticket.id);
}

/**
 * The counted items in the three facts a handoff states. PURE.
 *
 * An item the transport returned without a usable number is skipped for the
 * same reason as before — a birth briefed with a fabricated Ticket is worse
 * than a birth the daemon declines to plan — and a missing title becomes an
 * empty string rather than an invented one, because the handoff refuses an
 * empty title and refusing loudly beats briefing wrongly.
 */
export function queueTickets(items: readonly Record<string, unknown>[]): readonly RedskilledQueueTicket[] {
  const tickets: RedskilledQueueTicket[] = [];
  for (const item of items) {
    if (tickets.length >= REDSKILLED_QUEUE_ITEM_CAP) break;
    const number = item.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    tickets.push({
      id: String(number),
      title: typeof item.title === "string" ? item.title : "",
      labels: Array.isArray(item.labels)
        ? item.labels
          .map((label) => (typeof label === "string" ? label : (label as { name?: unknown } | null)?.name))
          .filter((name): name is string => typeof name === "string")
        : [],
    });
  }
  return tickets;
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
  /** Network requests issued: one per conditional project, or one per legacy batch. */
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

/**
 * Turn one answer into one document. PURE.
 *
 * Each project is judged on its own alias: a selector the token cannot resolve
 * fails alone while its neighbours still count, because one refused query is a
 * fact about that project and not about the host.
 */
export function parseQueueDiscoveryResponse(
  operation: RedskilledQueueOperation,
  payload: unknown,
): { readonly projects: readonly RedskilledProjectQueue[]; readonly rate_limit: RedskilledQueueRateLimit } {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const errors = Array.isArray(root.errors) ? root.errors.map(asRecord) : [];
  const rateLimit = readRateLimit(data.rateLimit, errors);

  const projects = operation.aliases.map(({ alias, project }): RedskilledProjectQueue => {
    const depth = issueCount(data[alias]);
    if (depth != null) {
      return {
        project_label: project.project_label,
        outcome: "counted",
        depth,
        detail: `project ${JSON.stringify(project.project_label)} has ${depth} item(s) matching its selector`,
      };
    }
    const aliasError = errors.find((candidate) => pathIncludes(candidate.path, alias));
    if (rateLimit.exhausted || isRateLimitError(aliasError)) {
      return {
        project_label: project.project_label,
        outcome: "rate-limited",
        depth: null,
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

/**
 * The document a host that cannot ask has: every project, and why none was asked.
 *
 * A poll nobody could run is REPORTED rather than skipped. The alternative is the
 * defect this exists to end: a daemon with no transport returned a bare `null`,
 * which every surface downstream renders exactly like a host that has counted
 * nothing yet — so a registration standing beside an empty machine looked healthy
 * and produced nothing. No depth is invented for it; `null` per project keeps a
 * silent host distinguishable from a drained one, which is the same line the
 * rate-limited and unreachable outcomes hold. PURE.
 */
export function unconfiguredQueueDiscovery(
  projects: readonly RedskilledProjectSelector[],
  fetchedAt: string,
  reason: string,
): RedskilledQueueDiscovery {
  return {
    version: 1,
    fetched_at: fetchedAt,
    // No request left this host, and the cost states so — an unconfigured poll
    // that claimed a request would put a fetch that never happened in the budget.
    request_count: 0,
    project_count: projects.length,
    batch_size: REDSKILLED_QUEUE_BATCH_SIZE,
    rate_limit: { remaining: null, reset_at: null, exhausted: false },
    projects: projects.map((project) => ({
      project_label: project.project_label,
      outcome: "unconfigured",
      depth: null,
      detail:
        `project ${JSON.stringify(project.project_label)} was not counted because this host polls no tracker: ${reason}`,
    })),
  };
}

/** The queue shares the host's conditional-capable activity transport. */
export type RedskilledQueueTransport = RedskilledActivityTransport;

export interface FetchQueueDiscoveryInput {
  readonly projects: readonly RedskilledProjectSelector[];
  readonly transport: RedskilledQueueTransport;
  readonly now: string;
  readonly batchSize?: number;
}

/**
 * One interval's queue fetch: one conditional request per project in production,
 * or aliased batches for an injected migration adapter.
 *
 * Batches are issued in order rather than at once, because a host past the bound
 * is spending one token's quota either way and a burst is the shape that trips a
 * secondary limit. A transport that throws is not swallowed into zeros: every
 * project of that batch comes back with no depth and the thrown sentence as its
 * detail, and the batches around it still answer for themselves.
 */
export async function fetchQueueDiscovery(input: FetchQueueDiscoveryInput): Promise<RedskilledQueueDiscovery> {
  if (input.projects.length === 0) return emptyQueueDiscovery(input.now);
  if (input.transport.conditionalList) return await fetchConditionalQueueDiscovery(input);
  const batchSize = input.batchSize ?? REDSKILLED_QUEUE_BATCH_SIZE;
  const batches = planQueueDiscoveryBatches(input.projects, batchSize);

  const projects: RedskilledProjectQueue[] = [];
  let rateLimit: RedskilledQueueRateLimit = { remaining: null, reset_at: null, exhausted: false };
  for (const batch of batches) {
    const operation = buildQueueDiscoveryQuery(batch, { batchSize });
    try {
      const payload = await input.transport(operation.query);
      const parsed = parseQueueDiscoveryResponse(operation, payload);
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

const REDSKILLED_QUEUE_REST_OPERATION: GithubAttributedOperation = {
  key: "redskilled queue poll",
  budget: "rest",
};

async function fetchConditionalQueueDiscovery(
  input: FetchQueueDiscoveryInput,
): Promise<RedskilledQueueDiscovery> {
  assertQueueProjects(input.projects);
  const list = input.transport.conditionalList!;
  const projects: RedskilledProjectQueue[] = [];
  let rateLimit: RedskilledQueueRateLimit = { remaining: null, reset_at: null, exhausted: false };
  let requestCount = 0;

  for (const project of input.projects) {
    try {
      if (project.poll == null) {
        const operation = buildQueueDiscoveryQuery([project], { batchSize: 1 });
        const parsed = parseQueueDiscoveryResponse(operation, await input.transport(operation.query));
        requestCount += 1;
        projects.push(...parsed.projects);
        rateLimit = mergeRateLimit(rateLimit, parsed.rate_limit);
        continue;
      }
      const answer = await list({
        cacheKey: `queue:${project.project_label}:${JSON.stringify(project.poll)}`,
        route: "GET /repos/{owner}/{repo}/issues",
        parameters: {
          owner: project.poll.owner,
          repo: project.poll.repo,
          state: "open",
          labels: project.poll.labels.join(","),
          ...(project.poll.creator == null ? {} : { creator: project.poll.creator }),
        },
        operation: REDSKILLED_QUEUE_REST_OPERATION,
      });
      requestCount += answer.requestCount;
      const matched = answer.data.filter((item) => !isRecord(item.pull_request));
      const depth = matched.length;
      rateLimit = mergeRateLimit(rateLimit, queueRateLimitFromHeaders(answer.headers));
      projects.push({
        project_label: project.project_label,
        outcome: "counted",
        depth,
        detail: `project ${JSON.stringify(project.project_label)} has ${depth} item(s) matching its selector`,
        items: queueItemIdentifiers(matched),
        tickets: queueTickets(matched),
      });
    } catch (error) {
      const rateLimited = isGithubRateLimitError(error);
      rateLimit = mergeRateLimit(rateLimit, {
        remaining: null,
        reset_at: rateLimited ? githubRateLimitResetAt(error) : null,
        exhausted: rateLimited,
      });
      projects.push({
        project_label: project.project_label,
        outcome: rateLimited ? "rate-limited" : "unreachable",
        depth: null,
        detail:
          `the queue fetch failed before project ${JSON.stringify(project.project_label)} answered: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    version: 1,
    fetched_at: input.now,
    request_count: requestCount,
    project_count: projects.length,
    batch_size: 1,
    rate_limit: rateLimit,
    projects,
  };
}

/** One project's depth, dated — the shape a consumer reads. */
export interface RedskilledQueueView extends RedskilledProjectQueue {
  readonly fetched_at: string;
  readonly age_ms: number | null;
  readonly stale: boolean;
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

function queueRateLimitFromHeaders(headers: GithubResponseHeaders): RedskilledQueueRateLimit {
  const remaining = integerHeader(headers, "x-ratelimit-remaining");
  const resetSeconds = integerHeader(headers, "x-ratelimit-reset");
  return {
    remaining,
    reset_at: resetSeconds == null ? null : new Date(resetSeconds * 1000).toISOString(),
    exhausted: remaining === 0,
  };
}

function integerHeader(headers: GithubResponseHeaders, name: string): number | null {
  const raw = headers[name];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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

/**
 * How long until the next queue poll, given what the last one saw. PURE.
 *
 * **The balance arrives free with every poll and used to be thrown away.** This
 * document has carried a `rate_limit` since it existed and nothing read it,
 * while the poll ran on a constant — so the daemon asked at exactly the same
 * rate whether the token was full or one request from empty.
 *
 * A fixed cadence must choose once between two opposite situations: slow at the
 * edge, where the number moves fastest and matters most, or wasteful in the
 * middle, where nothing is going to run out. This chooses per poll.
 *
 * **It may only ever slow DOWN.** Polling faster on a low balance would spend
 * more of exactly the budget it just noticed running out.
 *
 * **Exhaustion waits for the reset**, because until then no answer can change:
 * asking again spends a request to be told the same thing. The wait is clamped
 * at both ends so a missing, malformed or absurd reset instant can neither spin
 * nor sleep the poller out of existence.
 */
export function nextQueuePollMs(
  discovery: RedskilledQueueDiscovery | null,
  baseMs: number,
  nowMs: number,
): number {
  const limit = discovery?.rate_limit;
  if (limit == null) return baseMs;
  if (limit.exhausted) {
    const resetAtMs = limit.reset_at == null ? Number.NaN : Date.parse(limit.reset_at);
    const waitMs = Number.isFinite(resetAtMs) ? resetAtMs - nowMs + 1_000 : baseMs * 4;
    return Math.min(REDSKILLED_QUEUE_MAX_BACKOFF_MS, Math.max(baseMs, waitMs));
  }
  // `remaining` is a count, not a share: this payload states what is left and
  // never what the ceiling was, so the thresholds are absolute — the same shape
  // the balance module uses, expressed in the only unit carried here.
  const remaining = limit.remaining;
  if (remaining == null) return baseMs;
  if (remaining <= REDSKILLED_QUEUE_TIGHT_REMAINING) return Math.max(baseMs, 30_000);
  if (remaining <= REDSKILLED_QUEUE_LOW_REMAINING) return Math.max(baseMs, 20_000);
  return baseMs;
}

/**
 * Never sleep the poller longer than this, whatever a reset instant claims.
 *
 * **Bounded BELOW the registration TTL, not chosen freely.** Registration
 * sustainment has its own cadence, but open-work evidence still comes from this
 * poll. A backoff as long as the TTL makes that evidence stale before the next
 * poll can refresh it and removes the recovery proof for an accidental lapse.
 *
 * That is what #3133 actually was. The adaptive cadence introduced in #3121
 * landed at 300_000ms, exactly `REDSKILLED_REGISTRATION_TTL_MS`, so one slow
 * cycle retired a healthy project with a full queue and a Worker still landing.
 * A third of the TTL leaves room for two missed polls before evidence goes stale.
 *
 * Kept as a literal with the arithmetic shown rather than importing the TTL:
 * this module is PURE and imports nothing, and a cross-import for one number
 * would trade that for a constant that must not drift anyway — which is what
 * the guard below is for.
 */
export const REDSKILLED_QUEUE_MAX_BACKOFF_MS = 100_000;

/** At or under this many requests left, poll at the slowest ordinary cadence. */
export const REDSKILLED_QUEUE_TIGHT_REMAINING = 250;

/** At or under this many, begin slowing down. */
export const REDSKILLED_QUEUE_LOW_REMAINING = 1_000;
