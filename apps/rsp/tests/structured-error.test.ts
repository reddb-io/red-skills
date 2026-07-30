import { describe, expect, it } from "vitest";

import { classifyWrappedFailure, structuredExitCode } from "../src/structured-error.js";

describe("classifyWrappedFailure — GitHub quota is transient, never an auth problem (#2830)", () => {
  it("classifies a primary rate limit (403) as transient and points at the wait", () => {
    const classified = classifyWrappedFailure(
      "gh run list",
      "",
      "HTTP 403: API rate limit exceeded for installation ID 12345. (https://api.github.com/repos/o/r/actions/runs)\n",
    );

    expect(classified.category).toBe("transient");
    expect(classified.help).toMatch(/wait/i);
  });

  it("never suggests an authentication remedy for a rate limit", () => {
    const classified = classifyWrappedFailure("gh issue list", "", "API rate limit exceeded for user ID 12345.\n");

    expect(classified.category).not.toBe("real-error");
    expect(classified.help).not.toMatch(/auth/i);
  });

  it("classifies secondary limits and GraphQL exhaustion as transient too", () => {
    expect(
      classifyWrappedFailure("gh pr list", "", "HTTP 403: You have exceeded a secondary rate limit.\n").category,
    ).toBe("transient");
    expect(classifyWrappedFailure("gh api graphql", "", 'GraphQL: API rate limit exceeded (type: RATE_LIMITED)\n').category).toBe(
      "transient",
    );
  });

  it("keeps a genuine authentication failure a real error with the authentication remedy", () => {
    const classified = classifyWrappedFailure(
      "gh issue list",
      "",
      "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n",
    );

    expect(classified.category).toBe("real-error");
    expect(classified.help).toBe("gh auth login");
  });

  it("keeps other permanent failures exactly as they were", () => {
    expect(classifyWrappedFailure("git status", "", "fatal: not a git repository\n")).toMatchObject({
      category: "real-error",
      help: "git status",
    });
    expect(classifyWrappedFailure("gh repo view", "", "repository not found\n")).toMatchObject({
      category: "real-error",
      help: "gh repo view",
    });
    expect(classifyWrappedFailure("gh api /x", "", "HTTP 404: Not Found\n")).toMatchObject({
      category: "real-error",
      help: "gh api /x --help",
    });
  });

  it("still exits non-zero on a transient failure — the command did fail", () => {
    expect(structuredExitCode("transient")).toBe(1);
    expect(structuredExitCode("real-error")).toBe(1);
    expect(structuredExitCode("usage")).toBe(2);
    expect(structuredExitCode("no-op")).toBe(0);
  });
});
