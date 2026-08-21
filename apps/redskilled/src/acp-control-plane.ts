/**
 * ACP v1/v2 control plane — redskilled is the public Agent and the Client of each Worker.
 *
 * The public stdio command is only a transport projection onto the daemon-owned
 * socket. Sessions, admission, Worker rendezvous, cancellation, and terminal
 * cleanup all live here, in the host authority. The native Worker speaks ACP on
 * its assigned socket and exits when redskilled closes that connection.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { formatStandingOrdersBrief, type StandingOrdersStore } from "./standing-orders.js";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
  ACP_AGENT_IDS,
  type AcpAgentId,
  ACP_PROTOCOL_VERSION,
  ACP_V2_DRAFT_REVISION,
  REDSKILLS_WIRE_MAJOR,
  closeServer,
  connectWithDeadline,
  listen,
  removeAcpEndpoint,
  requireCompatibleWireMajor,
  requireSupportedV2Revision,
  socketStream,
  translateV1SessionUpdateToV2,
} from "@reddb-io/protocol-acp";
import { bindAcpGithubReaderUpdates, bindAcpProjectGithubCustodyStatus, type AcpGithubUpdateObserver } from "./acp-github.js";
import { connectionMethodTables } from "./acp-connection-methods.js";
import {
  acpSessionJournalPath,
  createAcpSessionJournal as createDurableAcpSessionJournal,
  type AcpSessionJournal as DurableAcpSessionJournal,
} from "./acp-session-journal.js";
import { isAcpRetakePrompt, notifyV1AcpRetakeEvidence, notifyV2AcpRetakeEvidence } from "./acp-retake-evidence.js";
import type { RedskilledHostState } from "./host-state.js";
import type { RedskilledGithubGatewayRegistration } from "./github-gateway.js";
import type { RedskilledPaths } from "./paths.js";
import { resolvePermission } from "./acp-permission.js";
import type { RedskilledProjectRegistrationRequest } from "./project-registration.js";
import {
  demandTurnRunnerFor,
  type DemandTurnRecord,
  type DemandTurnResult,
} from "./acp-demand-turn.js";

/** One demand birth's turn, named the way the demand loop holds a project. */
export interface DemandBirthTurn {
  readonly workspacePath: string;
  readonly prompt: string;
  readonly workItem?: string;
  /** The runner the registration's launch declared (its `--child-agent` token). */
  readonly runner?: string;
  /** The Ticket handoff that puts the Worker in its Ticket loop (#4118). */
  readonly ticket?: Readonly<Record<string, unknown>>;
}
import {
  bindProjectControl,
  createProjectControlStore,
  coreProjectInvocation,
  runV1ProjectControlTurn,
  projectControlStorePath,
  runV2ProjectControlTurn,
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
import { admitNativeAcpWorker } from "./acp-worker-admission.js";
export { runNativeAcpWorker } from "@reddb-io/worker/acp";
import { runAcpWorkflowTurn } from "./acp-workflow-turn.js";
import { createHostBrainStore, type HostBrainStore } from "./brain-store.js";
import { createProjectMemoryStore, type ProjectMemoryStore } from "./memory-store.js";

export { ACP_V2_DRAFT_REVISION, REDSKILLS_WIRE_MAJOR } from "@reddb-io/protocol-acp";

export interface PublicSession {
  readonly request: NewSessionRequest;
  readonly project: AcpProjectWorkspace;
  readonly dispatchJournal: AcpDispatchJournal;
}

export interface RedskillsAcpControlPlane {
  readonly socketPath: string;
  /** Run one turn for a Worker nobody is watching (#4100, `acp-demand-turn.ts`). */
  runDemandTurn(request: DemandBirthTurn): Promise<DemandTurnResult>;
  close(): Promise<void>;
}

export interface StartRedskillsAcpControlPlaneOptions {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
  readonly hostState: () => RedskilledHostState;
  readonly githubGateway?: RedskilledGithubGatewayRegistration;
  /** Explicit endpoint authority; ordinary public/project ACP stays false. */
  readonly hostAdministration?: boolean;
  /** Where a dead Worker's evidence is kept; this operator's lane by default. */
  readonly evidenceRoot?: string;
  /** How long an expired evidence lane survives (ADR 0149 §2). Host policy. */
  readonly evidenceTtlMs?: number;
  /** Daemon clock used to date status projections. */
  readonly clock?: () => string;
  /** The host's one brain holder (ADR 0152); injected only by a test. */
  readonly brainStore?: HostBrainStore;
  /** The daemon's per-Project memory holder (ADR 0152); injected only by a test. */
  readonly memoryStore?: ProjectMemoryStore;
  /** Where an unattended turn's lifecycle goes when no client listens (#4100). */
  readonly recordDemandTurn?: (record: DemandTurnRecord) => void;
  /**
   * Register a project with the demand loop, on its own behalf (#4101).
   *
   * The daemon's own registration path, handed in rather than reached for: the
   * control plane must not learn a second way to write the record the lifecycle
   * owns. Absent means this endpoint cannot register — legal in a test, and the
   * drain then answers exactly as it did before registrations reached it.
   */
  readonly registerProject?: (request: RedskilledProjectRegistrationRequest) => unknown;
  /** The matching release path: a stop hands the self-sustaining registration
   * back (#4159). Absent means a stop flips the intent only — legal in a test. */
  readonly releaseProject?: (projectLabel: string) => unknown;
  /** Stamp a native Worker's turn events as its statusline pulse (#4181). */
  readonly workerPulse?: (pulse: { workerId: string; line?: string; issue?: string }) => void;
  /** The standing orders store for injecting orders into Worker briefs. */
  readonly standingOrdersStore?: StandingOrdersStore;
}

/** The store handles every connection on this endpoint shares (ADR 0152). */
interface StoreHolders {
  readonly brainStore: HostBrainStore;
  readonly memoryStore: ProjectMemoryStore;
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
  // Above the connection loop on purpose: every session shares this one handle.
  const brainStore = options.brainStore ?? createHostBrainStore();
  const memoryStore = options.memoryStore ?? createProjectMemoryStore();
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
  await removeAcpEndpoint(paths.acpSocketPath);

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void servePublicConnection(
      socket,
      { ...options, brainStore, memoryStore },
      workspaceFor,
      projectControls,
      persistProjectControls,
      sessionJournal,
    ).catch(() => socket.destroy());
  });
  await listen(server, paths.acpSocketPath);

  const runTurn = demandTurnRunnerFor(options, sessionJournal);
  // The demand loop holds a label and a path, never a bound Project: resolving
  // here keeps the one workspace resolver in the one place that owns it.
  const runDemandTurn = async (request: DemandBirthTurn): Promise<DemandTurnResult> => runTurn({
    project: await workspaceFor(await resolveAcpProjectIdentity(request.workspacePath)),
    prompt: request.prompt,
    ...(request.workItem == null ? {} : { workItem: request.workItem }),
    ...(request.runner == null || !(ACP_AGENT_IDS as readonly string[]).includes(request.runner)
      ? {}
      : { runner: request.runner as AcpAgentId }),
    ...(request.ticket == null ? {} : { ticket: request.ticket }),
  });  let closed = false;
  return {
    socketPath: paths.acpSocketPath,
    runDemandTurn,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await removeAcpEndpoint(paths.acpSocketPath);
      if (options.brainStore == null) await brainStore.close();
      if (options.memoryStore == null) await memoryStore.close();
    },
  };
}

