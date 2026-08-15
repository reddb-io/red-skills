import type { GithubApiSurface, GithubOperation, GithubRateBudget } from "./surface.js";

export interface GithubPoolSnapshot {
  readonly remaining: number;
  readonly reset_at: string;
}

export type GithubPrimaryPool = GithubRateBudget;

export type GithubLimitFact =
  | {
      readonly kind: "primary-rest-exhausted";
      readonly pool: "rest";
      readonly retry_at: string;
      readonly evidence: "x-ratelimit-reset" | "balance";
      readonly message: string;
    }
  | {
      readonly kind: "primary-graphql-exhausted";
      readonly pool: "graphql";
      readonly retry_at: string;
      readonly evidence: "x-ratelimit-reset" | "balance";
      readonly message: string;
    }
  | {
      readonly kind: "search-exhausted";
      readonly pool: "search";
      readonly retry_at: string;
      readonly evidence: "x-ratelimit-reset" | "balance";
      readonly message: string;
    }
  | {
      readonly kind: "secondary-throttled";
      readonly pool: "secondary";
      readonly retry_at: string;
      readonly evidence: "retry-after" | "x-ratelimit-reset";
      readonly message: string;
    };

/** One credential profile's independent view of GitHub availability. */
export interface GithubBudgetSnapshot {
  readonly rest: GithubPoolSnapshot | null;
  readonly graphql: GithubPoolSnapshot | null;
  readonly search: GithubPoolSnapshot | null;
  /** Secondary throttling is account-wide and cannot be escaped by changing API surface. */
  readonly secondary: Extract<GithubLimitFact, { kind: "secondary-throttled" }> | null;
}

export type GithubRouteDecision =
  | {
      readonly outcome: "route";
      readonly surface: GithubApiSurface;
      readonly rerouted: boolean;
      readonly operation: string;
      readonly message: string;
    }
  | {
      readonly outcome: "cache";
      readonly pool: GithubRateBudget;
      readonly operation: string;
      readonly message: string;
    }
  | {
      readonly outcome: "backpressure";
      readonly fact: GithubLimitFact;
      readonly operation: string;
    };

export interface RouteGithubOperationOptions {
  readonly cacheEligible?: boolean;
}

/** Typed refusal carried across ACP without retaining a Worker or request. */
export class GithubBackpressureError extends Error {
  readonly fact: GithubLimitFact;
  readonly retryAt: string;

  constructor(fact: GithubLimitFact, options?: { readonly cause?: unknown }) {
    super(fact.message, options);
    this.name = "GithubBackpressureError";
    this.fact = fact;
    this.retryAt = fact.retry_at;
  }
}

/**
 * Select a live representation declared by the operation registry. PURE.
 *
 * Unknown balance permits the preferred rail. Known exhaustion requires a
 * known-healthy equivalent or an eligible cache; it never creates a timer.
 */
export function routeGithubOperation(
  operation: GithubOperation,
  budgets: GithubBudgetSnapshot,
  options: RouteGithubOperationOptions = {},
): GithubRouteDecision {
  if (budgets.secondary !== null) {
    if (options.cacheEligible) return cached(operation, operation.budget, budgets.secondary.retry_at);
    return { outcome: "backpressure", fact: budgets.secondary, operation: operation.key };
  }

  const preferred = budgets[operation.budget];
  if (preferred === null || preferred.remaining > 0) {
    return {
      outcome: "route",
      surface: operation.surface,
      rerouted: false,
      operation: operation.key,
      message: `${operation.key} uses its preferred ${operation.surface} rail`,
    };
  }

  if (options.cacheEligible) return cached(operation, operation.budget, preferred.reset_at);

  const fallback = operation.fallback;
  if (fallback !== null && fallback !== undefined) {
    const fallbackBudget = budgets[fallback];
    if (fallbackBudget !== null && fallbackBudget.remaining > 0) {
      return {
        outcome: "route",
        surface: fallback,
        rerouted: true,
        operation: operation.key,
        message: `${primaryLabel(operation.budget)} is exhausted until ${preferred.reset_at}; ` +
          `using the declared ${fallback} equivalent`,
      };
    }
  }

  return {
    outcome: "backpressure",
    fact: primaryFact(operation.budget, preferred.reset_at, "balance"),
    operation: operation.key,
  };
}

