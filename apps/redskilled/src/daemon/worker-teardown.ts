import type { RedskilledWorkerView } from "../host-state.js";
import type { RedskilledStopProbe } from "../reattach.js";

/** What the daemon does once, on the ONE teardown that actually happened. */
export type RedskilledTeardownSettle = (confirmed: boolean) => void;

/**
 * Tear one Worker down at most once, whoever asks and however often.
 *
 * The awaited promise resolves when the host has confirmed the death, not when
 * the request was placed, so every ask gets the same truthful answer.
 */
export type RedskilledEndWorkerOnce = (
  worker: RedskilledWorkerView,
  settle: RedskilledTeardownSettle,
) => Promise<boolean>;

/**
 * The teardown ledger: the stop each Worker is currently inside, keyed by its
 * Worker id.
 *
 * A stop yields to the event loop for as long as the host takes to confirm the
 * death — which is the point — so two asks for the SAME Worker can overlap
 * where a blocking stop accidentally serialised them. The ledger is what keeps
 * the death bookkeeping exactly-once: the second ask joins the first's teardown
 * instead of sending a second one, so one Worker is one death on the lane and
 * one slot given back. Bounded by the live Worker set: an entry exists only
 * while a teardown is in flight, and stops for DIFFERENT Workers still run at
 * the same time.
 */
export function createWorkerTeardownLedger(stopProbe: RedskilledStopProbe): RedskilledEndWorkerOnce {
  const workerStops = new Map<string, Promise<boolean>>();
  return function endWorkerOnce(worker, settle) {
    const joined = workerStops.get(worker.worker_id);
    if (joined != null) return joined;
    const teardown = (async () => {
      let confirmed = false;
      // A refused stop still releases the daemon's claim; the caller's own event
      // names what survived rather than forging host confirmation.
      try { confirmed = (await stopProbe(worker)) === true; } catch {}
      // `settle` is the daemon's own bookkeeping — forget the Worker, write its
      // death, re-arm the idle gate — and it runs in the order the teardowns
      // happened, never on a caller that merely joined.
      settle(confirmed);
      return confirmed;
    })().finally(() => {
      if (workerStops.get(worker.worker_id) === teardown) workerStops.delete(worker.worker_id);
    });
    workerStops.set(worker.worker_id, teardown);
    return teardown;
  };
}
