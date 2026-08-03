import { describe, expect, it } from "vitest";

import {
  GITHUB_BALANCE_CADENCE,
  GITHUB_BALANCE_MIN_CADENCE_MS,
  GITHUB_RATE_LIMIT_ARGV,
  GITHUB_RESERVED_FRACTION,
  admitGithubCall,
  admitGithubOperation,
  buildGithubBalanceReport,
  fetchGithubBalance,
  githubBalanceCadenceMs,
  githubBalancePosture,
  parseGithubBalance,
  unaskedGithubBalance,
} from "./balance.js";
import { routeGithubArgs } from "./surface.js";

const ASKED_AT = "2026-08-03T12:00:00.000Z";

function payload(over: {
  readonly core?: [number, number];
  readonly graphql?: [number, number];
  readonly search?: [number, number];
  readonly resetAt?: number;
} = {}): unknown {
  const reset = over.resetAt ?? Math.floor(Date.parse("2026-08-03T12:30:00.000Z") / 1000);
  const resource = ([limit, remaining]: [number, number]) => ({
    limit,
    remaining,
    used: limit - remaining,
    reset,
  });
  return {
    resources: {
      core: resource(over.core ?? [5000, 5000]),
      graphql: resource(over.graphql ?? [5000, 2200]),
      search: resource(over.search ?? [30, 30]),
    },
  };
}

describe("the balance is asked, never derived", () => {
  it("asks GET /rate_limit, which the routing table already classifies as REST", () => {
    expect(GITHUB_RATE_LIMIT_ARGV).toEqual(["api", "rate_limit"]);
    expect(routeGithubArgs(GITHUB_RATE_LIMIT_ARGV).surface).toBe("rest");
  });

  it("reads every pool's remaining straight out of the answer", () => {
    const balance = parseGithubBalance(payload(), { askedAt: ASKED_AT });

    expect(balance.origin).toBe("asked");
    expect(balance.outcome).toBe("asked");
    expect(balance.pools.rest?.remaining).toBe(5000);
    expect(balance.pools.rest?.resource).toBe("core");
    expect(balance.pools.graphql?.remaining).toBe(2200);
    expect(balance.pools.graphql?.fraction).toBeCloseTo(0.44, 5);
    expect(balance.pools.search?.limit).toBe(30);
    expect(balance.asked_at).toBe(ASKED_AT);
  });

  it("names a pool the endpoint did not report rather than calling it zero", () => {
    const balance = parseGithubBalance({ resources: { core: { limit: 5000, remaining: 4891, used: 109, reset: 0 } } }, {
      askedAt: ASKED_AT,
    });

    expect(balance.pools.rest?.remaining).toBe(4891);
    expect(balance.pools.graphql).toBeNull();
    expect(balance.unreported_pools).toEqual(["graphql", "search"]);
  });

  it("comes back unanswered — never spent, never full — when the ask fails", async () => {
    const balance = await fetchGithubBalance({
      transport: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      now: ASKED_AT,
    });

    expect(balance.outcome).toBe("unanswered");
    expect(balance.pools.rest).toBeNull();
    expect(balance.detail).toContain("connect ECONNREFUSED");
  });

  it("costs one request per ask, whatever the caller does with it", async () => {
    let calls = 0;
    const balance = await fetchGithubBalance({
      transport: async () => {
        calls += 1;
        return payload();
      },
      now: ASKED_AT,
    });

    expect(calls).toBe(1);
    expect(balance.request_count).toBe(1);
    expect(balance.outcome).toBe("asked");
  });

  it("has no accumulator to seed: an unasked balance knows nothing", () => {
    const balance = unaskedGithubBalance(ASKED_AT);

    expect(balance.outcome).toBe("unanswered");
    expect(balance.request_count).toBe(0);
    expect(balance.pools.graphql).toBeNull();
  });
});

describe("cadence is a function of the balance", () => {
  it("is rare above half, tightens as the balance falls, and stays continuous once spent", () => {
    const at = (remaining: number) =>
      githubBalanceCadenceMs(parseGithubBalance(payload({ graphql: [5000, remaining] }), { askedAt: ASKED_AT }), {
        now: ASKED_AT,
      });

    const full = at(5000);
    const belowHalf = at(2000);
    const inBand = at(500);
    const spent = at(0);

    expect(full).toBeGreaterThan(belowHalf);
    expect(belowHalf).toBeGreaterThan(inBand);
    expect(inBand).toBeGreaterThan(spent);
  });

  it("stays a cadence — seconds, never a poll per operation", () => {
    for (const step of GITHUB_BALANCE_CADENCE) {
      expect(step.every_ms).toBeGreaterThanOrEqual(GITHUB_BALANCE_MIN_CADENCE_MS);
    }
    const spent = parseGithubBalance(payload({ graphql: [5000, 0] }), { askedAt: ASKED_AT });
    expect(githubBalanceCadenceMs(spent, { now: ASKED_AT })).toBeGreaterThanOrEqual(GITHUB_BALANCE_MIN_CADENCE_MS);
  });

  it("takes the cadence of the tightest pool, not of the roomiest", () => {
    const balance = parseGithubBalance(payload({ core: [5000, 5000], graphql: [5000, 10] }), { askedAt: ASKED_AT });

    expect(githubBalanceCadenceMs(balance, { now: ASKED_AT })).toBe(
      githubBalanceCadenceMs(parseGithubBalance(payload({ core: [5000, 10], graphql: [5000, 10] }), { askedAt: ASKED_AT }), {
        now: ASKED_AT,
      }),
    );
  });

  it("asks again soon when nothing answered, because blind is not full", () => {
    const cadence = githubBalanceCadenceMs(unaskedGithubBalance(ASKED_AT), { now: ASKED_AT });

    expect(cadence).toBeLessThan(GITHUB_BALANCE_CADENCE[GITHUB_BALANCE_CADENCE.length - 1]!.every_ms);
  });
});

