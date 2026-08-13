// app-credential — which identity pays for a request, decided per repository.
//
// A Personal Access Token spends ONE bucket for the whole machine: the daemon's
// queue poll, every Worker's reads and the human's own `gh` draw from the same
// 5,000/hour, so one greedy surface starves the rest. An App installation
// carries its own bucket, states its permissions instead of inheriting
// everything its owner can do, and is revocable without touching a person.
//
// **But an installation covers an ACCOUNT, and the daemon is host-global.** The
// operator may be working in a repository the App was never installed on — a
// personal repo, another organisation, a fork — and that request must still go
// out, on the personal token. So this is not a switch between two credentials;
// it is a router keyed by repository, and the personal token remains the floor
// that answers wherever the App has no standing.
//
// The second cost of an App is that its installation token EXPIRES in an hour,
// which is why the App identity travels as the FACTS needed to mint one rather
// than as a token string: the transport re-mints on the schedule the token
// itself declares, and a daemon in its second hour is not a daemon holding a
// dead credential.
import { readFileSync } from "node:fs";

/** The three facts that identify an App installation. */
export interface GithubAppCredential {
  readonly appId: string;
  readonly installationId: string;
  /** Path to the App's private key (`.pem`). Read at use, never held in config. */
  readonly privateKeyPath: string;
}

/** Who a request authenticates as. */
export type GithubIdentity =
  | { readonly kind: "app"; readonly app: GithubAppCredential }
  | { readonly kind: "personal"; readonly token: string };

export const GITHUB_APP_ID_ENV = "RED_GITHUB_APP_ID";
export const GITHUB_APP_INSTALLATION_ENV = "RED_GITHUB_APP_INSTALLATION";
export const GITHUB_APP_KEY_ENV = "RED_GITHUB_APP_KEY";

/**
 * Read the App credential from the environment, or `null` when this host has none.
 *
 * All three facts are required together: a half-declared App is a configuration
 * mistake, and silently falling back to the personal token would hide it behind
 * the exact shared-bucket behaviour the App was adopted to end. `null` means
 * "this host authenticates as a person everywhere", a supported configuration.
 */
export function readGithubAppCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GithubAppCredential | null {
  const appId = (env[GITHUB_APP_ID_ENV] ?? "").trim();
  const installationId = (env[GITHUB_APP_INSTALLATION_ENV] ?? "").trim();
  const privateKeyPath = (env[GITHUB_APP_KEY_ENV] ?? "").trim();
  if (appId === "" && installationId === "" && privateKeyPath === "") return null;
  if (appId === "" || installationId === "" || privateKeyPath === "") {
    throw new Error(
      `an App credential needs all three of ${GITHUB_APP_ID_ENV}, ` +
        `${GITHUB_APP_INSTALLATION_ENV} and ${GITHUB_APP_KEY_ENV}; ` +
        "a partial declaration would silently fall back to the shared personal bucket",
    );
  }
  return { appId, installationId, privateKeyPath };
}

