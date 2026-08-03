// rest-plan.ts — how a single-object read is actually ISSUED on REST.
//
// {@link surfaceForCardinality} says a single-object read belongs on REST. That
// decision is worth nothing on its own: `gh issue view --json state` runs a
// GraphQL query no matter what a classifier believes, so realizing the route
// means issuing `gh api repos/{o}/{r}/issues/{n}` instead and projecting the REST
// payload back into the shape `--json` would have produced.
//
// **A field with no equivalent is named, not approximated.** REST's issue object
// carries a comment COUNT where `--json comments` gives the comment LIST, and
// gh normalizes a bot author to `app/<name>` where REST reports
// `<name>[bot]`. Projecting either one would be a quiet behaviour change on a
// path that decides whether a Worker keeps running, so {@link planGithubRestRead}
// answers `unavailable` and names the fields — the caller keeps its GraphQL call
// and the gap stays legible. ADR 0132 decision 4: the static split is the
// default, and a second implementation is built only where it is needed.

/** The single objects a REST read plan can fetch. */
export type GithubSingleObjectKind = "issue" | "pr";

/** A realizable REST read: the gh argv to run, and how to read its answer. */
export interface GithubRestReadPlan {
  readonly outcome: "plan";
  /** The gh argv — always a `gh api <path>` REST request. */
  readonly args: readonly string[];
  /** The REST path the request addresses, for logging and for tests. */
  readonly path: string;
  /**
   * Project the raw REST body into the object `gh <kind> view --json <fields>`
   * would have printed, carrying exactly the requested fields. RAISES on a body
   * that is not a JSON object, because an unparseable answer is not an empty one.
   */
  readonly decode: (stdout: string) => Record<string, unknown>;
}

/** A read that REST cannot answer in one request, with the fields that block it. */
export interface GithubRestReadUnavailable {
  readonly outcome: "unavailable";
  /** The requested fields with no single-request REST projection. */
  readonly fields: readonly string[];
  /** One line naming what is missing, suitable for a comment or a log. */
  readonly reason: string;
}

export type GithubRestRead = GithubRestReadPlan | GithubRestReadUnavailable;

export interface GithubRestReadRequest {
  readonly kind: GithubSingleObjectKind;
  readonly number: number;
  /** The `--json` field names the caller asked for. */
  readonly fields: readonly string[];
  /** `owner/repo`; omitted uses gh's own `{owner}/{repo}` placeholders. */
  readonly repo?: string;
}

type Projection = (body: Record<string, unknown>) => unknown;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** GraphQL spells enums in SCREAMING_CASE where REST spells them in lower. */
function upper(value: unknown): string {
  return str(value).toUpperCase();
}

/** `null` where GraphQL reports the absence, never the zero value. */
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function labels(body: Record<string, unknown>): unknown {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const label = record(entry);
    if (!label) return { name: str(entry) };
    return {
      id: label.node_id === undefined ? String(label.id ?? "") : str(label.node_id),
      name: str(label.name),
      description: str(label.description),
      color: str(label.color),
    };
  });
}

const ISSUE_PROJECTIONS: Readonly<Record<string, Projection>> = {
  number: (body) => body.number,
  title: (body) => str(body.title),
  body: (body) => str(body.body),
  state: (body) => upper(body.state),
  stateReason: (body) => (body.state_reason == null ? null : upper(body.state_reason)),
  url: (body) => str(body.html_url),
  createdAt: (body) => str(body.created_at),
  updatedAt: (body) => str(body.updated_at),
  closedAt: (body) => nullableString(body.closed_at),
  labels,
};

