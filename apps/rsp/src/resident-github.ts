import { join } from "node:path";
import {
  createGithubBalanceTransport,
  createGithubAttributionLedger,
  createGithubClient,
  fetchGithubBalance,
  githubBalanceCadenceMs,
  isGithubRateLimitError,
  routeGithubArgs,
  type GithubBalance,
  type GithubClient,
  type GithubOperation,
  type GithubRequestFetch,
} from "@reddb-io/github";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";

export interface RspResidentGithubRead {
  readonly args: readonly string[];
  readonly path: string;
  readonly params?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly actor: string;
}

export interface RspResidentGithubResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly surface: GithubOperation["surface"];
  readonly pool: GithubOperation["budget"];
  readonly quotaFree: boolean;
  readonly refused?: true;
}

export interface RspResidentGithubClient {
  read(input: RspResidentGithubRead): Promise<RspResidentGithubResult>;
}

export interface CreateRspResidentGithubClientOptions {
  readonly rootDir: string;
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: GithubRequestFetch;
  readonly balance?: () => GithubBalance | null | Promise<GithubBalance | null>;
  readonly retryCount?: number;
  readonly throttle?: boolean;
}

/** One adaptive balance reader shared by resident and long-lived wait clients. */
export function createCachedGithubBalanceReader(
  token: string,
  origin?: string,
): () => Promise<GithubBalance | null> {
  const transport = createGithubBalanceTransport({ token, ...(origin ? { origin } : {}) });
  let held: GithubBalance | null = null;
  let freshUntil = 0;
  let inFlight: Promise<GithubBalance | null> | null = null;
  return async (): Promise<GithubBalance | null> => {
    const now = Date.now();
    if (now < freshUntil) return held;
    if (inFlight !== null) return await inFlight;
    const askedAt = new Date(now).toISOString();
    inFlight = fetchGithubBalance({ transport, now: askedAt }).then((answer) => {
      held = answer;
      freshUntil = Date.now() + githubBalanceCadenceMs(answer, { now: new Date().toISOString() });
      return held;
    }).finally(() => {
      inFlight = null;
    });
    return await inFlight;
  };
}

/**
 * The resident-lifetime GitHub read boundary.
 *
 * The Octokit client and its in-memory validator store are deliberately created
 * once here. CLI wrappers are short lived, but the resident survives across
 * them, so the second unchanged read can earn GitHub's zero-cost 304 response.
 * The attribution ledger lives below rsp's own state tier; no redskilled path or
 * process is imported by this module.
 */
export function createRspResidentGithubClient(
  options: CreateRspResidentGithubClientOptions,
): RspResidentGithubClient {
  const attribution = createGithubAttributionLedger({
    path: join(rspStateDir(options.rootDir), "github", "spend.toonl"),
  });
  const client = createGithubClient({
    token: options.token,
    attribution,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.balance ? { balance: options.balance } : {}),
    ...(options.retryCount === undefined ? {} : { retryCount: options.retryCount }),
    ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
  });

  return createRspResidentGithubReader(client);
}

