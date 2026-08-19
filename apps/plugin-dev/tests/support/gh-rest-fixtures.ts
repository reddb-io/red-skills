// gh-rest-fixtures — express a single-object read fake once, not sixteen times.
//
// `packages/github` routes one issue or one pull request read by number to REST
// (ADR 0132 decision 4, #3094), so a fake exec that matched `["issue","view",…]`
// now sees `["api","repos/o/r/issues/42"]` and must answer a REST body rather
// than a `--json` one. The two differ in small, specific ways — REST spells
// `state` in lower case, `closed_at` instead of `closedAt`, `html_url` instead
// of `url`, `head.sha` instead of `headRefOid` — and a test that gets one of them
// wrong fails in a way that looks like a routing bug.
//
// So the tests state the row they mean in the shape they already think in, and
// these helpers project it into the REST body the router will actually read.

/**
 * The single object a REST argv addresses, or `null` when it addresses neither.
 * Tolerates the `gh` head and a leading `-R <repo>`, because half the fakes in
 * this tree receive the whole command line and half receive gh's arguments only.
 */
export function restSingleObject(
  args: readonly string[],
): { kind: "issue" | "pr"; number: number } | null {
  const at = args.indexOf("api");
  if (at < 0) return null;
  const path = args[at + 1];
  if (typeof path !== "string") return null;
  const match = /\/(issues|pulls)\/(\d+)$/.exec(path);
  if (!match) return null;
  return { kind: match[1] === "issues" ? "issue" : "pr", number: Number(match[2]) };
}

/** True when the argv is the REST read of one issue (any number, or a given one). */
export function readsIssue(args: readonly string[], number?: number): boolean {
  const target = restSingleObject(args);
  return target?.kind === "issue" && (number === undefined || target.number === number);
}

/** True when the argv is the REST read of one pull request. */
export function readsPull(args: readonly string[], number?: number): boolean {
  const target = restSingleObject(args);
  return target?.kind === "pr" && (number === undefined || target.number === number);
}

/** The `--json`-shaped issue row a test means, in the fields REST answers with. */
export interface IssueRowSpec {
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  stateReason?: string | null;
  url?: string;
  closedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  labels?: readonly string[];
}

/** Project {@link IssueRowSpec} into the REST issue body `gh api` would print. */
export function restIssueBody(spec: IssueRowSpec = {}): Record<string, unknown> {
  return {
    ...(spec.number === undefined ? {} : { number: spec.number }),
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.body === undefined ? {} : { body: spec.body }),
    ...(spec.state === undefined ? {} : { state: spec.state.toLowerCase() }),
    ...(spec.stateReason === undefined ? {} : { state_reason: spec.stateReason }),
    ...(spec.url === undefined ? {} : { html_url: spec.url }),
    ...(spec.closedAt === undefined ? {} : { closed_at: spec.closedAt }),
    ...(spec.createdAt === undefined ? {} : { created_at: spec.createdAt }),
    ...(spec.updatedAt === undefined ? {} : { updated_at: spec.updatedAt }),
    ...(spec.labels === undefined
      ? {}
      : { labels: spec.labels.map((name, index) => ({ id: index + 1, node_id: `LA_${index}`, name })) }),
  };
}

/** The `--json`-shaped pull-request row a test means, in REST's spelling. */
export interface PullRowSpec {
  number?: number;
  state?: string;
  mergedAt?: string | null;
  mergeCommitOid?: string | null;
  autoMerge?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  isDraft?: boolean;
}

/** Project {@link PullRowSpec} into the REST pull body `gh api` would print. */
export function restPullBody(spec: PullRowSpec = {}): Record<string, unknown> {
  const merged = spec.state?.toUpperCase() === "MERGED" || (spec.mergedAt ?? null) !== null;
  const mergeable =
    spec.mergeable === undefined
      ? undefined
      : spec.mergeable.toUpperCase() === "MERGEABLE"
        ? true
        : spec.mergeable.toUpperCase() === "CONFLICTING"
          ? false
          : null;
  return {
    ...(spec.number === undefined ? {} : { number: spec.number }),
    // GraphQL folds "merged" into the state enum; REST keeps it as its own flag.
    ...(spec.state === undefined
      ? {}
      : { state: merged ? "closed" : spec.state.toLowerCase(), merged }),
    ...(spec.mergedAt === undefined ? {} : { merged_at: spec.mergedAt }),
    ...(spec.mergeCommitOid === undefined ? {} : { merge_commit_sha: spec.mergeCommitOid }),
    ...(spec.autoMerge === undefined
      ? {}
      : { auto_merge: spec.autoMerge ? { enabled_at: "2026-01-01T00:00:00Z", merge_method: "merge" } : null }),
    ...(spec.mergeStateStatus === undefined ? {} : { mergeable_state: spec.mergeStateStatus.toLowerCase() }),
    ...(mergeable === undefined ? {} : { mergeable }),
    ...(spec.isDraft === undefined ? {} : { draft: spec.isDraft }),
    ...(spec.headRefName === undefined && spec.headRefOid === undefined
      ? {}
      : { head: { ref: spec.headRefName ?? "", sha: spec.headRefOid ?? "" } }),
    ...(spec.baseRefName === undefined && spec.baseRefOid === undefined
      ? {}
      : { base: { ref: spec.baseRefName ?? "", sha: spec.baseRefOid ?? "" } }),
  };
}
