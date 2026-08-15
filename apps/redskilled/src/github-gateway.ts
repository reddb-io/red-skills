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

export interface CreateRedskilledGithubGatewayOptions {
  readonly upstream: RedskilledGithubUpstream;
  readonly clock?: () => string;
  readonly freshMs?: number;
  readonly capacity?: number;
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
  if (request.kind === "rest") return validateRestRead(project, request);
  if (request.kind === "graphql") return validateGraphqlRead(request);
  if (request.kind === "repository-fetch") return validateRepositoryFetch(request);
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
