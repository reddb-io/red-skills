import { describe, expect, it } from "vitest";
import {
  GITHUB_OPERATIONS,
  UnclassifiedGithubOperationError,
  assertGithubRoutingTable,
  githubCommandPath,
  githubOperationKey,
  githubSurfaceFor,
  preferredSurfaceForRead,
  routeGithubArgs,
  tryRouteGithubArgs,
  type GithubOperation,
  type GithubReadVolatility,
} from "./surface.js";

/**
 * The pinned routing table. An operation that changes surface has to change this
 * literal too — which is the point (#3094 acceptance criterion 4): the surface a
 * call runs on stopped being an emergent property of a default and became a
 * declared fact somebody has to edit on purpose.
 */
const PINNED: ReadonlyArray<
  [
    key: string,
    kind: string,
    cardinality: string,
    volatility: GithubReadVolatility | undefined,
    surface: string,
    budget: string,
    fallback: string | null,
  ]
> = [
  ["issue view", "read", "single-object", "stable-poll", "rest", "rest", "graphql"],
  ["pr view", "read", "single-object", "stable-poll", "rest", "rest", "graphql"],
  ["repo view", "read", "single-object", "stable-poll", "rest", "rest", "graphql"],
  ["run view", "read", "single-object", "stable-poll", "rest", "rest", null],
  ["release view", "read", "single-object", "stable-poll", "rest", "rest", null],
  ["pr diff", "read", "single-object", "one-shot", "rest", "rest", null],
  ["issue list", "read", "multi-node", "stable-poll", "rest", "rest", "graphql"],
  ["pr list", "read", "multi-node", "stable-poll", "rest", "rest", "graphql"],
  ["pr checks", "read", "multi-node", "stable-poll", "rest", "rest", "graphql"],
  ["release list", "read", "multi-node", "stable-poll", "rest", "rest", null],
  ["run list", "read", "multi-node", "stable-poll", "rest", "rest", null],
  ["label list", "read", "multi-node", "one-shot", "graphql", "graphql", "rest"],
  ["issue list (search)", "read", "multi-node", "stable-poll", "rest", "search", null],
  ["pr list (search)", "read", "multi-node", "stable-poll", "rest", "search", null],
  ["search issues", "read", "multi-repository", "one-shot", "rest", "search", null],
  ["search prs", "read", "multi-repository", "one-shot", "rest", "search", null],
  ["search repos", "read", "multi-repository", "one-shot", "rest", "search", null],
  ["api graphql", "read", "multi-node", "one-shot", "graphql", "graphql", null],
  ["api rest", "read", "single-object", "one-shot", "rest", "rest", null],
  ["issue create", "write", "single-object", undefined, "rest", "rest", "graphql"],
  ["issue edit", "write", "single-object", undefined, "rest", "rest", "graphql"],
  ["issue close", "write", "single-object", undefined, "rest", "rest", "graphql"],
  ["issue reopen", "write", "single-object", undefined, "graphql", "graphql", "rest"],
  ["issue comment", "write", "single-object", undefined, "rest", "rest", "graphql"],
  ["issue develop", "write", "single-object", undefined, "graphql", "graphql", null],
  ["pr create", "write", "single-object", undefined, "rest", "rest", "graphql"],
  ["pr comment", "write", "single-object", undefined, "rest", "rest", "graphql"],
  ["pr merge", "write", "single-object", undefined, "rest", "rest", "graphql"],
  ["pr close", "write", "single-object", undefined, "graphql", "graphql", "rest"],
  ["pr edit", "write", "single-object", undefined, "graphql", "graphql", "rest"],
  ["pr ready", "write", "single-object", undefined, "graphql", "graphql", null],
  ["pr update-branch", "write", "single-object", undefined, "rest", "rest", "graphql"],
  ["label create", "write", "single-object", undefined, "rest", "rest", "graphql"],
];

