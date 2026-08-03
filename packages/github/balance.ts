// balance — what is left of the token's budget, ASKED rather than accumulated.
//
// ADR 0132 Amendment 2. A ledger that counts its own calls is blind by
// construction: the daemon is host-scoped, GitHub's quota is per TOKEN, and an
// operator running four machines on one token would have four daemons each
// reporting three quarters of a fiction. That was measured — the numbers only
// began to make sense when three of the four machines were switched off.
//
// **The fix is not federation. It is to stop counting and start asking.**
// `GET /rate_limit` returns the whole token's true remaining budget across every
// machine, and it costs nothing: six consecutive calls moved `core` by zero.
// A daemon never learns the operator's other machines exist; it sees their
// effect in the balance.
//
// This generalizes the rule three defects here share: **when an authoritative
// source exists, ask it — derive only when none exists, and say you are
// deriving.** #3080 derived host memory from a per-process walk and was wrong by
// 377x; #3092 derived "the daemon is absent" from its own failed reach while the
// process was alive and listening.
//
// PURE. Every function is total over its inputs and performs no IO; the caller
// owns the request and the clock.
import type { GithubRateBudget } from "./surface.js";

/** One pool's standing, as GitHub reports it. */
export interface GithubPoolBalance {
  readonly limit: number;
  readonly remaining: number;
  /** Epoch seconds at which this pool refills, as GitHub states it. */
  readonly resetAtSec: number;
}

/**
 * Every pool, plus WHEN it was asked.
 *
 * The instant is carried rather than implied because a balance is always read
 * later than it was taken, and a consumer that cannot see the age cannot tell a
 * fresh zero from a stale one.
 */
export interface GithubBalance {
  readonly pools: Readonly<Record<GithubRateBudget, GithubPoolBalance>>;
  /** Epoch ms when this reading was taken. */
  readonly askedAtMs: number;
}

/**
 * How long a balance may be believed before it is only a rumour.
 *
 * Deliberately shorter than the tightest poll below: a reading nobody refreshed
 * inside a full cadence means the poller stopped, and a stale balance presented
 * as current is what the reserved band exists to prevent.
 */
export const GITHUB_BALANCE_STALE_MS = 30_000;

/** A pool at or under this share of its limit is close enough to matter. */
export const GITHUB_BALANCE_TIGHT = 0.2;

/** Above this share nothing is going to run out inside one cadence. */
export const GITHUB_BALANCE_RELAXED = 0.5;

/**
 * The share held back for work that must not fail.
 *
 * The claim, a landing, and the closing comment of a Worker that has finished
 * are not conveniences: refusing them strands work that is already done. The
 * band is what makes degradation graduated rather than a 403 nobody predicted.
 */
export const GITHUB_RESERVED_BAND = 0.1;

/**
 * How often to ask again, given the balance. PURE.
 *
 * **Asking is free, so the cadence is a function of the balance rather than a
 * constant.** A fixed cadence forces one choice for two opposite situations: it
 * is either slow at the edge, where the number changes fastest and matters most,
 * or wasteful in the middle, where nothing is going to run out. An adaptive one
 * does not choose.
 *
 * The returned delay is a CADENCE, never a per-operation check. `GET
 * /rate_limit` is free of PRIMARY quota only — GitHub enforces secondary limits
 * on request rate and concurrency across every endpoint — so the floor here is
 * seconds, and no caller may ask before each call.
 */
export function nextBalancePollMs(balance: GithubBalance, nowMs: number): number {
  const tightest = tightestShare(balance);
  if (tightest <= 0) {
    // Spent. The only event that matters now is the reset, so wait for it
    // rather than asking a question whose answer cannot change until then.
    const resetInMs = msUntilEarliestReset(balance, nowMs);
    return clamp(resetInMs + 1_000, 5_000, 300_000);
  }
  if (tightest <= GITHUB_BALANCE_TIGHT) return 10_000;
  if (tightest <= GITHUB_BALANCE_RELAXED) return 60_000;
  return 300_000;
}

/** The share left in whichever pool is closest to empty. PURE. */
export function tightestShare(balance: GithubBalance): number {
  let tightest = 1;
  for (const pool of Object.values(balance.pools)) {
    if (pool.limit <= 0) continue;
    tightest = Math.min(tightest, Math.max(0, pool.remaining) / pool.limit);
  }
  return tightest;
}

