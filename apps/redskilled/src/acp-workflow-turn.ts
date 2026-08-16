import {
  methods,
  type AgentConnection,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import type { AcpTargetedDispatchIntent } from "./acp-dispatch-intent.js";
import {
  cleanupWorkflowWorker,
  notifySessionLifecycle,
  notifyWorkerLifecycle,
  reapWorkflowWorker,
  scheduleIdleCleanup,
  workerTransportIsClosed,
  workflowOutcome,
  type ActiveWorkflowWorker,
} from "./acp-worker-lifecycle.js";

export interface RunAcpWorkflowTurnInput {
  readonly sessionId: string;
  readonly prompt: PromptRequest["prompt"];
  readonly meta?: PromptRequest["_meta"];
  readonly dispatch?: AcpTargetedDispatchIntent;
  readonly active: Map<string, ActiveWorkflowWorker>;
  readonly admit: (replacement: boolean) => Promise<ActiveWorkflowWorker>;
  readonly attached: () => boolean;
  readonly notify: AgentConnection["client"]["notify"];
  readonly hostState: () => { readonly workers: readonly { readonly worker_id: string }[] };
  readonly checkpoint?: (response: PromptResponse, outcome?: string) => Promise<void>;
}

/** Run one public turn, replacing a dead Worker at most once without losing targeted intent. */
export async function runAcpWorkflowTurn(input: RunAcpWorkflowTurnInput): Promise<PromptResponse> {
  let worker = input.active.get(input.sessionId);
  let replacements = 0;
  for (;;) {
    if (worker == null) {
      try {
        worker = await input.admit(replacements > 0);
      } catch (error) {
        await notifyRefusal(input, error);
        throw error;
      }
      input.active.set(input.sessionId, worker);
      await notifyWorkerLifecycle(worker, replacements === 0 ? "admission" : "replacement");
      // Make targeted admission observable before any work reaches the process.
      if (input.dispatch != null) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (worker.idleTimer != null) clearTimeout(worker.idleTimer);
    try {
      if (worker.cancelled) {
        await worker.connection.agent.notify(methods.agent.session.cancel, {
          sessionId: worker.downstreamSessionId,
        });
      }
      const response = await worker.connection.agent.request(methods.agent.session.prompt, {
        sessionId: worker.downstreamSessionId,
        prompt: input.prompt,
        ...(input.meta == null ? {} : { _meta: input.meta }),
      });
      const outcome = workflowOutcome(response);
      await input.checkpoint?.(response, outcome);
      if (outcome != null) {
        await notifyWorkerLifecycle(worker, "terminal-outcome", outcome);
        await reapWorkflowWorker(input.sessionId, worker, input.active, outcome);
      } else if (!input.attached()) {
        await reapWorkflowWorker(input.sessionId, worker, input.active, "client-detached");
      } else {
        scheduleIdleCleanup(input.sessionId, worker, input.active);
      }
      return {
        ...response,
        _meta: {
          ...(response._meta ?? {}),
          redskills: {
            ...((response._meta as { redskills?: object } | undefined)?.redskills ?? {}),
            authority: "redskilled",
            workerId: worker.workerId,
            ...(input.dispatch == null ? {} : { dispatch: input.dispatch, replacement: replacements }),
          },
        },
      };
    } catch (error) {
      const dead = worker;
      if (!workerTransportIsClosed(dead)) {
        if (!input.attached()) {
          await reapWorkflowWorker(input.sessionId, dead, input.active, "client-detached");
        } else {
          scheduleIdleCleanup(input.sessionId, dead, input.active);
        }
        throw error;
      }
      cleanupWorkflowWorker(input.sessionId, dead, input.active);
      if (input.dispatch != null) {
        await waitForWorkerDeparture(input.hostState, dead.workerId);
        await notifyWorkerLifecycle(dead, "death", reason(error)).catch(() => undefined);
      }
      worker = undefined;
      if (replacements === 0) {
        replacements += 1;
        continue;
      }
      await notifyRefusal(input, error);
      throw error;
    }
  }
}

async function notifyRefusal(input: RunAcpWorkflowTurnInput, error: unknown): Promise<void> {
  if (input.dispatch == null) return;
  await notifySessionLifecycle(input.notify, input.sessionId, {
    event: "refusal",
    dispatch: input.dispatch,
    reason: reason(error),
  }).catch(() => undefined);
}

async function waitForWorkerDeparture(
  hostState: RunAcpWorkflowTurnInput["hostState"],
  workerId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (hostState().workers.some((worker) => worker.worker_id === workerId)) {
    if (Date.now() >= deadline) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