/**
 * Translate one GitHub refusal without guessing from primary-pool percentage.
 * Secondary evidence is considered first because its headers may simultaneously
 * report a healthy primary pool.
 */
export function classifyGithubLimit(
  error: unknown,
  requestedPool: GithubRateBudget,
  nowMs = Date.now(),
): GithubLimitFact | null {
  if (error instanceof GithubBackpressureError) return error.fact;
  const headers = errorHeaders(error);
  const retryAfter = header(headers, "retry-after");
  const message = error instanceof Error ? error.message : recordString(error, "message") ?? "";
  const status = recordNumber(error, "status");
  const secondary = status === 429 || retryAfter !== undefined || /secondary rate|abuse detection/i.test(message);
  if (secondary) {
    const retryAt = retryAfter === undefined
      ? resetAt(headers)
      : retryAfterAt(retryAfter, nowMs);
    if (retryAt === null) return null;
    return {
      kind: "secondary-throttled",
      pool: "secondary",
      retry_at: retryAt,
      evidence: retryAfter === undefined ? "x-ratelimit-reset" : "retry-after",
      message: `GitHub secondary throttling is active; retry after ${retryAt}`,
    };
  }

  if (header(headers, "x-ratelimit-remaining") !== "0") return null;
  const retryAt = resetAt(headers);
  if (retryAt === null) return null;
  const resource = header(headers, "x-ratelimit-resource");
  const pool = resource === "graphql" || resource === "search"
    ? resource
    : resource === "core"
      ? "rest"
      : requestedPool;
  return primaryFact(pool, retryAt, "x-ratelimit-reset");
}

export function isGithubBackpressureError(error: unknown): error is GithubBackpressureError {
  return error instanceof GithubBackpressureError;
}

function cached(operation: GithubOperation, pool: GithubRateBudget, retryAt: string): GithubRouteDecision {
  return {
    outcome: "cache",
    pool,
    operation: operation.key,
    message: `${primaryLabel(pool)} is unavailable until ${retryAt}; using an eligible cached answer`,
  };
}

function primaryFact(
  pool: GithubRateBudget,
  retryAt: string,
  evidence: "x-ratelimit-reset" | "balance",
): Exclude<GithubLimitFact, { kind: "secondary-throttled" }> {
  if (pool === "rest") {
    return {
      kind: "primary-rest-exhausted",
      pool,
      retry_at: retryAt,
      evidence,
      message: `REST primary quota is exhausted; retry after ${retryAt}`,
    };
  }
  if (pool === "graphql") {
    return {
      kind: "primary-graphql-exhausted",
      pool,
      retry_at: retryAt,
      evidence,
      message: `GraphQL primary quota is exhausted; retry after ${retryAt}`,
    };
  }
  return {
    kind: "search-exhausted",
    pool,
    retry_at: retryAt,
    evidence,
    message: `GitHub Search quota is exhausted; retry after ${retryAt}`,
  };
}

function primaryLabel(pool: GithubRateBudget): string {
  if (pool === "rest") return "REST primary quota";
  if (pool === "graphql") return "GraphQL primary quota";
  return "GitHub Search quota";
}

function retryAfterAt(value: string, nowMs: number): string | null {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(nowMs)) {
    return new Date(nowMs + seconds * 1_000).toISOString();
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

function resetAt(headers: Readonly<Record<string, unknown>>): string | null {
  const seconds = Number(header(headers, "x-ratelimit-reset"));
  return Number.isFinite(seconds) && seconds >= 0
    ? new Date(seconds * 1_000).toISOString()
    : null;
}

function errorHeaders(error: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(error) || !isRecord(error.response) || !isRecord(error.response.headers)) return {};
  return error.response.headers;
}

function header(headers: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function recordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function recordNumber(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
