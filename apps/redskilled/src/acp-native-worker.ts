/** Daemon admission and the native ACP Workflow Worker implementation. */
import { randomBytes, randomUUID } from "node:crypto";
import { constants, accessSync } from "node:fs";
import type { Socket } from "node:net";
import { delimiter, isAbsolute, join } from "node:path";
import {
  agent,
  client,
  methods,
  type AgentConnection,
  type McpServer,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { ACP_AGENT_CATALOG, type AcpEndpoint } from "./acp-agent-catalog.js";
import { WorkflowChildAgent } from "./acp-child-agent.js";
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_WIRE_MAJOR,
  abortableDelay,
  bindWorkerRendezvous,
  connectWithDeadline,
  removeAcpEndpoint,
  requireCompatibleWireMajor,
  socketStream,
  waitForAbort,
  withTimeout,
} from "@reddb-io/protocol-acp";
import {
  notifySessionRecovery,
  providerSessionEvidenceFromMeta,
  replacementRecoveryMeta,
  sessionRecoveryFromMeta,
  type AcpSessionJournal,
  type AcpSessionRecoveryCheckpoint,
} from "./acp-session-journal.js";
import type { AcpTargetedDispatchIntent } from "./acp-dispatch-intent.js";
import { resolveAcpWorkerEndpoint, type RedskilledPaths } from "./paths.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import type { LaunchedWorker, RedskilledWorkerSpec } from "./worker-launch.js";
import type { ActiveWorkflowWorker } from "./acp-worker-lifecycle.js";

interface NativeWorkerSession {
  readonly request: NewSessionRequest;
  readonly project: AcpProjectWorkspace;
}

interface NativeWorkerAdmissionOptions {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
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
  const rendezvous = await bindWorkerRendezvous(endpoint);
  let launched: LaunchedWorker;
  try {
    launched = options.startWorker(nativeWorkerSpec(session.project, endpoint, options.paths.runtimeDir));
  } catch (error) {
    rendezvous.server.close();
    await removeAcpEndpoint(endpoint);
    throw error;
  }

  let workerSocket: Socket;
  try {
    workerSocket = await withTimeout(rendezvous.connected, 10_000, "native ACP Worker rendezvous");
  } catch (error) {
    rendezvous.server.close();
    await removeAcpEndpoint(endpoint);
    throw error;
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
      cwd: session.project.workspacePath,
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
    throw error;
  }

