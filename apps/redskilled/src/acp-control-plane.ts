/**
 * ACP v1/v2 control plane — redskilled is the public Agent and the Client of each Worker.
 *
 * The public stdio command is only a transport projection onto the daemon-owned
 * socket. Sessions, admission, Worker rendezvous, cancellation, and terminal
 * cleanup all live here, in the host authority. The native Worker speaks ACP on
 * its assigned socket and exits when redskilled closes that connection.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  agent,
  methods,
  RequestError,
  type McpServer,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
  ACP_PROTOCOL_VERSION,
  ACP_V2_DRAFT_REVISION,
  REDSKILLS_WIRE_MAJOR,
  requireCompatibleWireMajor,
  requireSupportedV2Revision,
  translateV1SessionUpdateToV2,
} from "./acp-compat.js";
import {
  closeServer,
  connectWithDeadline,
  listen,
  socketStream,
  withTimeout,
} from "./acp-socket.js";
import {
  REDSKILLED_GITHUB_UPDATE_METHOD,
  bindAcpGithubReaderUpdates,
  bindAcpProjectGithubRead,
  bindAcpProjectGithubWrite,
  githubReadParams,
  githubWriteParams,
  type AcpGithubUpdateObserver,
} from "./acp-github.js";
import {
  bindAcpHostGithubBudget,
  bindAcpProjectGithubBudget,
  emptyBudgetParams,
  REDSKILLED_HOST_BUDGET_METHOD,
  REDSKILLED_PROJECT_BUDGET_METHOD,
} from "./acp-budget.js";
import {
  acpSessionJournalPath,
  createAcpSessionJournal as createDurableAcpSessionJournal,
  type AcpSessionJournal as DurableAcpSessionJournal,
} from "./acp-session-journal.js";
import {
  isAcpRetakePrompt,
  notifyV1AcpRetakeEvidence,
  notifyV2AcpRetakeEvidence,
} from "./acp-retake-evidence.js";
import type { RedskilledHostState } from "./host-state.js";
import {
  REDSKILLED_GITHUB_READ_METHOD,
  REDSKILLED_GITHUB_WRITE_METHOD,
  type RedskilledGithubGatewayRegistration,
} from "./github-gateway.js";
import type { RedskilledPaths } from "./paths.js";
import {
  applyProjectControl,
  coreProjectOperation,
  createProjectControlStore,
  notifyV1ProjectControl,
  PROJECT_CONTROL_METHODS,
  projectControlSnapshot,
  projectControlStorePath,
  runV2ProjectControlTurn,
  type ProjectControlOperation,
  type ProjectControlState,
} from "./project-control.js";
import {
  ensureAcpProjectWorkspace,
  resolveAcpProjectIdentity,
  type AcpProjectIdentity,
  type AcpProjectWorkspace,
} from "./project-workspace.js";
import type { LaunchedWorker, RedskilledWorkerSpec } from "./worker-launch.js";
import {
  bindTargetedDispatch,
  createAcpSessionJournal as createAcpDispatchJournal,
  type AcpSessionJournal as AcpDispatchJournal,
  type AcpTargetedDispatchIntent,
} from "./acp-dispatch-intent.js";
import {
  cleanupWorkflowWorker,
  notifyWorkerLifecycle,
  notifySessionLifecycle,
  reapWorkflowWorker,
  requestWorkflowTurn,
  scheduleIdleCleanup,
  workflowOutcome,
  type ActiveWorkflowWorker,
} from "./acp-worker-lifecycle.js";
import { admitNativeAcpWorker } from "./acp-native-worker.js";
export { runNativeAcpWorker } from "./acp-native-worker.js";
import { runAcpWorkflowTurn } from "./acp-workflow-turn.js";

export { ACP_V2_DRAFT_REVISION, REDSKILLS_WIRE_MAJOR } from "./acp-compat.js";

interface PublicSession {
  readonly request: NewSessionRequest;
  readonly project: AcpProjectWorkspace;
  readonly dispatchJournal: AcpDispatchJournal;
}

export interface RedskillsAcpControlPlane {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface StartRedskillsAcpControlPlaneOptions {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
  readonly hostState: () => RedskilledHostState;
  readonly githubGateway?: RedskilledGithubGatewayRegistration;
  /** Explicit endpoint authority; ordinary public/project ACP stays false. */
  readonly hostAdministration?: boolean;
}

