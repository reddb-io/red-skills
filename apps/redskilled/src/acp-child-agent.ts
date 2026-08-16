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
import { createChildAcpSpinEpisode, type ChildAcpSpinEpisode } from "./acp-child-spin.js";
import type { SpinPattern } from "@reddb-io/red-castle/engine/spin-evaluator";

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
  readonly supportsSteering: boolean;
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
  #spinEpisode: ChildAcpSpinEpisode | undefined;
  #spinUpdates: Promise<void> = Promise.resolve();

  constructor(options: ChildAgentSessionOptions) {
    this.#options = options;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    let attempts = 1;
    let active = this.#active ?? await this.#admit("child-admission");
    try {
      return await this.#promptActive(active, params, attempts);
    } catch (error) {
      if (!childTransportIsClosed(active)) throw error;
      this.#cleanup(active);
    }

    attempts += 1;
    active = await this.#admit("child-replacement");
    try {
      return await this.#promptActive(active, params, attempts);
    } catch (error) {
      this.#cleanup(active);
      await this.#lifecycle("child-failure");
      throw error;
    }
  }

  async #promptActive(
    active: ActiveChildAgent,
    params: PromptRequest,
    attempts: number,
  ): Promise<PromptResponse> {
    const episode = createChildAcpSpinEpisode();
    this.#spinEpisode = episode;
    let steers = 0;
    try {
      let response = await this.#request(active, params);
      await this.#spinUpdates;
      if (active.supportsSteering) {
        const detected = episode.beginSteer();
        if (detected != null) {
          steers = 1;
          await this.#lifecycle("child-spin-steer", detected);
          response = await this.#request(active, spinSteerRequest(params, detected));
          await this.#spinUpdates;
        }
      } else {
        const unsteered = episode.persistWithoutSteer();
        if (unsteered != null) await this.#lifecycle("child-spin-persistent", unsteered);
      }
      const persistent = episode.persistentPattern();
      if (response.stopReason === "cancelled") this.#cleanup(active);
      return persistent == null
        ? childResponse(response, this.#options.endpoint.agent, attempts)
        : childSpinResponse(response, this.#options.endpoint.agent, attempts, persistent, steers);
    } finally {
      if (this.#spinEpisode === episode) this.#spinEpisode = undefined;
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
      .onNotification(methods.client.session.update, ({ params }) => {
        const project = async () => {
          const spin = this.#spinEpisode?.observe(params.update) ?? null;
          await this.#options.parent.notify(
            methods.client.session.update,
            publicNotice(params, this.#options.publicSessionId, endpoint.agent),
          );
          if (spin != null) await this.#lifecycle(`child-spin-${spin.kind}`, spin.pattern);
        };
        this.#spinUpdates = this.#spinUpdates.then(project, project);
        return this.#spinUpdates;
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.#options.parent.request(
        methods.client.session.requestPermission,
        { ...params, sessionId: this.#options.publicSessionId },
      ) as Promise<RequestPermissionResponse>);
    const connection = app.connect(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
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
      const active = {
        child,
        connection,
        sessionId: session.sessionId,
        supportsSteering: childSupportsSteering(initialized._meta),
        cleaned: false,
      };
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

  #lifecycle(event: string, pattern?: SpinPattern): Promise<void> {
    return this.#options.parent.notify(methods.client.session.update, {
      sessionId: this.#options.publicSessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
      _meta: {
        redskills: {
          lifecycle: {
            event,
            agent: this.#options.endpoint.agent,
            ...(pattern == null ? {} : { pattern }),
          },
        },
      },
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

function childSpinResponse(
  response: PromptResponse,
  agent: string,
  attempts: number,
  pattern: SpinPattern,
  steers: number,
): PromptResponse {
  const governed = childResponse(response, agent, attempts);
  return {
    ...governed,
    _meta: {
      ...(governed._meta ?? {}),
      redskills: {
        ...((governed._meta as { redskills?: object } | undefined)?.redskills ?? {}),
        workflowOutcome: `spin:${pattern}`,
        spin: { pattern, steers },
      },
    },
  };
}

function spinSteerRequest(params: PromptRequest, pattern: SpinPattern): PromptRequest {
  return {
    ...params,
    prompt: [{
      type: "text",
      text: `Spin detected: ${pattern}. Break this pattern and take a materially different approach.`,
    }],
    _meta: {
      ...(params._meta ?? {}),
      redskills: {
        ...((params._meta as { redskills?: object } | undefined)?.redskills ?? {}),
        spinSteer: { pattern },
      },
    },
  };
}

function childSupportsSteering(meta: unknown): boolean {
  return (meta as { redskills?: { steering?: unknown } } | undefined)
    ?.redskills?.steering === true;
}

function childTransportIsClosed(active: ActiveChildAgent): boolean {
  return active.child.exitCode != null || active.child.signalCode != null ||
    active.child.stdin?.destroyed === true || active.child.stdout?.destroyed === true;
}