  return {
    workerId: launched.worker.worker_id,
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
  endpoint: string,
  runtimeDir: string,
): RedskilledWorkerSpec {
  const entry = process.argv[1];
  if (entry == null || entry === "") throw new Error("redskilled cannot resolve its Worker entry");
  const childAgent = pinChildAgentExecutable(defaultChildAgentEndpoint());
  return {
    // The host's authority key must survive a repository rename. The current
    // GitHub full name remains display metadata on the public session.
    project_label: project.projectId,
    workspace_path: project.workspacePath,
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

/** The daemon-admitted native Workflow Worker. */
export async function runNativeAcpWorker(socketPath: string, childEndpoint: AcpEndpoint): Promise<number> {
  const controllers = new Map<string, AbortController>();
  const sessions = new Map<string, {
    readonly request: NewSessionRequest;
    child?: WorkflowChildAgent;
  }>();
  const recoveries = new Map<string, AcpSessionRecoveryCheckpoint>();
  const app = agent({ name: "RedSkills native Worker" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      requireCompatibleWireMajor(params._meta, true);
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: {} },
        agentInfo: { name: "RedSkills native Worker", version: "1" },
        _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR, worker: true } },
      };
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      const sessionId = randomUUID();
      sessions.set(sessionId, { request: params });
      const recovery = sessionRecoveryFromMeta(params._meta);
      if (recovery != null) recoveries.set(sessionId, recovery);
      return {
        sessionId,
        _meta: {
          redskills: {
            sessionEvidence: {
              provider: "redskills-native",
              availability: "absent",
            },
          },
        },
      };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client: parent }) => {
      const held = sessions.get(params.sessionId);
      if (held == null) throw new Error("unknown native Worker ACP session");
      const controller = new AbortController();
      controllers.set(params.sessionId, controller);
      try {
        const recovery = recoveries.get(params.sessionId);
        if (recovery != null) {
          recoveries.delete(params.sessionId);
          await notifySessionRecovery(parent, params.sessionId, recovery);
        }
        const prompt = promptText(params);
        if (prompt.includes("delegate child")) {
          held.child ??= new WorkflowChildAgent({
            endpoint: childEndpoint,
            cwd: held.request.cwd,
            mcpServers: held.request.mcpServers,
            ...(held.request.additionalDirectories == null
              ? {}
              : { additionalDirectories: held.request.additionalDirectories }),
            publicSessionId: params.sessionId,
            parent,
          });
          return await held.child.prompt(params);
        }
        await parent.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [{ content: "Execute the prompt inside the admitted native Worker", priority: "high", status: "in_progress" }],
          },
        });
        await parent.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "native Worker is executing the prompt\n" },
          },
          _meta: { redskills: { lifecycle: { event: "tool-activity" } } },
        });
        let permissionResolution: string | undefined;
        if (prompt.includes("permission")) {
          // The delay gives the public launch-edge transport time to disappear;
          // policy resolution remains daemon-owned after it does.
          await abortableDelay(75, controller.signal);
          const title = prompt.includes("denial")
            ? "denied operation"
            : prompt.includes("uncovered")
              ? "uncovered operation"
              : "governed write";
          const permission = await parent.request(methods.client.session.requestPermission, {
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: randomUUID(),
              title,
              kind: "edit",
              status: "pending",
            },
            options: [
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          });
          permissionResolution = (permission._meta as {
            redskills?: { permissionResolution?: string };
          } | undefined)?.redskills?.permissionResolution;
          if (permission.outcome.outcome === "cancelled" || permissionResolution === "hitl-required") {
            return {
              stopReason: "cancelled",
              _meta: { redskills: { permissionResolution, workflowOutcome: "permission-hitl" } },
            } satisfies PromptResponse;
          }
          const chosen = permission.outcome.optionId;
          if (chosen === "reject") {
            return {
              stopReason: "end_turn",
              _meta: { redskills: { permissionResolution } },
            } satisfies PromptResponse;
          }
        }
        if (prompt.includes("wait for cancellation")) {
          await waitForAbort(controller.signal);
        } else {
          await abortableDelay(35, controller.signal);
        }
        if (controller.signal.aborted) {
          await parent.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "native Worker cancelled the prompt\n" },
            },
          });
          return { stopReason: "cancelled" } satisfies PromptResponse;
        }

        await parent.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [{ content: "Execute the prompt inside the admitted native Worker", priority: "high", status: "completed" }],
          },
        });
        await parent.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `native Worker completed: ${prompt}\n` },
          },
        });
        const workflowOutcome = prompt.includes("complete workflow")
          ? "completion"
          : prompt.includes("budget verdict")
            ? "budget-verdict"
            : prompt.includes("replace worker")
              ? "replacement"
              : prompt.includes("explicit control")
                ? "explicit-control"
                : undefined;
        return {
          stopReason: "end_turn",
          ...(workflowOutcome == null && permissionResolution == null
            ? {}
            : { _meta: { redskills: { workflowOutcome, permissionResolution } } }),
        } satisfies PromptResponse;
      } finally {
        controllers.delete(params.sessionId);
      }
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      controllers.get(params.sessionId)?.abort();
      await sessions.get(params.sessionId)?.child?.cancel(params._meta);
    });

  const socket = await connectWithDeadline(socketPath, 10_000);
  const connection = app.connect(socketStream(socket));
  await connection.closed;
  for (const session of sessions.values()) session.child?.close();
  return 0;
}

function promptText(params: PromptRequest): string {
  return params.prompt
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
