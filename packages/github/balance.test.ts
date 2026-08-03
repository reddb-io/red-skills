// The balance is ASKED, never counted (ADR 0132 Amendment 2, issue #3095).
import { describe, expect, it } from "vitest";
import {
  GITHUB_BALANCE_STALE_MS,
  GITHUB_RESERVED_BAND,
  isBalanceStale,
  maySpend,
  msUntilEarliestReset,
  nextBalancePollMs,
  parseRateLimit,
  tightestShare,
  type GithubBalance,
} from "./balance.js";

const NOW = Date.parse("2026-08-03T02:00:00.000Z");

function balance(shares: { rest?: number; graphql?: number; search?: number }, askedAtMs = NOW): GithubBalance {
  const pool = (share: number, limit: number) => ({
    limit,
    remaining: Math.round(limit * share),
    resetAtSec: Math.floor(NOW / 1000) + 3600,
  });
  return {
    pools: {
      rest: pool(shares.rest ?? 1, 5000),
      graphql: pool(shares.graphql ?? 1, 5000),
      search: pool(shares.search ?? 1, 30),
    },
    askedAtMs,
  };
}

describe("parseRateLimit", () => {
  it("maps GitHub's `core` onto our `rest` pool", () => {
    const parsed = parseRateLimit(
      { resources: { core: { limit: 5000, remaining: 4900, reset: 1 }, graphql: { limit: 5000, remaining: 2800, reset: 2 }, search: { limit: 30, remaining: 30, reset: 3 } } },
      NOW,
    );
    expect(parsed?.pools.rest.remaining).toBe(4900);
    expect(parsed?.pools.graphql.remaining).toBe(2800);
    expect(parsed?.askedAtMs).toBe(NOW);
  });

  it("returns null on a shape it does not recognise, never a zero", () => {
    // A zero would read as "spent" and open the breaker on a parse bug — the
    // failure that fakes the emergency it exists to detect.
    for (const bad of [null, undefined, {}, { resources: {} }, { resources: { core: { limit: "x" } } }]) {
      expect(parseRateLimit(bad, NOW)).toBeNull();
    }
  });
});

describe("nextBalancePollMs", () => {
  it("is rare when nothing is going to run out", () => {
    expect(nextBalancePollMs(balance({ graphql: 0.9 }), NOW)).toBe(300_000);
  });

  it("tightens as the balance falls", () => {
    expect(nextBalancePollMs(balance({ graphql: 0.4 }), NOW)).toBe(60_000);
    expect(nextBalancePollMs(balance({ graphql: 0.15 }), NOW)).toBe(10_000);
  });

  it("waits for the reset once spent, because nothing else can change the answer", () => {
    const spent = balance({ graphql: 0 });
    const wait = nextBalancePollMs(spent, NOW);
    expect(wait).toBeGreaterThan(60_000);
    expect(wait).toBeLessThanOrEqual(300_000);
  });

  it("is driven by the TIGHTEST pool, not the average", () => {
    // search is 30/hour; a full REST pool must not hide an empty search one.
    expect(nextBalancePollMs(balance({ rest: 1, graphql: 1, search: 0.1 }), NOW)).toBe(10_000);
  });

  it("never returns a per-operation cadence — the floor is seconds", () => {
    // /rate_limit is free of PRIMARY quota only; secondary limits apply.
    for (const share of [0, 0.05, 0.2, 0.5, 1]) {
      expect(nextBalancePollMs(balance({ graphql: share }), NOW)).toBeGreaterThanOrEqual(5_000);
    }
  });
});

describe("maySpend", () => {
  it("admits ordinary work when the balance is healthy", () => {
    expect(maySpend(balance({ graphql: 0.8 }), "graphql", false, NOW).allowed).toBe(true);
  });

  it("refuses convenience inside the reserved band but lets essentials through", () => {
    const low = balance({ graphql: GITHUB_RESERVED_BAND / 2 });
    expect(maySpend(low, "graphql", false, NOW).allowed).toBe(false);
    expect(maySpend(low, "graphql", true, NOW).allowed).toBe(true);
  });

  it("names the threshold that refused it", () => {
    const verdict = maySpend(balance({ graphql: 0.05 }), "graphql", false, NOW);
    expect(verdict.reason).toContain("reserved band");
    expect(verdict.reason).toContain("claim");
  });

  it("stops everything, essential included, once a pool is actually empty", () => {
    const spent = balance({ graphql: 0 });
    expect(maySpend(spent, "graphql", true, NOW).allowed).toBe(false);
    expect(maySpend(spent, "graphql", false, NOW).reason).toContain("spent");
  });

  it("decides against the named pool only — an empty graphql does not stop REST", () => {
    const mixed = balance({ rest: 0.9, graphql: 0 });
    expect(maySpend(mixed, "rest", false, NOW).allowed).toBe(true);
    expect(maySpend(mixed, "graphql", false, NOW).allowed).toBe(false);
  });

  it("on a stale reading refuses convenience and admits essentials", () => {
    // Refusing everything would let a dead poller halt a healthy machine;
    // admitting everything would spend a budget nobody has looked at.
    const old = balance({ graphql: 0.9 }, NOW - GITHUB_BALANCE_STALE_MS - 1);
    expect(maySpend(old, "graphql", false, NOW).allowed).toBe(false);
    expect(maySpend(old, "graphql", false, NOW).reason).toContain("last asked");
    expect(maySpend(old, "graphql", true, NOW).allowed).toBe(true);
  });
});

describe("staleness and reset", () => {
  it("believes a fresh reading and disbelieves an old one", () => {
    expect(isBalanceStale(balance({}, NOW), NOW)).toBe(false);
    expect(isBalanceStale(balance({}, NOW - GITHUB_BALANCE_STALE_MS), NOW)).toBe(true);
  });

  it("reports the soonest reset, and never a negative wait", () => {
    expect(msUntilEarliestReset(balance({}), NOW)).toBe(3_600_000);
    expect(msUntilEarliestReset(balance({}), NOW + 7_200_000)).toBe(0);
  });

  it("tightestShare clamps a negative remaining to zero", () => {
    const odd: GithubBalance = {
      pools: {
        rest: { limit: 5000, remaining: -5, resetAtSec: 0 },
        graphql: { limit: 5000, remaining: 5000, resetAtSec: 0 },
        search: { limit: 30, remaining: 30, resetAtSec: 0 },
      },
      askedAtMs: NOW,
    };
    expect(tightestShare(odd)).toBe(0);
  });
});
