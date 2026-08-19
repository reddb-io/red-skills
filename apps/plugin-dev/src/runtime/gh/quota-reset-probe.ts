// gh/quota-reset-probe.ts — the reset instant a quota wait aims at.
//
// `withGhQuotaBackoff` has always described "one free probe per wait": sleep
// until the drained pool actually refills, and retry once, instead of pacing
// blind. The probe was never installed by the production factory — `probeResetMs`
// had no default — so every real quota wait in the tree fell through to the
// doubling fallback: 60s, 120s, 240s, 480s, then ten-minute silences under a
// thirty-minute cap. That is the fifteen-minute `queue_status` of #3768. It was
// not a deadlock and nothing was broken: the call was asleep, on purpose, for a
// duration nobody chose, and returned the right answer when it woke.
//
// **The reset is already known, host-wide and free.** The daemon polls
// `GET /rate_limit` for the whole machine, so the answer costs this process a
// unix-socket read rather than a request — which is the reason to aim rather
// than to guess. An absent daemon yields `null` and the fallback still paces the
// retries, one rung at a time.

import { daemonGhBalanceReader, type GhBalanceReader } from "./band.js";
import type { GithubRateBudget } from "@reddb-io/github";

/** Pools in the order a blind caller cares about: the tightest window first. */
const PROBE_POOLS: readonly GithubRateBudget[] = ["search", "graphql", "rest"];

/**
 * When the drained pool next refills, in epoch ms — or `null` when unknown.
 *
 * The soonest reset across the pools is the honest answer to an unattributed
 * rate limit: the caller's response said "you are limited" without saying which
 * ledger, and waiting for the LATEST reset would sit out a window that had
 * already reopened. A retry that arrives early costs one refused request and one
 * more rung; a retry that arrives ten minutes late costs ten minutes.
 */
export function createDaemonQuotaResetProbe(
  readBalance: GhBalanceReader = daemonGhBalanceReader(),
): () => Promise<number | null> {
  return async (): Promise<number | null> => {
    const balance = await readBalance();
    if (balance == null) return null;
    let soonest: number | null = null;
    for (const pool of PROBE_POOLS) {
      const observed = balance.pools[pool];
      if (observed == null || observed.reset_at === "") continue;
      const resetMs = Date.parse(observed.reset_at);
      if (!Number.isFinite(resetMs)) continue;
      if (soonest === null || resetMs < soonest) soonest = resetMs;
    }
    return soonest;
  };
}
