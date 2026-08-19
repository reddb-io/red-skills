// github-request — translate one forge-shaped request into the gateway's own
// vocabulary (ADR 0147 §2, ADR 0144 §3, ADR 0132).
//
// `rs_github` forwards a method, a path, a body and headers; the gateway speaks
// declared reads and declared writes. This module is the ONE place the two meet,
// and it is deliberately a translation rather than a tunnel: a passthrough that
// handed arbitrary bytes to an authenticated socket would make the credential
// profile decorative, because whoever chose the path would have chosen the
// operation too.
//
// So a read becomes the gateway's REST read — which is where coalescing, the
// age-stamped cache and backpressure already live — and a write becomes one of
// the outbox's declared mutations. A request that maps to neither is refused by
// name, not approximated.
import { createHash } from "node:crypto";
import {
  isRedskilledGithubRequestMethod,
  type RedskilledGithubRequest,
  type RedskilledGithubRequestMethod,
  type RedskilledGithubRequestParams,
} from "@reddb-io/protocol-acp";
import {
  RedskilledGithubAuthorityError,
  type RedskilledGithubRead,
  type RedskilledGithubReadAnswer,
  type RedskilledGithubWriteAnswer,
  type RedskilledGithubWriteRequest,
} from "./github-gateway.js";

/** What the gateway is actually asked to do once the envelope is understood. */
export type RedskilledGithubRequestPlan =
  | { readonly mode: "read"; readonly path: string; readonly read: RedskilledGithubRead }
  | { readonly mode: "write"; readonly path: string; readonly write: RedskilledGithubWriteRequest };

/**
 * The answer, carrying WHICH lane served it.
 *
 * A read answer keeps the gateway's `cache` block verbatim, so `cache.age_ms`
 * says how old the served value is; a write answer keeps the outbox receipt, so
 * `idempotency_key` and `queued_at` say the mutation was scheduled durably
 * rather than fired and forgotten.
 */
export type RedskilledGithubRequestAnswer =
  | {
      readonly version: 1;
      readonly mode: "read";
      readonly method: RedskilledGithubRequestMethod;
      readonly path: string;
      readonly answer: RedskilledGithubReadAnswer;
    }
  | {
      readonly version: 1;
      readonly mode: "write";
      readonly method: RedskilledGithubRequestMethod;
      readonly path: string;
      readonly answer: RedskilledGithubWriteAnswer;
    };

/** The methods that only ever observe. Everything else mutates the forge. */
const READ_METHODS: readonly RedskilledGithubRequestMethod[] = ["GET", "HEAD"];

/** Reject caller-controlled Project, credential, remote, and host authority. */
export function githubRequestParams(value: unknown): RedskilledGithubRequestParams {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new RedskilledGithubAuthorityError("a Project GitHub request needs one request");
  }
  const params = value as Record<string, unknown>;
  if (Object.keys(params).length !== 1 || !("request" in params)) {
    throw new RedskilledGithubAuthorityError(
      "a Project GitHub request cannot name a Project, credential profile, remote, or host operation",
    );
  }
  if (params.request == null || typeof params.request !== "object" || Array.isArray(params.request)) {
    throw new RedskilledGithubAuthorityError("a Project GitHub request needs one request object");
  }
  return { request: params.request as RedskilledGithubRequest };
}

/**
 * Understand one request against one Project. PURE — no credential, no socket.
 *
 * Kept separate from the binding so the translation can be read, tested and
 * argued about without a live gateway behind it.
 */
export function planGithubRequest(
  projectLabel: string,
  request: RedskilledGithubRequest,
): RedskilledGithubRequestPlan {
  const method = request.method;
  if (!isRedskilledGithubRequestMethod(method)) {
    return refuse("a Project GitHub request needs one ordinary HTTP method");
  }
  requireOnlyKeys(request, ["method", "path", "body", "headers"]);
  refuseCallerHeaders(request.headers);
  const path = repositoryRelativePath(projectLabel, request.path);

  if (READ_METHODS.includes(method)) {
    if (request.body != null) return refuse(`a ${method} request carries no body`);
    return { mode: "read", path, read: { kind: "rest", path } };
  }
  return { mode: "write", path, write: writeRequest(method, path, request.body) };
}

/**
 * The outbox key a passthrough write is scheduled under.
 *
 * Derived from the request rather than named by the caller, because the caller
 * of a forge-shaped tool has no idempotency vocabulary to name one WITH — and a
 * key it invented per call would defeat the outbox exactly when it matters, on
 * the retry after a timeout whose write may already have landed. The cost is
 * stated rather than hidden: two deliberately identical publications are one
 * publication, and the second call returns the first one's durable receipt.
 */
export function githubRequestIdempotencyKey(
  method: RedskilledGithubRequestMethod,
  path: string,
  body: Readonly<Record<string, unknown>> | undefined,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([method, path, body ?? null]))
    .digest("hex");
  return `ghreq-${digest.slice(0, 48)}`;
}

