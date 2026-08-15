// github-companions — the payers this host measures beside the operator's token.
//
// A host that declares a GitHub App has TWO ceilings and used to have one
// measurement. The daemon is the only process that writes the balance surfaces
// and it asked exclusively on the operator's credential, so an installation
// spending thousands of reads an hour appeared nowhere: the snapshot measured
// the person, every history row was stamped `pat`, and the App's own file was
// named in the contract and written by nobody.
//
// **Two buckets are never summed.** Each payer answers for a ceiling the other's
// requests do not draw from, so each gets its own snapshot — a single document
// would have to pick an owner, making the last writer the displayed truth. The
// history lane is deliberately shared: one curve file, two labelled series, so a
// consumer separates them by identity instead of guessing which file is current.
import { join } from "node:path";
import {
  createGithubAppBalanceTransport,
  createGithubBalanceHistory,
  createGithubBalanceStore,
  createTimedGithubFetch,
  DEFAULT_GITHUB_BALANCE_TIMEOUT_MS,
  fetchGithubBalance,
  githubBalanceFileName,
  githubIdentityRef,
  type GithubAppCredential,
} from "@reddb-io/github";
import type {
  RedskilledBalanceCompanion,
  RedskilledBalanceRegistration,
} from "./daemon/types.js";
import {
  createRedskilledGithubGateway,
  createRedskilledGithubUpstream,
  type RedskilledGithubGatewayRegistration,
} from "./github-gateway.js";
import {
  createRedskilledGithubCredentialProfileResolver,
  type RedskilledGithubCredentialProfiles,
} from "./github-credential-profiles.js";

export interface ResolveServeGithubGatewayOptions {
  readonly profiles?: RedskilledGithubCredentialProfiles;
  readonly resolvePersonal: () => { readonly token: string } | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

/** Bind named daemon-owned credentials to the gateway, never to a client. */
export function resolveServeGithubGateway(
  options: ResolveServeGithubGatewayOptions,
): RedskilledGithubGatewayRegistration {
  const env = options.env ?? process.env;
  const fetchImpl = createTimedGithubFetch();
  const gateway = createRedskilledGithubGateway({
    configuredProfiles: ["personal", ...Object.keys(options.profiles ?? {})],
    upstream: createRedskilledGithubUpstream({
      ...(env.GITHUB_API_URL ? { origin: env.GITHUB_API_URL } : {}),
      ...(env.GITHUB_GRAPHQL_URL ? { graphqlEndpoint: env.GITHUB_GRAPHQL_URL } : {}),
      fetchImpl,
    }),
  });
  return {
    gateway,
    credentialForProject: createRedskilledGithubCredentialProfileResolver({
      profiles: options.profiles ?? {},
      resolvePersonal: options.resolvePersonal,
      ...(options.homeDir == null ? {} : { homeDir: options.homeDir }),
      ...(env.GITHUB_API_URL ? { origin: env.GITHUB_API_URL } : {}),
      fetchImpl,
    }),
  };
}

/**
 * The companions a declared App contributes. One entry today; the shape is a
 * list because "who pays on this host" is a set, not a second slot.
 */
export function resolveServeGithubCompanions(
  app: GithubAppCredential,
  hostStateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): RedskilledBalanceCompanion[] {
  const identity = githubIdentityRef({ kind: "app", app });
  return [{
    identity,
    transport: createGithubAppBalanceTransport({
      app,
      ...(env.GITHUB_API_URL ? { origin: env.GITHUB_API_URL } : {}),
      fetchImpl: createTimedGithubFetch({ timeoutMs: DEFAULT_GITHUB_BALANCE_TIMEOUT_MS }),
    }),
    store: createGithubBalanceStore({
      path: join(hostStateRoot, "github", githubBalanceFileName({ kind: "app", app })),
    }),
    history: createGithubBalanceHistory({
      path: join(hostStateRoot, "github", "balance-history.toonl"),
      identity,
    }),
  }];
}

/**
 * Measure every companion, each on its own credential.
 *
 * Nothing here may reach the daemon's own answer. `githubBalance()` stays the
 * PRIMARY's — the operator's token is the floor every surface renders, and an
 * App's ceiling cannot stand in for it on a repository the App does not cover.
 * A companion that throws costs its own row and nothing else: a payer that
 * cannot be measured is not a daemon that cannot serve.
 */
export async function measureGithubCompanions(
  companions: readonly RedskilledBalanceCompanion[],
  now: string,
): Promise<void> {
  for (const companion of companions) {
    try {
      const answer = await fetchGithubBalance({ transport: companion.transport, now });
      await companion.store?.write(answer).catch(() => undefined);
      await companion.history?.append(answer).catch(() => undefined);
    } catch {
      // Measured or not, the host keeps serving.
    }
  }
}

/**
 * Compose the whole balance registration: the operator's own ceiling, plus a
 * companion for each declared payer.
 *
 * Extracted from `serve` so BOTH arms can be judged. The absent-App arm is the
 * one that matters most and the one an inline ternary hid: a host that declares
 * no App must produce a registration byte-identical to the one it produced
 * before companions existed, or every operator without an App pays for a
 * feature they did not adopt.
 */
export function resolveServeGithubBalanceRegistration(
  resolved: { readonly transport: RedskilledBalanceRegistration["transport"] } | null,
  app: GithubAppCredential | null,
  hostStateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): RedskilledBalanceRegistration | null {
  if (resolved === null) return null;
  return {
    ...resolved,
    // The operator's own ceiling keeps the unsuffixed name and the default
    // `pat` stamp: this is the floor every surface already renders, and
    // renaming it would move a file other processes read.
    store: createGithubBalanceStore({ path: join(hostStateRoot, "github", "balance.toon") }),
    history: createGithubBalanceHistory({
      path: join(hostStateRoot, "github", "balance-history.toonl"),
    }),
    ...(app === null ? {} : { companions: resolveServeGithubCompanions(app, hostStateRoot, env) }),
  };
}