describe("the reserved band refuses convenience, never the claim", () => {
  const inBand = () => parseGithubBalance(payload({ graphql: [5000, 100] }), { askedAt: ASKED_AT });

  it("holds a stated fraction of the budget", () => {
    expect(GITHUB_RESERVED_FRACTION).toBeGreaterThan(0);
    expect(GITHUB_RESERVED_FRACTION).toBeLessThan(0.5);
    expect(githubBalancePosture(inBand(), "graphql")).toBe("reserved");
    expect(githubBalancePosture(parseGithubBalance(payload(), { askedAt: ASKED_AT }), "graphql")).toBe("open");
  });

  it("refuses a convenience read inside the band and admits the claim", () => {
    const balance = inBand();

    const convenience = admitGithubCall({ balance, pool: "graphql", criticality: "convenience" });
    const claim = admitGithubCall({ balance, pool: "graphql", criticality: "essential" });

    expect(convenience.admitted).toBe(false);
    expect(convenience.posture).toBe("reserved");
    expect(convenience.reason).toContain("reserved");
    expect(claim.admitted).toBe(true);
    expect(claim.reserved_floor).toBe(750);
  });

  it("admits everything while the balance is open", () => {
    const balance = parseGithubBalance(payload(), { askedAt: ASKED_AT });

    expect(admitGithubCall({ balance, pool: "graphql", criticality: "convenience" }).admitted).toBe(true);
    expect(admitGithubCall({ balance, pool: "rest", criticality: "essential" }).admitted).toBe(true);
  });

  it("refuses even the claim once the pool is spent, and names the reset", () => {
    const balance = parseGithubBalance(payload({ graphql: [5000, 0] }), { askedAt: ASKED_AT });
    const claim = admitGithubCall({ balance, pool: "graphql", criticality: "essential" });

    expect(claim.admitted).toBe(false);
    expect(claim.posture).toBe("spent");
    expect(claim.reason).toContain("2026-08-03T12:30:00.000Z");
  });

  it("stays reactive rather than refusing on a balance nobody answered", () => {
    const admission = admitGithubCall({
      balance: unaskedGithubBalance(ASKED_AT),
      pool: "graphql",
      criticality: "convenience",
    });

    expect(admission.posture).toBe("unknown");
    expect(admission.admitted).toBe(true);
    expect(admission.reason).toContain("no authoritative balance");
  });

  it("draws an operation's pool from the routing table rather than from the caller", () => {
    const balance = inBand();
    const listing = admitGithubOperation({
      balance,
      operation: routeGithubArgs(["issue", "list"]),
      criticality: "convenience",
    });
    const view = admitGithubOperation({
      balance,
      operation: routeGithubArgs(["issue", "view", "42"]),
      criticality: "convenience",
    });

    expect(listing.pool).toBe("graphql");
    expect(listing.admitted).toBe(false);
    expect(view.pool).toBe("rest");
    expect(view.admitted).toBe(true);
  });
});

describe("the report carries its own age and posture", () => {
  it("dates the balance so a consumer renders the age instead of inventing it", () => {
    const balance = parseGithubBalance(payload({ graphql: [5000, 100] }), { askedAt: ASKED_AT });
    const report = buildGithubBalanceReport({ balance, now: "2026-08-03T12:00:45.000Z" });

    expect(report.age_ms).toBe(45_000);
    expect(report.posture).toBe("reserved");
    expect(report.next_poll_ms).toBe(githubBalanceCadenceMs(balance, { now: ASKED_AT }));
    expect(report.stale).toBe(false);
  });

  it("says the daemon has asked nothing rather than reporting a full budget", () => {
    const report = buildGithubBalanceReport({ balance: null, now: ASKED_AT });

    expect(report.posture).toBe("unknown");
    expect(report.age_ms).toBeNull();
    expect(report.reason).toContain("has asked for no balance");
  });

  it("is out of quota and empty-queue distinguishable on one screen", () => {
    const spent = buildGithubBalanceReport({
      balance: parseGithubBalance(payload({ graphql: [5000, 0] }), { askedAt: ASKED_AT }),
      now: ASKED_AT,
    });
    const open = buildGithubBalanceReport({
      balance: parseGithubBalance(payload(), { askedAt: ASKED_AT }),
      now: ASKED_AT,
    });

    expect(spent.posture).toBe("spent");
    expect(spent.reason).not.toBe(open.reason);
    expect(spent.reason).toContain("graphql");
  });

  it("calls a balance older than the cadence it asked for stale", () => {
    const balance = parseGithubBalance(payload(), { askedAt: ASKED_AT });
    const report = buildGithubBalanceReport({ balance, now: "2026-08-03T13:00:00.000Z" });

    expect(report.stale).toBe(true);
    expect(report.reason).toContain("stale");
  });
});