/** Compose the public answer around whichever gateway lane served the request. */
export function githubRequestAnswer(
  method: RedskilledGithubRequestMethod,
  path: string,
  served:
    | { readonly mode: "read"; readonly answer: RedskilledGithubReadAnswer }
    | { readonly mode: "write"; readonly answer: RedskilledGithubWriteAnswer },
): RedskilledGithubRequestAnswer {
  return served.mode === "read"
    ? { version: 1, mode: "read", method, path, answer: served.answer }
    : { version: 1, mode: "write", method, path, answer: served.answer };
}

/**
 * Normalize to a path inside THIS Project's repository.
 *
 * An operator spells the full `repos/<owner>/<repo>/…` path out of habit, so the
 * prefix is accepted and stripped — but only when it names the bound repository.
 * Naming another one is the request this whole gateway exists to refuse.
 */
function repositoryRelativePath(projectLabel: string, value: unknown): string {
  let path = typeof value === "string" ? value.trim().replace(/^\/+/, "") : "";
  const prefix = `repos/${projectLabel}/`;
  if (path.toLowerCase().startsWith("repos/")) {
    if (!path.toLowerCase().startsWith(prefix.toLowerCase())) {
      return refuse("a Project GitHub request cannot address another repository");
    }
    path = path.slice(prefix.length);
  }
  if (path === "" || path.includes("\\") || path.split(/[/?#]/).some((part) => part === ".." || part === ".")) {
    return refuse("a Project GitHub request needs one repository-relative path");
  }
  return path;
}

/**
 * Map a mutating request onto one declared outbox write.
 *
 * The list is short on purpose: these are the mutations the daemon can make
 * idempotent, reconcile after a restart and attribute to a Project. A request
 * outside it is refused with the set named, so the caller learns the boundary
 * instead of guessing at a 404.
 */
function writeRequest(
  method: RedskilledGithubRequestMethod,
  path: string,
  body: Readonly<Record<string, unknown>> | undefined,
): RedskilledGithubWriteRequest {
  if (method !== "POST") {
    return refuse(
      `the Project GitHub gateway schedules no ${method} write — its outbox publishes Issues, Issue comments and pull requests`,
    );
  }
  if (body != null && (typeof body !== "object" || Array.isArray(body))) {
    return refuse("a Project GitHub write needs one request body object");
  }
  const fields = (body ?? {}) as Record<string, unknown>;
  const route = path.split(/[?#]/, 1)[0]!;
  const comment = /^issues\/([1-9][0-9]*)\/comments$/.exec(route);
  const write = comment != null
    ? { kind: "issue-publication" as const, issue: Number(comment[1]), body: text(fields.body, "an Issue comment needs a body") }
    : route === "issues"
      ? {
          kind: "issue-publication" as const,
          title: text(fields.title, "a new Issue needs a title"),
          body: text(fields.body, "a new Issue needs a body"),
          ...(fields.labels == null ? {} : { labels: labels(fields.labels) }),
        }
      : route === "pulls"
        ? {
            kind: "pull-request" as const,
            head: text(fields.head, "a pull request needs a head branch"),
            base: text(fields.base, "a pull request needs a base branch"),
            title: text(fields.title, "a pull request needs a title"),
            body: text(fields.body, "a pull request needs a body"),
          }
        : refuse(
            `the Project GitHub gateway schedules no write for ${JSON.stringify(route)} — ` +
              "its outbox publishes `issues`, `issues/<number>/comments` and `pulls`",
          );
  return { idempotency_key: githubRequestIdempotencyKey(method, path, body), write };
}

/**
 * A caller may name no header at all.
 *
 * Authorization is the obvious one, but every header here is refused: the
 * gateway conditions its own reads with the validators it holds, and a caller
 * that could set `if-none-match` would be steering a cache it does not own.
 */
function refuseCallerHeaders(headers: unknown): void {
  if (headers == null) return;
  if (typeof headers !== "object" || Array.isArray(headers)) {
    return refuse("a Project GitHub request needs one headers object");
  }
  const named = Object.keys(headers as Record<string, unknown>);
  if (named.length === 0) return;
  refuse(
    "the Project GitHub gateway owns its own request headers — it authenticates, negotiates and " +
      `conditions every call itself, so a caller may name none (received ${named.sort().join(", ")})`,
  );
}

function text(value: unknown, message: string): string {
  const found = typeof value === "string" ? value : "";
  return found.trim() === "" ? refuse(message) : found;
}

function labels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return refuse("Issue labels must be a list of label names");
  return value.map((entry) => text(entry, "an Issue label must be one non-empty label name"));
}

function requireOnlyKeys(value: object, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra != null) {
    refuse("a Project GitHub request carries only a method, a path, a body and headers");
  }
}

function refuse(message: string): never {
  throw new RedskilledGithubAuthorityError(message);
}
