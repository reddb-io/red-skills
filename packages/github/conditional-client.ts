// conditional-client.ts — the HTTP transport for stable GitHub reads.
//
// A 304 is a successful revalidation, not an empty response. The client owns the
// ETag and the answer it validates together, so no caller can observe a 304
// without the data from the preceding 200. Rate-limit and network failures are
// allowed through as failures: neither is evidence that the held answer is still
// current.

import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit as RestOctokit } from "@octokit/rest";

import {
  buildSingleObjectReadsQuery,
  readSingleObjectRows,
  type GithubAliasedSingleObjectRead,
} from "./aliased-query.js";
import type { GithubAttributionLedger, GithubAttributedOperation } from "./attribution.js";
import type { GithubBalance } from "./balance.js";
import {
  DEFAULT_GITHUB_BALANCE_TIMEOUT_MS,
  createTimedGithubFetch,
  githubRequestTimeoutMs,
  withGithubDeadline,
} from "./deadline.js";
import {
  githubBudgetGateEnabled,
  githubBudgetGateFromEnv,
  type GithubBudgetGateMode,
} from "./budget-gate.js";
import type { GithubApiSurface, GithubRateBudget } from "./surface.js";

const Octokit = RestOctokit.plugin(retry, throttling);

export type GithubRequestFetch = typeof fetch;
export type GithubResponseHeaders = Readonly<Record<string, string | number | undefined>>;

export interface GithubEtagEntry {
  readonly etag: string;
  readonly data: unknown;
  readonly headers: GithubResponseHeaders;
  /** When the held body was last confirmed by a 200 response. */
  readonly storedAt?: string;
}

/** The ETag and answer are one entry: retaining only the validator makes 304 empty. */
export interface GithubEtagStore {
  get(key: string): GithubEtagEntry | undefined;
  set(key: string, entry: GithubEtagEntry): void;
}

/** A daemon-lifetime store. Callers may provide a durable implementation later. */
export function createMemoryGithubEtagStore(): GithubEtagStore {
  const entries = new Map<string, GithubEtagEntry>();
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => entries.set(key, entry),
  };
}

export interface GithubConditionalRestRequest {
  /** Stable identity of one collection across poll cycles. */
  readonly cacheKey: string;
  /** An Octokit route such as `GET /search/issues`. */
  readonly route: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Durable spend attribution for this call. */
  readonly operation: GithubAttributedOperation;
  /** Named caller for durable spend attribution when several clients share one transport. */
  readonly actor?: string;
}

/**
 * The caller deliberately cannot distinguish 200 from 304. Both answers carry
 * the same data; only a failure escapes as a different outcome.
 */
export interface GithubRestAnswer<T> {
  readonly data: T;
  readonly headers: GithubResponseHeaders;
  /** True when a 304 reused the held answer and consumed no REST request budget. */
  readonly quotaFree: boolean;
  readonly degraded?: GithubCachedFallback;
}

export interface GithubCachedFallback {
  readonly source: "cache";
  readonly pool: GithubRateBudget;
  readonly resetAt: string;
  readonly ageMs: number | null;
  readonly reason: string;
}

export interface GithubPaginatedRestAnswer<T> extends GithubRestAnswer<readonly T[]> {
  /** HTTP requests issued, including free 304 revalidations. */
  readonly requestCount: number;
}

export interface GithubClient {
  conditionalRest<T>(request: GithubConditionalRestRequest): Promise<GithubRestAnswer<T>>;
  conditionalPaginate<T>(request: GithubConditionalRestRequest): Promise<GithubPaginatedRestAnswer<T>>;
  singleObject<T>(request: GithubSingleObjectRequest): Promise<GithubSingleObjectAnswer<T>>;
  graphql<T>(
    query: string,
    variables?: Readonly<Record<string, unknown>>,
    attribution?: GithubGraphqlAttribution,
  ): Promise<T>;
}

/** One issue or pull request read that may share a GraphQL request with its peers. */
export interface GithubSingleObjectRequest extends GithubAliasedSingleObjectRead {
  /** Stable conditional-REST identity. A held validator keeps this read on REST. */
  readonly cacheKey: string;
  readonly operation: GithubAttributedOperation;
  readonly actor?: string;
  /** Force one API rail when it is available; an exhausted rail falls back to its declared equivalent. */
  readonly rail?: GithubApiSurface;
  /** Project REST and GraphQL payloads into one caller-visible object shape. */
  readonly project?: (value: unknown, surface: GithubApiSurface) => unknown;
}

