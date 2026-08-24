/**
 * Stateless Project client for public adapters.
 *
 * Durable Project and workflow state remains behind the redskilled ACP Agent.
 * This object owns only one live ACP connection and its public session id.
 */
import { connect, type Socket } from "node:net";
import {
  client,
  methods,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { socketStream } from "@reddb-io/protocol-acp";
import { ensureRedskilledDaemon } from "./client.js";
import { resolveRedskilledClientEndpoint } from "./client-rendezvous.js";
import {
  REDSKILLS_ACP_METHODS,
  REDSKILLS_WIRE_MAJOR,
  type GoDispatchAnswer,
  type RedskilledBrainAnswer,
  type RedskilledBrainCall,
  type RedskilledMemoryAnswer,
  type RedskilledMemoryCall,
  type RedskilledGithubRequest,
} from "@reddb-io/protocol-acp";
import type { RedskilledGithubRequestAnswer } from "./github-request.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";
import type { ProjectStatusContext } from "./project-control.js";

export type RedskillsProjectControlOperation = "drain" | "stop" | "status";

/** What a control call may ask for, opaque to the daemon beyond its shape. */
export interface RedskillsProjectControlRequest {
  readonly target?: number;
  readonly runner?: string;
  /** The work this drain carries, authored by the project (#4101). */
  readonly registration?: Readonly<Record<string, unknown>>;
}

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

export type RedskillsProjectStatusContext = ProjectStatusContext;

export interface RedskillsProjectStatusSnapshot extends RedskillsProjectControlSnapshot {
  readonly context: RedskillsProjectStatusContext;
}

export interface RedskillsProjectPromptResult {
  readonly stopReason: string;
  readonly projectControl?: RedskillsProjectControlSnapshot;
  readonly updates: readonly SessionNotification["update"][];
}

export interface RedskillsProjectAcpSession {
  control(operation: "status"): Promise<RedskillsProjectStatusSnapshot>;
  /**
   * A control call CARRIES its request. A width the caller asked for that the
   * wire drops is worse than a refusal: the caller reads a healthy answer and
   * believes a number that never arrived.
   */
  control(
    operation: "drain" | "stop",
    request?: RedskillsProjectControlRequest,
  ): Promise<RedskillsProjectControlSnapshot>;
  /**
   * Forward one forge-shaped request to the daemon's Project gateway.
   *
   * The client composes the envelope and nothing else: which credential profile
   * answers it, whether a cached value is fresh enough to serve, and whether a
   * mutation is scheduled durably are all decided on the far side of this call.
   */
  github(request: RedskilledGithubRequest): Promise<RedskilledGithubRequestAnswer>;
  /**
   * Dispatch one ad-hoc demand through the daemon's own `/go` authority.
   *
   * The wire carries exactly the demand (ADR 0150 §3): lane, tracker, Worker
   * kind, budget and placement are the daemon's verdicts.
   */
  goDispatch(demand: string): Promise<GoDispatchAnswer>;
  /**
   * The daemon's whole host document: every Worker, every registration, the
   * daemon's own health. The read `status { scope: host }` answers from.
   */
  hostState(): Promise<unknown>;
  /**
   * Forward one brain tool call to the store the daemon holds for this host.
   *
   * The client names a tool and its arguments and nothing else: WHERE the brain
   * is, and whether it is already open, are answered on the far side of this
   * call — which is the whole point of the daemon holding it (ADR 0152).
   */
  brain(call: RedskilledBrainCall): Promise<RedskilledBrainAnswer>;
  /**
   * Forward one memory tool call to the store the daemon holds for this Project.
   *
   * The client names a tool, its arguments and its own Working mode. WHICH root
   * that resolves to — the Project's own, or this checkout's when the repository
   * opted in — is answered on the far side of this call, which is the whole
   * point of the daemon holding it (ADR 0152).
   */
  memory(call: RedskilledMemoryCall): Promise<RedskilledMemoryAnswer>;
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
  drain: REDSKILLS_ACP_METHODS.projectDrain,
  stop: REDSKILLS_ACP_METHODS.projectStop,
  status: REDSKILLS_ACP_METHODS.projectStatus,
} as const;

/**
 * One live dialled connection: socket, handshake, public session. Everything
 * here dies with the socket; the session object above it survives by dialling
 * a replacement (#4154).
 */
interface LiveProjectAcpConnection {
  readonly connection: ReturnType<ReturnType<typeof client>["connect"]>;
  readonly socket: Socket;
  readonly sessionId: string;
  readonly pendingUpdates: SessionNotification["update"][];
  readonly dead: () => boolean;
  readonly close: () => void;
}

/** Connect a public adapter to redskilled through ACP and no private daemon wire. */
export async function connectRedskillsProjectAcp(
  options: ConnectRedskillsProjectAcpOptions = {},
): Promise<RedskillsProjectAcpSession> {
  const cwd = options.cwd ?? process.cwd();
  const name = options.name ?? "RedSkills Project client";
  const version = options.version ?? "1";
  const paths = options.paths ?? resolveRedskilledPaths();

  const dial = async (): Promise<LiveProjectAcpConnection> => {
    await ensureRedskilledDaemon(paths);
    const endpoint = (await resolveRedskilledClientEndpoint(paths)).paths;
    const socket = await connectEndpoint(endpoint.acpSocketPath);
    const pendingUpdates: SessionNotification["update"][] = [];
    let sessionId = "";
    let dead = false;
    socket.once("close", () => { dead = true; });
    socket.once("error", () => { dead = true; });

    let app = client({ name })
      .onNotification(methods.client.session.update, async ({ params }) => {
        if (params.sessionId !== sessionId) return;
        pendingUpdates.push(params.update);
        await options.onUpdate?.(params.update);
      });
    if (options.requestPermission != null) {
      app = app.onRequest(methods.client.session.requestPermission, ({ params }) =>
        options.requestPermission!(params));
    }
    const connection = app.connect(socketStream(socket));
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name, version },
      _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
    });
    sessionId = (await connection.agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    })).sessionId;
    return {
      connection,
      socket,
      sessionId,
      pendingUpdates,
      dead: () => dead,
      close() {
        dead = true;
        connection.close();
        socket.destroy();
      },
    };
  };

  // The first dial fails exactly as it always did: a caller that connects to a
  // machine with no daemon deserves the fail-closed answer immediately, not a
  // session that will fail later.
  const healing = await createSelfHealingDial(dial);
  const ensureLive = healing.ensure;

  const control = (async (
    operation: RedskillsProjectControlOperation,
    request: RedskillsProjectControlRequest = {},
  ) => {
    const held = await ensureLive();
    const outcome = await held.connection.agent.request<unknown>(PROJECT_CONTROL_METHOD[operation], {
      ...(request.target == null ? {} : { target: request.target }),
      ...(request.runner == null ? {} : { runner: request.runner }),
      ...(request.registration == null ? {} : { registration: request.registration }),
    });
    if (!isProjectControl(outcome)) throw new Error("redskilled returned an invalid Project control outcome");
    if (operation === "status" && !isProjectStatus(outcome)) {
      throw new Error("redskilled returned Project status without a valid RedSkills context");
    }
    return outcome;
  }) as RedskillsProjectAcpSession["control"];

  return {
    control,
    async github(request) {
      const held = await ensureLive();
      return await held.connection.agent.request<RedskilledGithubRequestAnswer>(
        REDSKILLS_ACP_METHODS.githubRequest,
        { request },
      );
    },
    async goDispatch(demand) {
      const held = await ensureLive();
      return await held.connection.agent.request<GoDispatchAnswer>(
        REDSKILLS_ACP_METHODS.goDispatch,
        { demand },
      );
    },
    async hostState() {
      const held = await ensureLive();
      return await held.connection.agent.request<unknown>(REDSKILLS_ACP_METHODS.hostState, {});
    },
    async brain(call) {
      const held = await ensureLive();
      return await held.connection.agent.request<RedskilledBrainAnswer>(
        REDSKILLS_ACP_METHODS.brainCall,
        { tool: call.tool, arguments: call.arguments },
      );
    },
    async memory(call) {
      const held = await ensureLive();
      return await held.connection.agent.request<RedskilledMemoryAnswer>(
        REDSKILLS_ACP_METHODS.memoryCall,
        { tool: call.tool, arguments: call.arguments, ...(call.mode == null ? {} : { mode: call.mode }) },
      );
    },
    async prompt(text) {
      const held = await ensureLive();
      const firstUpdate = held.pendingUpdates.length;
      const response = await held.connection.agent.request(methods.agent.session.prompt, {
        sessionId: held.sessionId,
        prompt: [{ type: "text", text }],
      });
      return {
        stopReason: response.stopReason,
        ...projectControlFrom(response._meta),
        updates: held.pendingUpdates.slice(firstUpdate),
      };
    },
    async cancel() {
      const held = await ensureLive();
      return await held.connection.agent.notify(methods.agent.session.cancel, { sessionId: held.sessionId });
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
      healing.close();
    },
  };
}

