/**
 * What one Project status snapshot means for this container's exit.
 *
 * The container no longer decides which issue to work — the daemon's demand
 * loop polls the registration and births a Worker per queued item. So the only
 * question left here is when the container is DONE, and it is answered from the
 * daemon's own status projection rather than from a queue read of our own,
 * because two readers of one queue is how a container exits while a Worker it
 * birthed is still running.
 *
 * PURE — a snapshot in, a verdict out.
 */

/** `drained` and `unregistered` both end a run; only one of them is success. */
export function drainVerdict(status, { loop = false } = {}) {
  const queue = status?.context?.queue ?? {};
  if (queue.registered === false) {
    return {
      state: "unregistered",
      detail: "the daemon holds no registration for this Project, so nothing polls its queue",
    };
  }
  const depth = typeof queue.depth === "number" ? queue.depth : null;
  const live = typeof queue.live === "number" ? queue.live : null;
  if (queue.freshness !== "fresh" || depth == null || live == null) {
    return { state: "draining", detail: `queue ${queue.freshness ?? "unknown"}: ${queue.detail ?? "no reading yet"}` };
  }
  if (depth === 0 && live === 0) {
    return loop
      ? { state: "idle", detail: "queue empty; the registration stands and the daemon keeps polling" }
      : { state: "drained", detail: "queue empty and no Worker live" };
  }
  return { state: "draining", detail: `${depth} queued, ${live} live` };
}

/** Exponential idle backoff, capped at `ceiling`. PURE. */
export function nextBackoffSeconds(current, ceiling) {
  return Math.min(ceiling, current * 2);
}