/** The common answer shape from either realization of a single-object read. */
export interface GithubSingleObjectAnswer<T> {
  readonly data: T;
  readonly surface: GithubApiSurface;
  readonly quotaFree: boolean;
  /** Present for an explicit choice or a failover, so routing never becomes invisible. */
  readonly routing?: GithubRailRouting;
}

export interface GithubRailRouting {
  readonly requestedRail: GithubApiSurface;
  readonly selectedRail: GithubApiSurface;
  readonly rerouted: boolean;
  /** The exhausted source pool when rerouted. */
  readonly pool: GithubRateBudget;
  readonly resetAt: string | null;
  readonly reason: string;
}

export interface GithubGraphqlAttribution {
  readonly operation: GithubAttributedOperation;
  readonly actor?: string;
}

export interface CreateGithubClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: GithubRequestFetch;
  readonly etags?: GithubEtagStore;
  readonly attribution?: GithubAttributionLedger;
  /** The last authoritative token-wide balance; an unknown balance never diverts. */
  readonly balance?: () => GithubBalance | null | Promise<GithubBalance | null>;
  readonly now?: () => string;
  /** Transient retries; the plugin default in production, overridable in tests. */
  readonly retryCount?: number;
  /** Disable plugin pacing only for a caller-supplied transport test. */
  readonly throttle?: boolean;
  /**
   * Whether the balance may REFUSE a call, or only describe one. Off by default:
   * the quota is the operator's to spend (`budget-gate.ts`).
   */
  readonly budgetGate?: GithubBudgetGateMode;
  /** Per-request deadline; the env-tunable process default when absent. */
  readonly timeoutMs?: number;
  /**
   * Deadline for one balance read. Shorter than a request's, because an unknown
   * balance is a legal answer and a known one is never worth a stall.
   */
  readonly balanceTimeoutMs?: number;
}

/**
 * The first batch size that stays on REST; a larger cold batch uses GraphQL.
 *
 * This is deliberately a function of BOTH pools' remaining fractions. When
 * REST has eight times GraphQL's headroom the threshold is eight; when GraphQL
 * is healthier it falls to one. A missing or spent GraphQL pool cannot absorb a
 * batch and returns infinity. The threshold never falls below one: a lone
 * object remains the REST-preferred rule, while only plural reads coalesce.
 */
