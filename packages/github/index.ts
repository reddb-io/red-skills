// @reddb-io/github — the single owner of the GitHub API-surface decision.
//
// ADR 0132 decision 4. Two modules, one question each:
//   surface.ts       — WHICH API answers a call, decided by cardinality.
//   rest-plan.ts     — HOW a single-object read is actually issued on REST.
//   balance.ts       — WHAT is left of the token, asked rather than counted.
//   cache.ts         — a kept answer, and how old it is.
//   aliased-query.ts — every repository's counts in ONE request.
//
// The daemon and the castle both import this package rather than each keeping a
// table of their own: this repo has watched one table become two five times, and
// two implementations of one routing rule drift the first time GitHub changes.

export {
  GITHUB_OPERATIONS,
  UnclassifiedGithubOperationError,
  assertGithubRoutingTable,
  githubCommandPath,
  githubOperationKey,
  githubOperations,
  githubSurfaceFor,
  routeGithubArgs,
  surfaceForCardinality,
  tryRouteGithubArgs,
  type GithubApiSurface,
  type GithubCardinality,
  type GithubOperation,
  type GithubOperationKind,
  type GithubRateBudget,
} from "./surface.js";

export {
  githubJsonFields,
  planGithubRestRead,
  type GithubRestRead,
  type GithubRestReadPlan,
  type GithubRestReadRequest,
  type GithubRestReadUnavailable,
  type GithubSingleObjectKind,
} from "./rest-plan.js";

export {
  GITHUB_BALANCE_RELAXED,
  GITHUB_BALANCE_STALE_MS,
  GITHUB_BALANCE_TIGHT,
  GITHUB_RESERVED_BAND,
  isBalanceStale,
  maySpend,
  msUntilEarliestReset,
  nextBalancePollMs,
  parseRateLimit,
  tightestShare,
  type GithubBalance,
  type GithubPoolBalance,
  type GithubSpendVerdict,
} from "./balance.js";

export {
  GITHUB_CACHE_TTL_MS,
  githubCacheKey,
  pruneGithubCache,
  readGithubCache,
  writeGithubCache,
  type GithubCache,
  type GithubCacheEntry,
  type GithubCacheHit,
  type GithubCacheKind,
} from "./cache.js";

export {
  buildActivityCountsQuery,
  readActivityCounts,
  type GithubActivityCounts,
  type GithubAliasedQuery,
  type GithubRepoRef,
} from "./aliased-query.js";
