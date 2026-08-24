// mobile-ticket-dispatch — one Issue URL becomes one atomically claimed Worker.
//
// This is the daemon side of ADR 0169's single input. The app does not name a
// Project, workspace, credential, runner or lane: redskilled resolves the
// canonical repository under the personal profile, provisions its clean
// workspace idempotently, validates and wins the Ticket claim, then and only
// then admits the Worker through the ordinary unattended turn.
import { randomUUID } from "node:crypto";
import {
  acquireClaim,
  renderClaimComment,
  type ClaimGh,
  type RawClaimComment,
} from "@reddb-io/worker/engine";
import type {
  MobileTicketDispatchAnswer,
  MobileTicketDispatchParams,
} from "@reddb-io/protocol-acp";

import type { DemandTurnRequest, DemandTurnResult } from "./acp-demand-turn.js";
import type {
  RedskilledGithubCredential,
  RedskilledGithubGatewayRegistration,
  RedskilledGithubProjectReader,
} from "./github-gateway.js";
import type { RedskilledHostState } from "./host-state.js";
import type { RedskilledPaths } from "./paths.js";
import {
  ensureRemoteAcpProjectWorkspace,
  type AcpProjectIdentity,
  type AcpProjectWorkspace,
} from "./project-workspace.js";
import { mintHostWorkerId } from "./worker-launch.js";

interface GithubIssueReference {
  readonly owner: string;
  readonly repository: string;
  readonly ticket: number;
  readonly slug: string;
}

interface GithubRepository {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly cloneUrl: string;
}

interface GithubTicket {
  readonly title: string;
  readonly labels: readonly string[];
}

export interface CreateMobileTicketDispatcherOptions {
  readonly paths: Pick<RedskilledPaths, "projectWorkspaceRoot">;
  readonly githubGateway?: RedskilledGithubGatewayRegistration;
  readonly hostState: () => RedskilledHostState;
  readonly runTurn: (request: DemandTurnRequest) => Promise<DemandTurnResult>;
  readonly workspaceForRemote?: (
    identity: AcpProjectIdentity,
    credential: RedskilledGithubCredential,
  ) => Promise<AcpProjectWorkspace>;
  readonly onTurnError?: (error: unknown) => void;
}

export function createMobileTicketDispatcher(options: CreateMobileTicketDispatcherOptions) {
  return async (params: MobileTicketDispatchParams): Promise<MobileTicketDispatchAnswer> => {
    const reference = parseMobileIssueUrl(params.issue_url);
    const registration = options.githubGateway;
    const credential = await registration?.credentialForProfile?.("personal");
    if (registration == null || credential == null) {
      throw new Error("Mobile dispatch requires the daemon-owned personal GitHub profile");
    }

    const pendingReader = registration.gateway.forProject({
      projectId: `github-pending:${reference.slug.toLowerCase()}`,
      projectLabel: reference.slug,
      workspacePath: options.paths.projectWorkspaceRoot,
      credentialProfile: "personal",
    }, credential);
    const repository = repositoryFrom(await pendingReader.read({
      kind: "rest",
      path: `repos/${reference.slug}`,
    }).then((answer) => answer.value));
    const identity: AcpProjectIdentity = {
      projectId: `github:${repository.id}`,
      projectLabel: repository.fullName,
      checkoutRoot: repository.cloneUrl,
      remoteUrl: repository.cloneUrl,
    };
    const provisioned = await (options.workspaceForRemote == null
      ? ensureRemoteAcpProjectWorkspace(identity, options.paths.projectWorkspaceRoot, credential.secret)
      : options.workspaceForRemote(identity, credential));
    const project: AcpProjectWorkspace = { ...provisioned, credentialProfile: "personal" };
    const reader = registration.gateway.forProject({
      projectId: project.projectId,
      projectLabel: project.projectLabel,
      workspacePath: project.workspacePath,
      credentialProfile: "personal",
    }, credential);
    const ticket = ticketFrom(await reader.read({
      kind: "rest",
      path: `repos/${repository.fullName}/issues/${reference.ticket}`,
    }).then((answer) => answer.value), reference.ticket);

    const workerId = mintHostWorkerId(options.hostState().workers.map((worker) => worker.worker_id));
    const claim = claimAdapter(reader, repository.fullName, workerId);
    const decision = await acquireClaim(claim, { worker: workerId }, reference.ticket);
    if (decision.verdict !== "won") {
      throw new Error(`Ticket #${reference.ticket} is already claimed by ${decision.winner ?? "another Worker"}`);
    }

    let admitted = false;
    let resolveBorn!: (workerId: string) => void;
    let rejectBorn!: (error: unknown) => void;
    const born = new Promise<string>((resolve, reject) => {
      resolveBorn = resolve;
      rejectBorn = reject;
    });
    const turn = options.runTurn({
      project,
      workerId,
      workItem: String(reference.ticket),
      prompt: `Implement GitHub Ticket #${reference.ticket} and satisfy every stated acceptance criterion.`,
      ticket: {
        number: reference.ticket,
        title: ticket.title,
        labels: [...ticket.labels],
        base: repository.defaultBranch,
        handoff: `Implement Ticket #${reference.ticket} and satisfy every stated acceptance criterion.`,
        worker_id: workerId,
        preclaimed: true,
      },
      onBorn: (bornWorkerId) => {
        admitted = true;
        resolveBorn(bornWorkerId);
      },
    });
    void turn.catch(async (error) => {
      if (!admitted) {
        await claim.concede(
          reference.ticket,
          renderClaimComment({ worker: workerId }, "concede", "released"),
        ).catch(() => undefined);
        rejectBorn(error);
      }
      options.onTurnError?.(error);
    });
    const bornWorkerId = await born;
    return {
      version: 1,
      repository: repository.fullName,
      ticket: reference.ticket,
      worker_id: bornWorkerId,
    };
  };
}