function createRspResidentGithubReader(client: GithubClient): RspResidentGithubClient {
  return {
    async read(input): Promise<RspResidentGithubResult> {
      const operation = routeGithubArgs(input.args);
      if (operation.kind !== "read") {
        return refusal(operation, "github-write-passthrough", "writes are executed by the original gh command unchanged");
      }
      if (input.actor.trim() === "") {
        return refusal(operation, "github-actor-missing", "retry through rsp so the caller can be attributed");
      }
      // Search has its own minute pool. It must never become the escape hatch
      // when REST or GraphQL is scarce, and rsp has no search fallback at all.
      if (operation.budget === "search") {
        return refusal(operation, "github-search-not-routable", "search reads are never a fallback; narrow the read to a classified object");
      }
      try {
        const object = singleObjectPlan(operation, input);
        if (object) {
          const answer = await client.singleObject<Record<string, unknown>>({
            cacheKey: stableCacheKey(input.path, input.params),
            kind: object.kind,
            owner: object.owner,
            repo: object.repo,
            number: object.number,
            selection: object.selection,
            operation,
            actor: input.actor,
            project: object.project,
          });
          return {
            status: 0,
            stdout: JSON.stringify(answer.data),
            stderr: "",
            surface: answer.surface,
            pool: answer.surface === "graphql" ? "graphql" : "rest",
            quotaFree: answer.quotaFree,
          };
        }
        if (operation.surface === "graphql") {
          const plan = graphqlPlan(operation, input);
          if (!plan) {
            return refusal(
              operation,
              "github-graphql-read-not-realized",
              "use a classified rsp summary whose GraphQL projection is declared",
            );
          }
          const answer = await client.graphql<Record<string, unknown>>(
            plan.query,
            plan.variables,
            { operation, actor: input.actor },
          );
          return {
            status: 0,
            stdout: JSON.stringify(plan.decode(answer)),
            stderr: "",
            surface: operation.surface,
            pool: operation.budget,
            quotaFree: false,
          };
        }
        const answer = await client.conditionalRest<unknown>({
          cacheKey: stableCacheKey(input.path, input.params),
          route: `GET /${input.path.replace(/^\/+/, "")}`,
          parameters: definedParams(input.params),
          operation,
          actor: input.actor,
        });
        return {
          status: 0,
          stdout: JSON.stringify(answer.data),
          stderr: "",
          surface: operation.surface,
          pool: operation.budget,
          quotaFree: answer.quotaFree,
        };
      } catch (error) {
        if (isGithubRateLimitError(error)) {
          return refusal(
            operation,
            "github-budget-refused",
            "wait for the reported GitHub rate-limit reset, then retry",
          );
        }
        return {
          status: errorStatus(error),
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          surface: operation.surface,
          pool: operation.budget,
          quotaFree: false,
        };
      }
    },
  };
}

interface RspSingleObjectPlan {
  readonly kind: "issue" | "pr";
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly selection: string;
  readonly project: (value: unknown, surface: "rest" | "graphql") => Record<string, unknown>;
}

function singleObjectPlan(
  operation: GithubOperation,
  input: RspResidentGithubRead,
): RspSingleObjectPlan | null {
  if (operation.key !== "issue view" && operation.key !== "pr view") return null;
  const match = /^repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)\/?$/.exec(input.path.replace(/^\/+/, ""));
  if (!match) return null;
  const owner = stringParam(input.params, "owner") || match[1]!;
  const repo = stringParam(input.params, "repo") || match[2]!;
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number) || number <= 0 || owner.includes("{") || repo.includes("{")) return null;

  if (operation.key === "issue view") {
    return {
      kind: "issue",
      owner,
      repo,
      number,
      selection: "number title state body url updatedAt author { login } labels(first: 100) { nodes { name } }",
      project: (value, surface) => surface === "rest" ? record(value) ?? {} : issueGraphqlAsRest(value),
    };
  }
  return {
    kind: "pr",
    owner,
    repo,
    number,
    selection: "number title state body url updatedAt isDraft baseRefName headRefName author { login } labels(first: 100) { nodes { name } }",
    project: (value, surface) => surface === "rest" ? record(value) ?? {} : prGraphqlAsRest(value),
  };
}

function issueGraphqlAsRest(value: unknown): Record<string, unknown> {
  const node = record(value) ?? {};
  return {
    number: node.number,
    title: node.title,
    state: String(node.state ?? "").toLowerCase(),
    body: node.body,
    html_url: node.url,
    updated_at: node.updatedAt,
    user: record(node.author) ?? {},
    labels: nestedNodes(node.labels).map((label) => ({ name: label.name })),
  };
}

function prGraphqlAsRest(value: unknown): Record<string, unknown> {
  const node = record(value) ?? {};
  return {
    ...issueGraphqlAsRest(node),
    draft: node.isDraft === true,
    base: { ref: node.baseRefName },
    head: { ref: node.headRefName },
  };
}

interface RspGraphqlPlan {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly decode: (answer: Record<string, unknown>) => unknown;
}

