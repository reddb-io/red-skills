// acp-connection-methods — the `_redskills/*` surface one connection binds.
//
// Declared ONCE and registered onto both dialects. The domains themselves are
// dialect-blind: a Project status projection is the same answer whether v1 or
// v2 asked — since the go dispatch turn went unattended (its narration is a
// record, not a client stream), even `go_dispatch` binds identically, so the
// two tables are the same table registered twice.
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import { brainMethodDomain } from "./acp-brain.js";
import { budgetMethodDomain } from "./acp-budget.js";
import type { PublicSession } from "./acp-control-plane.js";
import type { AcpTargetedDispatchIntent } from "./acp-dispatch-intent.js";
import { githubMethodDomain } from "./acp-github.js";
import type { DemandTurnRequest, DemandTurnResult } from "./acp-demand-turn.js";
import { mintHostWorkerId } from "./worker-launch.js";
import {
  createAcpGithubGoTicketTracker,
  goAcceptanceCriteria,
  goDispatchMethodDomain,
  GO_DISPATCH_LANE,
  type GoDispatchBrief,
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
  /** The unattended demand-turn runner every dispatch entrance shares. */
  readonly runDemandTurn: (request: DemandTurnRequest) => Promise<DemandTurnResult>;
  /** Durable evidence for a dispatch turn that died after its answer left. */
  readonly recordDispatchFailure?: (failure: {
    readonly projectLabel: string;
    readonly detail: string;
    readonly surface: "turn";
  }) => void;
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
  const admit = goTurnAdmit(deps);
  return { v1: table(admit), v2: table(admit) };
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
  brief: GoDispatchBrief,
) => Promise<GoWorkerAdmission>;

/**
 * Admit by RUNNING the turn, not by only birthing the process.
 *
 * `go_dispatch` used to admit a Worker and stop: the native Worker enters its
 * Ticket loop only through a prompted handoff, so every dispatched Worker sat
 * idle forever with its Ticket unclaimed (observed live 2026-08-25, twice).
 * The turn is the same unattended demand turn the drain and the Mobile
 * dispatch run — fire-and-forget, with the answer resolved at admission — so
 * the dispatching client may hang up the moment it has its Worker id, which
 * is exactly what the MCP adapter and the phone both do.
 */
export function goTurnAdmit(deps: ConnectionMethodDeps): GoAdmit {
  return async (dispatch, _context, brief) => {
    const project = deps.scopedProject();
    const state = deps.hostState();
    const workerId = mintHostWorkerId(state.workers.map((worker) => worker.worker_id));
    const base = state.registrations
      ?.find((registration) => registration.project_label === project.projectLabel)
      ?.trunk?.branch ?? "main";
    let admitted = false;
    let resolveBorn!: (bornWorkerId: string) => void;
    let rejectBorn!: (error: unknown) => void;
    const born = new Promise<string>((resolve, reject) => {
      resolveBorn = resolve;
      rejectBorn = reject;
    });
    const turn = deps.runDemandTurn({
      project,
      workerId,
      workItem: String(dispatch.ticket),
      prompt: `Implement the /go dispatch Ticket #${dispatch.ticket}: ${brief.demand}`,
      ticket: {
        number: dispatch.ticket,
        title: brief.title,
        labels: [GO_DISPATCH_LANE],
        base,
        // The demand plus its own criteria section: the brief contract's
        // structural door refuses a handoff with no acceptance criteria at
        // all, before any claim (#4296) — the first live 4.4.0 dispatch
        // parked exactly there.
        handoff: `${brief.demand}\n\n${goAcceptanceCriteria(brief.demand).join("\n")}`,
        worker_id: workerId,
      },
      onBorn: (bornWorkerId) => {
        admitted = true;
        resolveBorn(bornWorkerId);
      },
    });
    void turn.catch((error: unknown) => {
      if (!admitted) rejectBorn(error);
      deps.recordDispatchFailure?.({
        projectLabel: project.projectLabel,
        detail: `go_dispatch turn for Ticket #${dispatch.ticket} died: ${
          error instanceof Error ? error.message : String(error)}`,
        surface: "turn",
      });
    });
    return { worker_id: await born };
  };
}