/** Bind the daemon-owned public ACP endpoint. */
export async function startRedskillsAcpControlPlane(
  options: StartRedskillsAcpControlPlaneOptions,
): Promise<RedskillsAcpControlPlane> {
  const { paths } = options;
  const sockets = new Set<Socket>();
  const projects = new Map<string, Promise<AcpProjectWorkspace>>();
  // Project control belongs to the daemon endpoint, not to any ACP connection.
  // Closing the client therefore drops observation only; drain intent remains
  // until the shared reducer receives an explicit stop.
  const projectControlStore = createProjectControlStore(projectControlStorePath(paths.registrationIntentPath));
  const projectControls = await projectControlStore.read();
  const persistProjectControls = projectControlStore.replace.bind(projectControlStore);
  const sessionJournal = await createDurableAcpSessionJournal(acpSessionJournalPath(paths.registrationIntentPath));
  const workspaceFor = (identity: AcpProjectIdentity): Promise<AcpProjectWorkspace> => {
    const held = projects.get(identity.projectId);
    if (held != null) return held;
    const pending = ensureAcpProjectWorkspace(identity, paths.projectWorkspaceRoot)
      .catch((error) => {
        projects.delete(identity.projectId);
        throw error;
      });
    projects.set(identity.projectId, pending);
    return pending;
  };
  await mkdir(join(paths.runtimeDir, "acp-workers"), { recursive: true, mode: 0o700 });
  await rm(paths.acpSocketPath, { force: true });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void servePublicConnection(
      socket,
      options,
      workspaceFor,
      projectControls,
      persistProjectControls,
      sessionJournal,
    ).catch(() => socket.destroy());
  });
  await listen(server, paths.acpSocketPath);

  let closed = false;
  return {
    socketPath: paths.acpSocketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await rm(paths.acpSocketPath, { force: true });
    },
  };
}

