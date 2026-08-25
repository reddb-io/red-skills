/**
 * host-fleet — the cross-host view, derived from per-host evidence.
 *
 * Each paired Host is polled on its own; this module folds those independent
 * outcomes into the one screen the operator asked the Remote link for: every
 * machine's verdict, and every Worker anywhere, each row still naming the
 * Host it belongs to — because a stop must be routed to the machine that owns
 * the Worker, and a row that lost its Host is a button that cannot act.
 */
import { deriveHostStatus, type HostLinkStatus } from "./host-status";
import type { MobileHostSnapshot, MobileWorker } from "./ticket-dispatch";
import { reconcilePendingWorkers } from "./worker-reconcile";

/** What one Host's polling has established so far. */
export interface HostRuntime {
  readonly snapshot: MobileHostSnapshot | null;
  readonly lastAnsweredAtMs: number | null;
  readonly failure: string | null;
}

export interface FleetHostView {
  readonly hostId: string;
  readonly hostName: string;
  readonly status: HostLinkStatus;
  readonly daemonVersion: string | null;
  readonly workerCount: number;
  readonly failure: string | null;
}

export interface FleetWorkerRow extends MobileWorker {
  readonly hostId: string;
  readonly hostName: string;
}

const EMPTY_RUNTIME: HostRuntime = { snapshot: null, lastAnsweredAtMs: null, failure: null };

/** One card per paired Host, each judged only on its own evidence. PURE. */
export function fleetHostViews(
  hosts: readonly { host_id: string; host_name: string }[],
  runtime: Readonly<Record<string, HostRuntime>>,
  nowMs: number,
): readonly FleetHostView[] {
  return hosts.map((host) => {
    const state = runtime[host.host_id] ?? EMPTY_RUNTIME;
    return {
      hostId: host.host_id,
      hostName: host.host_name,
      status: deriveHostStatus(state.lastAnsweredAtMs, nowMs),
      daemonVersion: state.snapshot?.daemonVersion ?? null,
      workerCount: state.snapshot?.workers.length ?? 0,
      failure: state.failure,
    };
  });
}

/**
 * Every Worker anywhere, host-labelled, pending receipts reconciled per Host.
 * A Host that never answered contributes nothing — absence of rows, not
 * invented idleness; its outage is on its own card. PURE.
 */
export function fleetWorkerRows(
  hosts: readonly { host_id: string; host_name: string }[],
  runtime: Readonly<Record<string, HostRuntime>>,
  pending: readonly FleetWorkerRow[],
  nowMs: number,
): readonly FleetWorkerRow[] {
  return hosts.flatMap((host) => {
    const state = runtime[host.host_id] ?? EMPTY_RUNTIME;
    const label = (worker: MobileWorker): FleetWorkerRow => ({
      ...worker,
      hostId: host.host_id,
      hostName: host.host_name,
    });
    const own = pending.filter((row) => row.hostId === host.host_id);
    if (state.snapshot == null) {
      // No answer yet: the dispatch receipts are the only evidence there is.
      return reconcilePendingWorkers([], own, nowMs).map(label);
    }
    return reconcilePendingWorkers(state.snapshot.workers, own, nowMs).map(label);
  });
}
