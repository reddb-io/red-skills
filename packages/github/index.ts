// @reddb-io/github — the one budget-aware GitHub client.
//
// ADR 0132 decision 4 as superseded by Amendment 2. Six modules, one question
// each:
//   surface.ts   — WHICH API is preferred and which can answer as fallback.
//   rest-plan.ts — HOW a single-object read is actually issued on REST.
//   balance.ts   — WHAT the token has left, asked rather than counted, and what
//                  that balance admits.
//   attribution.ts — WHO this process believes spent each pool, durably.
//   conditional-client.ts — HOW stable REST polls make an unchanged answer free.
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
  preferredSurfaceForRead,
  routeGithubArgs,
  surfaceForCardinality,
  tryRouteGithubArgs,
  type GithubApiSurface,
  type GithubCardinality,
  type GithubOperation,
  type GithubOperationKind,
  type GithubRateBudget,
  type GithubReadVolatility,
} from "./surface.js";

export {
  DEFAULT_GITHUB_BALANCE_TIMEOUT_MS,
  DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_REQUEST_TIMEOUT_ENV,
  GithubTimeoutError,
  createTimedGithubFetch,
  githubRequestTimeoutMs,
  isGithubTimeoutError,
  withGithubDeadline,
  type CreateTimedGithubFetchOptions,
} from "./deadline.js";

export {
  DEFAULT_GITHUB_BUDGET_GATE,
  GITHUB_BUDGET_GATE_CONFIG_KEY,
  GITHUB_BUDGET_GATE_ENV,
  githubBudgetGate,
  githubBudgetGateEnabled,
  githubBudgetGateFromEnv,
  type GithubBudgetGateMode,
} from "./budget-gate.js";

export {
  createGithubAttributionLedger,
  type GithubAttributedOperation,
  type CreateGithubAttributionLedgerOptions,
  type GithubAttributionLedger,
  type GithubOperationSpend,
  type GithubSpendAttributionReport,
  type GithubSpendObservation,
} from "./attribution.js";

export {
  GithubCredentialError,
  GithubPoolUnavailableError,
  createGithubClient,
  createMemoryGithubEtagStore,
  githubSingleObjectCoalescingThreshold,
  githubRateLimitResetAt,
  isGithubRateLimitError,
  type CreateGithubClientOptions,
  type GithubClient,
  type GithubCachedFallback,
  type GithubConditionalRestRequest,
  type GithubEtagEntry,
  type GithubEtagStore,
  type GithubGraphqlAttribution,
  type GithubRequestFetch,
  type GithubRailRouting,
  type GithubPaginatedRestAnswer,
  type GithubResponseHeaders,
  type GithubRestAnswer,
  type GithubSingleObjectAnswer,
  type GithubSingleObjectRequest,
} from "./conditional-client.js";

export {
  createGithubBalanceStore,
  type CreateGithubBalanceStoreOptions,
  type GithubBalanceStore,
} from "./balance-store.js";

export {
  createGithubBalanceHistory,
  type CreateGithubBalanceHistoryOptions,
  type GithubBalanceHistory,
  type GithubBalanceHistoryRow,
} from "./balance-history.js";

export {
  GITHUB_BALANCE_CADENCE,
  GITHUB_DIVERSION_BANDS,
  GITHUB_BALANCE_MIN_CADENCE_MS,
  GITHUB_BALANCE_STALENESS_FACTOR,
  GITHUB_POOLS,
  GITHUB_POOL_RESOURCES,
  GITHUB_RATE_LIMIT_ARGV,
  GITHUB_RATE_LIMIT_PATH,
  GITHUB_RESERVED_FRACTION,
  admitGithubCall,
  admitGithubOperation,
  balanceFromReport,
  buildGithubBalanceReport,
  createGithubBalanceTransport,
  fetchGithubBalance,
  githubBalanceCadenceMs,
  githubBalancePosture,
  githubDiversionDecision,
  githubReservedFloor,
  isGithubBalanceReport,
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
  type GithubDiversionBand,
  type GithubDiversionBandDefinition,
  type GithubDiversionDecision,
  type GithubDiversionInput,
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
  type GithubRestEndpointReadRequest,
  type GithubGraphqlReadRequest,
  type GithubSingleObjectRestReadRequest,
  type GithubRestReadUnavailable,
  type GithubSingleObjectKind,
} from "./rest-plan.js";

export {
  planGithubWrite,
  type GithubWriteContext,
  type GithubWritePlan,
} from "./write-plan.js";

export {
  GITHUB_APP_ID_ENV,
  GITHUB_APP_INSTALLATION_ENV,
  GITHUB_APP_KEY_ENV,
  createGithubIdentityRouter,
  createGithubInstallationLookup,
  githubBalanceFileName,
  githubIdentityRef,
  signGithubAppJwt,
  readGithubAppCredentialFromEnv,
  readGithubAppPrivateKey,
  type GithubAppCredential,
  type GithubIdentity,
  type GithubIdentityDecision,
  type GithubIdentityRouter,
  type GithubIdentityRouterOptions,
  type GithubInstallationLookup,
} from "./app-credential.js";

export {
  githubCoveragePath,
  openGithubCoverageCache,
  type GithubCoverageCache,
  type GithubCoverageEntry,
} from "./app-coverage.js";
