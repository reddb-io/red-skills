import { RequestError } from "@agentclientprotocol/sdk";
import { GithubBackpressureError } from "@reddb-io/github";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";
import {
  RedskilledGithubAuthorityError,
  type RedskilledGithubGatewayRegistration,
  type RedskilledGithubCustodyHandoff,
  type RedskilledGithubCustodyRecord,
  type RedskilledGithubCustodyStatus,
  type RedskilledGithubManagedProjectReader,
  type RedskilledGithubProjectReader,
  type RedskilledGithubRead,
  type RedskilledGithubUpdate,
  type RedskilledGithubWriteRequest,
} from "./github-gateway.js";
import {
  githubRequestAnswer,
  githubRequestParams,
  planGithubRequest,
  type RedskilledGithubRequestAnswer,
} from "./github-request.js";
import {
  redskillsAcpMethod,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import { RedskilledGithubCredentialProfileError } from "./github-credential-profiles.js";

type GithubReadParams = { readonly read: RedskilledGithubRead };
type GithubWriteParams = RedskilledGithubWriteRequest;
type GithubCustodyHandoffParams = RedskilledGithubCustodyHandoff;
type GithubRequestParams = ReturnType<typeof githubRequestParams>;

export const REDSKILLED_GITHUB_UPDATE_METHOD = REDSKILLS_ACP_METHODS.githubUpdate;

export interface AcpGithubDomainDeps {
  readonly gateway: RedskilledGithubGatewayRegistration | undefined;
  /** The Project this ACP connection bound; every method is scoped to it. */
  readonly scopedProject: () => AcpProjectWorkspace;
  /** Observe the reader the first read resolves, to stream its updates. */
  readonly onReader?: (reader: unknown) => void;
}

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

/**
 * Run one operation under this connection's Project against the daemon-owned
 * gateway, with the two refusals every credential-bound method owes a caller:
 * an unresolvable profile is an authorization answer, and upstream backpressure
 * is a dated retry rather than an opaque failure.
 */
async function servedByProjectReader<T>(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  project: AcpProjectWorkspace,
  onReader: ((reader: unknown) => void) | undefined,
  run: (reader: RedskilledGithubProjectReader) => Promise<T>,
): Promise<T> {
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
      return await run(reader);
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
}

/**
 * One Ticket's body, read through the Project gateway for the demand brief.
 *
 * The unattended posture forbids the inner agent GitHub access (#4227), so a
 * brief that named only number+title made the agent implement blind — the
 * first autonomous landed shipped a guess (#4243). The daemon holds the
 * credential; it reads the body and hands it over. `null` on any failure:
 * a brief without a body is degraded, never fatal.
 */
export async function readProjectTicketBody(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  project: AcpProjectWorkspace,
  issue: number,
): Promise<string | null> {
  try {
    const answer = await servedByProjectReader(gateway, project, undefined, (reader) =>
      reader.read({ kind: "rest", path: `repos/${project.projectLabel}/issues/${issue}` }));
    const body = (answer as { value?: { body?: unknown } } | null)?.value?.body;
    return typeof body === "string" && body.trim() !== "" ? body : null;
  } catch {
    return null;
  }
}

/** Bind one ACP connection's Project authority to the daemon-owned gateway. */
export function bindAcpProjectGithubRead(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  projectForConnection: () => AcpProjectWorkspace,
  onReader?: (reader: unknown) => void,
) {
  return async ({ params: { read } }: { readonly params: GithubReadParams }) => {
    const project = projectForConnection();
    return await servedByProjectReader(gateway, project, onReader, (reader) => reader.read(read));
  };
}

/**
 * Bind the forge-shaped passthrough `rs_github` forwards.
 *
 * One method serves both directions because a caller composing a request has
 * not yet decided which it is — the PATH and the METHOD decide, and the
 * translation decides them once, here. An observing request joins the gateway's
 * existing demand for that read, so two sessions asking the same question at
 * the same moment cost one upstream call; a mutating one is scheduled through
 * the durable outbox under a key derived from the request itself.
 */
export function bindAcpProjectGithubRequest(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  projectForConnection: () => AcpProjectWorkspace,
  onReader?: (reader: unknown) => void,
) {
  return async (
    { params: { request } }: { readonly params: GithubRequestParams },
  ): Promise<RedskilledGithubRequestAnswer> => {
    const project = projectForConnection();
    return await servedByProjectReader(gateway, project, onReader, async (reader) => {
      const plan = planGithubRequest(project.projectLabel, request);
      return plan.mode === "read"
        ? githubRequestAnswer(request.method, plan.path, {
            mode: "read",
            answer: await reader.read(plan.read),
          })
        : githubRequestAnswer(request.method, plan.path, {
            mode: "write",
            answer: await reader.write(plan.write),
          });
    });
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

/** Transfer a published PR to daemon custody under this connection's Project. */
export function bindAcpProjectGithubCustodyHandoff(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  projectForConnection: () => AcpProjectWorkspace,
) {
  return async ({ params }: { readonly params: GithubCustodyHandoffParams }): Promise<RedskilledGithubCustodyRecord> => {
    const { reader } = await custodyReader(gateway, projectForConnection());
    return reader.handoffMergeCustody(params);
  };
}

/** Read custody through ACP without making the observing client an owner. */
export function bindAcpProjectGithubCustodyStatus(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  projectForConnection: () => AcpProjectWorkspace,
) {
  return async (): Promise<RedskilledGithubCustodyStatus | undefined> => {
    if (gateway == null) return undefined;
    const project = projectForConnection();
    let selection;
    try {
      selection = await gateway.credentialForProject({
        projectId: project.projectId,
        projectLabel: project.projectLabel,
        workspacePath: project.workspacePath,
      });
    } catch (error) {
      // Project control remains observable when optional GitHub custody has no
      // usable credential profile. Credential-bound custody mutations still
      // return their typed authorization refusal through their own methods.
      if (error instanceof RedskilledGithubCredentialProfileError) return undefined;
      throw error;
    }
    if (selection == null) return undefined;
    const reader = gateway.gateway.forProject({
      projectId: project.projectId,
      projectLabel: project.projectLabel,
      workspacePath: project.workspacePath,
      credentialProfile: selection.profile,
    }, selection.credential);
    return isCustodyReader(reader) ? reader.mergeCustodyStatus() : undefined;
  };
}

async function custodyReader(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  project: AcpProjectWorkspace,
): Promise<{
  readonly reader: RedskilledGithubManagedProjectReader;
}> {
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
  const reader = gateway.gateway.forProject({
    projectId: project.projectId,
    projectLabel: project.projectLabel,
    workspacePath: project.workspacePath,
    credentialProfile: selection.profile,
  }, selection.credential);
  if (!isCustodyReader(reader)) {
    throw new RedskilledGithubAuthorityError("this GitHub gateway has no durable merge custodian");
  }
  return { reader };
}

function isCustodyReader(value: unknown): value is RedskilledGithubManagedProjectReader {
  return value != null && typeof value === "object" &&
    typeof (value as RedskilledGithubManagedProjectReader).handoffMergeCustody === "function" &&
    typeof (value as RedskilledGithubManagedProjectReader).mergeCustodyStatus === "function";
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

/** Reject caller-controlled Project and credential authority on custody handoff. */
export function githubCustodyHandoffParams(value: unknown): GithubCustodyHandoffParams {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new RedskilledGithubAuthorityError("merge custody needs one pull request handoff");
  }
  const params = value as Record<string, unknown>;
  const expected = ["pull_request", "owner_ticket", "branch", "base"];
  if (Object.keys(params).length !== expected.length || expected.some((key) => !(key in params))) {
    throw new RedskilledGithubAuthorityError(
      "a Project merge custody handoff cannot name a Project, credential profile, remote, or host operation",
    );
  }
  return params as unknown as GithubCustodyHandoffParams;
}

/**
 * The `github` domain: the Project-bound gateway's three request methods and
 * the one notification it advertises.
 *
 * The domain is only present when the daemon actually registered a gateway.
 * Advertising the methods with no gateway behind them would answer every call
 * with the same authorization refusal, which reads to a client as "your
 * credentials are wrong" when the truth is "this daemon has no forge at all".
 */
export function githubMethodDomain(deps: AcpGithubDomainDeps): RedskillsAcpMethodDomain {
  const readGithub = bindAcpProjectGithubRead(deps.gateway, deps.scopedProject, deps.onReader);
  const requestGithub = bindAcpProjectGithubRequest(deps.gateway, deps.scopedProject, deps.onReader);
  const writeGithub = bindAcpProjectGithubWrite(deps.gateway, deps.scopedProject);
  const handoffCustody = bindAcpProjectGithubCustodyHandoff(deps.gateway, deps.scopedProject);
  return {
    domain: "github",
    bindings: [
      redskillsAcpMethod(REDSKILLS_ACP_METHODS.githubRead, githubReadParams, readGithub),
      redskillsAcpMethod(REDSKILLS_ACP_METHODS.githubRequest, githubRequestParams, requestGithub),
      redskillsAcpMethod(REDSKILLS_ACP_METHODS.githubWrite, githubWriteParams, writeGithub),
      redskillsAcpMethod(
        REDSKILLS_ACP_METHODS.githubCustodyHandoff,
        githubCustodyHandoffParams,
        handoffCustody,
      ),
    ],
    ...(deps.gateway == null ? {} : {
      capability: {
        githubGateway: {
          version: 1,
          methods: [
            REDSKILLS_ACP_METHODS.githubRead,
            REDSKILLS_ACP_METHODS.githubRequest,
            REDSKILLS_ACP_METHODS.githubWrite,
            REDSKILLS_ACP_METHODS.githubCustodyHandoff,
          ],
          notifications: [REDSKILLED_GITHUB_UPDATE_METHOD],
        },
      },
    }),
  };
}
