// @reddb-io/github — the one budget-aware GitHub client.
//
// ADR 0132 decision 4 as superseded by Amendment 2. Four modules, one question
// each:
//   surface.ts   — WHICH API answers a call, decided by cardinality.
//   rest-plan.ts — HOW a single-object read is actually issued on REST.
//   balance.ts   — WHAT the token has left, asked rather than counted, and what
//                  that balance admits.
//   cache.ts     — WHAT was kept, and how old it is.
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
  GITHUB_BALANCE_CADENCE,
  GITHUB_BALANCE_MIN_CADENCE_MS,
  GITHUB_BALANCE_STALENESS_FACTOR,
  GITHUB_POOLS,
  GITHUB_POOL_RESOURCES,
  GITHUB_RATE_LIMIT_ARGV,
  GITHUB_RATE_LIMIT_PATH,
  GITHUB_RESERVED_FRACTION,
  admitGithubCall,
  admitGithubOperation,
  buildGithubBalanceReport,
  createGithubBalanceTransport,
  fetchGithubBalance,
  githubBalanceCadenceMs,
  githubBalancePosture,
  githubReservedFloor,
  parseGithubBalance,
  tightestGithubPool,
  unaskedGithubBalance,
  type FetchGithubBalanceInput,
  type GithubAdmission,
  type GithubBalance,
  type GithubBalanceCadenceStep,
  type GithubBalanceOutcome,
  type GithubBalancePosture,
  type GithubBalanceReport,
  type GithubBalanceTransport,
  type GithubCallCriticality,
  type GithubPoolBalance,
} from "./balance.js";

export {
  DEFAULT_GITHUB_CACHE_CAPACITY,
  DEFAULT_GITHUB_CACHE_FRESH_MS,
  createGithubCache,
  describeGithubCacheRead,
  type CreateGithubCacheOptions,
  type GithubCache,
  type GithubCacheEntry,
  type GithubCacheOutcome,
  type GithubCachePut,
  type GithubCacheRead,
} from "./cache.js";

export {
  githubJsonFields,
  planGithubRestRead,
  type GithubRestRead,
  type GithubRestReadPlan,
  type GithubRestReadRequest,
  type GithubRestReadUnavailable,
  type GithubSingleObjectKind,
} from "./rest-plan.js";