export function githubSingleObjectCoalescingThreshold(balance: GithubBalance | null): number {
  if (balance?.outcome !== "asked") return Number.POSITIVE_INFINITY;
  const rest = balance.pools.rest;
  const graphql = balance.pools.graphql;
  if (rest === null || graphql === null || graphql.remaining <= 0 || graphql.fraction <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (rest.remaining <= 0 || rest.fraction <= 0) return 1;
  if (!Number.isFinite(rest.fraction) || !Number.isFinite(graphql.fraction)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(1, Math.ceil(rest.fraction / graphql.fraction));
}

/** An expired credential stated in operator language rather than as a bare 401. */
export class GithubCredentialError extends Error {
  readonly status = 401;

  constructor(options?: { readonly cause?: unknown }) {
    super(
      "GitHub rejected the host credential; refresh the stored login with `gh auth login` or provide a current host token",
      options,
    );
    this.name = "GithubCredentialError";
  }
}

/** A primary pool cannot serve this request and no equivalent/cache can answer it. */
export class GithubPoolUnavailableError extends Error {
  readonly pool: GithubRateBudget;
  readonly resetAt: string;

  constructor(pool: GithubRateBudget, resetAt: string, detail?: string, options?: { readonly cause?: unknown }) {
    super(
      `${pool} pool is exhausted; parked until ${resetAt}${detail ? ` (${detail})` : ""}`,
      options,
    );
    this.name = "GithubPoolUnavailableError";
    this.pool = pool;
    this.resetAt = resetAt;
  }
}

/**
 * Build the typed GitHub transport decided by ADR 0133.
 *
 * `@octokit/rest` already composes `plugin-paginate-rest`; retry handles
 * transient server failures, while throttling serializes and classifies primary
 * and secondary limits. The callbacks decline a long in-call retry so the
 * execution owner's existing poll cadence can pace the next cycle from the response.
 */
export function createGithubClient(options: CreateGithubClientOptions): GithubClient {
  const etags = options.etags ?? createMemoryGithubEtagStore();
  const now = options.now ?? (() => new Date().toISOString());
  // Bounded at the transport, so a route added later inherits the deadline
  // instead of having to remember it (`deadline.ts`).
  const timeoutMs = options.timeoutMs ?? githubRequestTimeoutMs();
  const balanceTimeoutMs = options.balanceTimeoutMs ?? Math.min(timeoutMs || DEFAULT_GITHUB_BALANCE_TIMEOUT_MS, DEFAULT_GITHUB_BALANCE_TIMEOUT_MS);
  const gated = githubBudgetGateEnabled(options.budgetGate ?? githubBudgetGateFromEnv());
  const timedFetch = createTimedGithubFetch({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl as unknown as typeof fetch } : {}),
    timeoutMs,
  });
  const octokit = new Octokit({
    auth: options.token,
    // REST.js logs every non-2xx before the caller can classify it, including
    // the expected 304 that is this client's success path. Outcomes travel as
    // typed returns/errors instead of turning every quiet poll into stderr.
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    request: { fetch: timedFetch as unknown as GithubRequestFetch },
    retry: {
      doNotRetry: [304, 403, 429],
      ...(options.retryCount === undefined ? {} : { retries: options.retryCount }),
    },
    throttle: options.throttle === false
      ? { enabled: false }
      : {
          onRateLimit: () => false,
          onSecondaryRateLimit: () => false,
        },
  });

  // A balance is an OPTIMIZATION here, never a precondition: it picks a rail and,
  // when the gate is on, refuses a spent pool. So the read is bounded and a
  // stalled provider degrades to `null` — unknown — rather than holding the call
  // that asked for it. This is the joiner half of #3768: one wedged balance ask
  // must not become every caller's wait.
  const readBalance = async (): Promise<GithubBalance | null> => {
    if (options.balance === undefined) return null;
    try {
      return await withGithubDeadline("balance read", balanceTimeoutMs, async () =>
        await options.balance!() ?? null);
    } catch {
      return null;
    }
  };

  const refuseSpentPool = (balance: GithubBalance | null, pool: GithubRateBudget): void => {
    if (!gated) return;
    const observed = balance?.pools[pool] ?? null;
    if (observed !== null && observed.remaining <= 0) {
      throw new GithubPoolUnavailableError(pool, observed.reset_at);
    }
  };

  const conditionalRest = async <T>(input: GithubConditionalRestRequest): Promise<GithubRestAnswer<T>> => {
      const held = etags.get(input.cacheKey);
      const observed = gated ? (await readBalance())?.pools[input.operation.budget] ?? null : null;
      if (observed !== null && observed.remaining <= 0) {
        if (held !== undefined) return cachedAnswer<T>(held, input.operation.budget, observed.reset_at, now());
        throw new GithubPoolUnavailableError(input.operation.budget, observed.reset_at);
      }
      const parameters = { ...(input.parameters ?? {}) } as Record<string, unknown>;
      const callerHeaders = isRecord(parameters.headers) ? parameters.headers : {};
      parameters.headers = {
        ...callerHeaders,
        ...(held ? { "if-none-match": held.etag } : {}),
      };

      try {
        const response = await octokit.request(input.route, parameters);
        const headers = response.headers as GithubResponseHeaders;
        const etag = header(headers, "etag");
        if (etag !== undefined) etags.set(input.cacheKey, { etag, data: response.data, headers, storedAt: now() });
        await options.attribution?.record({ operation: input.operation, cost: 1, actor: input.actor });
        return { data: response.data as T, headers, quotaFree: false };
      } catch (error) {
        if (httpStatus(error) === 304) {
          if (held === undefined) {
            throw new Error(
              `GitHub returned 304 for ${JSON.stringify(input.cacheKey)} without a held answer to reuse`,
              { cause: error },
            );
          }
          const responseHeaders = errorHeaders(error);
          const headers = { ...held.headers, ...responseHeaders };
          const etag = header(headers, "etag") ?? held.etag;
          etags.set(input.cacheKey, { etag, data: held.data, headers, ...(held.storedAt ? { storedAt: held.storedAt } : {}) });
          await options.attribution?.record({ operation: input.operation, cost: 0, actor: input.actor });
          return { data: held.data as T, headers, quotaFree: true };
        }
        if (httpStatus(error) === 401) throw new GithubCredentialError({ cause: error });
        if (isGithubRateLimitError(error)) {
          if (held !== undefined) {
            const unavailable = unavailableFromError(input.operation.budget, error);
            return cachedAnswer<T>(held, input.operation.budget, unavailable.resetAt, now());
          }
          throw unavailableFromError(input.operation.budget, error);
        }
        throw error;
      }
    };

  interface PendingSingleObjectRead {
    readonly input: GithubSingleObjectRequest;
    readonly resolve: (answer: GithubSingleObjectAnswer<unknown>) => void;
    readonly reject: (error: unknown) => void;
  }

  const pendingSingleObjects = new Map<string, PendingSingleObjectRead[]>();
  let singleObjectFlushScheduled = false;

  const readSingleObjectRest = async (
    pending: PendingSingleObjectRead,
    routing?: GithubRailRouting,
  ): Promise<void> => {
    const input = pending.input;
    const pull = input.kind === "pr";
    try {
      const answer = await conditionalRest<unknown>({
        cacheKey: input.cacheKey,
        route: pull
          ? "GET /repos/{owner}/{repo}/pulls/{pull_number}"
          : "GET /repos/{owner}/{repo}/issues/{issue_number}",
        parameters: {
          owner: input.owner,
          repo: input.repo,
          ...(pull ? { pull_number: input.number } : { issue_number: input.number }),
        },
        operation: input.operation,
        actor: input.actor,
      });
      pending.resolve({
        data: input.project ? input.project(answer.data, "rest") : answer.data,
        surface: "rest",
        quotaFree: answer.quotaFree,
        ...(routing ? { routing } : {}),
      });
    } catch (error) {
      pending.reject(error);
    }
  };

  const readSingleObjectBatch = async (
    group: readonly PendingSingleObjectRead[],
    routing?: GithubRailRouting,
  ): Promise<void> => {
    try {
      const aliased = buildSingleObjectReadsQuery(group.map(({ input }) => input));
      const answer = await octokit.graphql(aliased.query) as unknown;
      const rows = readSingleObjectRows(aliased, answer);
      const pointCost = graphqlPointCost(answer);
      const first = group[0]!.input;
      await options.attribution?.record({
        operation: { key: first.operation.key, budget: "graphql" },
        cost: pointCost,
        actor: coalescedActor(group.map(({ input }) => input.actor)),
      });
      rows.forEach((row, index) => {
        const pending = group[index]!;
        if (row.value === null) {
          pending.reject(new Error(
            `GitHub returned no ${row.read.kind} #${row.read.number} from the coalesced query`,
          ));
        } else {
          pending.resolve({
            data: pending.input.project
              ? pending.input.project(row.value, "graphql")
              : row.value,
            surface: "graphql",
            quotaFree: false,
            ...(routing ? { routing } : {}),
          });
        }
      });
    } catch (error) {
      const translated = httpStatus(error) === 401 ? new GithubCredentialError({ cause: error }) : error;
      group.forEach((pending) => pending.reject(translated));
    }
  };

  const flushSingleObjects = async (): Promise<void> => {
    // **THE FLUSH IS THE ONLY DRAIN, so it must always reach one.** A caller
    // enqueued here holds a promise nothing else can settle, and while
    // `singleObjectFlushScheduled` is true no second flush is scheduled — so a
    // throw anywhere above the drain strands every waiting read forever, which
    // is the shape #3768 wore. The balance read above is bounded (`readBalance`),
    // and this frame guarantees the rest: the flag is cleared and every stranded
    // read is REJECTED, because a loud failure is a caller that can retry and a
    // pending promise is a caller that cannot.
    try {
      const balance = await readBalance();
      const threshold = githubSingleObjectCoalescingThreshold(balance);
      singleObjectFlushScheduled = false;
      const groups = [...pendingSingleObjects.values()];
      pendingSingleObjects.clear();
      await drainSingleObjectGroups(groups, balance, threshold);
    } catch (error) {
      singleObjectFlushScheduled = false;
      const stranded = [...pendingSingleObjects.values()];
      pendingSingleObjects.clear();
      for (const group of stranded) group.forEach((pending) => pending.reject(error));
    }
  };

  const drainSingleObjectGroups = async (
    groups: readonly PendingSingleObjectRead[][],
    balance: GithubBalance | null,
    threshold: number,
  ): Promise<void> => {
    await Promise.all(groups.map(async (group) => {
      const explicit = group[0]!.input.rail;
      const requested = explicit ?? "rest";
      // Rerouting off an exhausted rail is routing and stays on in both modes;
      // REFUSING when no rail can answer is the gate's, and stays off by default.
      const source = balance?.pools[requested] ?? null;
      const fallback: GithubApiSurface = requested === "rest" ? "graphql" : "rest";
      const destination = balance?.pools[fallback] ?? null;
      const requestedCache = requested === "rest" && group.every(({ input }) => etags.get(input.cacheKey) !== undefined);
      const fallbackCache = fallback === "rest" && group.every(({ input }) => etags.get(input.cacheKey) !== undefined);
      let selected = requested;
      let routing: GithubRailRouting | undefined;

      if (source !== null && source.remaining <= 0) {
        if ((destination !== null && destination.remaining > 0) || fallbackCache) {
          selected = fallback;
          routing = {
            requestedRail: requested,
            selectedRail: selected,
            rerouted: true,
            pool: requested,
            resetAt: source.reset_at,
            reason: `${requested} pool is exhausted until ${source.reset_at}; used the equivalent ${selected} rail`,
          };
        } else if (!requestedCache && gated) {
          const error = new GithubPoolUnavailableError(requested, source.reset_at, "the equivalent rail has no known budget");
          group.forEach((pending) => pending.reject(error));
          return;
        }
      } else if (explicit !== undefined) {
        routing = {
          requestedRail: requested,
          selectedRail: selected,
          rerouted: false,
          pool: requested,
          resetAt: source?.reset_at ?? null,
          reason: source === null
            ? `${requested} pool balance is unknown, so the explicit rail is honored reactively`
            : `${requested} pool has ${source.remaining} remaining, so the explicit rail is honored`,
        };
      }

      const warm = group.some(({ input }) => etags.get(input.cacheKey) !== undefined);
      if (selected === "graphql" || (explicit === undefined && !warm && group.length > threshold)) {
        await readSingleObjectBatch(group, routing);
      } else {
        await Promise.all(group.map((pending) => readSingleObjectRest(pending, routing)));
      }
    }));
  };

  const singleObject = <T>(input: GithubSingleObjectRequest): Promise<GithubSingleObjectAnswer<T>> => {
    // Rule 1 and its counter-rule stay together here: one object prefers REST,
    // while enough COLD peers may coalesce. A held validator can answer 304 for
    // zero primary quota, so it never gets traded for a charged GraphQL node.
    return new Promise<GithubSingleObjectAnswer<T>>((resolve, reject) => {
      const groupKey = `${input.kind}:${input.rail ?? "default"}`;
      const group = pendingSingleObjects.get(groupKey) ?? [];
      group.push({
        input,
        resolve: resolve as (answer: GithubSingleObjectAnswer<unknown>) => void,
        reject,
      });
      pendingSingleObjects.set(groupKey, group);
      if (!singleObjectFlushScheduled) {
        singleObjectFlushScheduled = true;
        // A zero-delay task collects reads started by adjacent promise jobs too;
        // a microtask would flush before those concurrently scheduled callers
        // had a chance to join the batch.
        setTimeout(() => void flushSingleObjects(), 0);
      }
    });
  };

  return {
    conditionalRest,
    singleObject,

    async conditionalPaginate<T>(input: GithubConditionalRestRequest): Promise<GithubPaginatedRestAnswer<T>> {
      const data: T[] = [];
      let headers: GithubResponseHeaders = {};
      let requestCount = 0;
      let quotaFree = true;
      let page = 1;
      for (;;) {
        const answer = await conditionalRest<unknown>({
          ...input,
          cacheKey: `${input.cacheKey}:page:${page}`,
          parameters: { ...(input.parameters ?? {}), per_page: 100, page },
        });
        requestCount += 1;
        quotaFree = quotaFree && answer.quotaFree;
        if (!Array.isArray(answer.data)) {
          throw new Error(`GitHub returned a non-list body for ${JSON.stringify(input.cacheKey)} page ${page}`);
        }
        data.push(...answer.data as T[]);
        headers = answer.headers;
        if (!hasNextPage(answer.headers)) break;
        page += 1;
      }
      return { data, headers, requestCount, quotaFree };
    },

    async graphql<T>(
      query: string,
      variables: Readonly<Record<string, unknown>> = {},
      attribution?: GithubGraphqlAttribution,
    ): Promise<T> {
      try {
        refuseSpentPool(await readBalance(), attribution?.operation.budget ?? "graphql");
        const answer = await octokit.graphql(query, variables) as T;
        if (attribution) {
          // Generic GraphQL does not expose the response's point cost. One is
          // the minimum observed spend; callers with a rateLimit.cost field can
          // replace this with the exact transport observation later.
          await options.attribution?.record({
            operation: attribution.operation,
            cost: 1,
            actor: attribution.actor,
          });
        }
        return answer;
      } catch (error) {
        if (httpStatus(error) === 401) throw new GithubCredentialError({ cause: error });
        if (isGithubRateLimitError(error)) {
          throw unavailableFromError(attribution?.operation.budget ?? "graphql", error);
        }
        throw error;
      }
    },
  };
}

