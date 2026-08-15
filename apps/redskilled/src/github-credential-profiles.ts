/**
 * Daemon-owned GitHub credential profiles.
 *
 * Project config contains one public profile name. Host config contains the
 * backend declaration, while credential material is resolved only at the
 * authenticated upstream edge and is never returned to ACP clients or Workers.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mintGithubInstallationToken, type GithubAppCredential } from "@reddb-io/github";
import { parse } from "yaml";
import type {
  RedskilledGithubCredentialSelection,
  RedskilledGithubProjectAuthority,
} from "./github-gateway.js";

export const DEFAULT_REDSKILLED_GITHUB_CREDENTIAL_PROFILE = "personal";

export type RedskilledGithubCredentialProfileDeclaration =
  | { readonly kind: "personal" }
  | {
      readonly kind: "github-app";
      readonly appId?: string;
      readonly installationId?: string;
      readonly privateKeyPath?: string;
    };

export type RedskilledGithubCredentialProfiles = Readonly<
  Record<string, RedskilledGithubCredentialProfileDeclaration>
>;

export type RedskilledGithubCredentialProfileRefusalReason =
  | "unknown-profile"
  | "missing-credentials"
  | "invalid-credentials"
  | "scope-incompatible"
  | "invalid-project-binding"
  | "project-credential-forbidden";

export interface RedskilledGithubCredentialProfileRefusal {
  readonly version: 1;
  readonly kind: "github-credential-profile";
  readonly reason: RedskilledGithubCredentialProfileRefusalReason;
  readonly credential_profile: string;
}

/** A public, typed, deliberately secret-free credential refusal. */
export class RedskilledGithubCredentialProfileError extends Error {
  readonly refusal: RedskilledGithubCredentialProfileRefusal;

  constructor(reason: RedskilledGithubCredentialProfileRefusalReason, profile: string) {
    const safeProfile = publishableProfile(profile)
      ? profile
      : DEFAULT_REDSKILLED_GITHUB_CREDENTIAL_PROFILE;
    super(credentialRefusalMessage(reason, safeProfile));
    this.name = "RedskilledGithubCredentialProfileError";
    this.refusal = {
      version: 1,
      kind: "github-credential-profile",
      reason,
      credential_profile: safeProfile,
    };
  }
}

export interface CreateRedskilledGithubCredentialProfileResolverOptions {
  readonly profiles: RedskilledGithubCredentialProfiles;
  readonly resolvePersonal: () => { readonly token: string } | null;
  readonly homeDir?: string;
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  readonly mintInstallationToken?: (app: GithubAppCredential) => Promise<string>;
  readonly readProjectProfile?: (workspacePath: string) => Promise<string>;
}

/**
 * Resolve one Project's named profile on every request.
 *
 * Re-reading both Project config and the backend credential is intentional:
 * tracked bindings and daemon-local credentials can rotate without restarting
 * the daemon, and an App installation token is never retained past one ask.
 */
export function createRedskilledGithubCredentialProfileResolver(
  options: CreateRedskilledGithubCredentialProfileResolverOptions,
): (
  project: Omit<RedskilledGithubProjectAuthority, "credentialProfile">,
) => Promise<RedskilledGithubCredentialSelection> {
  const readProfile = options.readProjectProfile ?? readProjectGithubCredentialProfile;
  const mint = options.mintInstallationToken ?? ((app: GithubAppCredential) =>
    mintGithubInstallationToken(app, {
      ...(options.origin == null ? {} : { origin: options.origin }),
      ...(options.fetchImpl == null ? {} : { fetchImpl: options.fetchImpl }),
    }));

  return async (project) => {
    const profile = await readProfile(project.workspacePath);
    const declaration = options.profiles[profile] ??
      (profile === DEFAULT_REDSKILLED_GITHUB_CREDENTIAL_PROFILE
        ? { kind: "personal" as const }
        : undefined);
    if (declaration == null) throw new RedskilledGithubCredentialProfileError("unknown-profile", profile);

    if (declaration.kind === "personal") {
      const personal = options.resolvePersonal();
      const secret = personal?.token.trim() ?? "";
      if (secret === "") throw new RedskilledGithubCredentialProfileError("missing-credentials", profile);
      return { profile, credential: { secret } };
    }

    const app = githubAppCredential(declaration, profile, options.homeDir);
    try {
      const secret = (await mint(app)).trim();
      if (secret === "") throw new Error("empty installation credential");
      return { profile, credential: { secret } };
    } catch {
      throw new RedskilledGithubCredentialProfileError("invalid-credentials", profile);
    }
  };
}

