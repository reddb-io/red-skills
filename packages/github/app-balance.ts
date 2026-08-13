// app-balance — the App's own ceiling, asked on the App's own credential.
//
// The balance surfaces were written by ONE process (the host daemon) asking on
// ONE credential (the operator's token), while the App's bucket was spent by
// other processes entirely. So an installation could carry thousands of reads
// an hour and appear nowhere: `balance.toon` measured the person, the history
// stamped every row `pat`, and `balance-app-<installation>.toon` — named in the
// contract and exercised only by tests — was written by nobody.
//
// **Two buckets are never summed, so they are asked separately.** This transport
// is the App half. It answers the same `/rate_limit` shape as the personal one,
// which is what lets both write the same document to different files rather than
// one document that would have to pick an owner.
//
// **A fresh installation token per ask, deliberately.** An installation token
// lives one hour and a balance ask is rare, so minting one per call costs a
// request the App itself pays for and removes expiry bookkeeping entirely — the
// alternative is a cached token that goes stale exactly when nobody is watching.
import type { GithubAppCredential } from "./app-credential.js";
import { signGithubAppJwt } from "./app-credential.js";
import { GITHUB_RATE_LIMIT_PATH, type GithubBalanceTransport } from "./balance.js";

/** Mint an installation access token for `app`. Throws with GitHub's own words. */
export async function mintGithubInstallationToken(
  app: GithubAppCredential,
  options: { readonly origin?: string; readonly fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const origin = options.origin ?? "https://api.github.com";
  const call = options.fetchImpl ?? fetch;
  const jwt = await signGithubAppJwt(app);
  const response = await call(
    `${origin}/app/installations/${app.installationId}/access_tokens`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok) {
    throw new Error(
      `minting an installation token for app ${app.appId} returned ${response.status}`,
    );
  }
  const body = (await response.json()) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  if (token === "") throw new Error("the installation token response carried no token");
  return token;
}

/**
 * The App's `/rate_limit`, asked as the installation.
 *
 * Shaped exactly like {@link createGithubBalanceTransport} so the caller cannot
 * tell the two apart — the difference belongs in WHERE the answer is written,
 * never in how it is read.
 */
export function createGithubAppBalanceTransport(options: {
  readonly app: GithubAppCredential;
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests; production mints through the App's own JWT. */
  readonly mintToken?: (app: GithubAppCredential) => Promise<string>;
}): GithubBalanceTransport {
  const origin = options.origin ?? "https://api.github.com";
  const call = options.fetchImpl ?? fetch;
  const mint = options.mintToken ??
    ((app: GithubAppCredential) => mintGithubInstallationToken(app, {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }));
  return async (): Promise<unknown> => {
    const token = await mint(options.app);
    const response = await call(`${origin}/${GITHUB_RATE_LIMIT_PATH}`, {
      method: "GET",
      headers: {
        authorization: `bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    });
    return await response.json();
  };
}
