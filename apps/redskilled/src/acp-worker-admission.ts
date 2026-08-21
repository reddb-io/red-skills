/**
 * Admission of a native ACP Workflow Worker: whether, when and where one exists.
 *
 * Everything here is a decision the Worker is not allowed to make for itself —
 * which child Agent it may spawn, where its rendezvous socket lives, what argv
 * re-execs it, and the journal pointers its session leaves behind. What the
 * admitted process then DOES lives in `@reddb-io/worker/acp` (ADR 0148).
 */
import { randomBytes } from "node:crypto";
import { constants, accessSync } from "node:fs";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  client,
  methods,
  type AgentConnection,
  type McpServer,
  type NewSessionRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { declaredChildAgentEndpoint, type AcpAgentId, type AcpEndpoint } from "./acp-agent-catalog.js";
import { childAgentWorkspaceEnv, ensureChildAgentHome } from "./acp-agent-home.js";
import { githubMethodDomain } from "./acp-github.js";
import { publicationMethodDomain } from "./acp-publication.js";
import {
  ACP_AGENT_IDS,
  ACP_PROTOCOL_VERSION,
  REDSKILLS_WIRE_MAJOR,
  bindWorkerRendezvous,
  removeAcpEndpoint,
  requireCompatibleWireMajor,
  socketStream,
  withTimeout,
} from "@reddb-io/protocol-acp";
import {
  providerSessionEvidenceFromMeta,
  replacementRecoveryMeta,
  type AcpSessionJournal,
} from "./acp-session-journal.js";
import type { AcpTargetedDispatchIntent } from "./acp-dispatch-intent.js";
import type { RedskilledGithubGatewayRegistration } from "./github-gateway.js";
import { workerModeEnv } from "@reddb-io/shared/working-mode.js";
import { resolveAcpWorkerEndpoint, type RedskilledPaths } from "./paths.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import { mintHostWorkerId, type LaunchedWorker, type RedskilledWorkerSpec } from "./worker-launch.js";
import {
  DEFAULT_WORKER_EVIDENCE_TTL_MS,
  workerEvidenceRoot,
  type WorkerEvidencePlan,
} from "./worker-evidence.js";
import {
  materializeWorkerWorkspace,
  releaseWorkerWorkspace,
  workerWorkspaceRoot,
  type MaterializedWorkerWorkspace,
} from "./worker-workspace.js";
import type { ActiveWorkflowWorker } from "./acp-worker-lifecycle.js";

interface NativeWorkerSession {
  readonly request: NewSessionRequest;
  readonly project: AcpProjectWorkspace;
}

interface NativeWorkerAdmissionOptions {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
  /**
   * The Workers this host already holds, so the minted id does not collide.
   *
   * The id is minted HERE rather than inside the launch, because the workspace
   * is named after it and has to exist before the process that stands in it
   * (ADR 0149 §3). Absent, the mint sees an empty live set — legal, since the id
   * is the birth instant and a collision walks it forward.
   */
  readonly hostState?: () => { readonly workers: readonly { readonly worker_id: string }[] };
  /** The host root Worker workspaces hang off. Defaults to the OS temporary root. */
  readonly workspaceRoot?: string;
  /**
   * The lane a dead Worker's log, session artifact and verdict are copied into.
   *
   * Defaults to this operator's `~/.red/tmp/workers` (ADR 0149 §2). Named here
   * rather than at cleanup because a handle being dropped is the last moment
   * anything knows this Worker existed.
   */
  readonly evidenceRoot?: string;
  /** How long an expired lane survives. Host policy; thirty days by default. */
  readonly evidenceTtlMs?: number;
  /**
   * The Project-bound GitHub gateway this Worker publishes and lands THROUGH.
   *
   * Absent is legal and means the Worker's publication requests are refused
   * with the gateway's own authorization answer — which is the truth when a
   * daemon has no forge, and better than a Worker discovering it by pushing.
   */
  readonly githubGateway?: RedskilledGithubGatewayRegistration;
}

