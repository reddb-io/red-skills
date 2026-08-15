import { randomUUID } from "node:crypto";
import {
  agent,
  methods,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_WIRE_MAJOR,
  requireCompatibleWireMajor,
} from "./acp-compat.js";
import { abortableDelay, connectWithDeadline, socketStream, waitForAbort } from "./acp-socket.js";
import {
  notifySessionRecovery,
  sessionRecoveryFromMeta,
  type AcpSessionRecoveryCheckpoint,
} from "./acp-session-journal.js";

/** The daemon-admitted native Workflow Worker. */
export async function runNativeAcpWorker(socketPath: string): Promise<number> {
  const controllers = new Map<string, AbortController>();
  const sessions = new Set<string>();
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
      sessions.add(sessionId);
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
      if (!sessions.has(params.sessionId)) throw new Error("unknown native Worker ACP session");
      const controller = new AbortController();
      controllers.set(params.sessionId, controller);
      try {
        const recovery = recoveries.get(params.sessionId);
        if (recovery != null) {
          recoveries.delete(params.sessionId);
          await notifySessionRecovery(parent, params.sessionId, recovery);
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

        const prompt = promptText(params);
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
          ...(workflowOutcome == null ? {} : { _meta: { redskills: { workflowOutcome } } }),
        } satisfies PromptResponse;
      } finally {
        controllers.delete(params.sessionId);
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      controllers.get(params.sessionId)?.abort();
    });

  const socket = await connectWithDeadline(socketPath, 10_000);
  const connection = app.connect(socketStream(socket));
  await connection.closed;
  return 0;
}

function promptText(params: PromptRequest): string {
  return params.prompt
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