async function servePublicConnection(
  socket: Socket,
  options: StartRedskillsAcpControlPlaneOptions,
  workspaceFor: (identity: AcpProjectIdentity) => Promise<AcpProjectWorkspace>,
  projectControls: Map<string, ProjectControlState>,
  persistProjectControls: (projects: ReadonlyMap<string, ProjectControlState>) => Promise<void>,
  sessionJournal: DurableAcpSessionJournal,
): Promise<void> {
  const sessions = new Map<string, PublicSession>();
  const active = new Map<string, ActiveWorkflowWorker>();
  const busy = new Set<string>();
  let connectionProject: AcpProjectWorkspace | undefined;
  let githubObserver: Promise<AcpGithubUpdateObserver> | undefined;
  let githubNotify: ((method: string, params?: unknown) => Promise<void>) | undefined;
  let attached = true;

  const bindProject = async (cwd: string, incompatible: () => Error): Promise<AcpProjectWorkspace> => {
    const identity = await resolveAcpProjectIdentity(cwd);
    if (connectionProject != null && connectionProject.projectId !== identity.projectId) throw incompatible();
    connectionProject ??= await workspaceFor(identity);
    return connectionProject;
  };

  const scopedState = () => {
    if (connectionProject == null) {
      throw RequestError.invalidRequest("a Project session must bind this ACP connection before state can be read");
    }
    return projectState(options.hostState(), connectionProject);
  };

  const scopedProject = (): AcpProjectWorkspace => {
    if (connectionProject == null) {
      throw RequestError.invalidRequest("a Project session must bind this ACP connection before control can be used");
    }
    return connectionProject;
  };
  const readProjectControl = () => projectControlSnapshot(scopedProject(), projectControls);
  const mutateProjectControl = (operation: ProjectControlOperation) =>
    applyProjectControl(scopedProject(), operation, projectControls, persistProjectControls);
  const readGithub = bindAcpProjectGithubRead(options.githubGateway, scopedProject, (reader) => {
    if (githubObserver != null || githubNotify == null) return;
    githubObserver = Promise.resolve(bindAcpGithubReaderUpdates(
      reader,
      (method, update) => githubNotify!(method, update),
    ));
  });
  const writeGithub = bindAcpProjectGithubWrite(options.githubGateway, scopedProject);
  const readProjectBudget = bindAcpProjectGithubBudget(options.githubGateway, scopedProject);
  const readHostBudget = bindAcpHostGithubBudget(options.githubGateway, options.hostAdministration === true);
  const emptyParams = () => ({});

  const v1App = agent({ name: "RedSkills" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      requireCompatibleWireMajor(params._meta);
      return {
        protocolVersion: params.protocolVersion === ACP_PROTOCOL_VERSION
          ? params.protocolVersion
          : ACP_PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: {} },
        agentInfo: { name: "RedSkills", version: "1" },
        _meta: {
          redskills: {
            wireMajor: REDSKILLS_WIRE_MAJOR,
            workerBacked: true,
            projectControl: { version: 1, methods: PROJECT_CONTROL_METHODS },
            ...(options.githubGateway == null ? {} : {
              githubGateway: {
                version: 1,
                methods: [REDSKILLED_GITHUB_READ_METHOD, REDSKILLED_GITHUB_WRITE_METHOD],
                notifications: [REDSKILLED_GITHUB_UPDATE_METHOD],
              },
              credentialBudgets: {
                version: 1,
                methods: [
                  REDSKILLED_PROJECT_BUDGET_METHOD,
                  ...(options.hostAdministration === true ? [REDSKILLED_HOST_BUDGET_METHOD] : []),
                ],
              },
            }),
          },
        },
      };
    })
    .onRequest(methods.agent.session.new, async ({ params, client: upstream }) => {
      const project = await bindProject(params.cwd, () => RequestError.invalidParams(
        {},
        "this project-scoped ACP connection cannot address a different Project",
      ));
      githubNotify ??= upstream.notify.bind(upstream);
      const sessionId = randomUUID();
      await sessionJournal.create(sessionId, project);
      sessions.set(sessionId, { request: params, project, dispatchJournal: createAcpDispatchJournal() });
      return {
        sessionId,
        _meta: {
          redskills: {
            authority: "redskilled",
            protocolVersion: ACP_PROTOCOL_VERSION,
            projectId: project.projectId,
            projectLabel: project.projectLabel,
            workspacePath: project.workspacePath,
          },
        },
      };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client: upstream }) => {
      const session = sessions.get(params.sessionId);
      if (session == null) throw new Error("unknown RedSkills ACP session");
      if (busy.has(params.sessionId)) throw new Error("this RedSkills ACP session already has an active turn");

      let dispatch: AcpTargetedDispatchIntent | undefined;
      try {
        dispatch = bindTargetedDispatch(session.dispatchJournal, params._meta);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await notifySessionLifecycle(upstream.notify.bind(upstream), params.sessionId, {
          event: "refusal",
          reason,
        });
        throw RequestError.invalidParams({}, reason);
      }
      await sessionJournal.prompt(params.sessionId, params.prompt);

      if (isAcpRetakePrompt(params.prompt)) {
        const projection = sessionJournal.retake(params.sessionId, session.project.projectId);
        if (projection == null) throw new Error("this Project is not authorized for the requested session evidence");
        await notifyV1AcpRetakeEvidence(upstream, params.sessionId, projection);
        return {
          stopReason: "end_turn",
          _meta: { redskills: { authority: "redskilled" } },
        } satisfies PromptResponse;
      }

      const controlOperation = coreProjectOperation(params.prompt);
      if (controlOperation != null) {
        const control = await applyProjectControl(
          session.project,
          controlOperation,
          projectControls,
          persistProjectControls,
        );
        await notifyV1ProjectControl(upstream, params.sessionId, controlOperation, control);
        return {
          stopReason: "end_turn",
          _meta: { redskills: { authority: "redskilled", projectControl: control } },
        } satisfies PromptResponse;
      }

      busy.add(params.sessionId);
      try {
        return await runAcpWorkflowTurn({
          sessionId: params.sessionId,
          prompt: params.prompt,
          ...(params._meta == null ? {} : { meta: params._meta }),
          ...(dispatch == null ? {} : { dispatch }),
          active,
          admit: (replacement) => admitNativeAcpWorker(
            options,
            sessionJournal,
            session,
            params.sessionId,
            upstream.notify.bind(upstream),
            (request) => resolvePermission(
              sessionJournal,
              params.sessionId,
              request,
              () => attached,
              (projected) => upstream.request(methods.client.session.requestPermission, projected),
            ),
            replacement,
            dispatch,
          ),
          attached: () => attached,
          notify: upstream.notify.bind(upstream),
          hostState: options.hostState,
          checkpoint: (response, outcome) => sessionJournal.checkpoint(params.sessionId, response, outcome),
        });
      } finally {
        busy.delete(params.sessionId);
      }
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const worker = active.get(params.sessionId);
      if (worker == null) return;
      worker.cancelled = true;
      await worker.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: worker.downstreamSessionId,
        ...(params._meta == null ? {} : { _meta: params._meta }),
      });
    })
    // Compatibility spelling, but deliberately a Project projection. Ordinary
    // ACP socket access is not an administrative capability.
    .onRequest("_redskills/host_state", emptyParams, scopedState)
    .onRequest(PROJECT_CONTROL_METHODS[0], emptyParams, () => mutateProjectControl("drain"))
    .onRequest(PROJECT_CONTROL_METHODS[1], emptyParams, () => mutateProjectControl("stop"))
    .onRequest(PROJECT_CONTROL_METHODS[2], emptyParams, readProjectControl)
    .onRequest(REDSKILLED_GITHUB_READ_METHOD, githubReadParams, readGithub)
    .onRequest(REDSKILLED_GITHUB_WRITE_METHOD, githubWriteParams, writeGithub)
    .onRequest(REDSKILLED_PROJECT_BUDGET_METHOD, emptyBudgetParams, readProjectBudget)
    .onRequest(REDSKILLED_HOST_BUDGET_METHOD, emptyBudgetParams, readHostBudget);

  const v2Turns = new Map<string, Promise<void>>();
  const v2App = acpV2.agent({ name: "RedSkills" })
    .onRequest(acpV2.methods.agent.initialize, ({ params }) => {
      requireCompatibleWireMajor(params._meta);
      requireSupportedV2Revision(params._meta);
      return {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "RedSkills", version: "1" },
        capabilities: { session: {} },
        _meta: {
          redskills: {
            wireMajor: REDSKILLS_WIRE_MAJOR,
            workerBacked: true,
            acpDraftRevision: ACP_V2_DRAFT_REVISION,
            projectControl: { version: 1, methods: PROJECT_CONTROL_METHODS },
            ...(options.githubGateway == null ? {} : {
              githubGateway: {
                version: 1,
                methods: [REDSKILLED_GITHUB_READ_METHOD, REDSKILLED_GITHUB_WRITE_METHOD],
                notifications: [REDSKILLED_GITHUB_UPDATE_METHOD],
              },
              credentialBudgets: {
                version: 1,
                methods: [
                  REDSKILLED_PROJECT_BUDGET_METHOD,
                  ...(options.hostAdministration === true ? [REDSKILLED_HOST_BUDGET_METHOD] : []),
                ],
              },
            }),
          },
        },
      };
    })
    .onRequest(acpV2.methods.agent.session.new, async ({ params, client: upstream }) => {
      const project = await bindProject(params.cwd, () => acpV2.RequestError.invalidParams(
        "this project-scoped ACP connection cannot address a different Project",
      ));
      githubNotify ??= upstream.notify.bind(upstream);
      const sessionId = randomUUID();
      await sessionJournal.create(sessionId, project);
      sessions.set(sessionId, {
        request: {
          cwd: params.cwd,
          mcpServers: (params.mcpServers ?? []) as unknown as McpServer[],
          ...(params.additionalDirectories == null
            ? {}
            : { additionalDirectories: params.additionalDirectories }),
        },
        project,
        dispatchJournal: createAcpDispatchJournal(),
      });
      return {
        sessionId,
        _meta: {
          redskills: {
            authority: "redskilled",
            protocolVersion: acpV2.PROTOCOL_VERSION,
            acpDraftRevision: ACP_V2_DRAFT_REVISION,
            projectId: project.projectId,
            projectLabel: project.projectLabel,
            workspacePath: project.workspacePath,
          },
        },
      };
    })
    .onRequest(acpV2.methods.agent.session.prompt, ({ params, client: upstream }) => {
      if (!sessions.has(params.sessionId)) throw acpV2.RequestError.invalidParams("unknown RedSkills ACP session");
      if (v2Turns.has(params.sessionId)) {
        throw acpV2.RequestError.invalidRequest("this RedSkills ACP session already has an active turn");
      }

      const accepted = new Promise<void>((resolve) => setTimeout(resolve, 0));
      const controlOperation = coreProjectOperation(params.prompt);
      const retake = isAcpRetakePrompt(params.prompt);
      const turn = accepted
        .then(async () => {
          await sessionJournal.prompt(
            params.sessionId,
            params.prompt as unknown as PromptRequest["prompt"],
          );
          if (retake) {
            const session = sessions.get(params.sessionId);
            if (session == null) return;
            const projection = sessionJournal.retake(params.sessionId, session.project.projectId);
            if (projection == null) return;
            await notifyV2AcpRetakeEvidence(upstream, params.sessionId, projection);
            return;
          }
          return controlOperation == null
            ? runV2PublicTurn(options, sessionJournal, sessions, active, params, upstream, () => attached)
            : runV2ProjectControlTurn(
              sessions,
              params,
              upstream,
              controlOperation,
              projectControls,
              persistProjectControls,
            );
        })
        .catch(() => {})
        .finally(() => v2Turns.delete(params.sessionId));
      v2Turns.set(params.sessionId, turn);
      return {};
    })
    .onNotification(acpV2.methods.agent.session.cancel, async ({ params }) => {
      const worker = active.get(params.sessionId);
      if (worker == null) return;
      worker.cancelled = true;
      await worker.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: worker.downstreamSessionId,
        ...(params._meta == null ? {} : { _meta: params._meta }),
      });
    })
    .onRequest("_redskills/host_state", emptyParams, scopedState)
    .onRequest(PROJECT_CONTROL_METHODS[0], emptyParams, () => mutateProjectControl("drain"))
    .onRequest(PROJECT_CONTROL_METHODS[1], emptyParams, () => mutateProjectControl("stop"))
    .onRequest(PROJECT_CONTROL_METHODS[2], emptyParams, readProjectControl)
    .onRequest(REDSKILLED_GITHUB_READ_METHOD, githubReadParams, readGithub)
    .onRequest(REDSKILLED_GITHUB_WRITE_METHOD, githubWriteParams, writeGithub)
    .onRequest(REDSKILLED_PROJECT_BUDGET_METHOD, emptyBudgetParams, readProjectBudget)
    .onRequest(REDSKILLED_HOST_BUDGET_METHOD, emptyBudgetParams, readHostBudget);

  const connection = acpV2.agentProtocolRouter()
    .withV1(v1App)
    .withV2(v2App)
    .connect(socketStream(socket) as unknown as acpV2.Stream);
  await connection.closed;
  attached = false;
  if (githubObserver != null) {
    const observer = await githubObserver;
    observer.close();
    await observer.settled();
  }
  for (const [sessionId, worker] of active) {
    if (busy.has(sessionId) || v2Turns.has(sessionId)) continue;
    cleanupWorkflowWorker(sessionId, worker, active);
  }
}

