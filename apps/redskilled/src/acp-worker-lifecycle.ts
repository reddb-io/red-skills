import type { Socket } from "node:net";
import {
  methods,
  type AgentConnection,
  type ClientConnection,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import type { AcpTargetedDispatchIntent } from "./acp-dispatch-intent.js";
import { removeAcpEndpoint } from "@reddb-io/protocol-acp";

export interface ActiveWorkflowWorker {
  readonly workerId: string;
  readonly downstreamSessionId: string;
  readonly connection: ClientConnection;
  readonly socket: Socket;
  readonly endpoint: string;
  readonly publicSessionId: string;
  readonly notify: AgentConnection["client"]["notify"];
  readonly dispatch?: AcpTargetedDispatchIntent;
  idleTimer?: NodeJS.Timeout;
  cancelled: boolean;
  cleaned: boolean;
}

export function scheduleIdleCleanup(
  sessionId: string,
  worker: ActiveWorkflowWorker,
  active: Map<string, ActiveWorkflowWorker>,
): void {
  const configured = Number.parseInt(process.env.REDSKILLED_ACP_WORKER_IDLE_MS ?? "30000", 10);
  const idleMs = Number.isFinite(configured) && configured >= 0 ? configured : 30_000;
  const timer = setTimeout(() => void reapWorkflowWorker(sessionId, worker, active, "idle-policy"), idleMs);
  timer.unref();
  worker.idleTimer = timer;
}

export async function reapWorkflowWorker(
  sessionId: string,
  worker: ActiveWorkflowWorker,
  active: Map<string, ActiveWorkflowWorker>,
  reason: string,
): Promise<void> {
  await notifyWorkerLifecycle(worker, "reaping", reason).catch(() => undefined);
  cleanupWorkflowWorker(sessionId, worker, active);
}

export async function notifyWorkerLifecycle(
  worker: ActiveWorkflowWorker,
  event: string,
  reason?: string,
): Promise<void> {
  await notifySessionLifecycle(worker.notify, worker.publicSessionId, {
    event,
    workerId: worker.workerId,
    ...(worker.dispatch == null ? {} : { dispatch: worker.dispatch }),
    ...(reason == null ? {} : { reason }),
  });
}

export async function notifySessionLifecycle(
  notify: AgentConnection["client"]["notify"],
  publicSessionId: string,
  lifecycle: {
    readonly event: string;
    readonly workerId?: string;
    readonly dispatch?: AcpTargetedDispatchIntent;
    readonly reason?: string;
  },
): Promise<void> {
  await notify(methods.client.session.update, {
    sessionId: publicSessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    _meta: { redskills: { lifecycle } },
  });
}

export function workflowOutcome(response: PromptResponse): string | undefined {
  if (response.stopReason === "cancelled") return "cancellation";
  return (response._meta as { redskills?: { workflowOutcome?: string } } | undefined)?.redskills?.workflowOutcome;
}

export function cleanupWorkflowWorker(
  sessionId: string,
  worker: ActiveWorkflowWorker,
  active: Map<string, ActiveWorkflowWorker>,
): void {
  if (worker.cleaned) return;
  worker.cleaned = true;
  if (worker.idleTimer != null) clearTimeout(worker.idleTimer);
  if (active.get(sessionId) === worker) active.delete(sessionId);
  worker.connection.close();
  worker.socket.destroy();
  void removeAcpEndpoint(worker.endpoint);
}

export function workerTransportIsClosed(worker: ActiveWorkflowWorker): boolean {
  return worker.socket.destroyed || worker.socket.readableEnded || worker.socket.writableEnded ||
    !worker.socket.readable || !worker.socket.writable;
}

/** Run one public turn, replacing an unhealthy Worker at most once. */
export async function requestWorkflowTurn(
  publicSessionId: string,
  active: Map<string, ActiveWorkflowWorker>,
  params: PromptRequest,
  admit: (replacement: boolean) => Promise<ActiveWorkflowWorker>,
): Promise<{ readonly worker: ActiveWorkflowWorker; readonly response: PromptResponse }> {
  let worker = active.get(publicSessionId);
  if (worker == null) {
    worker = await admit(false);
    active.set(publicSessionId, worker);
    await notifyWorkerLifecycle(worker, "admission");
  }
  if (worker.idleTimer != null) clearTimeout(worker.idleTimer);

  const request = async (held: ActiveWorkflowWorker) => {
    if (held.cancelled) {
      await held.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: held.downstreamSessionId,
      });
    }
    return held.connection.agent.request(methods.agent.session.prompt, {
      sessionId: held.downstreamSessionId,
      prompt: params.prompt,
      ...(params._meta == null ? {} : { _meta: params._meta }),
    });
  };
  try {
    return { worker, response: await request(worker) };
  } catch (error) {
    if (!workerTransportIsClosed(worker)) {
      scheduleIdleCleanup(publicSessionId, worker, active);
      throw error;
    }
    cleanupWorkflowWorker(publicSessionId, worker, active);
  }

  const replacement = await admit(true);
  active.set(publicSessionId, replacement);
  await notifyWorkerLifecycle(replacement, "replacement");
  try {
    return { worker: replacement, response: await request(replacement) };
  } catch (error) {
    cleanupWorkflowWorker(publicSessionId, replacement, active);
    throw error;
  }
}
