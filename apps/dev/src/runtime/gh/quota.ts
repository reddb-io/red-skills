// gh/quota.ts — rate-limit classification and bounded retry for gh CLI calls.
//
// GitHub enforces two layers of quota: primary (REST 403/429 with rate-limit
// headers, GraphQL RATE_LIMITED) and secondary (abuse detection). Both are
// TRANSIENT and fully distinguishable from permanent failures (auth errors,
// 404s, merge conflicts). Dying on either is a flow bug; this module provides
// the classifier and the bounded wait-and-retry primitive that prevents it.
//
// **BACKOFF IS ON BY DEFAULT, NOT OPT-IN.** Every gh invocation the runtime
// makes (landing, labels, comments, close) resolves its options through
// resolveGhQuotaBackoff: an injected `quotaBackoff` wins, and its ABSENCE means
// the documented default wait and cap — never "disabled". An opt-in safety
// primitive whose only populator is a test ships as a green suite over a binary
// with no protection at all (issue #2800); the resolver is what makes the
// implemented behavior reachable without a test injecting it.
//
// Read-only boot probes opt OUT explicitly at the call site (see gh/auth.ts):
// they classify a rate limit as transient themselves and proceed, so blocking
// boot for up to the cap would convert a survivable blip into a stall.

import { isGithubQuotaText } from "@reddb-io/shared/github-quota.js";

import { createDaemonQuotaResetProbe } from "./quota-reset-probe.js";
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
   * available. Default: 60 seconds, DOUBLING each retry up to one minute —
   * a fixed 60s cadence turned six waiting Workers into ~9,000 retries in one
   * evening (issue #3672's field data, 2026-08-11).
   */
  defaultWaitMs?: number;
  /**
   * When the drained pool resets, in epoch ms, or null when the answer is
   * unavailable. **Defaulted by `defaultGhQuotaBackoff` to the daemon's
   * host-wide balance** — an option documented as having no default is one
   * production never exercises, which is how every real wait here came to pace
   * blind (#3768). An injected probe still wins; `null` still falls through to
   * the doubling fallback below.
   */
  probeResetMs?: () => Promise<number | null>;
}

/** Maximum total wall-clock wait before the failing response is returned. */
export const DEFAULT_CAP_MS = 30 * 60 * 1000; // 30 minutes
/** First sleep between retries when no reset time is known. */
export const DEFAULT_WAIT_MS = 60 * 1000;      // 60 seconds
/**
 * Ceiling for the doubling fallback wait.
 *
 * Sixty seconds, not ten minutes (#3768). The fallback is what paces a wait that
 * could not learn the real reset instant, and a rung that long is indistinguishable
 * from a hang to whoever is holding the call: the fifteen-minute `queue_status`
 * was four of these rungs and nothing else. With the reset probe installed by
 * default the fallback is now the rare path, and a rare path is exactly the one
 * that must stay short — an aimed wait sleeps until the pool refills, a blind one
 * checks back every minute.
 */
export const MAX_FALLBACK_WAIT_MS = 60 * 1000; // 60 seconds
/** Safety margin added past the probed reset instant. */
export const RESET_MARGIN_MS = 5 * 1000;

/**
 * Emit the wait as operator-visible `quota-wait` activity. The exec helpers hold
 * no lane handle, so stderr is the surface that reaches the worker log: a bounded
 * wait an operator can read beats silence that reads as a hang. A caller wiring
 * a richer surface (vitals, lane records) overrides `onWait`.
 */
function announceQuotaWait(remainingMs: number, sleepForMs: number): void {
  const secs = Math.max(1, Math.round(sleepForMs / 1000));
  const budget = Math.max(0, Math.round(remainingMs / 1000));
  process.stderr.write(
    `quota-wait: github rate limit — waiting ${secs}s before retry (${budget}s of quota budget left)\n`,
  );
}

