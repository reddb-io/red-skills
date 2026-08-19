// github-request — the `_redskills/github_request` params shape (ADR 0147 §2).
//
// `rs_github` publishes ONE tool and forwards it whole: a method, a path, an
// optional body, optional headers — the shape of the forge's own REST API, so
// an operator who already knows the API needs no second vocabulary and the MCP
// needs no per-endpoint schema to keep in step with it.
//
// What lives here is the WIRE. WHICH requests a Project may actually make, and
// whether an answer came from the daemon's cache or from upstream, are the
// gateway's decisions and stay with the gateway (ADR 0132, ADR 0148): a caller
// composes an envelope, it does not compose an authorization.

/** The methods the envelope may carry. Anything else is not a forge request. */
export const REDSKILLED_GITHUB_REQUEST_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
] as const;

export type RedskilledGithubRequestMethod = (typeof REDSKILLED_GITHUB_REQUEST_METHODS)[number];

export function isRedskilledGithubRequestMethod(
  value: unknown,
): value is RedskilledGithubRequestMethod {
  return (REDSKILLED_GITHUB_REQUEST_METHODS as readonly string[]).includes(value as string);
}

/**
 * One forge request, as an operator would spell it.
 *
 * `headers` is part of the envelope precisely so a caller-named header is
 * REFUSED rather than silently dropped: the gateway authenticates, negotiates
 * and conditions every call itself, and a header field a caller can fill is the
 * field a credential would arrive in.
 */
export interface RedskilledGithubRequest {
  readonly method: RedskilledGithubRequestMethod;
  /** Repository-relative, or the full `repos/<owner>/<repo>/…` path of THIS Project. */
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The whole request. A caller names no Project, profile, remote or host. */
export interface RedskilledGithubRequestParams {
  readonly request: RedskilledGithubRequest;
}
