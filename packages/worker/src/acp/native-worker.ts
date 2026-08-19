/**
 * The native ACP Workflow Worker: everything that runs INSIDE the process.
 *
 * redskilled decides that this Worker should exist, binds its rendezvous
 * socket, launches it and reaps it. From the moment the process is running,
 * what it does with its turn — the child Agent it delegates to, the plan and
 * message chunks it emits, the permission it asks its parent for, the
 * cancellation it honours — is body, and lives here (ADR 0148).
 */
import { randomUUID } from "node:crypto";
import {
  agent,
  methods,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_WIRE_MAJOR,
  abortableDelay,
  connectWithDeadline,
  notifySessionRecovery,
  requireCompatibleWireMajor,
  sessionRecoveryFromMeta,
  socketStream,
  waitForAbort,
  type AcpEndpoint,
  type AcpSessionRecoveryCheckpoint,
} from "@reddb-io/protocol-acp";
import { WorkflowChildAgent } from "./child-agent.js";

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