/** Operator override for the per-retry wait, in ms. */
export const WAIT_MS_ENV = "RED_GH_QUOTA_WAIT_MS";
/** Operator override for the total wait budget, in ms. `0` disables waiting. */
export const CAP_MS_ENV = "RED_GH_QUOTA_CAP_MS";

/**
 * A non-negative integer ms value from `env[name]`, else `fallback`. A malformed
 * or negative value is IGNORED rather than throwing: a typo in an operator's
 * shell must not brick every gh call, and the fallback is the safe behavior.
 * PURE.
 */
export function readQuotaMsEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * The production quota-backoff options: real clock, real sleep, documented cap
 * and wait, and a `quota-wait` notice on every wait. `overrides` lets a caller
 * tune one field without re-deriving the rest; absent an override, the cap and
 * wait honour {@link CAP_MS_ENV} / {@link WAIT_MS_ENV} so an operator can widen
 * the budget — or set the cap to `0` to refuse the wait — without a code change.
 */
export function defaultGhQuotaBackoff(
  overrides: Partial<GhQuotaBackoffOpts> = {},
): GhQuotaBackoffOpts {
  const capMs = overrides.capMs ?? readQuotaMsEnv(CAP_MS_ENV, DEFAULT_CAP_MS);
  const waitMs = overrides.defaultWaitMs ?? readQuotaMsEnv(WAIT_MS_ENV, DEFAULT_WAIT_MS);
  return {
    nowMs: overrides.nowMs ?? (() => Date.now()),
    sleepMs: overrides.sleepMs ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    onWait: overrides.onWait ?? ((remainingMs) => announceQuotaWait(remainingMs, Math.min(waitMs, remainingMs))),
    capMs,
    defaultWaitMs: waitMs,
    // Installed BY DEFAULT (#3768). A probe whose only populator was a test is a
    // probe that never ran, and the aimed sleep this option exists for was the
    // thing production never got — every real wait paced blind instead. The
    // daemon already holds the reset instant host-wide, so this costs a socket
    // read rather than a request, and an absent daemon still yields the fallback.
    probeResetMs: overrides.probeResetMs ?? createDaemonQuotaResetProbe(),
  };
}

/**
 * The options a gh invocation runs with. Injection stays available for tests;
 * ABSENCE of injection no longer means absence of backoff — that is the whole
 * defect of #2800, where the only populator in the tree was a test file. PURE
 * apart from the clock/sleep closures it hands back.
 */
export function resolveGhQuotaBackoff(injected?: GhQuotaBackoffOpts): GhQuotaBackoffOpts {
  return injected ?? defaultGhQuotaBackoff();
}

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
  const baseWaitMs = opts.defaultWaitMs ?? DEFAULT_WAIT_MS;

  let result = await fn();
  if (!isGhRateLimited(result)) return result;

  const deadlineMs = opts.nowMs() + capMs;
  let fallbackWaitMs = baseWaitMs;

  while (isGhRateLimited(result)) {
    const remainingMs = deadlineMs - opts.nowMs();
    if (remainingMs <= 0) {
      // Cap exceeded: return the failing result so the caller can park with an
      // explicit quota reason rather than looping forever.
      return result;
    }
    // One free probe per wait: sleeping until the pool actually refills turns
    // the 60s hammer (~30 retries per window) into a single well-aimed retry.
    const resetMs = (await opts.probeResetMs?.().catch(() => null)) ?? null;
    const untilResetMs = resetMs === null ? null : resetMs + RESET_MARGIN_MS - opts.nowMs();
    const sleepForMs = Math.min(
      untilResetMs !== null && untilResetMs > 0 ? untilResetMs : fallbackWaitMs,
      remainingMs,
    );
    if (untilResetMs === null || untilResetMs <= 0) {
      fallbackWaitMs = Math.min(fallbackWaitMs * 2, MAX_FALLBACK_WAIT_MS);
    }
    opts.onWait?.(remainingMs);
    await opts.sleepMs(sleepForMs);
    result = await fn();
  }

  return result;
}