async function runV2PublicTurn(
  options: StartRedskillsAcpControlPlaneOptions,
  sessionJournal: DurableAcpSessionJournal,
  sessions: Map<string, PublicSession>,
  active: Map<string, ActiveWorkflowWorker>,
  params: acpV2.PromptRequest,
  upstream: acpV2.AgentContext,
  attached: () => boolean,
): Promise<void> {
  const session = sessions.get(params.sessionId);
  if (session == null) return;
  const messageId = randomUUID();
  await upstream.notify(acpV2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: { sessionUpdate: "state_update", state: "running" },
  });

  let worker: ActiveWorkflowWorker | undefined;
  try {
    const forward = async (_method: typeof methods.client.session.update, notice: SessionNotification) => {
      const update = translateV1SessionUpdateToV2(notice.update, messageId);
      if (update == null) return;
      await upstream.notify(acpV2.methods.client.session.update, {
        sessionId: params.sessionId,
        update,
        _meta: notice._meta,
      });
    };
    const turn = await requestWorkflowTurn(
      params.sessionId,
      active,
      {
        sessionId: params.sessionId,
        prompt: params.prompt as unknown as PromptRequest["prompt"],
        ...(params._meta == null ? {} : { _meta: params._meta }),
      },
      (replacement) => admitNativeAcpWorker(
        options,
        sessionJournal,
        session,
        params.sessionId,
        forward,
        (request) => resolvePermission(
          sessionJournal,
          params.sessionId,
          request,
          attached,
          async (projected) => await upstream.request(
            acpV2.methods.client.session.requestPermission,
            projected as unknown as acpV2.RequestPermissionRequest,
          ) as unknown as RequestPermissionResponse,
        ),
        replacement,
      ),
    );
    worker = turn.worker;
    const response = turn.response;
    const outcome = workflowOutcome(response);
    await sessionJournal.checkpoint(params.sessionId, response, outcome);
    if (outcome != null) {
      await notifyWorkerLifecycle(worker, "terminal-outcome", outcome).catch(() => undefined);
      await reapWorkflowWorker(params.sessionId, worker, active, outcome);
    } else if (!attached()) {
      await reapWorkflowWorker(params.sessionId, worker, active, "client-detached");
    } else {
      scheduleIdleCleanup(params.sessionId, worker, active);
    }
    await upstream.notify(acpV2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "state_update", state: "idle", stopReason: response.stopReason },
      _meta: { redskills: { authority: "redskilled", workerId: worker.workerId } },
    });
  } catch (error) {
    if (worker != null) cleanupWorkflowWorker(params.sessionId, worker, active);
    await upstream.notify(acpV2.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "state_update", state: "idle", stopReason: "refusal" },
      _meta: {
        redskills: {
          authority: "redskilled",
          detail: error instanceof Error ? error.message : String(error),
        },
      },
    });
  }
}

