import type {
  RedskilledGithubCredential,
  RedskilledGithubGateway,
  RedskilledGithubProjectAuthority,
} from "./github-gateway.js";

export interface RedskilledGithubCredentialSelection {
  readonly profile: string;
  readonly credential: RedskilledGithubCredential;
}

export interface RedskilledGithubGatewayRegistration {
  readonly gateway: RedskilledGithubGateway;
  readonly credentialForProfile?: (
    profile: string,
  ) => RedskilledGithubCredential | null | Promise<RedskilledGithubCredential | null>;
  readonly credentialForProject: (
    project: Omit<RedskilledGithubProjectAuthority, "credentialProfile">,
  ) => RedskilledGithubCredentialSelection | null | Promise<RedskilledGithubCredentialSelection | null>;
}

/** Resolve the daemon-bound profile before considering checkout policy. */
export async function credentialForAcpProject(
  registration: RedskilledGithubGatewayRegistration | undefined,
  project: {
    readonly projectId: string;
    readonly projectLabel: string;
    readonly workspacePath: string;
    readonly credentialProfile?: string;
  },
): Promise<RedskilledGithubCredentialSelection | null> {
  if (registration == null) return null;
  if (project.credentialProfile != null) {
    const credential = await registration.credentialForProfile?.(project.credentialProfile);
    return credential == null ? null : { profile: project.credentialProfile, credential };
  }
  return await registration.credentialForProject({
    projectId: project.projectId,
    projectLabel: project.projectLabel,
    workspacePath: project.workspacePath,
  });
}
