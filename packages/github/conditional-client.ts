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

import type { GithubAttributionLedger, GithubAttributedOperation } from "./attribution.js";

const Octokit = RestOctokit.plugin(retry, throttling);

export type GithubRequestFetch = typeof fetch;
export type GithubResponseHeaders = Readonly<Record<string, string | number | undefined>>;

export interface GithubEtagEntry {
  readonly etag: string;
  readonly data: unknown;
  readonly headers: GithubResponseHeaders;
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
}

export interface GithubPaginatedRestAnswer<T> extends GithubRestAnswer<readonly T[]> {
  /** HTTP requests issued, including free 304 revalidations. */
  readonly requestCount: number;
}

export interface GithubClient {
  conditionalRest<T>(request: GithubConditionalRestRequest): Promise<GithubRestAnswer<T>>;
  conditionalPaginate<T>(request: GithubConditionalRestRequest): Promise<GithubPaginatedRestAnswer<T>>;
  graphql<T>(query: string, variables?: Readonly<Record<string, unknown>>): Promise<T>;
}

export interface CreateGithubClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: GithubRequestFetch;
  readonly etags?: GithubEtagStore;
  readonly attribution?: GithubAttributionLedger;
  /** Transient retries; the plugin default in production, overridable in tests. */
  readonly retryCount?: number;
  /** Disable plugin pacing only for a caller-supplied transport test. */
  readonly throttle?: boolean;
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

/**
 * Build the typed GitHub transport decided by ADR 0133.
 *
 * `@octokit/rest` already composes `plugin-paginate-rest`; retry handles
 * transient server failures, while throttling serializes and classifies primary
 * and secondary limits. The callbacks decline a long in-call retry so the
 * daemon's existing poll cadence can pace the next cycle from the response.
 */
export function createGithubClient(options: CreateGithubClientOptions): GithubClient {
  const etags = options.etags ?? createMemoryGithubEtagStore();
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
    ...(options.fetchImpl ? { request: { fetch: options.fetchImpl } } : {}),
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

  const conditionalRest = async <T>(input: GithubConditionalRestRequest): Promise<GithubRestAnswer<T>> => {
      const held = etags.get(input.cacheKey);
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
        if (etag !== undefined) etags.set(input.cacheKey, { etag, data: response.data, headers });
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
          etags.set(input.cacheKey, { etag, data: held.data, headers });
          await options.attribution?.record({ operation: input.operation, cost: 0, actor: input.actor });
          return { data: held.data as T, headers, quotaFree: true };
        }
        if (httpStatus(error) === 401) throw new GithubCredentialError({ cause: error });
        throw error;
      }
    };

  return {
    conditionalRest,

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

    async graphql<T>(query: string, variables: Readonly<Record<string, unknown>> = {}): Promise<T> {
      try {
        return await octokit.graphql(query, variables) as T;
      } catch (error) {
        if (httpStatus(error) === 401) throw new GithubCredentialError({ cause: error });
        throw error;
      }
    },
  };
}

function hasNextPage(headers: GithubResponseHeaders): boolean {
  const link = header(headers, "link");
  return link !== undefined && /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*;|\s*(?:,|$))/i.test(link);
}

/** Primary/secondary quota refusal, distinct from 304 and transport failure. */
export function isGithubRateLimitError(error: unknown): boolean {
  const status = httpStatus(error);
  const headers = errorHeaders(error);
  return status === 429 ||
    (status === 403 && header(headers, "x-ratelimit-remaining") === "0") ||
    (error instanceof Error && /secondary rate|rate limit/i.test(error.message));
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