/** Read only the public profile binding from tracked Project config. */
export async function readProjectGithubCredentialProfile(workspacePath: string): Promise<string> {
  let document: unknown;
  try {
    document = parse(await readFile(join(workspacePath, ".red", "config.yaml"), "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_REDSKILLED_GITHUB_CREDENTIAL_PROFILE;
    }
    throw new RedskilledGithubCredentialProfileError(
      "invalid-project-binding",
      DEFAULT_REDSKILLED_GITHUB_CREDENTIAL_PROFILE,
    );
  }

  const github = mappingAt(document, ["plugins", "dev", "github"]);
  const forbidden = Object.keys(github).find((key) => PROJECT_CREDENTIAL_KEY.test(key));
  if (forbidden != null) {
    throw new RedskilledGithubCredentialProfileError(
      "project-credential-forbidden",
      profileScalar(github.credential_profile) ?? DEFAULT_REDSKILLED_GITHUB_CREDENTIAL_PROFILE,
    );
  }
  if (github.credential_profile == null) return DEFAULT_REDSKILLED_GITHUB_CREDENTIAL_PROFILE;
  const profile = profileScalar(github.credential_profile);
  if (profile == null || !publishableProfile(profile)) {
    throw new RedskilledGithubCredentialProfileError(
      "invalid-project-binding",
      DEFAULT_REDSKILLED_GITHUB_CREDENTIAL_PROFILE,
    );
  }
  return profile;
}

/** Turn an upstream authorization failure into the same typed ACP-safe shape. */
export function githubCredentialScopeRefusal(profile: string): RedskilledGithubCredentialProfileError {
  return new RedskilledGithubCredentialProfileError("scope-incompatible", profile);
}

function githubAppCredential(
  declaration: Extract<RedskilledGithubCredentialProfileDeclaration, { kind: "github-app" }>,
  profile: string,
  homeDir: string | undefined,
): GithubAppCredential {
  const appId = declaration.appId?.trim() ?? "";
  const installationId = declaration.installationId?.trim() ?? "";
  const statedPath = declaration.privateKeyPath?.trim() ?? "";
  if (appId === "" || installationId === "" || statedPath === "") {
    throw new RedskilledGithubCredentialProfileError("missing-credentials", profile);
  }
  const privateKeyPath = statedPath.startsWith("~/") && homeDir != null
    ? join(homeDir, statedPath.slice(2))
    : statedPath;
  return { appId, installationId, privateKeyPath };
}

function profileScalar(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function mappingAt(value: unknown, path: readonly string[]): Readonly<Record<string, unknown>> {
  let current = value;
  for (const key of path) {
    if (!isMapping(current)) return {};
    current = current[key];
  }
  return isMapping(current) ? current : {};
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publishableProfile(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

const PROJECT_CREDENTIAL_KEY = /^(?:token|secret|credential|pem|private[_-]?key|app_id|installation_id)$/i;

function credentialRefusalMessage(
  reason: RedskilledGithubCredentialProfileRefusalReason,
  profile: string,
): string {
  const named = `GitHub credential profile ${JSON.stringify(profile)}`;
  if (reason === "unknown-profile") return `${named} is not declared by redskilled host config`;
  if (reason === "missing-credentials") return `${named} has no resolvable daemon-owned credentials`;
  if (reason === "invalid-credentials") return `${named} could not resolve valid daemon-owned credentials`;
  if (reason === "scope-incompatible") return `${named} is not authorized for this Project request`;
  if (reason === "project-credential-forbidden") return "Project config may select a GitHub credential profile but may not contain credential material";
  return "Project config has an invalid GitHub credential profile binding";
}
