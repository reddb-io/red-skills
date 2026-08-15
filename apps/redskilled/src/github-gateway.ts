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
  DEFAULT_GITHUB_CACHE_CAPACITY,
  DEFAULT_GITHUB_CACHE_FRESH_MS,
  GithubBackpressureError,
  classifyGithubLimit,
  createGithubCache,
  type GithubCacheOutcome,
  type GithubLimitFact,
} from "@reddb-io/github";
import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  RedskilledGithubCredentialProfileError,
  githubCredentialScopeRefusal,
} from "./github-credential-profiles.js";
import {
  budgetKey,
  poolForRead,
  projectPools,
  publishableProfile,
  type BudgetObservation,
  type RedskilledGithubBudgetFacts,
  type RedskilledGithubBudgetPool,
  type RedskilledGithubManagedBudgetGateway,
} from "./github-budget.js";

export type {
  RedskilledGithubBudgetEvidence,
  RedskilledGithubBudgetEvidenceState,
  RedskilledGithubBudgetFacts,
  RedskilledGithubBudgetGateway,
  RedskilledGithubBudgetPool,
  RedskilledGithubBudgetPresentation,
  RedskilledGithubHostBudgetProjection,
  RedskilledGithubManagedBudgetGateway,
  RedskilledGithubPoolBudgetProjection,
  RedskilledGithubProfileBudgetProjection,
  RedskilledGithubProjectBudgetProjection,
} from "./github-budget.js";

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

export interface RedskilledGithubUpstreamAnswer {
  readonly value: unknown;
  readonly budget: RedskilledGithubBudgetFacts | null;
  /** Validators belong to the daemon cache entry, never to an ACP caller. */
  readonly validators?: RedskilledGithubValidators;
  /** A 304 confirms the held value; it never represents an empty answer. */
  readonly notModified?: boolean;
}

export interface RedskilledGithubValidators {
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface RedskilledGithubUpstreamInput {
  readonly project: RedskilledGithubProjectAuthority;
  readonly credential: RedskilledGithubCredential;
  readonly read: RedskilledGithubRead;
  readonly conditional?: RedskilledGithubValidators;
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
  /** Present when an eligible dated cache answered an unavailable live read. */
  readonly backpressure?: GithubLimitFact;
  readonly retry_at?: string;
}

export interface RedskilledGithubProjectReader {
  read(request: RedskilledGithubRead): Promise<RedskilledGithubReadAnswer>;
}

export interface RedskilledGithubManagedProjectReader extends RedskilledGithubProjectReader {
  /** Authoritatively refresh every cached read in this Project/profile scope. */
  refresh(): Promise<number>;
  /** A webhook delivery is only a deduplicated wake hint; its payload is absent. */
  wake(signal: RedskilledGithubWake): Promise<number>;
  /** Observe ordered updates derived only from completed authoritative refreshes. */
  subscribe(observer: (update: RedskilledGithubUpdate) => void): () => void;
}

export interface RedskilledGithubGateway {
  forProject(
    authority: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
  ): RedskilledGithubProjectReader;
  close?(): void;
}

export interface RedskilledGithubManagedGateway extends RedskilledGithubGateway {
  forProject(
    authority: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
  ): RedskilledGithubManagedProjectReader;
  close(): void;
}

export interface RedskilledGithubWake {
  readonly deliveryId: string;
}

export interface RedskilledGithubUpdate {
  readonly version: 1;
  readonly sequence: number;
  readonly project_id: string;
  readonly credential_profile: string;
  readonly read: RedskilledGithubRead;
  readonly fetched_at: string;
  readonly value: unknown;
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
  ) => RedskilledGithubCredentialSelection | null | Promise<RedskilledGithubCredentialSelection | null>;
}

export interface CreateRedskilledGithubGatewayOptions {
  readonly upstream: RedskilledGithubUpstream;
  readonly clock?: () => string;
  readonly freshMs?: number;
  readonly capacity?: number;
  /** Public profile names from host config; credential declarations stay private. */
  readonly configuredProfiles?: readonly string[];
  /** Authoritative polling cadence; a webhook may only bring this refresh forward. */
  readonly refreshMs?: number;
}

export interface CreateRedskilledGithubUpstreamOptions {
  readonly origin?: string;
  readonly graphqlEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly fetchRepository?: (input: RedskilledGithubUpstreamInput) => Promise<unknown>;
  readonly clock?: () => string;
}

interface KeptGithubAnswer {
  readonly value: unknown;
  readonly budget: RedskilledGithubBudgetFacts | null;
}