function row(
  operation: GithubOperation,
): [string, string, string, GithubReadVolatility | undefined, string, string, string | null | undefined] {
  const declaration = operation as GithubOperation & { fallback?: string | null };
  return [
    operation.key,
    operation.kind,
    operation.cardinality,
    operation.volatility,
    operation.surface,
    operation.budget,
    declaration.fallback,
  ];
}

describe("the routing table", () => {
  it("matches the pinned table exactly, in both directions", () => {
    expect(GITHUB_OPERATIONS.map(row)).toEqual(PINNED.map((entry) => [...entry]));
  });

  it("contradicts itself nowhere", () => {
    expect(assertGithubRoutingTable()).toEqual([]);
  });

  it("derives every unconstrained read's preferred surface from volatility then cardinality", () => {
    for (const operation of GITHUB_OPERATIONS) {
      if (operation.kind !== "read" || operation.only) continue;
      expect([operation.key, operation.surface]).toEqual([
        operation.key,
        preferredSurfaceForRead(operation.volatility!, operation.cardinality),
      ]);
    }
  });

  it("names a one-API constraint wherever a read departs from the preference rule", () => {
    for (const operation of GITHUB_OPERATIONS) {
      if (operation.kind !== "read") continue;
      if (operation.surface === preferredSurfaceForRead(operation.volatility!, operation.cardinality)) continue;
      expect(operation.only).toBe(operation.surface);
    }
  });

  it("catches a read whose declared surface fights its cardinality", () => {
    const problems = assertGithubRoutingTable([
      {
        key: "issue view",
        kind: "read",
        cardinality: "single-object",
        volatility: "one-shot",
        surface: "graphql",
        budget: "graphql",
        fallback: null,
        noFallbackBecause: "fixture exercises only the preferred surface",
        why: "a single object sent to the node-point pool",
      },
    ]);
    expect(problems).toEqual([
      "issue view is a single-object read declared on graphql, but cardinality implies rest",
    ]);
  });

  it("catches a read whose volatility is undeclared", () => {
    const problems = assertGithubRoutingTable([
      {
        key: "issue view",
        kind: "read",
        cardinality: "single-object",
        surface: "rest",
        budget: "rest",
        fallback: null,
        noFallbackBecause: "fixture exercises only the volatility declaration",
        why: "one issue",
      },
    ]);
    expect(problems).toEqual(["issue view states no volatility"]);
  });

  it("catches a duplicate key", () => {
    const entry: GithubOperation = {
      key: "issue view",
      kind: "read",
      cardinality: "single-object",
      volatility: "one-shot",
      surface: "rest",
      budget: "rest",
      fallback: null,
      noFallbackBecause: "fixture exercises only duplicate keys",
      why: "one issue",
    };
    expect(assertGithubRoutingTable([entry, entry])).toEqual(['duplicate operation key "issue view"']);
  });

  it("requires one usable fallback or one reason that none exists", () => {
    const malformed = [
      {
        key: "missing",
        kind: "read",
        cardinality: "single-object",
        volatility: "one-shot",
        surface: "rest",
        budget: "rest",
        why: "no fallback declaration",
      },
      {
        key: "unexplained",
        kind: "read",
        cardinality: "single-object",
        volatility: "one-shot",
        surface: "rest",
        budget: "rest",
        fallback: null,
        noFallbackBecause: "",
        why: "an unexplained dead end",
      },
      {
        key: "absolute",
        kind: "read",
        cardinality: "single-object",
        volatility: "one-shot",
        surface: "graphql",
        budget: "graphql",
        only: "graphql",
        fallback: "rest",
        why: "a GraphQL-only resource",
      },
      {
        key: "searched",
        kind: "read",
        cardinality: "multi-node",
        volatility: "one-shot",
        surface: "graphql",
        budget: "search",
        fallback: "rest",
        why: "search cannot absorb diverted traffic",
      },
    ] as unknown as GithubOperation[];

    expect(assertGithubRoutingTable(malformed)).toEqual([
      "missing states neither a fallback nor why none exists",
      "unexplained states no reason for having no fallback",
      "absolute is exposed only on graphql and cannot fall back to rest",
      "searched draws from search and cannot declare a fallback",
    ]);
  });
});

