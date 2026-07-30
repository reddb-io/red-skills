// gh/quota.ts — rate-limit classification and bounded retry for gh CLI calls.
//
// GitHub enforces two layers of quota: primary (REST 403/429 with rate-limit
// headers, GraphQL RATE_LIMITED) and secondary (abuse detection). Both are
// TRANSIENT and fully distinguishable from permanent failures (auth errors,
// 404s, merge conflicts). Dying on either is a flow bug; this module provides
// the classifier and the bounded wait-and-retry primitive that prevents it.
//
// Every gh mutation in the worker path (landing, labels, comments, close)
// routes through withGhQuotaBackoff when GhContext/GitContext carries a
// quotaBackoff option. Without the option, behavior is unchanged.

import { isGithubQuotaText } from "@reddb-io/shared/github-quota.js";

import type { ExecOutput } from "../exec.js";

// The quota taxonomy itself — primary limits, secondary/abuse limits, GraphQL
// exhaustion — is owned by `@reddb-io/shared/github-quota.js` so that every
// boundary that classifies a GitHub failure reads the same patterns (#2830).
// This module owns only the exec-output shape and the bounded retry around it.

/**
 * True when `output` is a GitHub rate-limit response (REST 403/429 with
 * rate-limit markers, or GraphQL RATE_LIMITED). Returns false on success
 * (code 0) or on unrelated failures (auth errors, 404, merge conflicts).
 */
export function isGhRateLimited(output: ExecOutput): boolean {
  if (output.code === 0) return false;
  return isGithubQuotaText(`${output.stdout}\n${output.stderr}`);
}

export interface GhQuotaBackoffOpts {
  /** Returns the current epoch in ms (injectable for testing with a fake clock). */
  nowMs(): number;
  /**
   * Sleep for `ms` milliseconds before the next retry. Injectable for testing
   * so the full retry cycle runs in-process without real delays.
   */
  sleepMs(ms: number): Promise<void>;
  /**
   * Called at the start of each wait with the remaining ms until retry.
   * Wire this to emit 'quota-wait' activity on worker vitals/lane records so
   * the wait is visible to the operator rather than appearing as silence.
   */
  onWait?(remainingMs: number): void;
  /**
   * Maximum total wall-clock wait before giving up and returning the last
   * failing output. Default: 30 minutes. After the cap the caller receives
   * the rate-limit response and can park with an explicit quota reason.
   */
  capMs?: number;
  /**
   * How long to sleep between retries when no server-supplied reset time is
   * available. Default: 60 seconds.
   */
  defaultWaitMs?: number;
}

const DEFAULT_CAP_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_WAIT_MS = 60 * 1000;      // 60 seconds

/**
 * Run `fn` once. If the result is a rate-limit, sleep for up to `capMs`
 * (default 30 min) and retry. Returns the FIRST non-rate-limit result — either
 * a success or a genuine non-quota failure. Returns the last rate-limit result
 * unchanged if the cap would be exceeded before any retry is safe.
 *
 * `opts.onWait` is called before each sleep so callers can emit 'quota-wait'
 * activity on lane records, keeping the wait visible to the operator.
 */
export async function withGhQuotaBackoff(
  fn: () => Promise<ExecOutput>,
  opts: GhQuotaBackoffOpts,
): Promise<ExecOutput> {
  const capMs = opts.capMs ?? DEFAULT_CAP_MS;
  const waitMs = opts.defaultWaitMs ?? DEFAULT_WAIT_MS;

  let result = await fn();
  if (!isGhRateLimited(result)) return result;

  const deadlineMs = opts.nowMs() + capMs;

  while (isGhRateLimited(result)) {
    const remainingMs = deadlineMs - opts.nowMs();
    if (remainingMs <= 0) {
      // Cap exceeded: return the failing result so the caller can park with an
      // explicit quota reason rather than looping forever.
      return result;
    }
    const sleepForMs = Math.min(waitMs, remainingMs);
    opts.onWait?.(remainingMs);
    await opts.sleepMs(sleepForMs);
    result = await fn();
  }

  return result;
}
