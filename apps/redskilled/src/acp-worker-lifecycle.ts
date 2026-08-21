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
import { redskilledMetrics } from "./telemetry-metrics.js";
import {
  pruneWorkerEvidence,
  retainWorkerEvidence,
  type WorkerEvidencePlan,
} from "./worker-evidence.js";
import { releaseWorkerWorkspace, type MaterializedWorkerWorkspace } from "./worker-workspace.js";

export interface ActiveWorkflowWorker {
  readonly workerId: string;
  readonly downstreamSessionId: string;
  readonly connection: ClientConnection;
  readonly socket: Socket;
  readonly endpoint: string;
  readonly publicSessionId: string;
  readonly notify: AgentConnection["client"]["notify"];
  /**
   * The OS-temporary workspace this Worker stands in, released when it dies.
   *
   * Held on the handle rather than looked up at cleanup time: the daemon is the
   * only thing that knows this directory exists, so a Worker whose handle is
   * dropped without it is bytes nobody will ever attribute again (ADR 0149 §1).
   */
  readonly workspace?: MaterializedWorkerWorkspace;
  /**
   * Where this Worker's cheap, irreplaceable bytes go when it dies.
   *
   * Held here for the same reason the workspace is, and it is the SAME fact
   * seen from the other side: the workspace is what death may take, the
   * evidence is what death must keep (ADR 0149 §2).
   */
  readonly evidence?: WorkerEvidencePlan;
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
  cleanupWorkflowWorker(sessionId, worker, active, reason);
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
  outcome = "cleanup",
): void {
  if (worker.cleaned) return;
  worker.cleaned = true;
  if (worker.idleTimer != null) clearTimeout(worker.idleTimer);
  if (active.get(sessionId) === worker) active.delete(sessionId);
  worker.connection.close();
  worker.socket.destroy();
  void removeAcpEndpoint(worker.endpoint);
  // The live set is snapshotted HERE, synchronously, while it is still true.
  // Reading it inside the prune's continuation would judge a later host: a
  // Worker admitted in the meantime would be absent from a set captured before
  // it existed, and the prune would be free to take its lane.
  const stillLive = [...active.values()].map((held) => held.workerId);
  // Evidence is retained BEFORE the workspace goes, because a Worker's log may
  // be inside the directory about to be deleted.
  const retained = worker.evidence == null
    ? Promise.resolve()
    : retainWorkerEvidence(evidenceFor(worker, worker.evidence, outcome)).then(() => undefined);
  void retained
    .catch(() => undefined)
    .then(async () => {
      // The workspace goes with the Worker. It is expensive and regenerable, and
      // deleting it costs no conscience precisely because everything a human
      // returns to has already been copied out (ADR 0149 §1/§2).
      if (worker.workspace != null) await releaseWorkerWorkspace(worker.workspace).catch(() => undefined);
      if (worker.evidence == null) return;
      await pruneWorkerEvidence({
        root: worker.evidence.root,
        ttlMs: worker.evidence.ttlMs,
        live: stillLive,
      }).catch(() => undefined);
    })
    .catch(() => undefined);
}

/** What this death asks the evidence lane to keep. PURE. */
function evidenceFor(
  worker: ActiveWorkflowWorker,
  plan: WorkerEvidencePlan,
  outcome: string,
): Parameters<typeof retainWorkerEvidence>[0] {
  return {
    root: plan.root,
    ...(plan.logPath == null ? {} : { logPath: plan.logPath }),
    verdict: {
      workerId: worker.workerId,
      outcome,
      diedAt: new Date().toISOString(),
      publicSessionId: worker.publicSessionId,
      ...(worker.workspace == null ? {} : { workspacePath: worker.workspace.workspacePath }),
      ...(plan.sessionArtifact == null ? {} : { sessionArtifact: plan.sessionArtifact }),
    },
  };
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
  options: { readonly replaceClosedTransport?: boolean } = {},
): Promise<{ readonly worker: ActiveWorkflowWorker; readonly response: PromptResponse }> {
  const replaceClosedTransport = options.replaceClosedTransport ?? true;
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
    const response = await request(worker);
    redskilledMetrics().observeTurn("completed");
    return { worker, response };
  } catch (error) {
    if (!replaceClosedTransport || !workerTransportIsClosed(worker)) {
      scheduleIdleCleanup(publicSessionId, worker, active);
      redskilledMetrics().observeTurn("refused");
      throw error;
    }
    cleanupWorkflowWorker(publicSessionId, worker, active);
  }

  const replacement = await admit(true);
  active.set(publicSessionId, replacement);
  await notifyWorkerLifecycle(replacement, "replacement");
  try {
    const response = await request(replacement);
    redskilledMetrics().observeTurn("completed");
    return { worker: replacement, response };
  } catch (error) {
    cleanupWorkflowWorker(publicSessionId, replacement, active);
    redskilledMetrics().observeTurn("refused");
    throw error;
  }
}
