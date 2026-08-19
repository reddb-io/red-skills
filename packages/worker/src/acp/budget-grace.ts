import {
  REDSKILLS_ACP_METHODS,
  type RedskilledGithubWriteRequest,
} from "@reddb-io/protocol-acp";

/** ACP control delivered to a Worker after the daemon records its budget verdict. */
export const REDSKILLED_WORKER_BUDGET_GRACE_METHOD = REDSKILLS_ACP_METHODS.workerBudgetGrace;

export interface WorkerBudgetGraceControl {
  readonly version: 1;
  readonly worker_id: string;
  readonly detail: string;
  /** Observability only. The daemon remains the sole deadline and kill authority. */
  readonly deadline_at: string;
}

export interface WorkerBudgetGraceCheckpoint {
  readonly ref: string;
  readonly sha: string;
}

export interface WorkerBudgetExtensionBlocker {
  readonly status: "blocked";
  readonly kind: "budget";
  readonly summary: string;
  readonly next: string;
}

/** Terminal evidence handed to the Worker's ordinary Envelope writer. */
export interface WorkerBudgetGraceEnvelope {
  readonly outcome: "budget-exceeded";
  readonly worker_id: string;
  readonly detail: string;
  readonly deadline_at: string;
  readonly checkpoint?: WorkerBudgetGraceCheckpoint;
  readonly publication_requested: boolean;
  readonly publication_receipt?: unknown;
  readonly failures: readonly string[];
  readonly blocker: WorkerBudgetExtensionBlocker;
}

export interface AcpWorkerBudgetGraceDeps {
  /** Cancel the Worker's child Agent through its existing ACP connection. */
  cancelChildAgent(control: WorkerBudgetGraceControl): Promise<void>;
  /** Commit recoverable local work and return the ref/commit to publish. */
  checkpointLocalWork(control: WorkerBudgetGraceControl): Promise<WorkerBudgetGraceCheckpoint | null>;
  /** Ask redskilled's Project-bound GitHub gateway to publish; no credential crosses this seam. */
  requestPublication(request: RedskilledGithubWriteRequest): Promise<unknown>;
  writeEnvelope(envelope: WorkerBudgetGraceEnvelope): Promise<void>;
  /** End the Worker. Deadline expiry may independently kill it at any point. */
  terminate(): Promise<void> | void;
}

export interface AcpWorkerBudgetGraceRuntime {
  receive(control: WorkerBudgetGraceControl): Promise<void>;
}

const EXTENSION_BLOCKER: WorkerBudgetExtensionBlocker = {
  status: "blocked",
  kind: "budget",
  summary: "The Worker exhausted its resource budget and checkpointed recoverable local work before termination.",
  next: "Decide whether to requeue with a larger budget, re-scope, or stop.",
};

/**
 * Run the Worker's checkpoint-and-die transaction once.
 *
 * Each recoverable stage is best-effort so a failed commit or publication does
 * not suppress the Envelope or turn Budget grace into a live held state. The
 * daemon's timer is deliberately not mirrored here: it may kill this process
 * unconditionally while any awaited stage is still running.
 */
export function createAcpWorkerBudgetGraceRuntime(
  deps: AcpWorkerBudgetGraceDeps,
): AcpWorkerBudgetGraceRuntime {
  let terminal: Promise<void> | undefined;
  return {
    receive(control) {
      terminal ??= runBudgetGrace(control, deps);
      return terminal;
    },
  };
}

async function runBudgetGrace(
  control: WorkerBudgetGraceControl,
  deps: AcpWorkerBudgetGraceDeps,
): Promise<void> {
  const failures: string[] = [];
  let checkpoint: WorkerBudgetGraceCheckpoint | undefined;
  let publicationRequested = false;
  let publicationReceipt: unknown;

  try {
    await deps.cancelChildAgent(control);
  } catch (error) {
    failures.push(`cancellation: ${reason(error)}`);
  }

  try {
    checkpoint = (await deps.checkpointLocalWork(control)) ?? undefined;
  } catch (error) {
    failures.push(`checkpoint: ${reason(error)}`);
  }

  if (checkpoint != null) {
    publicationRequested = true;
    try {
      publicationReceipt = await deps.requestPublication({
        idempotency_key: `worker-budget-grace:${control.worker_id}`,
        write: { kind: "repository-push", ref: checkpoint.ref, sha: checkpoint.sha },
      });
    } catch (error) {
      failures.push(`publication: ${reason(error)}`);
    }
  }

  try {
    await deps.writeEnvelope({
      outcome: "budget-exceeded",
      worker_id: control.worker_id,
      detail: control.detail,
      deadline_at: control.deadline_at,
      ...(checkpoint == null ? {} : { checkpoint }),
      publication_requested: publicationRequested,
      ...(publicationReceipt === undefined ? {} : { publication_receipt: publicationReceipt }),
      failures,
      blocker: EXTENSION_BLOCKER,
    });
  } catch {
    // The Worker cannot durably report an Envelope-writer failure from inside
    // that same failed writer. Termination still wins over retaining the slot.
  } finally {
    await deps.terminate();
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