interface RefreshState {
  readonly key: string;
  readonly scope: string;
  readonly project: RedskilledGithubProjectAuthority;
  readonly credential: RedskilledGithubCredential;
  readonly read: RedskilledGithubRead;
  answer?: KeptGithubAnswer;
  validators?: RedskilledGithubValidators;
  timer?: NodeJS.Timeout;
}

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
): RedskilledGithubManagedBudgetGateway {
  const cache = createGithubCache({
    ...(options.freshMs == null ? {} : { freshMs: options.freshMs }),
    ...(options.capacity == null ? {} : { capacity: options.capacity }),
  });
  const clock = options.clock ?? (() => new Date().toISOString());
  const refreshMs = Math.max(1, options.refreshMs ?? options.freshMs ?? DEFAULT_GITHUB_CACHE_FRESH_MS);
  const capacity = Math.max(1, options.capacity ?? DEFAULT_GITHUB_CACHE_CAPACITY);
  const inFlight = new Map<string, Promise<RedskilledGithubReadAnswer>>();
  const profiles = new Set((options.configuredProfiles ?? []).filter(publishableProfile));
  const projectsByProfile = new Map<string, Map<string, string>>();
  const observations = new Map<string, BudgetObservation>();

  const observe = (
    project: RedskilledGithubProjectAuthority,
    pool: RedskilledGithubBudgetPool,
    observation: BudgetObservation,
  ): void => {
    observations.set(budgetKey(project.credentialProfile, pool), observation);
  };
  const states = new Map<string, RefreshState>();
  const observers = new Map<string, Set<(update: RedskilledGithubUpdate) => void>>();
  const sequences = new Map<string, number>();
  const seenWakes = new Map<string, Set<string>>();
  let closed = false;

  const schedule = (state: RefreshState): void => {
    if (closed) return;
    if (state.timer != null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void refreshState(state).catch(() => undefined);
    }, refreshMs);
    state.timer.unref?.();
  };

  const publish = (state: RefreshState, value: unknown, fetchedAt: string): void => {
    const sequence = (sequences.get(state.scope) ?? 0) + 1;
    sequences.set(state.scope, sequence);
    const update: RedskilledGithubUpdate = {
      version: 1,
      sequence,
      project_id: state.project.projectId,
      credential_profile: state.project.credentialProfile,
      read: state.read,
      fetched_at: fetchedAt,
      value,
    };
    for (const observer of observers.get(state.scope) ?? []) observer(update);
  };

  const refreshState = async (state: RefreshState): Promise<RedskilledGithubReadAnswer> => {
    const pending = inFlight.get(state.key);
    if (pending != null) return pending;
    const held = cache.read<KeptGithubAnswer>(state.key, { now: clock() });
    const pool = poolForRead(state.read);
    const request = options.upstream({
      project: state.project,
      credential: state.credential,
      read: state.read,
      ...(state.validators == null || state.read.kind !== "rest" ? {} : { conditional: state.validators }),
    }).then((upstreamAnswer) => {
      const fetchedAt = clock();
      if (upstreamAnswer.notModified) {
        const answer = state.answer ?? held.value;
        if (answer == null) {
          throw new Error("redskilled GitHub upstream returned not-modified without a held cache answer");
        }
        state.answer = {
          value: answer.value,
          budget: upstreamAnswer.budget ?? answer.budget,
        };
        state.validators = upstreamAnswer.validators ?? state.validators;
        if (pool != null) observe(state.project, pool, {
          facts: state.answer.budget,
          state: upstreamAnswer.budget == null ? "unavailable" : "authoritative",
          observedAt: fetchedAt,
        });
        cache.put({ key: state.key, kind: state.read.kind, value: state.answer, fetchedAt });
        return publicAnswer(state.project, state.answer, "cache", {
          outcome: "fresh",
          fetched_at: fetchedAt,
          age_ms: 0,
          fresh_ms: cache.read(state.key, { now: fetchedAt }).fresh_ms,
        });
      }
      const answer: KeptGithubAnswer = { value: upstreamAnswer.value, budget: upstreamAnswer.budget };
      const changed = state.answer == null || !isDeepStrictEqual(state.answer.value, answer.value);
      state.answer = answer;
      state.validators = upstreamAnswer.validators;
      if (pool != null) observe(state.project, pool, {
        facts: answer.budget,
        state: answer.budget == null ? "unavailable" : "authoritative",
        observedAt: fetchedAt,
      });
      cache.put({ key: state.key, kind: state.read.kind, value: answer, fetchedAt });
      if (changed) publish(state, answer.value, fetchedAt);
      return publicAnswer(state.project, answer, "upstream", {
        outcome: "fresh",
        fetched_at: fetchedAt,
        age_ms: 0,
        fresh_ms: cache.read(state.key, { now: fetchedAt }).fresh_ms,
      });
    }).catch((error: unknown) => {
      if (pool != null) observe(state.project, pool, {
        facts: held.value?.budget ?? state.answer?.budget ?? null,
        state: error instanceof GithubBackpressureError ? "backpressured" : "unavailable",
        observedAt: clock(),
        ...(error instanceof GithubBackpressureError ? { backpressure: error.fact } : {}),
      });
      if (
        error instanceof GithubBackpressureError &&
        state.read.kind !== "repository-fetch" &&
        held.hit && held.value != null && held.fetched_at != null && held.age_ms != null
      ) {
        return publicAnswer(state.project, held.value, "cache", {
          outcome: held.outcome,
          fetched_at: held.fetched_at,
          age_ms: held.age_ms,
          fresh_ms: held.fresh_ms,
        }, error.fact);
      }
      throw error;
    }).finally(() => {
      inFlight.delete(state.key);
      schedule(state);
    });
    inFlight.set(state.key, request);
    return request;
  };

  const trimStates = (): void => {
    while (states.size > capacity) {
      const oldest = states.entries().next().value as [string, RefreshState] | undefined;
      if (oldest == null) return;
      const [key, state] = oldest;
      if (state.timer != null) clearTimeout(state.timer);
      states.delete(key);
      cache.forget(key);
    }
  };

  return {
    forProject(authority, credential) {
      const project = validateAuthority(authority);
      if (typeof credential.secret !== "string" || credential.secret.trim() === "") {
        throw new RedskilledGithubAuthorityError(
          `credential profile ${JSON.stringify(project.credentialProfile)} has no daemon-owned credential`,
        );
      }
      profiles.add(project.credentialProfile);
      const attributed = projectsByProfile.get(project.credentialProfile) ?? new Map<string, string>();
      attributed.set(project.projectId, project.projectLabel);
      projectsByProfile.set(project.credentialProfile, attributed);
      const scope = scopeKey(project);
      return {
        async read(request) {
          const read = validateRead(project, request);
          const pool = poolForRead(read);
          const key = cacheKey(project, read);
          const now = clock();
          const held = cache.read<KeptGithubAnswer>(key, { now });
          if (held.outcome === "fresh" && held.value != null && held.fetched_at != null && held.age_ms != null) {
            if (pool != null) observe(project, pool, {
              facts: held.value.budget,
              state: "cached",
              observedAt: held.fetched_at,
            });
            return publicAnswer(project, held.value, "cache", {
              outcome: held.outcome,
              fetched_at: held.fetched_at,
              age_ms: held.age_ms,
              fresh_ms: held.fresh_ms,
            });
          }

          const pending = inFlight.get(key);
          if (pending != null) return pending;
          let state = states.get(key);
          if (state == null) {
            state = { key, scope, project, credential, read };
            states.set(key, state);
            trimStates();
          }
          return refreshState(state);
        },
        async refresh() {
          const scoped = [...states.values()].filter((state) => state.scope === scope);
          await Promise.all(scoped.map((state) => refreshState(state)));
          return scoped.length;
        },
        async wake(signal) {
          validateWake(signal);
          let deliveries = seenWakes.get(scope);
          if (deliveries == null) {
            deliveries = new Set();
            seenWakes.set(scope, deliveries);
          }
          if (deliveries.has(signal.deliveryId)) return 0;
          deliveries.add(signal.deliveryId);
          if (deliveries.size > 1_024) deliveries.delete(deliveries.values().next().value!);
          const scoped = [...states.values()].filter((state) => state.scope === scope);
          await Promise.all(scoped.map((state) => refreshState(state)));
          return scoped.length;
        },
        subscribe(observer) {
          let scoped = observers.get(scope);
          if (scoped == null) {
            scoped = new Set();
            observers.set(scope, scoped);
          }
          scoped.add(observer);
          return () => {
            scoped!.delete(observer);
            if (scoped!.size === 0) observers.delete(scope);
          };
        },
      };
    },
    projectBudget(authority) {
      const project = validateAuthority(authority);
      return {
        version: 1,
        scope: "project",
        project_id: project.projectId,
        project_label: project.projectLabel,
        credential_profile: project.credentialProfile,
        pools: projectPools(project.credentialProfile, observations, clock()),
      };
    },
    hostBudget() {
      return {
        version: 1,
        scope: "host-administration",
        profiles: [...profiles].sort().map((profile) => {
          const attributed = projectsByProfile.get(profile) ?? new Map<string, string>();
          const projects = [...attributed].sort(([left], [right]) => left.localeCompare(right));
          return {
            credential_profile: profile,
            project_ids: projects.map(([id]) => id),
            project_labels: projects.map(([, label]) => label),
            pools: projectPools(profile, observations, clock()),
          };
        }),
      };
    },
    close() {
      closed = true;
      for (const state of states.values()) if (state.timer != null) clearTimeout(state.timer);
      states.clear();
      observers.clear();
      seenWakes.clear();
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
  const clock = options.clock ?? (() => new Date().toISOString());

  return async (input) => {
    if (input.read.kind === "repository-fetch") {
      return { value: await fetchRepository(input), budget: null };
    }

    if (input.read.kind === "rest") {
      const repository = input.project.projectLabel.split("/").map(encodeURIComponent).join("/");
      const conditionalHeaders = input.conditional == null ? {} : {
        ...(input.conditional.etag == null ? {} : { "if-none-match": input.conditional.etag }),
        ...(input.conditional.lastModified == null
          ? {}
          : { "if-modified-since": input.conditional.lastModified }),
      };
      const response = await fetchImpl(`${origin}/repos/${repository}/${input.read.path}`, {
        method: "GET",
        headers: { ...githubHeaders(input.credential.secret), ...conditionalHeaders },
      });
      const pool = input.read.path.replace(/^\/+/, "").startsWith("search/") ? "search" : "rest";
      const validators = validatorsFromHeaders(response.headers, input.conditional);
      if (response.status === 304) {
        return {
          value: undefined,
          budget: budgetFromHeaders(pool, response.headers),
          validators,
          notModified: true,
        };
      }
      if (!response.ok) {
        throw upstreamRefusal("REST", pool, response, clock(), input.project.credentialProfile);
      }
      return {
        value: await responseValue(response),
        budget: budgetFromHeaders(pool, response.headers),
        validators,
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
    if (!response.ok) {
      throw upstreamRefusal("GraphQL", "graphql", response, clock(), input.project.credentialProfile);
    }
    const body = await response.json() as {
      readonly data?: { readonly repository?: unknown; readonly rateLimit?: unknown };
      readonly errors?: readonly unknown[];
    };
    if (body.errors?.some(isGithubScopeError)) {
      throw githubCredentialScopeRefusal(input.project.credentialProfile);
    }
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
  backpressure?: GithubLimitFact,
): RedskilledGithubReadAnswer {
  return {
    version: 1,
    project_id: project.projectId,
    credential_profile: project.credentialProfile,
    source,
    cache,
    budget: answer.budget,
    value: answer.value,
    ...(backpressure === undefined ? {} : {
      backpressure,
      retry_at: backpressure.retry_at,
    }),
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

function scopeKey(project: RedskilledGithubProjectAuthority): string {
  return JSON.stringify([project.projectId, project.credentialProfile]);
}

function validateWake(value: RedskilledGithubWake): void {
  if (value == null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 1 || typeof value.deliveryId !== "string" ||
    value.deliveryId.trim() === "" || value.deliveryId.length > 256) {
    refuse("a GitHub webhook wake may carry only one bounded delivery identifier");
  }
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

function validatorsFromHeaders(
  headers: Headers,
  previous: RedskilledGithubValidators | undefined,
): RedskilledGithubValidators | undefined {
  const etag = headers.get("etag") ?? previous?.etag;
  const lastModified = headers.get("last-modified") ?? previous?.lastModified;
  if (etag == null && lastModified == null) return undefined;
  return {
    ...(etag == null ? {} : { etag }),
    ...(lastModified == null ? {} : { lastModified }),
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

function upstreamRefusal(
  surface: string,
  pool: "rest" | "graphql" | "search",
  response: Response,
  now: string,
  profile: string,
): Error {
  const observed = {
    status: response.status,
    response: { headers: Object.fromEntries(response.headers.entries()) },
  };
  const fact = classifyGithubLimit(observed, pool, Date.parse(now));
  if (fact != null) return new GithubBackpressureError(fact);
  if (response.status === 401) {
    return new RedskilledGithubCredentialProfileError("invalid-credentials", profile);
  }
  if (response.status === 403) return githubCredentialScopeRefusal(profile);
  return new Error(`redskilled GitHub ${surface} read failed with status ${response.status}`);
}

function isGithubScopeError(value: unknown): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "FORBIDDEN" || record.extensions != null &&
    typeof record.extensions === "object" &&
    (record.extensions as Record<string, unknown>).type === "FORBIDDEN";
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
