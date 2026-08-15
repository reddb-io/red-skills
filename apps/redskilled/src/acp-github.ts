import { RequestError } from "@agentclientprotocol/sdk";
import { GithubBackpressureError } from "@reddb-io/github";
import {
  RedskilledGithubAuthorityError,
  type RedskilledGithubGatewayRegistration,
  type RedskilledGithubManagedProjectReader,
  type RedskilledGithubRead,
  type RedskilledGithubUpdate,
  type RedskilledGithubWriteRequest,
} from "./github-gateway.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import { RedskilledGithubCredentialProfileError } from "./github-credential-profiles.js";

type GithubReadParams = { readonly read: RedskilledGithubRead };
type GithubWriteParams = RedskilledGithubWriteRequest;

export const REDSKILLED_GITHUB_UPDATE_METHOD = "_redskills/github_update";

export interface AcpGithubUpdateObserver {
  close(): void;
  settled(): Promise<void>;
}

/**
 * Project-bind a gateway observer and serialize its custom ACP notification.
 * The notification contains refreshed public state only; credential selection
 * and webhook transport remain private daemon concerns.
 */
export async function bindAcpProjectGithubUpdates(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  project: AcpProjectWorkspace,
  notify: (method: typeof REDSKILLED_GITHUB_UPDATE_METHOD, update: RedskilledGithubUpdate) => Promise<void>,
): Promise<AcpGithubUpdateObserver> {
  const selection = await gateway?.credentialForProject({
    projectId: project.projectId,
    projectLabel: project.projectLabel,
    workspacePath: project.workspacePath,
  });
  if (gateway == null || selection == null) return emptyObserver();
  const reader = gateway.gateway.forProject({
    projectId: project.projectId,
    projectLabel: project.projectLabel,
    workspacePath: project.workspacePath,
    credentialProfile: selection.profile,
  }, selection.credential);
  return bindAcpGithubReaderUpdates(reader, notify);
}

export function bindAcpGithubReaderUpdates(
  reader: unknown,
  notify: (method: typeof REDSKILLED_GITHUB_UPDATE_METHOD, update: RedskilledGithubUpdate) => Promise<void>,
): AcpGithubUpdateObserver {
  if (!isManagedReader(reader)) return emptyObserver();

  let tail = Promise.resolve();
  const unsubscribe = reader.subscribe((update) => {
    tail = tail.then(() => notify(REDSKILLED_GITHUB_UPDATE_METHOD, update)).catch(() => undefined);
  });
  return {
    close: unsubscribe,
    settled: () => tail,
  };
}

function isManagedReader(value: unknown): value is RedskilledGithubManagedProjectReader {
  return value != null && typeof value === "object" &&
    typeof (value as RedskilledGithubManagedProjectReader).subscribe === "function";
}

function emptyObserver(): AcpGithubUpdateObserver {
  return { close: () => undefined, settled: async () => undefined };
}

/** Bind one ACP connection's Project authority to the daemon-owned gateway. */
export function bindAcpProjectGithubRead(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  projectForConnection: () => AcpProjectWorkspace,
  onReader?: (reader: unknown) => void,
) {
  return async ({ params: { read } }: { readonly params: GithubReadParams }) => {
    const project = projectForConnection();
    try {
      const selection = await gateway?.credentialForProject({
        projectId: project.projectId,
        projectLabel: project.projectLabel,
        workspacePath: project.workspacePath,
      });
      if (gateway == null || selection == null) {
        throw RequestError.authRequired(
          {
            version: 1,
            kind: "github-credential-profile",
            reason: "missing-credentials",
            credential_profile: "personal",
          },
          "this Project has no resolvable daemon-owned GitHub credential profile",
        );
      }
      try {
        const reader = gateway.gateway.forProject({
          projectId: project.projectId,
          projectLabel: project.projectLabel,
          workspacePath: project.workspacePath,
          credentialProfile: selection.profile,
        }, selection.credential);
        onReader?.(reader);
        return await reader.read(read);
      } catch (error) {
        if (!(error instanceof GithubBackpressureError)) throw error;
        throw new RequestError(-32001, error.message, {
          version: 1,
          kind: "github-backpressure",
          project_id: project.projectId,
          credential_profile: selection.profile,
          retry_at: error.fact.retry_at,
          fact: error.fact,
        });
      }
    } catch (error) {
      if (error instanceof RedskilledGithubCredentialProfileError) {
        throw RequestError.authRequired(error.refusal, error.message);
      }
      throw error;
    }
  };
}

/** Bind one ACP connection to durable publication under its resolved Project. */
export function bindAcpProjectGithubWrite(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  projectForConnection: () => AcpProjectWorkspace,
) {
  return async ({ params }: { readonly params: GithubWriteParams }) => {
    const project = projectForConnection();
    try {
      const selection = await gateway?.credentialForProject({
        projectId: project.projectId,
        projectLabel: project.projectLabel,
        workspacePath: project.workspacePath,
      });
      if (gateway == null || selection == null) {
        throw RequestError.authRequired(
          {
            version: 1,
            kind: "github-credential-profile",
            reason: "missing-credentials",
            credential_profile: "personal",
          },
          "this Project has no resolvable daemon-owned GitHub credential profile",
        );
      }
      return await gateway.gateway.forProject({
        projectId: project.projectId,
        projectLabel: project.projectLabel,
        workspacePath: project.workspacePath,
        credentialProfile: selection.profile,
      }, selection.credential).write(params);
    } catch (error) {
      if (error instanceof RedskilledGithubCredentialProfileError) {
        throw RequestError.authRequired(error.refusal, error.message);
      }
      throw error;
    }
  };
}

/** Reject caller-controlled Project, credential, remote, and host authority. */
export function githubReadParams(value: unknown): GithubReadParams {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new RedskilledGithubAuthorityError("a Project GitHub gateway request needs one read");
  }
  const params = value as Record<string, unknown>;
  if (Object.keys(params).length !== 1 || !("read" in params)) {
    throw new RedskilledGithubAuthorityError(
      "a Project GitHub request cannot name a Project, credential profile, remote, or host operation",
    );
  }
  if (params.read == null || typeof params.read !== "object" || Array.isArray(params.read)) {
    throw new RedskilledGithubAuthorityError("a Project GitHub gateway request needs one read object");
  }
  return { read: params.read as RedskilledGithubRead };
}

/** Reject caller-controlled Project, credential, remote, and host authority. */
export function githubWriteParams(value: unknown): GithubWriteParams {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new RedskilledGithubAuthorityError("a Project GitHub write needs one mutation");
  }
  const params = value as Record<string, unknown>;
  if (Object.keys(params).length !== 2 || !("idempotency_key" in params) || !("write" in params)) {
    throw new RedskilledGithubAuthorityError(
      "a Project GitHub write cannot name a Project, credential profile, remote, or host operation",
    );
  }
  if (params.write == null || typeof params.write !== "object" || Array.isArray(params.write)) {
    throw new RedskilledGithubAuthorityError("a Project GitHub write needs one mutation object");
  }
  return params as unknown as GithubWriteParams;
}
