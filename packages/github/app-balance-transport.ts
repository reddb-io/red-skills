import { createAppAuth } from "@octokit/auth-app";

import { readGithubAppPrivateKey, type GithubAppCredential } from "./app-credential.js";
import { createGithubBalanceTransport, type GithubBalanceTransport } from "./balance.js";

/** Ask one App installation's independent balance with a renewable token. */
export function createGithubAppBalanceTransport(options: {
  readonly app: GithubAppCredential;
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  /** Test seam that returns a short-lived installation token. */
  readonly authenticate?: () => Promise<string>;
}): GithubBalanceTransport {
  const authenticate = options.authenticate ?? (() => {
    const appAuth = createAppAuth({
      appId: options.app.appId,
      installationId: options.app.installationId,
      privateKey: readGithubAppPrivateKey(options.app),
    });
    return async () => (await appAuth({ type: "installation" })).token;
  })();
  return async () => await createGithubBalanceTransport({
    token: await authenticate(),
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })();
}
