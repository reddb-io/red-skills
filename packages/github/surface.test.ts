import { describe, expect, it } from "vitest";
import {
  GITHUB_OPERATIONS,
  UnclassifiedGithubOperationError,
  assertGithubRoutingTable,
  githubCommandPath,
  githubOperationKey,
  githubSurfaceFor,
  routeGithubArgs,
  surfaceForCardinality,
  tryRouteGithubArgs,
  type GithubOperation,
} from "./surface.js";

/**
 * The pinned routing table. An operation that changes surface has to change this
 * literal too — which is the point (#3094 acceptance criterion 4): the surface a
 * call runs on stopped being an emergent property of a default and became a
 * declared fact somebody has to edit on purpose.
 */
const PINNED: ReadonlyArray<[key: string, kind: string, cardinality: string, surface: string, budget: string]> = [
  ["issue view", "read", "single-object", "rest", "rest"],
  ["pr view", "read", "single-object", "rest", "rest"],
  ["repo view", "read", "single-object", "rest", "rest"],
  ["run view", "read", "single-object", "rest", "rest"],
  ["release view", "read", "single-object", "rest", "rest"],
  ["pr diff", "read", "single-object", "rest", "rest"],
  ["issue list", "read", "multi-node", "graphql", "graphql"],
  ["pr list", "read", "multi-node", "graphql", "graphql"],
  ["pr checks", "read", "multi-node", "graphql", "graphql"],
  ["release list", "read", "multi-node", "rest", "rest"],
  ["run list", "read", "multi-node", "rest", "rest"],
  ["label list", "read", "multi-node", "graphql", "graphql"],
  ["issue list (search)", "read", "multi-node", "graphql", "search"],
  ["pr list (search)", "read", "multi-node", "graphql", "search"],
  ["search issues", "read", "multi-repository", "rest", "search"],
  ["search prs", "read", "multi-repository", "rest", "search"],
  ["search repos", "read", "multi-repository", "rest", "search"],
  ["api graphql", "read", "multi-node", "graphql", "graphql"],
  ["api rest", "read", "single-object", "rest", "rest"],
  ["issue create", "write", "single-object", "graphql", "graphql"],
  ["issue edit", "write", "single-object", "graphql", "graphql"],
  ["issue close", "write", "single-object", "graphql", "graphql"],
  ["issue reopen", "write", "single-object", "graphql", "graphql"],
  ["issue comment", "write", "single-object", "rest", "rest"],
  ["issue develop", "write", "single-object", "graphql", "graphql"],
  ["pr create", "write", "single-object", "rest", "rest"],
  ["pr comment", "write", "single-object", "rest", "rest"],
  ["pr merge", "write", "single-object", "graphql", "graphql"],
  ["pr close", "write", "single-object", "graphql", "graphql"],
  ["pr edit", "write", "single-object", "graphql", "graphql"],
  ["pr ready", "write", "single-object", "graphql", "graphql"],
  ["pr update-branch", "write", "single-object", "rest", "rest"],
  ["label create", "write", "single-object", "rest", "rest"],
];

function row(operation: GithubOperation): [string, string, string, string, string] {
  return [operation.key, operation.kind, operation.cardinality, operation.surface, operation.budget];
}

describe("the routing table", () => {
  it("matches the pinned table exactly, in both directions", () => {
    expect(GITHUB_OPERATIONS.map(row)).toEqual(PINNED.map((entry) => [...entry]));
  });

  it("contradicts itself nowhere", () => {
    expect(assertGithubRoutingTable()).toEqual([]);
  });

  it("derives every unconstrained read's surface from cardinality alone", () => {
    for (const operation of GITHUB_OPERATIONS) {
      if (operation.kind !== "read" || operation.only) continue;
      expect([operation.key, operation.surface]).toEqual([
        operation.key,
        surfaceForCardinality(operation.cardinality),
      ]);
    }
  });

  it("names a one-API constraint wherever a read departs from cardinality", () => {
    for (const operation of GITHUB_OPERATIONS) {
      if (operation.kind !== "read") continue;
      if (operation.surface === surfaceForCardinality(operation.cardinality)) continue;
      expect(operation.only).toBe(operation.surface);
    }
  });

  it("catches a read whose declared surface fights its cardinality", () => {
    const problems = assertGithubRoutingTable([
      {
        key: "issue view",
        kind: "read",
        cardinality: "single-object",
        surface: "graphql",
        budget: "graphql",
        why: "a single object sent to the node-point pool",
      },
    ]);
    expect(problems).toEqual([
      "issue view is a single-object read declared on graphql, but cardinality implies rest",
    ]);
  });

  it("catches a duplicate key", () => {
    const entry: GithubOperation = {
      key: "issue view",
      kind: "read",
      cardinality: "single-object",
      surface: "rest",
      budget: "rest",
      why: "one issue",
    };
    expect(assertGithubRoutingTable([entry, entry])).toEqual(['duplicate operation key "issue view"']);
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
  it("routes a single-object read to REST and a listing to GraphQL", () => {
    expect(githubSurfaceFor(["issue", "view", "42", "--json", "state,labels"])).toBe("rest");
    expect(githubSurfaceFor(["-R", "acme/widgets", "pr", "view", "7", "--json", "mergeable"])).toBe("rest");
    expect(githubSurfaceFor(["issue", "list", "--json", "number"])).toBe("graphql");
    expect(githubSurfaceFor(["pr", "list", "--state", "open", "--json", "number"])).toBe("graphql");
  });

  it("routes the multi-repository aggregate to GraphQL", () => {
    expect(githubSurfaceFor(["api", "graphql", "-f", "query=query { rateLimit { remaining } }"])).toBe(
      "graphql",
    );
    expect(routeGithubArgs(["api", "graphql"]).cardinality).not.toBe("single-object");
  });

  it("stops mislabelling the writes", () => {
    expect(routeGithubArgs(["issue", "comment", "42", "--body", "x"]).surface).toBe("rest");
    expect(routeGithubArgs(["issue", "create", "--title", "x"]).surface).toBe("graphql");
    expect(routeGithubArgs(["pr", "create", "--title", "x"]).surface).toBe("rest");
    expect(routeGithubArgs(["issue", "edit", "42", "--add-label", "x"]).surface).toBe("graphql");
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
