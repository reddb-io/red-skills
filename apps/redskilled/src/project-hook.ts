/** Project-scoped hooks, dispatched through ordinary Worker admission and birth. */
import type { RedskilledAdmissionVerdict } from "./admission.js";
import {
  REDSKILLED_PUBLIC_HOST_EVENT_KINDS,
  type RedskilledPublicHostEventKind,
  type RedskilledWorkerEventKind,
} from "./event-lane.js";
import type { RedskilledWorkerView } from "./host-state.js";
import { workerSpecFromLaunch } from "./launch-template.js";
import type { RedskilledProjectRegistration } from "./project-registration.js";
import { mintHostWorkerId, RedskilledAdmissionError, type RedskilledWorkerSpec } from "./worker-launch.js";

export interface RedskilledProjectHookRuntimeOptions {
  readonly registration: (projectLabel: string) => RedskilledProjectRegistration | undefined;
  readonly liveWorkerIds: () => Iterable<string>;
  readonly admit: (spec: RedskilledWorkerSpec) => RedskilledAdmissionVerdict;
  readonly start: (spec: RedskilledWorkerSpec, admission: RedskilledAdmissionVerdict) => RedskilledWorkerView;
  readonly refuse: (projectLabel: string, detail: string) => void;
  readonly recordExpiry: (projectLabel: string, detail: string) => void;
}

export interface RedskilledProjectHookRuntime {
  /** Mark a newborn as a hook before its birth reaches the event dispatcher. */
  track(workerId: string): void;
  /** Observe a recorded Worker event, firing only project-declared public kinds. */
  onEvent(kind: RedskilledWorkerEventKind, worker: RedskilledWorkerView): void;
  /** Resolve when every synchronous hook fired so far has exited or expired. */
  waitForSettled(): Promise<void>;
}

interface SyncHookWaitOptions {
  readonly deadlineMs: number;
  readonly waiting: () => boolean;
  readonly expire: () => void;
}

/** Wait for one synchronous hook, proceeding and recording when its bound expires. */
export async function waitForSyncHook(options: SyncHookWaitOptions): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (!options.waiting()) return;
    const remainingMs = options.deadlineMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      options.expire();
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remainingMs, 10)));
  }
}

export function createRedskilledProjectHookRuntime(
  options: RedskilledProjectHookRuntimeOptions,
): RedskilledProjectHookRuntime {
  const hookWorkers = new Set<string>();
  const syncWaits = new Set<Promise<void>>();

  function fire(kind: RedskilledPublicHostEventKind, eventWorker: RedskilledWorkerView): void {
    const template = options.registration(eventWorker.project_label)?.hooks?.[kind];
    if (template == null) return;
    try {
      const spec = workerSpecFromLaunch(
        template,
        { worker_id: mintHostWorkerId(options.liveWorkerIds()), slot: 0, workspace_path: eventWorker.workspace_path },
        { project_label: eventWorker.project_label },
      );
      const admission = options.admit(spec);
      if (!admission.admitted) throw new RedskilledAdmissionError(admission.reason, admission);
      const hook = options.start(spec, admission);
      hookWorkers.add(hook.worker_id);
      if (template.mode === "sync") {
        const deadlineMs = template.deadline_ms!;
        const wait = waitForSyncHook({
          deadlineMs,
          waiting: () => hookWorkers.has(hook.worker_id),
          expire: () => {
            options.recordExpiry(
              eventWorker.project_label,
              `project ${JSON.stringify(eventWorker.project_label)} sync ${kind} hook exceeded its declared ` +
                `${deadlineMs}ms deadline; redskilled stopped waiting and proceeded`,
            );
          },
        });
        syncWaits.add(wait);
        void wait.finally(() => syncWaits.delete(wait));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.refuse(
        eventWorker.project_label,
        `project ${JSON.stringify(eventWorker.project_label)} registered an async ${kind} hook, but redskilled ` +
          `refused it before launch: ${reason}`,
      );
    }
  }

  return {
    track: (workerId) => hookWorkers.add(workerId),
    onEvent(kind, worker) {
      const isHookWorker = hookWorkers.has(worker.worker_id);
      if (!isHookWorker && REDSKILLED_PUBLIC_HOST_EVENT_KINDS.includes(kind as RedskilledPublicHostEventKind)) {
        fire(kind as RedskilledPublicHostEventKind, worker);
      }
      if (isHookWorker && (kind === "worker-death" || kind === "worker-budget-kill")) {
        hookWorkers.delete(worker.worker_id);
      }
    },
    async waitForSettled() {
      while (syncWaits.size > 0) await Promise.all(syncWaits);
    },
  };
}