/** The private key bytes, with a failure that names the path rather than the syscall. */
export function readGithubAppPrivateKey(credential: GithubAppCredential): string {
  try {
    return readFileSync(credential.privateKeyPath, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read the GitHub App private key at ${credential.privateKeyPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Whether the App is installed on one repository. `null` when the question could not be answered. */
export type GithubInstallationLookup = (
  owner: string,
  repo: string,
) => Promise<boolean | null>;

export interface GithubIdentityRouterOptions {
  /** The personal credential. Always required: it is the floor. */
  readonly token: string;
  /** The App, when this host declares one. */
  readonly app?: GithubAppCredential | null;
  /** Ask GitHub whether the App covers a repository. */
  readonly lookup?: GithubInstallationLookup;
  /** Report each routing decision once per repository, for the operator. */
  readonly onDecision?: (decision: GithubIdentityDecision) => void;
}

export interface GithubIdentityDecision {
  readonly owner: string;
  readonly repo: string;
  readonly kind: GithubIdentity["kind"];
  readonly reason: string;
}

export interface GithubIdentityRouter {
  /** The identity that pays for requests against `owner/repo`. */
  forRepo(owner: string, repo: string): Promise<GithubIdentity>;
}

/**
 * Route each repository to the identity that can pay for it.
 *
 * Three answers, and the reason travels with each so a surprised operator can
 * see WHY a repository is on one bucket rather than the other:
 *
 * 1. The App covers the repository → the App, on its own bucket.
 * 2. The App exists but is not installed there → the personal token. This is
 *    the ordinary case for a repo outside the installed account, not a fault.
 * 3. The coverage question could not be answered (offline, App key unreadable,
 *    GitHub refusing) → the personal token, because a request that CAN be paid
 *    for must not fail over an optimisation. The reason says the answer was
 *    unknown, so an outage never masquerades as "not installed".
 *
 * The decision is cached per repository for the process: the coverage of an
 * installation changes at human speed, and asking once per request would spend
 * the very budget the App exists to protect.
 */
export function createGithubIdentityRouter(
  options: GithubIdentityRouterOptions,
): GithubIdentityRouter {
  const personal: GithubIdentity = { kind: "personal", token: options.token };
  const app = options.app ?? null;
  const decided = new Map<string, Promise<GithubIdentity>>();

  async function decide(owner: string, repo: string): Promise<GithubIdentity> {
    if (app === null) return personal;
    const covered = options.lookup === undefined ? null : await options.lookup(owner, repo);
    const [identity, reason] = covered === true
      ? [{ kind: "app", app } as GithubIdentity, "the App is installed on this repository"]
      : covered === false
        ? [personal, "the App is not installed on this repository"]
        : [personal, "the App's coverage of this repository is unknown"];
    options.onDecision?.({ owner, repo, kind: identity.kind, reason });
    return identity;
  }

  return {
    forRepo(owner, repo) {
      const key = `${owner}/${repo}`.toLowerCase();
      let pending = decided.get(key);
      if (pending === undefined) {
        pending = decide(owner, repo);
        decided.set(key, pending);
      }
      return pending;
    },
  };
}

/**
 * Ask GitHub which repositories the App covers, using the App's own JWT.
 *
 * `GET /repos/{owner}/{repo}/installation` is the one question with a real
 * answer: 200 means this installation stands here, 404 means it does not, and
 * anything else is an outage rather than a verdict — so it answers `null` and
 * the router keeps the personal token instead of inventing coverage.
 */
export function createGithubInstallationLookup(
  app: GithubAppCredential,
  fetchImpl: typeof fetch = fetch,
): GithubInstallationLookup {
  return async (owner, repo) => {
    let jwt: string;
    try {
      jwt = await signGithubAppJwt(app);
    } catch {
      return null; // an unreadable key is an outage of the optimisation, never a verdict
    }
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
        { headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" } },
      );
      if (response.status === 200) return true;
      if (response.status === 404) return false;
      return null;
    } catch {
      return null;
    }
  };
}

/** Sign the short-lived App JWT. Ten minutes is GitHub's ceiling; nine keeps clock skew legal. */
export async function signGithubAppJwt(app: GithubAppCredential): Promise<string> {
  const { createSign } = await import("node:crypto");
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${
    encode({ iat: issuedAt, exp: issuedAt + 540, iss: app.appId })
  }`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(readGithubAppPrivateKey(app)).toString("base64url")}`;
}

/**
 * The file name that holds one identity's balance.
 *
 * Two identities on one host have two SEPARATE buckets, and 5,000 App requests
 * cannot pay for a repository the App does not cover. Writing both answers to
 * one file would make the last writer the displayed truth — a statusline
 * showing a healthy balance for a bucket the next request will not use. Naming
 * the file after the identity keeps the two answers two answers.
 */
export function githubBalanceFileName(identity: GithubIdentity): string {
  return identity.kind === "app"
    ? `balance-app-${identity.app.installationId}.toon`
    : "balance.toon";
}

/** A short, stable label for the identity, for logs and the operator's surfaces. */
export function githubIdentityRef(identity: GithubIdentity): string {
  return identity.kind === "app" ? `app:${identity.app.installationId}` : "pat";
}

/**
 * Where the `github_app` block lives inside a parsed host config document.
 *
 * The daemon and the dev runtime each parse `~/.red/config.yaml` with their own
 * YAML dependency, so the PATH is the one thing they must agree on. Two hand-
 * written navigations of the same four keys drift into two different answers —
 * one of them silently reading no App at all, which is indistinguishable from a
 * host that declared none.
 */
export function githubAppBlockIn(document: unknown): unknown {
  if (document === null || typeof document !== "object") return null;
  const plugins = (document as Record<string, unknown>).plugins;
  if (plugins === null || typeof plugins !== "object") return null;
  const dev = (plugins as Record<string, unknown>).dev;
  if (dev === null || typeof dev !== "object") return null;
  const redskilled = (dev as Record<string, unknown>).redskilled;
  if (redskilled === null || typeof redskilled !== "object") return null;
  return (redskilled as Record<string, unknown>).github_app ?? null;
}

/**
 * Read the App credential from an operator's parsed host config.
 *
 * The environment is for a one-run override; the FILE is the onboarding
 * surface, because three exported variables are a setup nobody remembers having
 * done and nobody finds again. The shape mirrors the host policy it sits beside:
 *
 * ```yaml
 * plugins:
 *   dev:
 *     redskilled:
 *       github_app:
 *         app_id: "4575633"
 *         installation_id: "153309957"
 *         private_key: ~/.red/redskilled/credentials/github-app.pem
 * ```
 *
 * A partial block is refused for the same reason a partial environment is: a
 * silent fallback restores the shared bucket the App was adopted to end.
 */
export function readGithubAppCredentialFromConfig(
  block: unknown,
  expandHome: (path: string) => string = (path) => path,
): GithubAppCredential | null {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return null;
  const record = block as Record<string, unknown>;
  const appId = String(record.app_id ?? "").trim();
  const installationId = String(record.installation_id ?? "").trim();
  const privateKeyPath = String(record.private_key ?? "").trim();
  if (appId === "" && installationId === "" && privateKeyPath === "") return null;
  if (appId === "" || installationId === "" || privateKeyPath === "") {
    throw new Error(
      "a github_app block needs all three of app_id, installation_id and private_key; " +
        "a partial declaration would silently fall back to the shared personal bucket",
    );
  }
  return { appId, installationId, privateKeyPath: expandHome(privateKeyPath) };
}

/**
 * The App credential this host declares, file first and environment as override.
 *
 * Never returns the token itself, and the App credential must never be exported
 * as `GH_TOKEN` or `GITHUB_TOKEN`: writes go out through the `gh` CLI so that
 * comments, labels and pull requests carry the OPERATOR's name, and the App pays
 * only for reads. Handing the App token to the CLI would sign the operator's
 * work as a bot — the App is a payer, not an author.
 */
export function resolveGithubAppCredential(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly configBlock?: unknown;
  readonly expandHome?: (path: string) => string;
}): GithubAppCredential | null {
  return (
    readGithubAppCredentialFromEnv(input.env ?? process.env) ??
    readGithubAppCredentialFromConfig(input.configBlock, input.expandHome)
  );
}