/** Milliseconds until the first pool refills; `0` when one already has. PURE. */
export function msUntilEarliestReset(balance: GithubBalance, nowMs: number): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const pool of Object.values(balance.pools)) {
    soonest = Math.min(soonest, pool.resetAtSec * 1_000 - nowMs);
  }
  return Number.isFinite(soonest) ? Math.max(0, soonest) : 0;
}

/** True when this reading is too old to act on. PURE. */
export function isBalanceStale(balance: GithubBalance, nowMs: number): boolean {
  return nowMs - balance.askedAtMs >= GITHUB_BALANCE_STALE_MS;
}

/**
 * Whether an operation may proceed, and why not when it may not.
 *
 * `essential` is the caller's word, not this module's: only the project knows
 * that a claim strands a Worker and a progress comment does not.
 */
export interface GithubSpendVerdict {
  readonly allowed: boolean;
  /** The pool this verdict was decided against. */
  readonly budget: GithubRateBudget;
  /** Present only on a refusal, and always says which threshold refused it. */
  readonly reason: string | null;
}

/**
 * May this call spend from `budget` right now? PURE.
 *
 * **Essential work outlives the band; convenience does not.** A Worker that has
 * finished must be able to say so, and a claim that cannot be written is a
 * Worker that must decline its issue rather than proceed unclaimed — so both
 * pass while the balance is merely low, and only an empty pool stops them.
 *
 * **A stale balance refuses convenience and admits essentials.** Refusing
 * everything on a reading nobody refreshed would let a dead poller halt a
 * healthy machine; admitting everything would spend a budget nobody has looked
 * at. Essentials are the smaller risk of the two.
 */
export function maySpend(
  balance: GithubBalance,
  budget: GithubRateBudget,
  essential: boolean,
  nowMs: number,
): GithubSpendVerdict {
  const pool = balance.pools[budget];
  const stale = isBalanceStale(balance, nowMs);
  const share = pool.limit > 0 ? Math.max(0, pool.remaining) / pool.limit : 1;

  if (pool.remaining <= 0) {
    return {
      allowed: false,
      budget,
      reason:
        `the ${budget} pool is spent (0/${pool.limit}); it refills in ` +
        `${Math.ceil(msUntilEarliestReset(balance, nowMs) / 1_000)}s`,
    };
  }
  if (essential) return { allowed: true, budget, reason: null };
  if (stale) {
    return {
      allowed: false,
      budget,
      reason:
        `the balance was last asked ${Math.round((nowMs - balance.askedAtMs) / 1_000)}s ago, past the ` +
        `${GITHUB_BALANCE_STALE_MS / 1_000}s it may be believed, so only essential work spends`,
    };
  }
  if (share <= GITHUB_RESERVED_BAND) {
    return {
      allowed: false,
      budget,
      reason:
        `the ${budget} pool is inside the reserved band (${pool.remaining}/${pool.limit}, ` +
        `${Math.round(share * 100)}% <= ${GITHUB_RESERVED_BAND * 100}%), which is held for the claim, the ` +
        `landing and a finishing Worker's last word`,
    };
  }
  return { allowed: true, budget, reason: null };
}

/**
 * Read GitHub's `/rate_limit` document into a balance. PURE.
 *
 * Tolerant by design: a shape this does not recognise yields `null` rather than
 * a throw or a zero. A zero would read as "spent" and open the breaker on a
 * parse bug, which is the failure that fakes the emergency it was built to
 * detect.
 */
export function parseRateLimit(document: unknown, askedAtMs: number): GithubBalance | null {
  if (document === null || typeof document !== "object") return null;
  const resources = (document as { resources?: unknown }).resources;
  if (resources === null || typeof resources !== "object") return null;

  const pools: Partial<Record<GithubRateBudget, GithubPoolBalance>> = {};
  // GitHub names the REST pool `core`; the other two match our own vocabulary.
  for (const [budget, key] of [["rest", "core"], ["graphql", "graphql"], ["search", "search"]] as const) {
    const pool = readPool((resources as Record<string, unknown>)[key]);
    if (pool === null) return null;
    pools[budget] = pool;
  }
  return { pools: pools as Record<GithubRateBudget, GithubPoolBalance>, askedAtMs };
}

function readPool(value: unknown): GithubPoolBalance | null {
  if (value === null || typeof value !== "object") return null;
  const pool = value as Record<string, unknown>;
  const limit = pool.limit;
  const remaining = pool.remaining;
  const reset = pool.reset;
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) return null;
  return { limit: limit as number, remaining: remaining as number, resetAtSec: reset as number };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
