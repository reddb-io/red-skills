import { spawnSync } from "node:child_process";
import type { RedskilledWorkerView } from "../host-state.js";

export const DEFAULT_REDSKILLED_BUDGET_GRACE_MS = 30_000;
export const REDSKILLED_BUDGET_GRACE_SIGNAL: NodeJS.Signals = "SIGUSR2";

/** Delivers the checkpoint signal; delivery is deliberately not an acknowledgement. */
export type RedskilledBudgetGraceSignal = (worker: RedskilledWorkerView) => boolean;

export interface RedskilledBudgetGraceRuntime {
  begin(worker: RedskilledWorkerView, detail: string): Promise<boolean>;
  workerExited(workerId: string): void;
  stop(): void;
}

interface BudgetGraceRuntimeOptions {
  readonly graceMs: number;
  readonly signal: RedskilledBudgetGraceSignal;
  readonly held: (workerId: string) => boolean;
  readonly kill: (worker: RedskilledWorkerView, detail: string) => void | Promise<void>;
  readonly record: (
    kind: "worker-budget-verdict" | "worker-budget-grace",
    worker: RedskilledWorkerView,
    detail: string,
  ) => void;
}

/** One fixed daemon-policy window per Worker, cancelled only by observed exit. */
export function createBudgetGraceRuntime(options: BudgetGraceRuntimeOptions): RedskilledBudgetGraceRuntime {
  const deadlines = new Map<string, NodeJS.Timeout>();

  function workerExited(workerId: string): void {
    const deadline = deadlines.get(workerId);
    if (deadline != null) clearTimeout(deadline);
    deadlines.delete(workerId);
  }

  return {
    async begin(worker, detail) {
      if (deadlines.has(worker.worker_id)) return false;
      options.record("worker-budget-verdict", worker, detail);
      try { options.signal(worker); } catch {}
      options.record(
        "worker-budget-grace",
        worker,
        `${detail}; checkpoint window ${Math.max(0, options.graceMs)}ms`,
      );
      if (options.graceMs <= 0) {
        if (options.held(worker.worker_id)) await options.kill(worker, detail);
        return true;
      }
      const deadline = setTimeout(() => {
        deadlines.delete(worker.worker_id);
        if (options.held(worker.worker_id)) void options.kill(worker, detail);
      }, options.graceMs);
      deadline.unref();
      deadlines.set(worker.worker_id, deadline);
      return true;
    },
    workerExited,
    stop() {
      for (const deadline of deadlines.values()) clearTimeout(deadline);
      deadlines.clear();
    },
  };
}

/** Signal the unit when there is one; otherwise signal the detached Worker tree. */
export function signalWorkerForBudgetGrace(worker: RedskilledWorkerView): boolean {
  if (worker.unit != null && worker.unit !== "") {
    const sent = spawnSync(
      "systemctl",
      ["--user", "kill", `--signal=${REDSKILLED_BUDGET_GRACE_SIGNAL}`, "--kill-whom=all", worker.unit],
      { stdio: "ignore" },
    );
    return sent.error == null && sent.status === 0;
  }
  try {
    process.kill(-(worker.pgid ?? worker.pid), REDSKILLED_BUDGET_GRACE_SIGNAL);
    return true;
  } catch {
    try { process.kill(worker.pid, REDSKILLED_BUDGET_GRACE_SIGNAL); return true; } catch { return false; }
  }
}
