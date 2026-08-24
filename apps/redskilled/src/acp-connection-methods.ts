// acp-connection-methods — the `_redskills/*` surface one connection binds.
//
// Declared ONCE and registered onto both dialects. The domains themselves are
// dialect-blind: a Project status projection is the same answer whether v1 or
// v2 asked. Only `go_dispatch` differs, and only in how the Worker it admits
// frames its narration for the caller — so that is the one thing the two
// tables are built with different arguments for.
import { randomUUID } from "node:crypto";
import {
  methods,
  type AgentContext,
  type AgentConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { translateV1SessionUpdateToV2 } from "@reddb-io/protocol-acp";

import { brainMethodDomain } from "./acp-brain.js";
import { budgetMethodDomain } from "./acp-budget.js";
import type { PublicSession } from "./acp-control-plane.js";
import type { AcpTargetedDispatchIntent } from "./acp-dispatch-intent.js";
import { githubMethodDomain } from "./acp-github.js";
import { createGoWorkerAdmission } from "./acp-go-admission.js";
import {
  createAcpGithubGoTicketTracker,
  goDispatchMethodDomain,
  type GoWorkerAdmission,
} from "./acp-go-dispatch.js";
import { hostStateMethodDomain } from "./acp-host-methods.js";
import { memoryMethodDomain } from "./acp-memory.js";
import { mobileOperatorMethodDomain } from "./acp-mobile-operator.js";
import { telemetryMethodDomain } from "./acp-telemetry.js";
import {
  redskillsAcpMethodTable,
  type RedskillsAcpMethodTable,
} from "./acp-method-registry.js";
import type { ActiveWorkflowWorker } from "./acp-worker-lifecycle.js";
import {
  worktreeMethodDomain,
  type RedskilledRegisteredCheckout,
  type RedskilledWorkerWorktree,
} from "./acp-worktree.js";
import type { AcpSessionJournal } from "./acp-session-journal.js";
import type { HostBrainStore } from "./brain-store.js";
import type { ProjectMemoryStore } from "./memory-store.js";
import type { RedskilledGithubGatewayRegistration } from "./github-gateway.js";
import type { RedskilledHostState } from "./host-state.js";
import type { RedskilledStatuslinePayload } from "./statusline-payload.js";
import type { RedskilledPaths } from "./paths.js";
import {
  projectControlMethodDomain,
  type ProjectControlOperation,
  type ProjectControlRequest,
} from "./project-control.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import type { LaunchedWorker, RedskilledWorkerSpec } from "./worker-launch.js";
import type {
  MobileTicketDispatchAnswer,
  MobileTicketDispatchParams,
  MobileWorkerStopAnswer,
  MobileWorkerStopParams,
} from "@reddb-io/protocol-acp";

export interface ConnectionMethodDeps {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
  readonly githubGateway: RedskilledGithubGatewayRegistration | undefined;
  readonly hostAdministration: boolean;
  readonly mobileTicketDispatch: (
    params: MobileTicketDispatchParams,
  ) => Promise<MobileTicketDispatchAnswer>;
  readonly mobileWorkerStop: (
    params: MobileWorkerStopParams,
  ) => Promise<MobileWorkerStopAnswer>;
  /** The statusline read the Mobile v2 answer dates itself by; null when none. */
  readonly statuslinePayload?: () => RedskilledStatuslinePayload | null;
  readonly clock?: () => string;
  /**
   * The host's ONE brain store holder (ADR 0152).
   *
   * Passed in rather than constructed here because this function runs per
   * connection: a holder built at this depth would be a store handle per
   * session, which is the cost the daemon took the store over to remove.
   */
  readonly brainStore: HostBrainStore;
  /**
   * The daemon's per-Project memory holder (ADR 0152). Passed in for the same
   * reason the brain holder is: built at this depth it would be a store handle
   * per session, which is the cost the daemon took the stores over to remove.
   */
  readonly memoryStore: ProjectMemoryStore;
  readonly sessionJournal: AcpSessionJournal;
  readonly sessions: Map<string, PublicSession>;
  readonly active: Map<string, ActiveWorkflowWorker>;
  /** The Project projection this connection may read. Throws when unbound. */
  readonly scopedState: () => unknown;
  /** The Project this connection bound. Throws when none has. */
  readonly scopedProject: () => AcpProjectWorkspace;
  /** The daemon's own state, read for the registration a worktree stands on. */
  readonly hostState: () => RedskilledHostState;
  readonly mutateProjectControl: (
    operation: ProjectControlOperation,
    request: ProjectControlRequest,
  ) => Promise<unknown>;
  readonly readProjectStatus: () => Promise<unknown>;
  /** Observe the reader the first GitHub read resolves, to stream its updates. */
  readonly onGithubReader: (reader: unknown) => void;
  /** Resolve one permission decision under this connection's durable policy. */
  readonly permission: (
    sessionId: string,
    request: RequestPermissionRequest,
    project: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ) => Promise<RequestPermissionResponse>;
}

export interface ConnectionMethodTables {
  readonly v1: RedskillsAcpMethodTable;
  readonly v2: RedskillsAcpMethodTable;
}

/** Compose this connection's domains, once per dialect. */
export function connectionMethodTables(deps: ConnectionMethodDeps): ConnectionMethodTables {
  const table = (admit: GoAdmit): RedskillsAcpMethodTable => redskillsAcpMethodTable([
    hostStateMethodDomain({ scopedState: deps.scopedState }),
    projectControlMethodDomain({
      mutate: deps.mutateProjectControl,
      read: deps.readProjectStatus,
    }),
    githubMethodDomain({
      gateway: deps.githubGateway,
      scopedProject: deps.scopedProject,
      onReader: deps.onGithubReader,
    }),
    budgetMethodDomain({
      gateway: deps.githubGateway,
      scopedProject: deps.scopedProject,
      hostAdministration: deps.hostAdministration,
    }),
    goDispatchMethodDomain({
      tracker: createAcpGithubGoTicketTracker(deps.githubGateway, deps.scopedProject),
      admit,
    }),
    mobileOperatorMethodDomain({
      hostAdministration: deps.hostAdministration,
      hostState: deps.hostState,
      ...(deps.statuslinePayload == null ? {} : { statuslinePayload: deps.statuslinePayload }),
      ...(deps.clock == null ? {} : { clock: deps.clock }),
      dispatch: deps.mobileTicketDispatch,
      stop: deps.mobileWorkerStop,
    }),
    worktreeMethodDomain({
      registeredCheckout: () => registeredCheckout(deps),
      workerWorktrees: () => workerWorktrees(deps),
    }),
    telemetryMethodDomain({ hostAdministration: deps.hostAdministration }),
    brainMethodDomain({ store: deps.brainStore }),
    memoryMethodDomain({ store: deps.memoryStore, scopedProject: deps.scopedProject }),
  ]);
  return { v1: table(admitThroughV1(deps)), v2: table(admitThroughV2(deps)) };
}

/**
 * The registration this connection's checkout stands on, or nothing.
 *
 * Absence is an ordinary answer here rather than a throw, because it is the
 * one the worktree domain turns into its typed `checkout-not-registered`
 * refusal — a caller told "no registration" can register, while a caller told
 * "internal error" cannot.
 */
function registeredCheckout(deps: ConnectionMethodDeps): RedskilledRegisteredCheckout | undefined {
  const project = deps.scopedProject();
  const registration = deps.hostState().registrations
    ?.find((entry) => entry.project_label === project.projectLabel);
  if (registration == null) return undefined;
  return {
    project_label: project.projectLabel,
    checkout_root: project.checkoutRoot,
    ...(registration.trunk == null ? {} : { trunk: registration.trunk }),
  };
}

/**
 * This Project's Worker worktrees, as the daemon knows them.
 *
 * `workspace_path` is carried verbatim — the daemon stores what it was given
 * and interprets nothing, so the inventory reports the execution root the
 * Worker was born with rather than a path composed from a layout the daemon
 * would have had to learn.
 */
function workerWorktrees(deps: ConnectionMethodDeps): readonly RedskilledWorkerWorktree[] {
  const project = deps.scopedProject();
  return deps.hostState().workers
    .filter((worker) => worker.project_label === project.projectLabel)
    .map((worker) => ({ worker_id: worker.worker_id, path: worker.workspace_path }));
}

type GoAdmit = (
  dispatch: AcpTargetedDispatchIntent,
  context: { readonly client: unknown },
) => Promise<GoWorkerAdmission>;

/**
 * The caller's connection is reachable only from inside a handler, so the
 * admission is bound around the context the request arrived with. The cast is
 * the registry's erasure being undone by the dialect that erased it.
 */
function admitThroughV1(deps: ConnectionMethodDeps): GoAdmit {
  return async (dispatch, context) => {
    const upstream = context.client as AgentContext;
    return await goAdmission(deps, {
      forward: () => upstream.notify.bind(upstream) as AgentConnection["client"]["notify"],
      permission: (request) => upstream.request(methods.client.session.requestPermission, request),
    })(dispatch);
  };
}

function admitThroughV2(deps: ConnectionMethodDeps): GoAdmit {
  return async (dispatch, context) => {
    const upstream = context.client as acpV2.AgentContext;
    const messageId = randomUUID();
    return await goAdmission(deps, {
      forward: (sessionId) => (async (_method: unknown, notice: SessionNotification) => {
        const update = translateV1SessionUpdateToV2(notice.update, messageId);
        if (update == null) return;
        await upstream.notify(acpV2.methods.client.session.update, {
          sessionId,
          update,
          _meta: notice._meta,
        });
      }) as AgentConnection["client"]["notify"],
      permission: async (request) => await upstream.request(
        acpV2.methods.client.session.requestPermission,
        request as unknown as acpV2.RequestPermissionRequest,
      ) as unknown as RequestPermissionResponse,
    })(dispatch);
  };
}

interface GoDialect {
  readonly forward: (sessionId: string) => AgentConnection["client"]["notify"];
  readonly permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

function goAdmission(deps: ConnectionMethodDeps, dialect: GoDialect) {
  return createGoWorkerAdmission({
    paths: deps.paths,
    startWorker: deps.startWorker,
    hostState: deps.hostState,
    sessionJournal: deps.sessionJournal,
    sessions: deps.sessions,
    active: deps.active,
    project: deps.scopedProject,
    forward: dialect.forward,
    permission: (sessionId, request) => deps.permission(sessionId, request, dialect.permission),
  });
}