export function parseMobileIssueUrl(value: string): GithubIssueReference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Mobile dispatch requires a valid GitHub Issue URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const ticket = Number(parts[3]);
  if (
    url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" ||
    parts.length !== 4 || parts[2] !== "issues" || !Number.isSafeInteger(ticket) || ticket <= 0 ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0] ?? "") || !/^[A-Za-z0-9_.-]+$/.test(parts[1] ?? "") ||
    url.search !== "" || url.hash !== ""
  ) {
    throw new Error("Mobile dispatch accepts only https://github.com/owner/repository/issues/number");
  }
  return {
    owner: parts[0]!,
    repository: parts[1]!,
    ticket,
    slug: `${parts[0]}/${parts[1]}`,
  };
}

function repositoryFrom(value: unknown): GithubRepository {
  const record = asRecord(value, "GitHub returned no repository for this Issue URL");
  const id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id).trim() : "";
  const fullName = typeof record.full_name === "string" ? record.full_name.trim() : "";
  const defaultBranch = typeof record.default_branch === "string" ? record.default_branch.trim() : "";
  const cloneUrl = typeof record.clone_url === "string" ? record.clone_url.trim() : "";
  if (id === "" || !/^[^/]+\/[^/]+$/.test(fullName) || defaultBranch === "" || cloneUrl === "") {
    throw new Error("GitHub returned an incomplete canonical repository");
  }
  return { id, fullName, defaultBranch, cloneUrl };
}

function ticketFrom(value: unknown, number: number): GithubTicket {
  const record = asRecord(value, `GitHub returned no Ticket #${number}`);
  if (record.pull_request != null) throw new Error(`Ticket #${number} is a pull request, not an Issue`);
  if (String(record.state ?? "").toLowerCase() !== "open") throw new Error(`Ticket #${number} is not open`);
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const labels = Array.isArray(record.labels)
    ? record.labels.map((label) => typeof label === "string" ? label : asLabelName(label)).filter(Boolean)
    : [];
  if (title === "") throw new Error(`Ticket #${number} has no title`);
  if (labels.includes("type:spec")) throw new Error(`Ticket #${number} is a Spec, not executable work`);
  const blocker = labels.find((label) => label.startsWith("blocked:") || label === "ready-for-human");
  if (blocker != null) throw new Error(`Ticket #${number} is blocked by ${blocker}`);
  return { title, labels };
}

function claimAdapter(reader: RedskilledGithubProjectReader, repository: string, workerId: string): ClaimGh {
  let sequence = 0;
  const publish = async (issue: number, body: string): Promise<unknown> => {
    sequence += 1;
    return await reader.write({
      idempotency_key: `mobile:${workerId}:${issue}:${sequence}:${randomUUID()}`.slice(0, 128),
      write: { kind: "issue-publication", issue, body },
    }).then((answer) => answer.value);
  };
  return {
    async postClaim(issue, body) {
      const value = asRecord(await publish(issue, body), "GitHub published no claim receipt");
      const id = Number(value.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("GitHub published no claim comment id");
      return id;
    },
    async listClaims(issue): Promise<RawClaimComment[]> {
      const value = await reader.read({
        kind: "rest",
        path: `repos/${repository}/issues/${issue}/comments?per_page=100`,
      }).then((answer) => answer.value);
      if (!Array.isArray(value)) throw new Error("GitHub returned no claim comment list");
      return value.flatMap((entry) => {
        if (entry == null || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        const id = Number(record.id);
        return Number.isSafeInteger(id) && id > 0 && typeof record.body === "string"
          ? [{ id, body: record.body }]
          : [];
      });
    },
    async concede(issue, body) {
      await publish(issue, body);
    },
  };
}

function asRecord(value: unknown, detail: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(detail);
  return value as Record<string, unknown>;
}

function asLabelName(value: unknown): string {
  return value != null && typeof value === "object" && typeof (value as { name?: unknown }).name === "string"
    ? (value as { name: string }).name
    : "";
}
