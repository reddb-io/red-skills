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
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_WIRE_MAJOR,
  type AcpEndpoint,
} from "@reddb-io/protocol-acp";
import { _credentialFreeEnvWithHome } from "@reddb-io/shared/credential-free-env.js";
import type { SpinPattern } from "../engine/spin-evaluator.js";
import {
  forgetChildAgentProcess,
  installChildAgentReaper,
  reapChildProcessTree,
  registerChildAgentProcess,
} from "./child-reaper.js";
import { createChildAcpSpinEpisode, type ChildAcpSpinEpisode } from "./child-spin.js";
import { createWorkerTerminalHost, type WorkerTerminalHost } from "./terminal-host.js";
import type { WorkerTerminalDenial } from "./terminal-policy.js";

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
  readonly #terminals: WorkerTerminalHost;
  #active: ActiveChildAgent | undefined;
  #spinEpisode: ChildAcpSpinEpisode | undefined;
  #spinUpdates: Promise<void> = Promise.resolve();
  /**
   * Every reap this Agent started, so `close` can wait for all of them.
   *
   * A replacement reaps its predecessor from inside a turn, where there is
   * nothing to await it — chaining the reaps here is what makes the Worker's
   * own teardown able to promise that no child of its is left running.
   */
  #reaps: Promise<void> = Promise.resolve();

  constructor(options: ChildAgentSessionOptions) {
    this.#options = options;
    // One host per child Agent, not per child PROCESS: a replacement inherits
    // the terminals its predecessor opened rather than orphaning them.
    this.#terminals = createWorkerTerminalHost({
      cwd: options.cwd,
      env: _credentialFreeEnvWithHome(process.env),
      onDenial: (denial) => void this.#terminalDenial(denial),
    });
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

  /**
   * Give up every process this Agent holds, and CONFIRM the child is gone.
   *
   * Awaited rather than fired: the Worker body calls this on its way out, and a
   * teardown that only asked would return before the child had left — which is
   * precisely how six `codex-acp` pairs outlived their Workers (#4241).
   */
  async close(): Promise<void> {
    this.#terminals.closeAll();
    if (this.#active != null) this.#cleanup(this.#active);
    await this.#reaps;
  }

  async #admit(event: "child-admission" | "child-replacement"): Promise<ActiveChildAgent> {
    const endpoint = this.#options.endpoint;
    // The process that runs the model receives no credential (ADR 0144 §3).
    // The daemon already stripped them from the Worker's own environment; this
    // strips them again rather than trusting a hop it cannot see.
    //
    // `detached` buys a process GROUP, not independence: the endpoint command is
    // usually `npx`, which spawns the real Agent binary as its own child, and a
    // kill aimed at the pid we hold would leave that grandchild running and
    // re-parented onto the user manager (#4241). Its own group makes the whole
    // subtree one signal away, and `child-reaper.ts` owns sending it.
    const child = spawn(endpoint.command, endpoint.args, {
      cwd: this.#options.cwd,
      env: _credentialFreeEnvWithHome(process.env),
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    if (child.pid != null) {
      installChildAgentReaper();
      registerChildAgentProcess(child.pid);
      const pid = child.pid;
      child.once("exit", () => forgetChildAgentProcess(pid));
    }
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
      ) as Promise<RequestPermissionResponse>)
      // The Worker answers `terminal/*` itself: the policy refuses publication
      // and every credentialed remote, and what survives runs in the Worktree.
      .onRequest(methods.client.terminal.create, ({ params }) => this.#terminals.create(params))
      .onRequest(methods.client.terminal.output, ({ params }) => this.#terminals.output(params))
      .onRequest(methods.client.terminal.waitForExit, ({ params }) => this.#terminals.waitForExit(params))
      .onRequest(methods.client.terminal.kill, ({ params }) => this.#terminals.kill(params))
      .onRequest(methods.client.terminal.release, ({ params }) => this.#terminals.release(params));
    const connection = app.connect(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { terminal: true },
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
      // **The unattended posture is established BEFORE the first prompt.**
      // Nobody answers a permission dialog here, and `acp-permission.ts` turns
      // an uncovered decision into `cancelled` — which every shipped Agent
      // reads as an interrupt and aborts the whole turn on. claude-code-acp
      // parses no argv, so a session mode is the only door it has (#4278); if
      // the mode is refused the child cannot work, and failing here is a birth
      // that explains itself rather than a turn that dies on its first write.
      if (endpoint.unattendedSessionMode != null) {
        await connection.agent.request(methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: endpoint.unattendedSessionMode,
        });
      }
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
      this.#reap(child);
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
    this.#reap(active.child);
  }

  /**
   * Queue one child's group kill behind the reaps already running.
   *
   * Synchronous callers — a replacement mid-turn, an admission that threw — get
   * the kill STARTED; `close` is where somebody finally waits for it.
   */
  #reap(child: ChildProcess): void {
    const reap = () => reapChildProcessTree(child).then(() => undefined);
    this.#reaps = this.#reaps.then(reap, reap);
  }

  /** Tell the parent what the policy refused, so the Worker log holds the lesson. */
  #terminalDenial(denial: WorkerTerminalDenial): Promise<void> {
    return this.#options.parent.notify(methods.client.session.update, {
      sessionId: this.#options.publicSessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
      _meta: {
        redskills: {
          lifecycle: { event: "child-terminal-denied", agent: this.#options.endpoint.agent },
          terminalPolicy: {
            decision: "deny",
            reason: denial.reason,
            command: denial.command,
            what: denial.what,
            remedy: denial.remedy,
          },
        },
      },
    });
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
