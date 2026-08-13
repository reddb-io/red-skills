import { fetchGithubBalance } from "@reddb-io/github";

import type { RedskilledBalanceObserver } from "./types.js";

type RemotePoll = <T>(label: string, poll: () => Promise<T>) => Promise<T>;

/** Observe optional payers without replacing the personal balance used by policy. */
export async function pollGithubBalanceObservers(
  observers: readonly RedskilledBalanceObserver[] | undefined,
  remotePoll: RemotePoll,
  now: () => string,
): Promise<void> {
  for (const observer of observers ?? []) {
    const observed = await remotePoll(`GitHub balance poll (${observer.identity})`, () =>
      fetchGithubBalance({ transport: observer.transport, now: now() }));
    await observer.store?.write(observed).catch(() => undefined);
    await observer.history?.append(observed).catch(() => undefined);
  }
}