async function servePublicConnection(
  socket: Socket,
  options: StartRedskillsAcpControlPlaneOptions & StoreHolders,
  workspaceFor: (identity: AcpProjectIdentity) => Promise<AcpProjectWorkspace>,
  projectControls: Map<string, ProjectControlState>,
  persistProjectControls: (projects: ReadonlyMap<string, ProjectControlState>) => Promise<void>,
  sessionJournal: DurableAcpSessionJournal,
): Promise<void> {
  /** What this daemon is serving, read fresh so a handover is visible at once. */
  const servedVersion = (): string => options.hostState().daemon_version;
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
  const { mutateProjectControl, readProjectStatus } = bindProjectControl({
    scopedProject,
    projectControls,
    persistProjectControls,
    hostState: options.hostState,
    clock: () => options.clock?.() ?? new Date().toISOString(),
    readGithubCustody: bindAcpProjectGithubCustodyStatus(options.githubGateway, scopedProject),
    ...(options.registerProject == null
      ? {}
      : { registerProject: (request) => options.registerProject!(request as never) }),
    ...(options.releaseProject == null
      ? {}
      : { releaseProject: (projectLabel) => options.releaseProject!(projectLabel) }),
  });

  const { v1: v1Methods, v2: v2Methods } = connectionMethodTables({
    paths: options.paths,
    startWorker: options.startWorker,
    githubGateway: options.githubGateway,
    hostAdministration: options.hostAdministration === true,
    brainStore: options.brainStore,
    memoryStore: options.memoryStore,
    sessionJournal,
    sessions,
    active,
    scopedState,
    scopedProject,
    hostState: options.hostState,
    mutateProjectControl,
    readProjectStatus: () => readProjectStatus(scopedProject()),
    onGithubReader: (reader) => {
      if (githubObserver != null || githubNotify == null) return;
      githubObserver = Promise.resolve(bindAcpGithubReaderUpdates(
        reader,
        (method, update) => githubNotify!(method, update),
      ));
    },
    permission: (sessionId, request, project) => resolvePermission(
      sessionJournal,
      sessionId,
      request,
      () => attached,
      project,
    ),
  });

  const v1App = agent({ name: "RedSkills" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      requireCompatibleWireMajor(params._meta);
      return {
        protocolVersion: params.protocolVersion === ACP_PROTOCOL_VERSION
          ? params.protocolVersion
          : ACP_PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: {} },
        agentInfo: { name: "RedSkills", version: servedVersion() },
        _meta: {
          redskills: {
            wireMajor: REDSKILLS_WIRE_MAJOR,
            // **The daemon says which version it serves** (ADR 0151). A client
            // that resolves a bundle from its own cache is one of three caches
            // deciding independently, which is how one machine came to hold
            // 3.17.1, 3.18.12 and 3.19.3 at once. Announced on the handshake so
            // a launcher can ask instead of guessing; a differing MINOR is
            // compatible by contract (ADR 0145 §3) and is not a refusal.
            servedVersion: servedVersion(),
            workerBacked: true,
            ...v1Methods.capabilities,
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

      const controlTurn = await runV1ProjectControlTurn(
        params,
        upstream,
        session.project,
        { mutate: mutateProjectControl, read: readProjectStatus },
      );
      if (controlTurn != null) return controlTurn;

      busy.add(params.sessionId);
      try {
        // Inject standing orders into the prompt if present
        let prompt = params.prompt;
        if (options.standingOrdersStore != null) {
          const ordersResult = await options.standingOrdersStore.show(session.project.projectLabel);
          if (ordersResult.orders.length > 0) {
            const ordersText = formatStandingOrdersBrief(ordersResult.orders);
            prompt = [{ type: "text", text: ordersText }, ...prompt];
          }
        }
        return await runAcpWorkflowTurn({
          sessionId: params.sessionId,
          prompt,
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
    });
  for (const binding of v1Methods.bindings) {
    v1App.onRequest(binding.method, binding.params, binding.handle);
  }

  const v2Turns = new Map<string, Promise<void>>();
  const v2App = acpV2.agent({ name: "RedSkills" })
    .onRequest(acpV2.methods.agent.initialize, ({ params }) => {
      requireCompatibleWireMajor(params._meta);
      requireSupportedV2Revision(params._meta);
      return {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "RedSkills", version: servedVersion() },
        capabilities: { session: {} },
        _meta: {
          redskills: {
            wireMajor: REDSKILLS_WIRE_MAJOR,
            // Same answer on both wires: the daemon owns the version (ADR 0151).
            servedVersion: servedVersion(),
            workerBacked: true,
            acpDraftRevision: ACP_V2_DRAFT_REVISION,
            ...v2Methods.capabilities,
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
      const invocation = coreProjectInvocation(params.prompt);
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
          return invocation == null
            ? runV2PublicTurn(options, sessionJournal, sessions, active, params, upstream, () => attached)
            : runV2ProjectControlTurn(
              sessions, params, upstream, invocation, projectControls, persistProjectControls, readProjectStatus,
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
    });
  for (const binding of v2Methods.bindings) {
    v2App.onRequest(binding.method, binding.params, binding.handle);
  }

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
    if (busy.has(sessionId) || v2Turns.has(sessionId)) {
      // **A busy Worker whose client left is finished or it is leaked.** The
      // turn paths already reap on completion when `attached()` is false — the
      // hole was a turn that never completes: an answer notified to a dead
      // upstream, a child that never ends. Measured on 2026-08-20 as Workers
      // alive 56 minutes for clients gone 55 of them, each holding a host slot
      // other projects were refused against.
      //
      // A DISPATCHED Ticket turn is the one busy shape that outlives its
      // client on purpose (#3885): it publishes through the daemon and its PR
      // is useful with nobody watching. An ordinary prompt turn's answer has
      // no reader, so it is cancelled — and cancellation gets a deadline,
      // because a cancel nobody bounds is the same eternal wait wearing a
      // politer name.
      if (worker.dispatch == null) {
        worker.cancelled = true;
        void worker.connection.agent
          .notify(methods.agent.session.cancel, { sessionId: worker.downstreamSessionId })
          .catch(() => undefined);
        const grace = setTimeout(() => {
          if (active.get(sessionId) === worker) {
            void reapWorkflowWorker(sessionId, worker, active, "detached-turn-deadline");
          }
        }, DETACHED_TURN_GRACE_MS);
        grace.unref();
      }
      continue;
    }
    cleanupWorkflowWorker(sessionId, worker, active);
  }
}

/**
 * How long a cancelled, client-less turn may take to end on its own before the
 * daemon reaps it. Generous: a child agent mid-tool-call finishes the call
 * before honouring cancellation. What it buys is that the slot RETURNS.
 */
const DETACHED_TURN_GRACE_MS = 120_000;

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
    // Inject standing orders into the prompt if present
    let prompt = params.prompt as unknown as PromptRequest["prompt"];
    if (options.standingOrdersStore != null) {
      const ordersResult = await options.standingOrdersStore.show(session.project.projectLabel);
      if (ordersResult.orders.length > 0) {
        const ordersText = formatStandingOrdersBrief(ordersResult.orders);
        prompt = [{ type: "text", text: ordersText }, ...prompt];
      }
    }
    const turn = await requestWorkflowTurn(
      params.sessionId,
      active,
      {
        sessionId: params.sessionId,
        prompt,
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
