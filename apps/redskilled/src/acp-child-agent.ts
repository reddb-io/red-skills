/** Worker-owned ACP Client for one governed child coding Agent. */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  type AgentConnection,
  type ClientConnection,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpEndpoint } from "./acp-agent-catalog.js";
import { ACP_PROTOCOL_VERSION, REDSKILLS_WIRE_MAJOR } from "./acp-compat.js";

export interface ChildAgentSessionOptions {
  readonly endpoint: AcpEndpoint;
  readonly cwd: string;
  readonly mcpServers: readonly McpServer[];
  readonly additionalDirectories?: readonly string[];
  readonly publicSessionId: string;
  readonly parent: AgentConnection["client"];
}

interface ActiveChildAgent {
  readonly child: ChildProcess;
  readonly connection: ClientConnection;
  readonly sessionId: string;
  cleaned: boolean;
}

const DELEGATION_SCOPE = {
  authority: "parent-worker",
  budget: "parent-remaining",
  cancellation: "parent-mediated",
  permissions: "parent-mediated",
} as const;

/** One Workflow Worker may retain one child Agent, but never replace it more than once per turn. */
export class WorkflowChildAgent {
  readonly #options: ChildAgentSessionOptions;
  #active: ActiveChildAgent | undefined;

  constructor(options: ChildAgentSessionOptions) {
    this.#options = options;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    let attempts = 1;
    let active = this.#active ?? await this.#admit("child-admission");
    try {
      const response = await this.#request(active, params);
      if (response.stopReason === "cancelled") this.#cleanup(active);
      return childResponse(response, this.#options.endpoint.agent, attempts);
    } catch (error) {
      if (!childTransportIsClosed(active)) throw error;
      this.#cleanup(active);
    }

    attempts += 1;
    active = await this.#admit("child-replacement");
    try {
      const response = await this.#request(active, params);
      if (response.stopReason === "cancelled") this.#cleanup(active);
      return childResponse(response, this.#options.endpoint.agent, attempts);
    } catch (error) {
      this.#cleanup(active);
      await this.#lifecycle("child-failure");
      throw error;
    }
  }

  async cancel(meta?: PromptRequest["_meta"]): Promise<void> {
    const active = this.#active;
    if (active == null) return;
    await active.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: active.sessionId,
      ...(meta == null ? {} : { _meta: meta }),
    });
  }

  close(): void {
    if (this.#active != null) this.#cleanup(this.#active);
  }

  async #admit(event: "child-admission" | "child-replacement"): Promise<ActiveChildAgent> {
    const endpoint = this.#options.endpoint;
    const child = spawn(endpoint.command, endpoint.args, {
      cwd: this.#options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (child.stdin == null || child.stdout == null) throw new Error("child ACP Agent did not expose stdio");

    const app = client({ name: "RedSkills Workflow Worker" })
      .onNotification(methods.client.session.update, ({ params }) => this.#options.parent.notify(
        methods.client.session.update,
        publicNotice(params, this.#options.publicSessionId, endpoint.agent),
      ))
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.#options.parent.request(
        methods.client.session.requestPermission,
        { ...params, sessionId: this.#options.publicSessionId },
      ) as Promise<RequestPermissionResponse>);
    const connection = app.connect(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "RedSkills Workflow Worker", version: "1" },
        _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
      });
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: this.#options.cwd,
        mcpServers: [...this.#options.mcpServers],
        ...(this.#options.additionalDirectories == null
          ? {}
          : { additionalDirectories: [...this.#options.additionalDirectories] }),
        _meta: { redskills: { delegation: DELEGATION_SCOPE } },
      });
      const active = { child, connection, sessionId: session.sessionId, cleaned: false };
      this.#active = active;
      await this.#lifecycle(event);
      return active;
    } catch (error) {
      connection.close();
      child.kill();
      throw error;
    }
  }

  #request(active: ActiveChildAgent, params: PromptRequest): Promise<PromptResponse> {
    return active.connection.agent.request(methods.agent.session.prompt, {
      sessionId: active.sessionId,
      prompt: params.prompt,
      _meta: {
        ...(params._meta ?? {}),
        redskills: {
          ...((params._meta as { redskills?: object } | undefined)?.redskills ?? {}),
          delegation: DELEGATION_SCOPE,
        },
      },
    });
  }

  #cleanup(active: ActiveChildAgent): void {
    if (active.cleaned) return;
    active.cleaned = true;
    if (this.#active === active) this.#active = undefined;
    active.connection.close();
    if (active.child.exitCode == null && active.child.signalCode == null) active.child.kill();
  }

  #lifecycle(event: string): Promise<void> {
    return this.#options.parent.notify(methods.client.session.update, {
      sessionId: this.#options.publicSessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
      _meta: { redskills: { lifecycle: { event, agent: this.#options.endpoint.agent } } },
    });
  }
}

function publicNotice(params: SessionNotification, sessionId: string, agent: string): SessionNotification {
  return {
    ...params,
    sessionId,
    _meta: {
      ...(params._meta ?? {}),
      redskills: {
        ...((params._meta as { redskills?: object } | undefined)?.redskills ?? {}),
        childAgent: agent,
      },
    },
  };
}

function childResponse(response: PromptResponse, agent: string, attempts: number): PromptResponse {
  return {
    ...response,
    _meta: {
      ...(response._meta ?? {}),
      redskills: {
        ...((response._meta as { redskills?: object } | undefined)?.redskills ?? {}),
        childAgent: agent,
        childAttempts: attempts,
      },
    },
  };
}

function childTransportIsClosed(active: ActiveChildAgent): boolean {
  return active.child.exitCode != null || active.child.signalCode != null ||
    active.child.stdin?.destroyed === true || active.child.stdout?.destroyed === true;
}