/**
 * The connection every call rides, re-dialled when the held one died (#4154).
 *
 * A daemon restart is a routine event on a machine that installs releases, so
 * a dead connection is an instruction to dial again — single-flight, so
 * concurrent tool calls share one replacement instead of leaking sockets. Only
 * a genuinely unreachable daemon surfaces, with the provision repair the dial
 * already carries. The FIRST dial happens here and fails to the caller
 * directly: a machine with no daemon deserves the fail-closed answer at
 * connect time, never a session that fails later.
 */
export async function createSelfHealingDial<Held extends { dead(): boolean; close(): void }>(
  dial: () => Promise<Held>,
): Promise<{ ensure(): Promise<Held>; close(): void }> {
  let live = await dial();
  let closed = false;
  let redialling: Promise<Held> | null = null;
  return {
    async ensure() {
      if (closed) throw new Error("this RedSkills Project ACP client is closed");
      if (!live.dead()) return live;
      redialling ??= dial().then(
        (replacement) => { live = replacement; redialling = null; return replacement; },
        (error) => { redialling = null; throw error; },
      );
      return await redialling;
    },
    close() {
      closed = true;
      live.close();
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

function isProjectStatus(value: unknown): value is RedskillsProjectStatusSnapshot {
  const context = record(record(value)?.context);
  const queue = record(context?.queue);
  const workers = record(context?.workers);
  const adapter = record(context?.adapter_health);
  return context?.version === 1 && typeof context.observed_at === "string" &&
    typeof queue?.posture === "string" &&
    (queue.depth === null || typeof queue.depth === "number") &&
    (queue.target === null || typeof queue.target === "number") &&
    typeof queue.live === "number" &&
    (queue.wanted === null || typeof queue.wanted === "number") &&
    (queue.observed_at === null || typeof queue.observed_at === "string") &&
    (queue.age_ms === null || typeof queue.age_ms === "number") &&
    (queue.freshness === "fresh" || queue.freshness === "stale" || queue.freshness === "unknown") &&
    typeof queue.detail === "string" &&
    workers?.freshness === "fresh" && typeof workers.observed_at === "string" &&
    typeof workers.total === "number" && Array.isArray(workers.items) &&
    workers.items.every(isProjectWorkerSummary) &&
    (adapter?.status === "healthy" || adapter?.status === "degraded" || adapter?.status === "unknown") &&
    (adapter.checked_at === null || typeof adapter.checked_at === "string") &&
    (adapter.last_success_at === null || typeof adapter.last_success_at === "string") &&
    (adapter.last_failure_at === null || typeof adapter.last_failure_at === "string") &&
    typeof adapter.detail === "string";
}

function isProjectWorkerSummary(value: unknown): boolean {
  const worker = record(value);
  return typeof worker?.worker_id === "string" && worker.state === "running" &&
    typeof worker.started_at === "string" && typeof worker.isolated === "boolean" &&
    Array.isArray(worker.warnings) && worker.warnings.every((warning) => typeof warning === "string") &&
    (worker.base_commits_ahead === null || typeof worker.base_commits_ahead === "number");
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
