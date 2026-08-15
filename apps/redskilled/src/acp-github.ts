import { RequestError } from "@agentclientprotocol/sdk";
import { GithubBackpressureError } from "@reddb-io/github";
import {
  RedskilledGithubAuthorityError,
  type RedskilledGithubGatewayRegistration,
  type RedskilledGithubRead,
} from "./github-gateway.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";

type GithubReadParams = { readonly read: RedskilledGithubRead };

/** Bind one ACP connection's Project authority to the daemon-owned gateway. */
export function bindAcpProjectGithubRead(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  projectForConnection: () => AcpProjectWorkspace,
) {
  return async ({ params: { read } }: { readonly params: GithubReadParams }) => {
    const project = projectForConnection();
    const selection = gateway?.credentialForProject({
      projectId: project.projectId,
      projectLabel: project.projectLabel,
      workspacePath: project.workspacePath,
    });
    if (gateway == null || selection == null) {
      throw RequestError.invalidRequest("this Project has no daemon-owned GitHub credential profile");
    }
    try {
      return await gateway.gateway.forProject({
        projectId: project.projectId,
        projectLabel: project.projectLabel,
        workspacePath: project.workspacePath,
        credentialProfile: selection.profile,
      }, selection.credential).read(read);
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
