import type { MobileWorker } from "./ticket-dispatch";

/**
 * How long a dispatch receipt may stand in for a Worker the Host has not yet
 * listed. Beyond this the receipt stops being "in flight" and keeping the row
 * would be the app inventing a Worker the Host denies having.
 */
export const PENDING_DISPATCH_GRACE_MS = 30_000;

/**
 * Fold a dispatch's pending rows into the Host's own list. PURE.
 *
 * The Host's answer always wins: a pending row survives only while the Host
 * has not listed it AND its receipt is younger than the grace window. The
 * moment the Host lists the Worker, the published row (with its phase and
 * heartbeat) replaces the receipt.
 */
export function reconcilePendingWorkers(
  published: readonly MobileWorker[],
  pending: readonly MobileWorker[],
  nowMs: number,
): readonly MobileWorker[] {
  const listed = new Set(published.map((worker) => worker.workerId));
  const inFlight = pending.filter((worker) =>
    worker.pending === true &&
    !listed.has(worker.workerId) &&
    nowMs - Date.parse(worker.startedAt) < PENDING_DISPATCH_GRACE_MS,
  );
  return [...inFlight, ...published];
}