describe("githubCommandPath", () => {
  it("skips the global repo flag and stops before the first option", () => {
    expect(githubCommandPath(["-R", "acme/widgets", "pr", "view", "42", "--json", "state"])).toEqual([
      "pr",
      "view",
    ]);
    expect(githubCommandPath(["issue", "view", "42", "--repo", "acme/widgets", "--json", "state"])).toEqual([
      "issue",
      "view",
    ]);
  });

  it("never mistakes a flag value for a command token", () => {
    expect(githubCommandPath(["issue", "list", "--label", "view"])).toEqual(["issue", "list"]);
  });

  it("answers an empty argv with an empty path", () => {
    expect(githubCommandPath([])).toEqual([]);
  });
});

describe("githubOperationKey", () => {
  it("collapses every raw API path to one of two keys", () => {
    expect(githubOperationKey(["api", "graphql", "-f", "query=x"])).toBe("api graphql");
    expect(githubOperationKey(["api", "repos/acme/widgets/issues/1/comments"])).toBe("api rest");
  });

  it("gives a searched listing its own key, because it draws a different pool", () => {
    expect(githubOperationKey(["issue", "list", "--search", 'label:"a","b"'])).toBe("issue list (search)");
    expect(githubOperationKey(["issue", "list", "--label", "a"])).toBe("issue list");
  });
});

describe("the router", () => {
  it("routes stable polls to REST before considering cardinality", () => {
    expect(githubSurfaceFor(["issue", "view", "42", "--json", "state,labels"])).toBe("rest");
    expect(githubSurfaceFor(["-R", "acme/widgets", "pr", "view", "7", "--json", "mergeable"])).toBe("rest");
    expect(githubSurfaceFor(["issue", "list", "--json", "number"])).toBe("rest");
    expect(githubSurfaceFor(["pr", "list", "--state", "open", "--json", "number"])).toBe("rest");
  });

  it("routes the multi-repository aggregate to GraphQL", () => {
    expect(githubSurfaceFor(["api", "graphql", "-f", "query=query { rateLimit { remaining } }"])).toBe(
      "graphql",
    );
    expect(routeGithubArgs(["api", "graphql"]).cardinality).not.toBe("single-object");
  });

  it("stops mislabelling the writes", () => {
    expect(routeGithubArgs(["issue", "comment", "42", "--body", "x"]).surface).toBe("rest");
    expect(routeGithubArgs(["issue", "create", "--title", "x"]).surface).toBe("rest");
    expect(routeGithubArgs(["pr", "create", "--title", "x"]).surface).toBe("rest");
    expect(routeGithubArgs(["pr", "merge", "42", "--merge"]).surface).toBe("rest");
    expect(routeGithubArgs(["issue", "edit", "42", "--add-label", "x"]).surface).toBe("rest");
  });

  it("raises on an unclassified operation instead of defaulting to GraphQL", () => {
    expect(() => routeGithubArgs(["ruleset", "list"])).toThrow(UnclassifiedGithubOperationError);
    const error = (() => {
      try {
        routeGithubArgs(["ruleset", "list"]);
        return null;
      } catch (thrown) {
        return thrown as UnclassifiedGithubOperationError;
      }
    })();
    expect(error?.operation).toBe("ruleset list");
    expect(error?.message).toContain("packages/github/surface.ts");
    expect(tryRouteGithubArgs(["ruleset", "list"])).toBeNull();
  });

  it("raises on an empty argv rather than inventing a surface", () => {
    expect(() => routeGithubArgs([])).toThrow(/\(empty argv\)/);
  });
});
