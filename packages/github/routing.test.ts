import { describe, expect, it } from "vitest";

import {
  GITHUB_OPERATIONS,
  GithubBackpressureError,
  classifyGithubLimit,
  routeGithubOperation,
  type GithubBudgetSnapshot,
} from "./index.js";

const RESET = "2026-08-15T22:00:00.000Z";

function budgets(rest: number, graphql: number, search = 30): GithubBudgetSnapshot {
  return {
    rest: { remaining: rest, reset_at: RESET },
    graphql: { remaining: graphql, reset_at: RESET },
    search: { remaining: search, reset_at: RESET },
    secondary: null,
  };
}

describe("GitHub operation rail routing", () => {
  it("reroutes every REST-preferred operation with a declared GraphQL equivalent", () => {
    const equivalent = GITHUB_OPERATIONS.filter((operation) =>
      operation.surface === "rest" && operation.fallback === "graphql");
    expect(equivalent.length).toBeGreaterThan(0);

    for (const operation of equivalent) {
      expect(routeGithubOperation(operation, budgets(0, 4_900))).toMatchObject({
        outcome: "route",
        surface: "graphql",
        rerouted: true,
      });
    }
  });

  it("reroutes every GraphQL-preferred operation with a declared REST equivalent", () => {
    const equivalent = GITHUB_OPERATIONS.filter((operation) =>
      operation.surface === "graphql" && operation.fallback === "rest");
    expect(equivalent.length).toBeGreaterThan(0);

    for (const operation of equivalent) {
      expect(routeGithubOperation(operation, budgets(4_900, 0))).toMatchObject({
        outcome: "route",
        surface: "rest",
        rerouted: true,
      });
    }
  });

  it("returns immediately with typed retry evidence when no rail or cache can answer", () => {
    const operation = GITHUB_OPERATIONS.find(({ key }) => key === "run view")!;
    const decision = routeGithubOperation(operation, budgets(0, 4_900));
    expect(decision).toMatchObject({
      outcome: "backpressure",
      fact: { kind: "primary-rest-exhausted", pool: "rest", retry_at: RESET },
    });
    expect(() => {
      if (decision.outcome === "backpressure") throw new GithubBackpressureError(decision.fact);
    }).toThrow("REST primary quota is exhausted");

    expect(routeGithubOperation(operation, budgets(0, 4_900), { cacheEligible: true }))
      .toMatchObject({ outcome: "cache", pool: "rest" });
  });

  it.each([
    ["rest", "primary-rest-exhausted"],
    ["graphql", "primary-graphql-exhausted"],
    ["search", "search-exhausted"],
  ] as const)("classifies %s primary exhaustion distinctly", (pool, kind) => {
    expect(classifyGithubLimit({
      status: 403,
      response: { headers: {
        "x-ratelimit-resource": pool === "rest" ? "core" : pool,
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Date.parse(RESET) / 1_000),
      } },
    }, pool)).toMatchObject({ kind, pool, retry_at: RESET });
  });

  it("classifies secondary throttling from retry evidence, independent of healthy primary percentages", () => {
    const fact = classifyGithubLimit({
      status: 403,
      message: "You have exceeded a secondary rate limit",
      response: { headers: { "retry-after": "90", "x-ratelimit-remaining": "4999" } },
    }, "rest", Date.parse("2026-08-15T21:00:00.000Z"));

    expect(fact).toEqual({
      kind: "secondary-throttled",
      pool: "secondary",
      retry_at: "2026-08-15T21:01:30.000Z",
      evidence: "retry-after",
      message: "GitHub secondary throttling is active; retry after 2026-08-15T21:01:30.000Z",
    });
    expect(routeGithubOperation(
      GITHUB_OPERATIONS.find(({ key }) => key === "issue view")!,
      { ...budgets(4_999, 4_999), secondary: fact },
    )).toMatchObject({ outcome: "backpressure", fact: { kind: "secondary-throttled" } });
  });
});