const PR_PROJECTIONS: Readonly<Record<string, Projection>> = {
  number: (body) => body.number,
  title: (body) => str(body.title),
  body: (body) => str(body.body),
  // GraphQL folds "merged" into the state enum; REST keeps it as its own boolean.
  state: (body) => (body.merged === true ? "MERGED" : upper(body.state)),
  url: (body) => str(body.html_url),
  createdAt: (body) => str(body.created_at),
  updatedAt: (body) => str(body.updated_at),
  closedAt: (body) => nullableString(body.closed_at),
  mergedAt: (body) => nullableString(body.merged_at),
  isDraft: (body) => body.draft === true,
  headRefName: (body) => str(record(body.head)?.ref),
  baseRefName: (body) => str(record(body.base)?.ref),
  headRefOid: (body) => str(record(body.head)?.sha),
  baseRefOid: (body) => str(record(body.base)?.sha),
  // REST answers `null` while GitHub is still computing the merge; GraphQL says
  // UNKNOWN. Same fact, and both callers already treat it as "ask again".
  mergeable: (body) =>
    body.mergeable === true ? "MERGEABLE" : body.mergeable === false ? "CONFLICTING" : "UNKNOWN",
  mergeStateStatus: (body) => (body.mergeable_state == null ? "UNKNOWN" : upper(body.mergeable_state)),
  mergeCommit: (body) => {
    const sha = str(body.merge_commit_sha);
    return sha === "" ? null : { oid: sha };
  },
  autoMergeRequest: (body) => {
    const auto = record(body.auto_merge);
    if (!auto) return null;
    return {
      enabledAt: nullableString(auto.enabled_at),
      mergeMethod: upper(auto.merge_method),
    };
  },
  labels,
};

/**
 * Why a field has no single-request REST projection. A field absent from this
 * map and from the projections is simply undeclared; one that is here is
 * declared IMPOSSIBLE, which is a different and more useful statement.
 */
const NO_REST_EQUIVALENT: Readonly<Record<string, string>> = {
  comments: "REST's object carries a comment count, not the comment list",
  author: "gh normalizes a bot author to `app/<name>` where REST reports `<name>[bot]`",
  authorAssociation: "gh derives it alongside the normalized author, which REST does not match",
  statusCheckRollup: "the rollup is a second and third request against check-runs and statuses",
  reviews: "reviews are their own REST listing, not a field of the pull request",
  reviewDecision: "the decision is computed from the reviews listing, not carried by the object",
  commits: "commits are their own REST listing",
  files: "files are their own REST listing",
  projectItems: "project items have no REST projection on the object",
};

function projectionsFor(kind: GithubSingleObjectKind): Readonly<Record<string, Projection>> {
  return kind === "issue" ? ISSUE_PROJECTIONS : PR_PROJECTIONS;
}

function restPath(kind: GithubSingleObjectKind, number: number, repo: string | undefined): string {
  // gh substitutes `{owner}`/`{repo}` from the current checkout when the caller
  // has no slug to hand, so an absent repo is not a reason to fall back.
  const base = repo && repo.trim() !== "" ? repo.trim() : "{owner}/{repo}";
  return `repos/${base}/${kind === "issue" ? "issues" : "pulls"}/${number}`;
}

/**
 * Split `--json` field names — `gh` takes them comma-separated, callers hold them
 * either way. PURE.
 */
export function githubJsonFields(spec: string): string[] {
  return spec
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field !== "");
}

/**
 * The REST realization of one single-object read, or the named reason there is
 * none. PURE — it builds an argv and a decoder and issues nothing itself.
 */
export function planGithubRestRead(request: GithubRestReadRequest): GithubRestRead {
  const fields = [...new Set(request.fields.map((field) => field.trim()).filter((f) => f !== ""))];
  if (fields.length === 0) {
    return { outcome: "unavailable", fields: [], reason: "the read names no fields" };
  }
  if (!Number.isSafeInteger(request.number) || request.number <= 0) {
    return {
      outcome: "unavailable",
      fields,
      reason: `a single-object read needs a positive number, got ${request.number}`,
    };
  }
  const projections = projectionsFor(request.kind);
  const missing = fields.filter((field) => !(field in projections));
  if (missing.length > 0) {
    const reasons = missing.map(
      (field) => `${field} (${NO_REST_EQUIVALENT[field] ?? "no declared REST projection"})`,
    );
    return {
      outcome: "unavailable",
      fields: missing,
      reason: `no single-request REST projection for ${reasons.join("; ")}`,
    };
  }
  const path = restPath(request.kind, request.number, request.repo);
  return {
    outcome: "plan",
    path,
    args: ["api", path],
    decode(stdout: string): Record<string, unknown> {
      const body = record(JSON.parse(stdout.trim() === "" ? "null" : stdout));
      if (!body) throw new Error(`REST read of ${path} returned a non-object payload`);
      const out: Record<string, unknown> = {};
      for (const field of fields) out[field] = projections[field]!(body);
      return out;
    },
  };
}
