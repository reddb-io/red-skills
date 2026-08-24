// acp-publication — the daemon publishes and lands on Worker request (#4019).
//
// ADR 0144 §3: no GitHub credential reaches the process that runs the model.
// The Worker's terminal policy refuses `git push` and `gh` (#4016), and this
// module is the promise that refusal made. A Worker names the branch and the
// commit its turn produced; the daemon — holding the Project's credential
// profile, its canonical workspace and its remote — performs the write.
//
// The methods are bound on the WORKER-facing connection, not on the public
// control plane, which is why the `publication` domain is declared unserved.
// Who is asking is therefore answered by the socket rather than by the params:
// a `worker_id` a caller could spell would let any peer publish as any Worker,
// and that is the one authority this module exists to hold.
//
// **The objects have to be delivered before they can be pushed.** A Worker's
// Worktree is a CLONE of the Project workspace (ADR 0149 §1,
// `materializeWorkerWorkspace`), not a linked worktree, so the commit it names
// does not exist in the repository the push runs from. Publication fetches the
// branch into a `refs/redskilled/publications/` ref first and refuses when the
// named commit still is not there — a push that skipped that step would fail
// deep inside git on a sha the remote has never heard of.
//
// **Landing arms custody; it never awaits a merge.** The land method opens the
// pull request and hands "this pull request ends merged" to the Queue Custodian,
// which outlives the Worker. A landing that waited would hold a Worker — and
// its workspace, its budget and its host slot — open for the length of review.
import { execFile } from "node:child_process";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  REDSKILLS_ACP_METHODS,
  type RedskilledLandAnswer,
  type RedskilledLandRequest,
  type RedskilledPublishAnswer,
  type RedskilledPublishRequest,
} from "@reddb-io/protocol-acp";
import {
  redskillsAcpMethod,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import { RedskilledGithubCredentialProfileError } from "./github-credential-profiles.js";
import {
  RedskilledGithubAuthorityError,
  credentialForAcpProject,
  type RedskilledGithubCredentialSelection,
  type RedskilledGithubGatewayRegistration,
  type RedskilledGithubManagedProjectReader,
  type RedskilledGithubProjectReader,
} from "./github-gateway.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";

/** How long a local object delivery may take before publication gives up. */
const DELIVERY_TIMEOUT_MS = 120_000;

/** A full object name, which is what `git rev-parse HEAD` in a Worktree gives. */
const OBJECT_NAME = /^[0-9a-f]{40}$/;

/**
 * One ordinary branch name, spelled the same way the write outbox spells it.
 *
 * Restated rather than imported because the two checks answer different
 * questions at different depths: the outbox refuses a malformed write, and this
 * refuses a malformed REQUEST before a Worker's objects are moved for it. The
 * pattern is deliberately identical so a branch cannot pass one and fail the
 * other, which would be a publication that fetched and then refused.
 */
const ORDINARY_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * One Worker the daemon still holds, seen from the publication seam.
 *
 * `worktreePath` is the daemon's own record of where it materialised this
 * Worker, never something the Worker told it — which is what makes "publish
 * what I committed" safe to answer at all.
 */
export interface RedskilledPublicationWorker {
  readonly workerId: string;
  readonly worktreePath: string;
  readonly project: AcpProjectWorkspace;
}

/** One local object transfer, from a Worker's clone into the Project workspace. */
export interface RedskilledPublicationDelivery {
  readonly workerId: string;
  readonly worktreePath: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly commit: string;
}

export interface AcpPublicationDeps {
  readonly gateway: RedskilledGithubGatewayRegistration | undefined;
  /**
   * The Worker on the other end, while the daemon still holds it.
   *
   * `undefined` is the refusal: a Worker already reaped has no workspace to
   * read, no budget to charge and nobody left to answer for what it publishes.
   */
  readonly held: () => RedskilledPublicationWorker | undefined;
  /** Test seam over the local fetch. Production moves real objects. */
  readonly deliver?: (delivery: RedskilledPublicationDelivery) => Promise<void>;
}

/** Push what a Worker's turn committed, under the Project's credential profile. */
export function bindAcpWorkerPublish(deps: AcpPublicationDeps) {
  const deliver = deps.deliver ?? deliverWorkerCommit;
  return async (
    { params }: { readonly params: RedskilledPublishRequest },
  ): Promise<RedskilledPublishAnswer> => {
    const worker = requireHeldWorker(deps.held());
    const reader = await projectReader(deps.gateway, worker.project);
    await deliver({
      workerId: worker.workerId,
      worktreePath: worker.worktreePath,
      workspacePath: worker.project.workspacePath,
      branch: params.branch,
      commit: params.commit,
    });
    const published = await reader.write({
      idempotency_key: params.idempotency_key,
      // Fully qualified on the way out: the Worker names the branch it is on,
      // and only a `refs/heads/` ref says which namespace that is on a remote.
      write: { kind: "repository-push", ref: `refs/heads/${params.branch}`, sha: params.commit },
    });
    return {
      version: 1,
      worker_id: worker.workerId,
      branch: params.branch,
      commit: params.commit,
      published_at: published.published_at,
    };
  };
}

/** Open the pull request for a published branch and hand its merge to custody. */
export function bindAcpWorkerLand(deps: AcpPublicationDeps) {
  return async (
    { params }: { readonly params: RedskilledLandRequest },
  ): Promise<RedskilledLandAnswer> => {
    const worker = requireHeldWorker(deps.held());
    const reader = await projectReader(deps.gateway, worker.project);
    const opened = await reader.write({
      idempotency_key: params.idempotency_key,
      write: {
        kind: "pull-request",
        head: params.branch,
        base: params.base,
        title: params.title,
        body: params.body,
      },
    });
    const pullRequest = pullRequestNumber(opened.value);
    // The handoff RECORDS the obligation and returns. Whether the pull request
    // ends merged is the Queue Custodian's question, asked on its own tick.
    const custody = await custodian(reader).handoffMergeCustody({
      pull_request: pullRequest,
      owner_ticket: params.owner_ticket,
      branch: params.branch,
      base: params.base,
      armed_head: params.commit,
    });
    return {
      version: 1,
      worker_id: worker.workerId,
      pull_request: pullRequest,
      branch: params.branch,
      base: params.base,
      custody_state: custody.state,
      handed_off_at: custody.handed_off_at,
    };
  };
}

/** Reject caller-controlled Project, credential, remote and Worker authority. */
export function publishParams(value: unknown): RedskilledPublishRequest {
  const params = exactly(value, ["idempotency_key", "branch", "commit"], "a Worker publication");
  const commit = params.commit;
  if (typeof commit !== "string" || !OBJECT_NAME.test(commit)) {
    throw new RedskilledGithubAuthorityError("a Worker publication names one full commit object name");
  }
  return {
    idempotency_key: text(params.idempotency_key, "idempotency key"),
    branch: branchName(params.branch),
    commit,
  };
}

/** Reject caller-controlled Project, credential, remote and Worker authority. */
export function landParams(value: unknown): RedskilledLandRequest {
  const params = exactly(
    value,
    ["idempotency_key", "branch", "commit", "base", "title", "body", "owner_ticket"],
    "a Worker landing",
  );
  const ticket = params.owner_ticket;
  if (typeof ticket !== "number" || !Number.isSafeInteger(ticket) || ticket <= 0) {
    throw new RedskilledGithubAuthorityError("a Worker landing names the Ticket that inherits the merge");
  }
  const commit = params.commit;
  if (typeof commit !== "string" || !OBJECT_NAME.test(commit)) {
    throw new RedskilledGithubAuthorityError("a Worker landing names the full commit object name its publish carried");
  }
  return {
    idempotency_key: text(params.idempotency_key, "idempotency key"),
    branch: branchName(params.branch),
    commit,
    base: branchName(params.base),
    title: text(params.title, "title"),
    body: text(params.body, "body"),
    owner_ticket: ticket,
  };
}

/**
 * The `publication` domain: the two methods a Worker asks its parent for.
 *
 * It advertises no capability and is bound on the Worker connection rather than
 * on the public control plane, so `REDSKILLS_ACP_METHOD_DOMAINS` declares it
 * unserved. A client that could call these would be publishing as a Worker the
 * daemon holds, and the connection is the only honest proof of which one.
 */
export function publicationMethodDomain(deps: AcpPublicationDeps): RedskillsAcpMethodDomain {
  return {
    domain: "publication",
    bindings: [
      redskillsAcpMethod(REDSKILLS_ACP_METHODS.publish, publishParams, bindAcpWorkerPublish(deps)),
      redskillsAcpMethod(REDSKILLS_ACP_METHODS.land, landParams, bindAcpWorkerLand(deps)),
    ],
  };
}

function requireHeldWorker(
  worker: RedskilledPublicationWorker | undefined,
): RedskilledPublicationWorker {
  if (worker != null) return worker;
  throw RequestError.invalidRequest(
    { version: 1, kind: "worker-not-held" },
    "redskilled does not hold the Worker this publication came from",
  );
}

async function projectReader(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  project: AcpProjectWorkspace,
): Promise<RedskilledGithubProjectReader> {
  let selection: RedskilledGithubCredentialSelection | null | undefined;
  try {
    selection = await credentialForAcpProject(gateway, project);
  } catch (error) {
    if (error instanceof RedskilledGithubCredentialProfileError) {
      throw RequestError.authRequired(error.refusal, error.message);
    }
    throw error;
  }
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
  return gateway.gateway.forProject({
    projectId: project.projectId,
    projectLabel: project.projectLabel,
    workspacePath: project.workspacePath,
    credentialProfile: selection.profile,
  }, selection.credential);
}

function custodian(reader: RedskilledGithubProjectReader): RedskilledGithubManagedProjectReader {
  const managed = reader as RedskilledGithubManagedProjectReader;
  if (typeof managed.handoffMergeCustody !== "function") {
    throw new RedskilledGithubAuthorityError("this GitHub gateway has no durable merge custodian");
  }
  return managed;
}

function pullRequestNumber(value: unknown): number {
  const number = (value as { readonly number?: unknown } | null)?.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new RedskilledGithubAuthorityError(
      "the opened pull request answered with no number to take custody of",
    );
  }
  return number;
}

