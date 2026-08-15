import { rm } from "node:fs/promises";
import type { Socket } from "node:net";
import {
  methods,
  type AgentConnection,
  type ClientConnection,
  type PromptResponse,
} from "@agentclientprotocol/sdk";

export interface ActiveWorkflowWorker {
  readonly workerId: string;
  readonly downstreamSessionId: string;
  readonly connection: ClientConnection;
  readonly socket: Socket;
  readonly endpoint: string;
  readonly publicSessionId: string;
  readonly notify: AgentConnection["client"]["notify"];
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
  await worker.notify(methods.client.session.update, {
    sessionId: worker.publicSessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    _meta: { redskills: { lifecycle: { event, workerId: worker.workerId, ...(reason == null ? {} : { reason }) } } },
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
  void rm(worker.endpoint, { force: true });
}