export async function admitNativeAcpWorker(
  options: NativeWorkerAdmissionOptions,
  sessionJournal: AcpSessionJournal,
  session: NativeWorkerSession,
  publicSessionId: string,
  forward: AgentConnection["client"]["notify"],
  permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  replacement: boolean,
  dispatch?: AcpTargetedDispatchIntent,
): Promise<ActiveWorkflowWorker> {
  const endpointId = randomBytes(6).toString("hex");
  const endpoint = resolveAcpWorkerEndpoint(options.paths, endpointId);
  // The workspace is named after the id and has to exist before the process
  // that stands in it, so the mint happens here rather than inside the launch.
  const workerId = mintHostWorkerId((options.hostState?.().workers ?? []).map((worker) => worker.worker_id));
  const workspace = await materializeWorkerWorkspace({
    root: options.workspaceRoot ?? workerWorkspaceRoot(),
    workerId,
    projectWorkspacePath: session.project.workspacePath,
    // #4188: refresh the mirror's trunk from the canonical remote before the
    // fork, so the Worker's base — and its `origin` — are today's main.
    ...(session.project.remoteUrl == null ? {} : { trunk: { remoteUrl: session.project.remoteUrl } }),
  });
  const rendezvous = await bindWorkerRendezvous(endpoint);
  // Every failure from here on releases the workspace: a Worker that never
  // reached its rendezvous still cost a clone, and nothing else knows it exists.
  const abandon = async (error: unknown): Promise<never> => {
    rendezvous.server.close();
    await removeAcpEndpoint(endpoint);
    await releaseWorkerWorkspace(workspace).catch(() => undefined);
    throw error;
  };
  // The runner the registration declared travels on the session meta; a session
  // that names none gets the governed default. The choice is admission's, never
  // the Worker's (ADR 0148) — the Worker receives only the resolved endpoint.
  const runner = runnerFromSessionMeta(session.request._meta) ?? "redcode";
  let launched: LaunchedWorker;
  try {
    await ensureChildAgentHome(runner);
    launched = options.startWorker(
      nativeWorkerSpec(session.project, workspace, endpoint, options.paths.runtimeDir, dispatch?.workerKind, runner),
    );
  } catch (error) {
    return await abandon(error);
  }

  let workerSocket: Socket;
  try {
    workerSocket = await withTimeout(rendezvous.connected, 10_000, "native ACP Worker rendezvous");
  } catch (error) {
    return await abandon(error);
  }
  rendezvous.server.close();

  let downstreamSessionId = "";
  let sessionArtifact: WorkerEvidencePlan["sessionArtifact"];
  // Filled in once the handle exists, and read on every publication request.
  // Until then — and after `cleanupWorkflowWorker` marks the handle spent —
  // there is no Worker for the daemon to publish AS, and the domain refuses.
  const holding: { worker?: ActiveWorkflowWorker } = {};
  const publication = publicationMethodDomain({
    ...(options.githubGateway == null ? { gateway: undefined } : { gateway: options.githubGateway }),
    held: () => {
      const worker = holding.worker;
      if (worker == null || worker.cleaned) return undefined;
      return { workerId: worker.workerId, worktreePath: workspace.worktreePath, project: session.project };
    },
  });
  const downstreamApp = client({ name: "redskilled" })
    .onNotification(methods.client.session.update, async ({ params }) => {
      const downstreamRedskills = (params._meta as {
        redskills?: { lifecycle?: object };
      } | undefined)?.redskills;
      const notice: SessionNotification = {
        ...params,
        sessionId: publicSessionId,
        _meta: {
          ...(params._meta ?? {}),
          redskills: {
            ...(downstreamRedskills ?? {}),
            authority: "redskilled",
            workerId: launched.worker.worker_id,
            ...(dispatch == null ? {} : { dispatch }),
            ...(downstreamRedskills?.lifecycle == null ? {} : {
              lifecycle: {
                ...downstreamRedskills.lifecycle,
                workerId: launched.worker.worker_id,
                ...(dispatch == null ? {} : { dispatch }),
              },
            }),
          },
        },
      };
      await sessionJournal.update(publicSessionId, params.update);
      await forward(methods.client.session.update, notice);
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => permission({
      ...params,
      sessionId: publicSessionId,
    }));
  // **A Worker holds no credential, so every write it needs is a request to the
  // daemon** (ADR 0144 §3). The Ticket loop claims its Ticket through the
  // registry's `githubWrite`, and this connection served only publish and land
  // — so the first real drain refused at the claim with a method-not-found for
  // it, one Worker every fifteen seconds until somebody read the host lane. The
  // GitHub domain is bound here, scoped to the Project this Worker was admitted
  // for, for the same reason publication is: the socket says who is asking.
  const github = options.githubGateway == null
    ? undefined
    : githubMethodDomain({ gateway: options.githubGateway, scopedProject: () => session.project });
  for (const binding of [...publication.bindings, ...(github?.bindings ?? [])]) {
    // The Worker connection hands a handler no peer of its own: the daemon IS
    // the peer here, so the context the domain expects is completed with none.
    downstreamApp.onRequest(binding.method, binding.params, ({ params }) =>
      binding.handle({ params, client: undefined }));
  }
  const connection = downstreamApp.connect(socketStream(workerSocket));
  try {
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "redskilled", version: "1" },
      _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
    });
    requireCompatibleWireMajor(initialized._meta, true);
    const recovery = replacement ? sessionJournal.recovery(publicSessionId) : undefined;
    const recoveryMeta = recovery == null
      ? undefined
      : replacementRecoveryMeta(session.request._meta, recovery);
    const downstreamMeta = dispatch == null
      ? recoveryMeta
      : {
        ...(recoveryMeta ?? {}),
        redskills: {
          ...((recoveryMeta as { redskills?: object } | undefined)?.redskills ?? {}),
          dispatch,
        },
      };
    const downstreamSession = await connection.agent.request(methods.agent.session.new, {
      cwd: workspace.worktreePath,
      mcpServers: session.request.mcpServers as McpServer[],
      ...(session.request.additionalDirectories == null
        ? {}
        : { additionalDirectories: session.request.additionalDirectories }),
      ...(downstreamMeta == null ? {} : { _meta: downstreamMeta }),
    });
    downstreamSessionId = downstreamSession.sessionId;
    await sessionJournal.worker(publicSessionId, launched.worker.worker_id, downstreamSessionId, replacement);
    const evidence = providerSessionEvidenceFromMeta(downstreamSession._meta);
    if (evidence != null) {
      sessionArtifact = evidence;
      await sessionJournal.evidence(publicSessionId, launched.worker.worker_id, evidence);
    }
  } catch (error) {
    connection.close();
    workerSocket.destroy();
    await removeAcpEndpoint(endpoint);
    await releaseWorkerWorkspace(workspace).catch(() => undefined);
    throw error;
  }

  const admitted: ActiveWorkflowWorker = {
    workerId: launched.worker.worker_id,
    workspace,
    evidence: {
      root: options.evidenceRoot ?? workerEvidenceRoot(homedir()),
      ttlMs: options.evidenceTtlMs ?? DEFAULT_WORKER_EVIDENCE_TTL_MS,
      ...(launched.worker.log_path == null ? {} : { logPath: launched.worker.log_path }),
      ...(sessionArtifact == null ? {} : { sessionArtifact }),
    },
    downstreamSessionId,
    connection,
    socket: workerSocket,
    endpoint,
    publicSessionId,
    notify: forward,
    ...(dispatch == null ? {} : { dispatch }),
    cancelled: false,
    cleaned: false,
  };
  holding.worker = admitted;
  return admitted;
}