function cachedAnswer<T>(
  held: GithubEtagEntry,
  pool: GithubRateBudget,
  resetAt: string,
  now: string,
): GithubRestAnswer<T> {
  const current = Date.parse(now);
  const stored = held.storedAt === undefined ? Number.NaN : Date.parse(held.storedAt);
  return {
    data: held.data as T,
    headers: held.headers,
    quotaFree: true,
    degraded: {
      source: "cache",
      pool,
      resetAt,
      ageMs: Number.isFinite(current) && Number.isFinite(stored) ? Math.max(0, current - stored) : null,
      reason: `${pool} pool is exhausted until ${resetAt}; serving the last-known answer instead of going dark`,
    },
  };
}

function unavailableFromError(pool: GithubRateBudget, error: unknown): GithubPoolUnavailableError {
  const headers = errorHeaders(error);
  const resetSeconds = Number(header(headers, "x-ratelimit-reset"));
  const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0
    ? new Date(resetSeconds * 1_000).toISOString()
    : "an unknown reset instant";
  return new GithubPoolUnavailableError(pool, resetAt, "GitHub refused the live request", { cause: error });
}

function hasNextPage(headers: GithubResponseHeaders): boolean {
  const link = header(headers, "link");
  return link !== undefined && /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*;|\s*(?:,|$))/i.test(link);
}

