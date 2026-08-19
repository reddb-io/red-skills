/**
 * acp-demand-turn — the daemon's own turn, for a Worker nobody is watching.
 *
 * **A birth nobody speaks to does nothing.** The demand loop births a process
 * for each unit of queue demand and then never prompts it, while every client
 * turn goes through admission → session → prompt (`acp-worker-admission.ts`,
 * `acp-worker-lifecycle.ts`). That gap is the whole reason a registered,
 * draining project produced Workers and no work (Spec #4097, #4100).
 *
 * This runs the same admission and the same turn with **no client on the other
 * end**: its own session map, its own synthetic session id, and a sink that
 * records lifecycle where a client would have been notified. It deliberately
 * does not borrow a connection's session map — an unattended turn that lived
 * inside a client's would die when that client disconnected, which is the one
 * property a drain must not have (#3885).
 *
 * The daemon still reads nothing: the prompt is a project-authored string with
 * the daemon's own facts expanded into it, exactly as the argv already was.
 */
import type { AgentConnection, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

import { admitNativeAcpWorker } from "./acp-worker-admission.js";
import {
  cleanupWorkflowWorker,
  requestWorkflowTurn,
  workflowOutcome,
  type ActiveWorkflowWorker,
} from "./acp-worker-lifecycle.js";
import type { AcpSessionJournal } from "./acp-session-journal.js";
import type { RedskilledGithubGatewayRegistration } from "./github-gateway.js";
import type { RedskilledPaths } from "./paths.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import type { LaunchedWorker, RedskilledWorkerSpec } from "./worker-launch.js";

/** What one unattended turn needs to exist. The daemon's own facts, no client's. */
export interface DemandTurnDeps {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
  readonly hostState: () => { readonly workers: readonly { readonly worker_id: string }[] };
  readonly sessionJournal: AcpSessionJournal;
  readonly githubGateway?: RedskilledGithubGatewayRegistration;
  readonly evidenceRoot?: string;
  readonly evidenceTtlMs?: number;
  readonly workspaceRoot?: string;
  /**
   * How a Worker is admitted for this turn.
   *
   * Defaults to the same native admission every client turn uses; a test
   * substitutes it, because the alternative is spawning a real coder agent to
   * assert that a prompt was sent.
   */
  readonly admit?: (input: DemandTurnAdmission) => Promise<ActiveWorkflowWorker>;
  /**
   * Where a lifecycle line goes when there is no client to notify.
   *
   * An unattended turn must be exactly as observable as an attended one, or the
   * only way to learn a drain is working is to watch for commits.
   */
  readonly record?: (line: DemandTurnRecord) => void;
}

/** What one admission needs, whoever performs it. */
export interface DemandTurnAdmission {
  readonly project: AcpProjectWorkspace;
  readonly sessionId: string;
  readonly notify: AgentConnection["client"]["notify"];
  readonly permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  readonly replacement: boolean;
}

export interface DemandTurnRecord {
  readonly event: string;
  readonly project_label: string;
  readonly worker_id?: string;
  readonly work_item?: string;
  readonly detail?: string;
}

export interface DemandTurnRequest {
  readonly project: AcpProjectWorkspace;
  /** The project's prompt, with this birth's facts already written into it. */
  readonly prompt: string;
  /** The queue identifier this turn is for, when the birth had one. */
  readonly workItem?: string;
}

export interface DemandTurnResult {
  readonly workerId: string;
  readonly outcome: string;
}

/**
 * A permission request with nobody to ask.
 *
 * **Refused, and said out loud.** A daemon that answered "approved" on an
 * operator's behalf would be granting, unattended, exactly the reach an
 * attached client is shown a dialog for; one that hung would hold a Worker
 * open until its idle timer. The Worker sees a refusal it can park on.
 */
export const DEMAND_TURN_PERMISSION_REFUSAL =
  "this turn runs unattended: redskilled refuses permission on nobody's behalf — park the work for /hitl instead";

function refusePermission(request: RequestPermissionRequest): RequestPermissionResponse {
  const cancelled = request.options.find((option) => option.kind === "reject_once")
    ?? request.options.find((option) => option.kind === "reject_always");
  return cancelled == null
    ? { outcome: { outcome: "cancelled" }, _meta: { redskills: { permissionResolution: "unattended-refused" } } }
    : {
      outcome: { outcome: "selected", optionId: cancelled.optionId },
      _meta: { redskills: { permissionResolution: "unattended-refused", reason: DEMAND_TURN_PERMISSION_REFUSAL } },
    };
}

/**
 * Bind a runner from the control plane's own options, so the assembler states
 * the dependency once instead of restating every optional field. PURE wiring.
 */
export function demandTurnRunnerFor(
  options: {
    readonly paths: RedskilledPaths;
    readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
    readonly hostState: () => { readonly workers: readonly { readonly worker_id: string }[] };
    readonly githubGateway?: RedskilledGithubGatewayRegistration;
    readonly evidenceRoot?: string;
    readonly evidenceTtlMs?: number;
    readonly recordDemandTurn?: (record: DemandTurnRecord) => void;
  },
  sessionJournal: AcpSessionJournal,
): (request: DemandTurnRequest) => Promise<DemandTurnResult> {
  return createDemandTurnRunner({
    paths: options.paths,
    startWorker: options.startWorker,
    hostState: options.hostState,
    sessionJournal,
    ...(options.githubGateway == null ? {} : { githubGateway: options.githubGateway }),
    ...(options.evidenceRoot == null ? {} : { evidenceRoot: options.evidenceRoot }),
    ...(options.evidenceTtlMs == null ? {} : { evidenceTtlMs: options.evidenceTtlMs }),
    ...(options.recordDemandTurn == null ? {} : { record: options.recordDemandTurn }),
  });
}

/**
 * Bind the daemon's unattended turn runner.
 *
 * One `active` map per runner, held for the daemon's life: a Worker admitted
 * for one work item is reaped when its turn ends, so the map never holds more
 * than the turns actually in flight.
 */
export function createDemandTurnRunner(
  deps: DemandTurnDeps,
): (request: DemandTurnRequest) => Promise<DemandTurnResult> {
  const active = new Map<string, ActiveWorkflowWorker>();
  let sequence = 0;
  const admit = deps.admit ?? ((input: DemandTurnAdmission) => admitNativeAcpWorker(
    {
      paths: deps.paths,
      startWorker: deps.startWorker,
      hostState: deps.hostState,
      ...(deps.workspaceRoot == null ? {} : { workspaceRoot: deps.workspaceRoot }),
      ...(deps.evidenceRoot == null ? {} : { evidenceRoot: deps.evidenceRoot }),
      ...(deps.evidenceTtlMs == null ? {} : { evidenceTtlMs: deps.evidenceTtlMs }),
      ...(deps.githubGateway == null ? {} : { githubGateway: deps.githubGateway }),
    },
    deps.sessionJournal,
    { request: { cwd: input.project.workspacePath, mcpServers: [] }, project: input.project },
    input.sessionId,
    input.notify,
    input.permission,
    input.replacement,
  ));

  return async (request: DemandTurnRequest): Promise<DemandTurnResult> => {
    sequence += 1;
    // Synthetic and unique per turn: the session id keys the admission map and
    // the journal, and a reused one would make two unattended turns look like
    // one session being replaced.
    const sessionId = `demand-${sequence}-${request.project.projectId}`;
    const record = (event: string, worker?: ActiveWorkflowWorker, detail?: string): void => {
      deps.record?.({
        event,
        project_label: request.project.projectLabel,
        ...(worker == null ? {} : { worker_id: worker.workerId }),
        ...(request.workItem == null ? {} : { work_item: request.workItem }),
        ...(detail == null ? {} : { detail }),
      });
    };
    // Nobody is listening, so a notification is a record. The shape is kept so
    // the admission path cannot tell the difference between this and a client.
    const notify: AgentConnection["client"]["notify"] = async () => {};

    try {
      const { worker, response } = await requestWorkflowTurn(
        sessionId,
        active,
        {
          sessionId,
          prompt: [{ type: "text", text: request.prompt }],
          _meta: {
            redskills: {
              unattended: true,
              ...(request.workItem == null ? {} : { workItem: request.workItem }),
            },
          },
        },
        (replacement) => admit({
          project: request.project,
          sessionId,
          notify,
          permission: async (permission) => refusePermission(permission),
          replacement,
        }),
      );
      const outcome = workflowOutcome(response) ?? response.stopReason;
      record("demand-turn-completed", worker, outcome);
      // The turn is the Worker's whole life: it was admitted for one work item
      // and has now finished it, so it is reaped here rather than left on an
      // idle timer nobody will come back to.
      cleanupWorkflowWorker(sessionId, worker, active, outcome);
      return { workerId: worker.workerId, outcome };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record("demand-turn-refused", active.get(sessionId), detail);
      const held = active.get(sessionId);
      if (held != null) cleanupWorkflowWorker(sessionId, held, active, "demand-turn-refused");
      throw error;
    }
  };
}