export function nativeWorkerSpec(
  project: AcpProjectWorkspace,
  workspace: MaterializedWorkerWorkspace,
  endpoint: string,
  runtimeDir: string,
  workerKind: "afk" | "go" | "scout" | undefined,
  runner: AcpAgentId = "redcode",
): RedskilledWorkerSpec {
  const entry = process.argv[1];
  if (entry == null || entry === "") throw new Error("redskilled cannot resolve its Worker entry");
  const childAgent = pinChildAgentExecutable(declaredChildAgentEndpoint(runner));
  return {
    worker_id: workspace.workerId,
    // The registration store, the demand loop's live count, and queue discovery
    // all key a project by the registration's project_label. A Worker recorded
    // under projectId is invisible to every one of them: the demand loop reads
    // live=0 forever, births another Worker each tick, and the host ceiling
    // fills with connected Workers no ticket route can find (#4129 drain).
    project_label: project.projectLabel,
    // The Worker stands in ITS OWN worktree in temporary storage (ADR 0149 §1);
    // the Project workspace is what that worktree was forked from, never a cwd
    // two Workers could share.
    workspace_path: workspace.worktreePath,
    // ADR 0150 §2: the run declares its Working mode, so a skill written for a
    // human's checkout refuses inside a Worker instead of running there.
    env: {
      ...workerModeEnv(workerKind),
      ...childAgentWorkspaceEnv(childAgent.agent, workspace.workspacePath),
    },
    command: process.execPath,
    args: [
      ...process.execArgv,
      entry,
      "acp-worker",
      "--socket", endpoint,
      "--child-agent", childAgent.agent,
      "--child-command", childAgent.command,
      // The unattended posture of an Agent that parses no argv (#4278): the
      // Worker sets it as a session mode, so it has to reach the Worker.
      ...(childAgent.unattendedSessionMode == null
        ? []
        : ["--child-session-mode", childAgent.unattendedSessionMode]),
      // Inline form, because an adapter's args start with dashes (`-y`, `-p`)
      // and the pair form reads the next dash token as a flag, not a value.
      ...childAgent.args.map((arg) => `--child-arg=${arg}`),
    ],
    log_path: join(runtimeDir, "acp-workers", `${randomBytes(6).toString("hex")}.toonl`),
  };
}

function pinChildAgentExecutable(endpoint: AcpEndpoint): AcpEndpoint {
  if (isAbsolute(endpoint.command) || endpoint.command.includes("/") || endpoint.command.includes("\\")) {
    return endpoint;
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${endpoint.command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return { ...endpoint, command: candidate };
      } catch {
        // Try the next host PATH entry; child launch still accounts for total absence.
      }
    }
  }
  return endpoint;
}

/** The runner the session's daemon-side composer declared; null when it declared none. */
export function runnerFromSessionMeta(meta: unknown): AcpAgentId | null {
  const candidate = (meta as { redskills?: { runner?: unknown } } | undefined)?.redskills?.runner;
  return typeof candidate === "string" && (ACP_AGENT_IDS as readonly string[]).includes(candidate)
    ? (candidate as AcpAgentId)
    : null;
}
