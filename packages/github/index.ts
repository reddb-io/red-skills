// @reddb-io/github — the single owner of the GitHub API-surface decision.
//
// ADR 0132 decision 4. Two modules, one question each:
//   surface.ts   — WHICH API answers a call, decided by cardinality.
//   rest-plan.ts — HOW a single-object read is actually issued on REST.
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