function graphqlPlan(
  operation: GithubOperation,
  input: RspResidentGithubRead,
): RspGraphqlPlan | null {
  const owner = stringParam(input.params, "owner");
  const repo = stringParam(input.params, "repo");
  if (!owner || !repo) return null;
  const first = positiveIntParam(input.params, "per_page", 30);
  const states = [String(input.params?.state ?? "open").toUpperCase()];

  if (operation.key === "issue list") {
    return {
      query: `query RspIssueList($owner: String!, $repo: String!, $first: Int!, $states: [IssueState!], $labels: [String!]) {
        repository(owner: $owner, name: $repo) {
          issues(first: $first, states: $states, labels: $labels, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { number title body state url updatedAt author { login } labels(first: 100) { nodes { name } } }
          }
        }
      }`,
      variables: {
        owner,
        repo,
        first,
        states,
        labels: csvParam(input.params, "labels"),
      },
      decode: (answer) => connectionNodes(answer, "issues").map((node) => ({
        number: node.number,
        title: node.title,
        body: node.body,
        state: String(node.state ?? "").toLowerCase(),
        html_url: node.url,
        updated_at: node.updatedAt,
        user: node.author,
        labels: nestedNodes(node.labels),
      })),
    };
  }

  if (operation.key === "pr list") {
    return {
      query: `query RspPrList($owner: String!, $repo: String!, $first: Int!, $states: [PullRequestState!]) {
        repository(owner: $owner, name: $repo) {
          pullRequests(first: $first, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { number title body state url updatedAt isDraft author { login } baseRefName headRefName labels(first: 100) { nodes { name } } }
          }
        }
      }`,
      variables: { owner, repo, first, states },
      decode: (answer) => connectionNodes(answer, "pullRequests").map((node) => ({
        number: node.number,
        title: node.title,
        body: node.body,
        state: String(node.state ?? "").toLowerCase(),
        html_url: node.url,
        updated_at: node.updatedAt,
        draft: node.isDraft === true,
        user: node.author,
        base: { ref: node.baseRefName },
        head: { ref: node.headRefName },
        labels: nestedNodes(node.labels),
      })),
    };
  }
  return null;
}

function connectionNodes(answer: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const repository = record(answer.repository);
  const connection = record(repository?.[key]);
  return Array.isArray(connection?.nodes)
    ? connection.nodes.map(record).filter((node): node is Record<string, unknown> => node !== null)
    : [];
}

function nestedNodes(value: unknown): Record<string, unknown>[] {
  const connection = record(value);
  return Array.isArray(connection?.nodes)
    ? connection.nodes.map(record).filter((node): node is Record<string, unknown> => node !== null)
    : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringParam(params: RspResidentGithubRead["params"], key: string): string {
  const value = params?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function positiveIntParam(
  params: RspResidentGithubRead["params"],
  key: string,
  fallback: number,
): number {
  const value = Number(params?.[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function csvParam(params: RspResidentGithubRead["params"], key: string): string[] | null {
  const value = stringParam(params, key);
  return value === "" ? null : value.split(",").map((part) => part.trim()).filter(Boolean);
}

function refusal(operation: GithubOperation, reason: string, repair: string): RspResidentGithubResult {
  return {
    status: 75,
    stdout: "",
    stderr: JSON.stringify({
      refused: true,
      reason,
      operation: operation.key,
      pool: operation.budget,
      repair,
    }),
    surface: operation.surface,
    pool: operation.budget,
    quotaFree: false,
    refused: true,
  };
}

function stableCacheKey(
  path: string,
  params: RspResidentGithubRead["params"],
): string {
  return JSON.stringify({
    path,
    params: Object.entries(params ?? {})
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  });
}

function definedParams(
  params: RspResidentGithubRead["params"],
): Readonly<Record<string, string | number | boolean>> {
  return Object.fromEntries(
    Object.entries(params ?? {}).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
}

function errorStatus(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status > 0) return status;
  }
  return 1;
}
