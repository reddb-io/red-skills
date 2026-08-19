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
import { ACP_AGENT_CATALOG, type AcpEndpoint } from "./acp-agent-catalog.js";
import {
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
import { workerModeEnv } from "@reddb-io/shared/working-mode.js";
import { resolveAcpWorkerEndpoint, type RedskilledPaths } from "./paths.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import { mintHostWorkerId, type LaunchedWorker, type RedskilledWorkerSpec } from "./worker-launch.js";
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
  let launched: LaunchedWorker;
  try {
    launched = options.startWorker(
      nativeWorkerSpec(session.project, workspace, endpoint, options.paths.runtimeDir, dispatch?.workerKind),
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
      await sessionJournal.evidence(publicSessionId, launched.worker.worker_id, evidence);
    }
  } catch (error) {
    connection.close();
    workerSocket.destroy();
    await removeAcpEndpoint(endpoint);
    await releaseWorkerWorkspace(workspace).catch(() => undefined);
    throw error;
  }

  return {
    workerId: launched.worker.worker_id,
    workspace,
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
}

function nativeWorkerSpec(
  project: AcpProjectWorkspace,
  workspace: MaterializedWorkerWorkspace,
  endpoint: string,
  runtimeDir: string,
  workerKind: "afk" | "go" | "scout" | undefined,
): RedskilledWorkerSpec {
  const entry = process.argv[1];
  if (entry == null || entry === "") throw new Error("redskilled cannot resolve its Worker entry");
  const childAgent = pinChildAgentExecutable(defaultChildAgentEndpoint());
  return {
    worker_id: workspace.workerId,
    // The host's authority key must survive a repository rename. The current
    // GitHub full name remains display metadata on the public session.
    project_label: project.projectId,
    // The Worker stands in ITS OWN worktree in temporary storage (ADR 0149 §1);
    // the Project workspace is what that worktree was forked from, never a cwd
    // two Workers could share.
    workspace_path: workspace.worktreePath,
    // ADR 0150 §2: the run declares its Working mode, so a skill written for a
    // human's checkout refuses inside a Worker instead of running there.
    env: workerModeEnv(workerKind),
    command: process.execPath,
    args: [
      ...process.execArgv,
      entry,
      "acp-worker",
      "--socket", endpoint,
      "--child-agent", childAgent.agent,
      "--child-command", childAgent.command,
      ...childAgent.args.flatMap((arg) => ["--child-arg", arg]),
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

function defaultChildAgentEndpoint(): AcpEndpoint {
  const descriptor = ACP_AGENT_CATALOG.find(({ id }) => id === "redcode");
  if (descriptor == null || descriptor.kind !== "native") {
    throw new Error("the governed Redcode child ACP endpoint is not configured");
  }
  return {
    agent: descriptor.id,
    transport: "stdio",
    command: descriptor.command[0],
    args: descriptor.command.slice(1),
  };
}
