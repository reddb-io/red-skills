/**
 * Project-scoped GitHub reads owned by the redskilled daemon.
 *
 * A caller receives a reader already bound to one Project and one named
 * daemon-owned credential profile. It can describe a read, but it cannot name a
 * credential, a second Project, a repository remote, or a host operation. The
 * gateway therefore has one place to coalesce demand and one place to enforce
 * the authority boundary before any authenticated transport is reached.
 */
import {
  createGithubCache,
  type GithubCacheOutcome,
} from "@reddb-io/github";
import { execFile } from "node:child_process";

export const REDSKILLED_GITHUB_READ_METHOD = "_redskills/github_read";

export interface RedskilledGithubProjectAuthority {
  readonly projectId: string;
  /** Canonical `owner/repository` display identity resolved by redskilled. */
  readonly projectLabel: string;
  /** Canonical daemon-owned workspace, never a client checkout. */
  readonly workspacePath: string;
  /** Public, non-secret name of the daemon-owned credential profile. */
  readonly credentialProfile: string;
}

/** Secret material remains behind the daemon edge and never enters a result. */
export interface RedskilledGithubCredential {
  readonly secret: string;
}

export type RedskilledGithubRead =
  | { readonly kind: "rest"; readonly path: string }
  | { readonly kind: "graphql"; readonly selection: string }
  | { readonly kind: "repository-fetch"; readonly ref?: string };

export interface RedskilledGithubBudgetFacts {
  readonly pool: string;
  readonly remaining: number | null;
  readonly reset_at: string | null;
  readonly limit?: number | null;
}

export interface RedskilledGithubUpstreamAnswer {
  readonly value: unknown;
  readonly budget: RedskilledGithubBudgetFacts | null;
}

export interface RedskilledGithubUpstreamInput {
  readonly project: RedskilledGithubProjectAuthority;
  readonly credential: RedskilledGithubCredential;
  readonly read: RedskilledGithubRead;
}

export type RedskilledGithubUpstream = (
  input: RedskilledGithubUpstreamInput,
) => Promise<RedskilledGithubUpstreamAnswer>;

export interface RedskilledGithubReadAnswer {
  readonly version: 1;
  readonly project_id: string;
  readonly credential_profile: string;
  readonly source: "cache" | "upstream";
  readonly cache: {
    readonly outcome: GithubCacheOutcome;
    readonly fetched_at: string;
    readonly age_ms: number;
    readonly fresh_ms: number;
  };
  readonly budget: RedskilledGithubBudgetFacts | null;
  readonly value: unknown;
}

export interface RedskilledGithubProjectReader {
  read(request: RedskilledGithubRead): Promise<RedskilledGithubReadAnswer>;
}

export interface RedskilledGithubGateway {
  forProject(
    authority: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
  ): RedskilledGithubProjectReader;
}

export interface RedskilledGithubCredentialSelection {
  readonly profile: string;
  readonly credential: RedskilledGithubCredential;
}

/** Host registration passed into the control plane; profile policy stays here. */
export interface RedskilledGithubGatewayRegistration {
  readonly gateway: RedskilledGithubGateway;
  readonly credentialForProject: (
    project: Omit<RedskilledGithubProjectAuthority, "credentialProfile">,
  ) => RedskilledGithubCredentialSelection | null;
}

export interface CreateRedskilledGithubGatewayOptions {
  readonly upstream: RedskilledGithubUpstream;
  readonly clock?: () => string;
  readonly freshMs?: number;
  readonly capacity?: number;
}

export interface CreateRedskilledGithubUpstreamOptions {
  readonly origin?: string;
  readonly graphqlEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly fetchRepository?: (input: RedskilledGithubUpstreamInput) => Promise<unknown>;
}

interface KeptGithubAnswer extends RedskilledGithubUpstreamAnswer {}

export class RedskilledGithubAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedskilledGithubAuthorityError";
  }
}

/**
 * Create the one host gateway. The cache and in-flight map belong to this
 * instance, so every ACP connection served by the daemon joins the same demand.
 */
