// repair-lane — mechanical merge-queue recovery for fleet pull requests
// (Spec #3283, issue #3285).
//
// A repair Worker is not an owning issue Worker and never runs an inner agent.
// It has its own provenance in the shared Worker root, merges the current base,
// runs the repository's declared generators verbatim, publishes the repaired
// branch, and asks the merge queue again. Only a semantic failure observed
// AFTER that re-queue is attached to and escalated through the owning Ticket.
//
// PURE SEQUENCING: forge, git, shell, tracker, and Worker-state effects are
// injected. This keeps queue-event and periodic-sweep callers on one behavior.

/** Spawn-time provenance written to `origin` in the shared Worker state. */
export const REPAIR_ORIGIN = "repair";

/** Castle Worker kind written to `current.kind`. */
export const REPAIR_KIND = "repair";

export interface RepairCandidate {
  readonly prNumber: number;
  readonly ownerTicket: number;
  readonly branch: string;
  readonly base: string;
  readonly mergeStateStatus: string;
  readonly mergeable: string;
  /** True while the forge still carries the auto-merge/queue request. */
  readonly queued: boolean;
}

export interface RepairWorkerStamp {
  readonly origin: typeof REPAIR_ORIGIN;
  readonly kind: typeof REPAIR_KIND;
  readonly prNumber: number;
  readonly ownerTicket: number;
}

export interface QueueFailure {
  readonly summary: string;
  readonly check?: string;
  readonly detailsUrl?: string;
}

export type QueueObservation =
  | { readonly outcome: "accepted" | "merged" | "pending" }
  | { readonly outcome: "semantic-failure"; readonly failure: QueueFailure }
  | { readonly outcome: "mechanical-failure"; readonly reason: string };

export interface RepairStepResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface RepairLaneDeps {
  /** Materialize the Worker row under the shared root before doing any work. */
  readonly stampWorker: (stamp: RepairWorkerStamp) => Promise<void>;
  /** Merge the candidate's fresh base into its existing branch. */
  readonly mergeBase: (candidate: RepairCandidate) => Promise<RepairStepResult>;
  /** Run one declared generator command verbatim in declaration order. */
  readonly runGenerator: (
    command: string,
    candidate: RepairCandidate,
  ) => Promise<RepairStepResult>;
  /** Commit as needed and publish the merged, regenerated branch. */
  readonly pushBranch: (candidate: RepairCandidate) => Promise<RepairStepResult>;
  /** Ask the forge to place the PR in its merge queue. */
  readonly enqueue: (candidate: RepairCandidate) => Promise<RepairStepResult>;
  /** Observe the result of the new queue request. */
  readonly waitForQueue: (candidate: RepairCandidate) => Promise<QueueObservation>;
  /** Persist exact queue evidence on the owning Ticket before escalation. */
  readonly attachQueueFailure: (
    ownerTicket: number,
    prNumber: number,
    failure: QueueFailure,
  ) => Promise<void>;
  /** Route the owning Ticket back to its semantic-correction path. */
  readonly escalateOwner: (
    ownerTicket: number,
    prNumber: number,
    failure: QueueFailure,
  ) => Promise<void>;
}

export type RepairLaneResult =
  | { readonly outcome: "requeued"; readonly prNumber: number }
  | {
      readonly outcome: "escalated";
      readonly prNumber: number;
      readonly ownerTicket: number;
      readonly failure: QueueFailure;
    }
  | {
      readonly outcome: "deferred";
      readonly prNumber: number;
      readonly stage: "merge" | "generator" | "push" | "enqueue" | "queue";
      readonly reason: string;
    };

function stamp(candidate: RepairCandidate): RepairWorkerStamp {
  return {
    origin: REPAIR_ORIGIN,
    kind: REPAIR_KIND,
    prNumber: candidate.prNumber,
    ownerTicket: candidate.ownerTicket,
  };
}

function deferred(
  candidate: RepairCandidate,
  stage: Extract<RepairLaneResult, { outcome: "deferred" }>["stage"],
  step: RepairStepResult,
): RepairLaneResult {
  return {
    outcome: "deferred",
    prNumber: candidate.prNumber,
    stage,
    reason: step.reason?.trim() || `${stage} repair did not complete`,
  };
}

async function observeRequeue(
  deps: RepairLaneDeps,
  candidate: RepairCandidate,
): Promise<RepairLaneResult> {
  const observation = await deps.waitForQueue(candidate);
  if (observation.outcome === "semantic-failure") {
    await deps.attachQueueFailure(
      candidate.ownerTicket,
      candidate.prNumber,
      observation.failure,
    );
    await deps.escalateOwner(
      candidate.ownerTicket,
      candidate.prNumber,
      observation.failure,
    );
    return {
      outcome: "escalated",
      prNumber: candidate.prNumber,
      ownerTicket: candidate.ownerTicket,
      failure: observation.failure,
    };
  }
  if (observation.outcome === "mechanical-failure") {
    return {
      outcome: "deferred",
      prNumber: candidate.prNumber,
      stage: "queue",
      reason: observation.reason,
    };
  }
  return { outcome: "requeued", prNumber: candidate.prNumber };
}

async function enqueueAndObserve(
  deps: RepairLaneDeps,
  candidate: RepairCandidate,
): Promise<RepairLaneResult> {
  const enqueued = await deps.enqueue(candidate);
  if (!enqueued.ok) return deferred(candidate, "enqueue", enqueued);
  return observeRequeue(deps, candidate);
}

/**
 * Handle one queue-ejection event without waking the owning Worker. Mechanical
 * failures remain in the repair lane; only the re-queued semantic verdict can
 * cross the boundary back to the owning Ticket.
 */
export async function healQueueEjection(
  deps: RepairLaneDeps,
  candidate: RepairCandidate,
  generatorCommands: readonly string[],
): Promise<RepairLaneResult> {
  await deps.stampWorker(stamp(candidate));

  const merged = await deps.mergeBase(candidate);
  if (!merged.ok) return deferred(candidate, "merge", merged);

  for (const command of generatorCommands) {
    const generated = await deps.runGenerator(command, candidate);
    if (!generated.ok) return deferred(candidate, "generator", generated);
  }

  const pushed = await deps.pushBranch(candidate);
  if (!pushed.ok) return deferred(candidate, "push", pushed);

  return enqueueAndObserve(deps, candidate);
}

/** A CLEAN + MERGEABLE open PR outside the queue needs no branch rewrite. */
export function isUnqueuedMergeable(candidate: RepairCandidate): boolean {
  return (
    !candidate.queued &&
    candidate.mergeStateStatus.trim().toUpperCase() === "CLEAN" &&
    candidate.mergeable.trim().toUpperCase() === "MERGEABLE"
  );
}

/**
 * Periodic belt for the event gap: enqueue every clean mergeable fleet PR that
 * is sitting outside the queue. Already-queued and conflicting PRs are not
 * touched; each selected PR is represented by a repair Worker stamp.
 */
export async function sweepRepairLane(
  deps: RepairLaneDeps,
  candidates: readonly RepairCandidate[],
): Promise<RepairLaneResult[]> {
  const results: RepairLaneResult[] = [];
  for (const candidate of candidates) {
    if (!isUnqueuedMergeable(candidate)) continue;
    await deps.stampWorker(stamp(candidate));
    results.push(await enqueueAndObserve(deps, candidate));
  }
  return results;
}
