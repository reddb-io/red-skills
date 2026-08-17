/**
 * Stateless Project client for public adapters.
 *
 * Durable Project and workflow state remains behind the redskilled ACP Agent.
 * This object owns only one live ACP connection and its public session id.
 */
import { connect, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { ensureRedskilledDaemon } from "./client.js";
import { resolveRedskilledClientEndpoint } from "./client-rendezvous.js";
import { REDSKILLS_WIRE_MAJOR } from "./acp-compat.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";

export type RedskillsProjectControlOperation = "drain" | "stop" | "status";

export interface RedskillsProjectControlSnapshot {
  readonly version: 1;
  readonly project_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly drain_intent: "inactive" | "draining" | "stopped";
  readonly revision: number;
  readonly updates: ReadonlyArray<{
    readonly sequence: number;
    readonly operation: "drain" | "stop";
    readonly drain_intent: "draining" | "stopped";
  }>;
}

export interface RedskillsProjectPromptResult {
  readonly stopReason: string;
  readonly projectControl?: RedskillsProjectControlSnapshot;
  readonly updates: readonly SessionNotification["update"][];
}

export interface RedskillsProjectAcpSession {
  control(operation: RedskillsProjectControlOperation): Promise<RedskillsProjectControlSnapshot>;
  prompt(text: string): Promise<RedskillsProjectPromptResult>;
  cancel(): Promise<void>;
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  close(): void;
}

export interface ConnectRedskillsProjectAcpOptions {
  readonly cwd?: string;
  readonly name?: string;
  readonly version?: string;
  readonly paths?: RedskilledPaths;
  readonly onUpdate?: (update: SessionNotification["update"]) => void | Promise<void>;
  readonly requestPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

const PROJECT_CONTROL_METHOD = {
  drain: "_redskills/project_drain",
  stop: "_redskills/project_stop",
  status: "_redskills/project_status",
} as const;

/** Connect a public adapter to redskilled through ACP and no private daemon wire. */
export async function connectRedskillsProjectAcp(
  options: ConnectRedskillsProjectAcpOptions = {},
): Promise<RedskillsProjectAcpSession> {
  const cwd = options.cwd ?? process.cwd();
  const name = options.name ?? "RedSkills Project client";
  const version = options.version ?? "1";
  const paths = options.paths ?? resolveRedskilledPaths();
  await ensureRedskilledDaemon(paths);
  const endpoint = (await resolveRedskilledClientEndpoint(paths)).paths;
  const socket = await connectEndpoint(endpoint.acpSocketPath);
  const pendingUpdates: SessionNotification["update"][] = [];
  let publicSessionId = "";

  let app = client({ name })
    .onNotification(methods.client.session.update, async ({ params }) => {
      if (params.sessionId !== publicSessionId) return;
      pendingUpdates.push(params.update);
      await options.onUpdate?.(params.update);
    });
  if (options.requestPermission != null) {
    app = app.onRequest(methods.client.session.requestPermission, ({ params }) =>
      options.requestPermission!(params));
  }
  const connection = app.connect(ndJsonStream(
    Writable.toWeb(socket) as WritableStream<Uint8Array>,
    Readable.toWeb(socket) as ReadableStream<Uint8Array>,
  ));
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name, version },
    _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
  });
  publicSessionId = (await connection.agent.request(methods.agent.session.new, {
    cwd,
    mcpServers: [],
  })).sessionId;

  return {
    control(operation) {
      return connection.agent.request<RedskillsProjectControlSnapshot>(PROJECT_CONTROL_METHOD[operation], {});
    },
    async prompt(text) {
      const firstUpdate = pendingUpdates.length;
      const response = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: publicSessionId,
        prompt: [{ type: "text", text }],
      });
      return {
        stopReason: response.stopReason,
        ...projectControlFrom(response._meta),
        updates: pendingUpdates.slice(firstUpdate),
      };
    },
    cancel() {
      return connection.agent.notify(methods.agent.session.cancel, { sessionId: publicSessionId });
    },
    async permission(request) {
      if (options.requestPermission == null) {
        return {
          outcome: { outcome: "cancelled" },
          _meta: { redskills: { permissionResolution: "hitl-required" } },
        };
      }
      return await options.requestPermission(request);
    },
    close() {
      connection.close();
      socket.destroy();
    },
  };
}

function projectControlFrom(meta: unknown): { projectControl?: RedskillsProjectControlSnapshot } {
  const redskills = record(record(meta)?.redskills);
  const projectControl = redskills?.projectControl;
  return isProjectControl(projectControl)
    ? { projectControl: projectControl as unknown as RedskillsProjectControlSnapshot }
    : {};
}

function isProjectControl(value: unknown): boolean {
  const control = record(value);
  return control?.version === 1 && typeof control.project_id === "string" &&
    typeof control.revision === "number" && Array.isArray(control.updates);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function connectEndpoint(endpoint: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect(endpoint);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