export function createRedskilledGithubGateway(
  options: CreateRedskilledGithubGatewayOptions,
): RedskilledGithubGateway {
  const cache = createGithubCache({
    ...(options.freshMs == null ? {} : { freshMs: options.freshMs }),
    ...(options.capacity == null ? {} : { capacity: options.capacity }),
  });
  const clock = options.clock ?? (() => new Date().toISOString());
  const inFlight = new Map<string, Promise<RedskilledGithubReadAnswer>>();

  return {
    forProject(authority, credential) {
      const project = validateAuthority(authority);
      if (typeof credential.secret !== "string" || credential.secret.trim() === "") {
        throw new RedskilledGithubAuthorityError(
          `credential profile ${JSON.stringify(project.credentialProfile)} has no daemon-owned credential`,
        );
      }
      return {
        async read(request) {
          const read = validateRead(project, request);
          const key = cacheKey(project, read);
          const now = clock();
          const held = cache.read<KeptGithubAnswer>(key, { now });
          if (held.outcome === "fresh" && held.value != null && held.fetched_at != null && held.age_ms != null) {
            return publicAnswer(project, held.value, "cache", {
              outcome: held.outcome,
              fetched_at: held.fetched_at,
              age_ms: held.age_ms,
              fresh_ms: held.fresh_ms,
            });
          }

          const pending = inFlight.get(key);
          if (pending != null) return pending;
          const fetch = options.upstream({ project, credential, read })
            .then((answer) => {
              const fetchedAt = clock();
              cache.put({ key, kind: read.kind, value: answer, fetchedAt });
              const kept = cache.read<KeptGithubAnswer>(key, { now: fetchedAt });
              return publicAnswer(project, answer, "upstream", {
                outcome: "fresh",
                fetched_at: fetchedAt,
                age_ms: 0,
                fresh_ms: kept.fresh_ms,
              });
            })
            .finally(() => inFlight.delete(key));
          inFlight.set(key, fetch);
          return fetch;
        },
      };
    },
  };
}

/**
 * The daemon's authenticated external edge. The transport accepts only the
 * already-authorized normalized request emitted above; it has no public socket
 * or independently selectable credential surface.
 */
