/** Hard wall-clock bound for one daemon-owned remote poll. */
export const DEFAULT_REDSKILLED_REMOTE_POLL_TIMEOUT_MS = 10_000;

/** Bind the daemon option once, then apply the same deadline to every poller. */
export function createRemotePollDeadline(
  timeoutMs = DEFAULT_REDSKILLED_REMOTE_POLL_TIMEOUT_MS,
): <T>(label: string, poll: () => Promise<T>) => Promise<T> {
  return async <T>(label: string, poll: () => Promise<T>) =>
    await withinRemotePollDeadline(label, timeoutMs, poll);
}

/**
 * Let a poller go back to sleep even when its transport never settles.
 *
 * The remote promise may still finish after the deadline when its transport has
 * no cancellation surface. Callers must therefore commit fetched state only
 * from this promise's resolved value, never from inside `poll`.
 */
export async function withinRemotePollDeadline<T>(
  label: string,
  timeoutMs: number,
  poll: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await poll();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`redskilled ${label} exceeded its ${timeoutMs}ms remote-call deadline`)),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([Promise.resolve().then(poll), deadline]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