/** Primary/secondary quota refusal, distinct from 304 and transport failure. */
export function isGithubRateLimitError(error: unknown): boolean {
  if (error instanceof GithubPoolUnavailableError) return true;
  const status = httpStatus(error);
  const headers = errorHeaders(error);
  return status === 429 ||
    (status === 403 && header(headers, "x-ratelimit-remaining") === "0") ||
    (error instanceof Error && /secondary rate|rate limit/i.test(error.message));
}

/** Reset instant carried by a primary or secondary rate-limit refusal. */
export function githubRateLimitResetAt(error: unknown, nowMs = Date.now()): string | null {
  const headers = errorHeaders(error);
  const resetSeconds = Number(header(headers, "x-ratelimit-reset"));
  if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
    return new Date(resetSeconds * 1_000).toISOString();
  }
  const retryAfter = header(headers, "retry-after");
  if (retryAfter == null) return null;
  const delaySeconds = Number(retryAfter);
  if (Number.isFinite(delaySeconds) && delaySeconds >= 0 && Number.isFinite(nowMs)) {
    return new Date(nowMs + delaySeconds * 1_000).toISOString();
  }
  const retryAtMs = Date.parse(retryAfter);
  return Number.isFinite(retryAtMs) ? new Date(retryAtMs).toISOString() : null;
}

function httpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function errorHeaders(error: unknown): GithubResponseHeaders {
  if (!isRecord(error) || !isRecord(error.response) || !isRecord(error.response.headers)) return {};
  return error.response.headers as GithubResponseHeaders;
}

function header(headers: GithubResponseHeaders, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve GitHub's observed point cost on the one request the ledger records. */
function graphqlPointCost(answer: unknown): number {
  const envelope = isRecord(answer) ? answer : {};
  const root = isRecord(envelope.data) ? envelope.data : envelope;
  const rateLimit = isRecord(root.rateLimit) ? root.rateLimit : {};
  const observed = rateLimit.cost;
  if (!Number.isSafeInteger(observed) || (observed as number) < 0) {
    throw new Error("GitHub aliased query did not return a non-negative integer rateLimit.cost");
  }
  return observed as number;
}

/** Attribute a shared request exactly once while retaining every named caller. */
function coalescedActor(actors: readonly (string | undefined)[]): string | undefined {
  const named = [...new Set(actors.filter((actor): actor is string => actor !== undefined))].sort();
  if (named.length === 0) return undefined;
  if (named.length === 1) return named[0];
  return `coalesced:${named.join("+")}`;
}