export function createRedskilledGithubUpstream(
  options: CreateRedskilledGithubUpstreamOptions = {},
): RedskilledGithubUpstream {
  const origin = (options.origin ?? "https://api.github.com").replace(/\/+$/, "");
  const graphqlEndpoint = options.graphqlEndpoint ?? `${origin}/graphql`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchRepository = options.fetchRepository ?? fetchCanonicalRepository;

  return async (input) => {
    if (input.read.kind === "repository-fetch") {
      return { value: await fetchRepository(input), budget: null };
    }

    if (input.read.kind === "rest") {
      const repository = input.project.projectLabel.split("/").map(encodeURIComponent).join("/");
      const response = await fetchImpl(`${origin}/repos/${repository}/${input.read.path}`, {
        method: "GET",
        headers: githubHeaders(input.credential.secret),
      });
      if (!response.ok) throw upstreamRefusal("REST", response.status);
      return {
        value: await responseValue(response),
        budget: budgetFromHeaders("rest", response.headers),
      };
    }

    const [owner, repository] = input.project.projectLabel.split("/", 2) as [string, string];
    const query =
      `query RedskilledProjectRead { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repository)}) { ` +
      `${input.read.selection} } rateLimit { limit remaining resetAt cost } }`;
    const response = await fetchImpl(graphqlEndpoint, {
      method: "POST",
      headers: { ...githubHeaders(input.credential.secret), "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) throw upstreamRefusal("GraphQL", response.status);
    const body = await response.json() as {
      readonly data?: { readonly repository?: unknown; readonly rateLimit?: unknown };
      readonly errors?: readonly unknown[];
    };
    if (body.errors != null && body.errors.length > 0) {
      throw new Error("redskilled GitHub GraphQL read was refused upstream");
    }
    return {
      value: body.data?.repository,
      budget: graphqlBudget(body.data?.rateLimit),
    };
  };
}

function publicAnswer(
  project: RedskilledGithubProjectAuthority,
  answer: KeptGithubAnswer,
  source: RedskilledGithubReadAnswer["source"],
  cache: RedskilledGithubReadAnswer["cache"],
): RedskilledGithubReadAnswer {
  return {
    version: 1,
    project_id: project.projectId,
    credential_profile: project.credentialProfile,
    source,
    cache,
    budget: answer.budget,
    value: answer.value,
  };
}

function validateAuthority(
  authority: RedskilledGithubProjectAuthority,
): RedskilledGithubProjectAuthority {
  const fields = [authority.projectId, authority.projectLabel, authority.workspacePath, authority.credentialProfile];
  if (fields.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new RedskilledGithubAuthorityError("a GitHub reader needs one resolved Project and credential profile");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(authority.projectLabel)) {
    throw new RedskilledGithubAuthorityError("the resolved Project has no canonical GitHub repository identity");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(authority.credentialProfile)) {
    throw new RedskilledGithubAuthorityError("the daemon-owned credential profile name is not publishable");
  }
  return { ...authority };
}

function validateRead(
  project: RedskilledGithubProjectAuthority,
  request: RedskilledGithubRead,
): RedskilledGithubRead {
  if (request == null || typeof request !== "object") return refuse("a GitHub read must be an object");
  if (request.kind === "rest") {
    requireOnlyKeys(request, ["kind", "path"]);
    return validateRestRead(project, request);
  }
  if (request.kind === "graphql") {
    requireOnlyKeys(request, ["kind", "selection"]);
    return validateGraphqlRead(request);
  }
  if (request.kind === "repository-fetch") {
    requireOnlyKeys(request, ["kind", "ref"]);
    return validateRepositoryFetch(request);
  }
  return refuse("Project authority permits only REST, GraphQL, and repository-fetch reads");
}

function validateRestRead(
  project: RedskilledGithubProjectAuthority,
  request: Extract<RedskilledGithubRead, { kind: "rest" }>,
): RedskilledGithubRead {
  let path = typeof request.path === "string" ? request.path.trim().replace(/^\/+/, "") : "";
  const repositoryPrefix = `repos/${project.projectLabel}/`;
  if (path.startsWith("repos/")) {
    if (!path.toLowerCase().startsWith(repositoryPrefix.toLowerCase())) {
      return refuse("a Project GitHub reader cannot address another repository");
    }
    path = path.slice(repositoryPrefix.length);
  }
  if (path === "" || path.includes("\\") || path.split("/").some((part) => part === ".." || part === ".")) {
    return refuse("a Project GitHub REST read needs one repository-relative path");
  }
  const root = path.split(/[/?#]/, 1)[0]!.toLowerCase();
  if (["admin", "applications", "enterprises", "installation", "installations", "orgs", "rate_limit", "user", "users"].includes(root)) {
    return refuse("Project authority cannot use the GitHub gateway for host or account administration");
  }
  return { kind: "rest", path };
}

function validateGraphqlRead(
  request: Extract<RedskilledGithubRead, { kind: "graphql" }>,
): RedskilledGithubRead {
  const selection = typeof request.selection === "string"
    ? request.selection.trim().replace(/\s+/g, " ")
    : "";
  if (selection === "") return refuse("a Project GraphQL read needs a repository field selection");
  // The upstream wraps this selection inside repository(owner:, name:). Root
  // operations and root-only fields are therefore refused rather than parsed or
  // executed as caller-authored documents.
  if (/\b(query|mutation|subscription|repository|viewer|user|organization|enterprise|node|nodes|search|rateLimit)\b\s*(?:\(|\{)/i.test(selection) || selection.includes("$")) {
    return refuse("a Project GraphQL read may select fields only from its bound repository");
  }
  return { kind: "graphql", selection };
}

function validateRepositoryFetch(
  request: Extract<RedskilledGithubRead, { kind: "repository-fetch" }>,
): RedskilledGithubRead {
  if (request.ref == null || request.ref.trim() === "") return { kind: "repository-fetch" };
  const ref = request.ref.trim();
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(ref) ||
    ref.includes("..") || ref.includes("//") || ref.endsWith(".") || ref.endsWith("/") || ref.includes("@{")) {
    return refuse("a Project repository fetch may name only one ordinary branch or tag ref");
  }
  return { kind: "repository-fetch", ref };
}

function cacheKey(project: RedskilledGithubProjectAuthority, read: RedskilledGithubRead): string {
  const request = read.kind === "rest"
    ? read.path
    : read.kind === "graphql"
      ? read.selection
      : read.ref ?? "*";
  return JSON.stringify([project.projectId, project.credentialProfile, read.kind, request]);
}

function refuse(message: string): never {
  throw new RedskilledGithubAuthorityError(message);
}

function requireOnlyKeys(value: object, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra != null) {
    refuse("a Project GitHub read cannot carry Project, credential, remote, or host authority fields");
  }
}

function githubHeaders(secret: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${secret}`,
    "x-github-api-version": "2022-11-28",
  };
}

async function responseValue(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? response.json() : response.text();
}

function budgetFromHeaders(pool: string, headers: Headers): RedskilledGithubBudgetFacts | null {
  const remaining = finiteNumber(headers.get("x-ratelimit-remaining"));
  const limit = finiteNumber(headers.get("x-ratelimit-limit"));
  const reset = finiteNumber(headers.get("x-ratelimit-reset"));
  if (remaining == null && limit == null && reset == null) return null;
  return {
    pool,
    remaining,
    reset_at: reset == null ? null : new Date(reset * 1000).toISOString(),
    limit,
  };
}

function graphqlBudget(value: unknown): RedskilledGithubBudgetFacts | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    pool: "graphql",
    remaining: finiteNumber(record.remaining),
    reset_at: typeof record.resetAt === "string" ? record.resetAt : null,
    limit: finiteNumber(record.limit),
  };
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function upstreamRefusal(surface: string, status: number): Error {
  return new Error(`redskilled GitHub ${surface} read failed with status ${status}`);
}

async function fetchCanonicalRepository(input: RedskilledGithubUpstreamInput): Promise<unknown> {
  if (input.read.kind !== "repository-fetch") throw new Error("repository fetch received a non-fetch read");
  const authorization = Buffer.from(`x-access-token:${input.credential.secret}`, "utf8").toString("base64");
  const args = ["fetch", "--no-tags", "origin", ...(input.read.ref == null ? [] : [input.read.ref])];
  await new Promise<void>((resolve, reject) => {
    execFile("git", args, {
      cwd: input.project.workspacePath,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
        GIT_TERMINAL_PROMPT: "0",
      },
      windowsHide: true,
      timeout: 60_000,
    }, (error) => error == null ? resolve() : reject(new Error("redskilled repository fetch failed", { cause: error })));
  });
  return { fetched: true, ref: input.read.ref ?? null };
}