function projectState(host: RedskilledHostState, project: AcpProjectWorkspace) {
  return {
    project_id: project.projectId,
    project_label: project.projectLabel,
    workspace_path: project.workspacePath,
    workers: host.workers.filter((worker) => worker.project_label === project.projectId),
  };
}

/** Stdio launch-edge adapter: transport only; no session state lives here. */
export async function runRedskillsAcpAdapter(paths: RedskilledPaths): Promise<number> {
  const socket = await connectWithDeadline(paths.acpSocketPath, 10_000);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise<void>((resolve, reject) => {
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  return 0;
}
type PermissionDecision = Extract<
  ReturnType<DurableAcpSessionJournal["recovery"]>["entries"][number],
  { kind: "permission" }
>;

async function resolvePermission(
  journal: DurableAcpSessionJournal,
  publicSessionId: string,
  request: RequestPermissionRequest,
  attached: () => boolean,
  project: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
): Promise<RequestPermissionResponse> {
  const policyKey = permissionPolicyKey(request);
  const granted = [...journal.recovery(publicSessionId).entries]
    .reverse()
    .find((entry): entry is PermissionDecision => entry.kind === "permission" &&
      entry.policy_key === policyKey && entry.decision === "attached-approved" &&
      entry.option_kind === "allow_always");
  const preAuthorized = granted == null
    ? undefined
    : request.options.find((option) => option.optionId === granted.option_id && option.kind === "allow_always");
  if (preAuthorized != null) {
    await journal.permission(publicSessionId, request, policyKey, "policy-pre-authorized", preAuthorized.optionId);
    return permissionAnswer(preAuthorized.optionId, "policy-pre-authorized");
  }

  if (attached()) {
    try {
      const response = await withTimeout(
        project(request),
        permissionDecisionTimeoutMs(),
        "attached ACP permission decision",
      );
      const outcome = response.outcome;
      const selected = outcome.outcome === "selected"
        ? request.options.find((option) => option.optionId === outcome.optionId)
        : undefined;
      if (selected != null) {
        const approved = selected.kind === "allow_once" || selected.kind === "allow_always";
        const decision = approved ? "attached-approved" : "attached-denied";
        await journal.permission(publicSessionId, request, policyKey, decision, selected.optionId);
        return permissionAnswer(selected.optionId, decision, response._meta);
      }
    } catch {
      // A disconnect or bounded timeout is an uncovered decision, never approval.
    }
  }

  await journal.permission(publicSessionId, request, policyKey, "hitl-required");
  return {
    outcome: { outcome: "cancelled" },
    _meta: { redskills: { permissionResolution: "hitl-required", durableHitl: true } },
  };
}

function permissionAnswer(
  optionId: string,
  permissionResolution: "attached-approved" | "attached-denied" | "policy-pre-authorized",
  meta?: RequestPermissionResponse["_meta"],
): RequestPermissionResponse {
  return {
    outcome: { outcome: "selected", optionId },
    _meta: {
      ...(meta ?? {}),
      redskills: {
        ...((meta as { redskills?: object } | undefined)?.redskills ?? {}),
        permissionResolution,
      },
    },
  };
}

function permissionPolicyKey(request: RequestPermissionRequest): string {
  return `${request.toolCall.kind ?? "other"}:${request.toolCall.title ?? "untitled"}`;
}

function permissionDecisionTimeoutMs(): number {
  const configured = Number.parseInt(process.env.REDSKILLED_ACP_PERMISSION_TIMEOUT_MS ?? "30000", 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30_000;
}