/**
 * Move the Worker's branch into the Project workspace, then prove the commit landed.
 *
 * The fetch names the BRANCH rather than the commit because a bare object name
 * is only fetchable from a repository configured to serve one, and a Worker's
 * clone is not. The `cat-file` afterwards is what turns "the fetch reported
 * success" into "the object the caller named is here".
 */
async function deliverWorkerCommit(delivery: RedskilledPublicationDelivery): Promise<void> {
  const destination = `refs/redskilled/publications/${delivery.workerId}/${delivery.branch}`;
  await git(delivery.workspacePath, [
    "fetch",
    "--no-tags",
    "--quiet",
    "--",
    delivery.worktreePath,
    `+refs/heads/${delivery.branch}:${destination}`,
  ]);
  await git(delivery.workspacePath, ["cat-file", "-e", `${delivery.commit}^{commit}`]);
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: DELIVERY_TIMEOUT_MS,
      windowsHide: true,
    }, (error, _stdout, stderr) => {
      if (error == null) {
        resolve();
        return;
      }
      reject(new RedskilledGithubAuthorityError(
        `redskilled could not deliver the Worker's publication: ${String(stderr).trim() || error.message}`,
      ));
    });
  });
}

function exactly(
  value: unknown,
  keys: readonly string[],
  subject: string,
): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new RedskilledGithubAuthorityError(`${subject} needs one request object`);
  }
  const params = value as Record<string, unknown>;
  if (Object.keys(params).length !== keys.length || keys.some((key) => !(key in params))) {
    throw new RedskilledGithubAuthorityError(
      `${subject} cannot name a Project, credential profile, remote, Worker, or host operation`,
    );
  }
  return params;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RedskilledGithubAuthorityError(`a Worker publication needs a ${field}`);
  }
  return value;
}

/**
 * A branch name safe to interpolate into a refspec and hand to `git`.
 *
 * The Worker read this from its own `rev-parse --abbrev-ref HEAD`, so the check
 * is less distrust of the name than of the SOCKET: a leading `-` would be read
 * by git as an option rather than as a ref, which is how a refspec turns into
 * an argument nobody meant to pass.
 */
function branchName(value: unknown): string {
  const branch = text(value, "branch");
  const refused = !ORDINARY_BRANCH.test(branch) || branch.includes("..") || branch.includes("//") ||
    branch.endsWith(".") || branch.endsWith("/") || branch.includes("@{");
  if (refused) {
    throw new RedskilledGithubAuthorityError(
      `${JSON.stringify(branch)} is not a branch redskilled can publish`,
    );
  }
  return branch;
}
