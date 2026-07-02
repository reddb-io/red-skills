import { describe, expect, it } from "vitest";
import { DEFAULT_BRANCH, parseBranchPin, parseParentPrd, resolvePin } from "../src/core/pin-reader.js";

describe("parseBranchPin", () => {
  it("pulls the branch out of a bare branch line", () => {
    expect(parseBranchPin("## What to build\nbranch: feature/login\nmore text")).toBe("feature/login");
  });

  it("accepts a leading list marker and trims the value", () => {
    expect(parseBranchPin("- branch:    release/2.0   \n")).toBe("release/2.0");
  });

  it("strips surrounding backticks", () => {
    expect(parseBranchPin("branch: `hotfix/x`")).toBe("hotfix/x");
  });

  it("strips surrounding quotes", () => {
    expect(parseBranchPin('branch: "quoted/branch"')).toBe("quoted/branch");
    expect(parseBranchPin("branch: 'quoted/branch'")).toBe("quoted/branch");
  });

  it("takes the first canonical line when several exist", () => {
    expect(parseBranchPin("branch: first/one\nbranch: second/two")).toBe("first/one");
  });

  it("returns undefined when no canonical line is present", () => {
    expect(parseBranchPin("## What to build\njust some prose, no pin here")).toBeUndefined();
  });

  it("does not match prose 'branch:' mid-sentence", () => {
    expect(parseBranchPin("This branch: is a sentence, not a pin.\nWe will branch: later maybe")).toBeUndefined();
  });
});

describe("parseParentPrd", () => {
  it("extracts the PRD number from a Parent section", () => {
    expect(parseParentPrd("## Parent\nPRD #59\n\n## What to build")).toBe(59);
  });

  it("tolerates spaces around the hash", () => {
    expect(parseParentPrd("Parent: PRD # 12")).toBe(12);
  });

  it("returns undefined when there is no PRD reference", () => {
    expect(parseParentPrd("## What to build\nno parent reference")).toBeUndefined();
  });
});

describe("resolvePin", () => {
  const issueWithPin = "## What to build\nbranch: issue/own";
  const issueNoPin = "## What to build\n## Parent\nPRD #59";
  const prdWithPin = "## PRD\nbranch: prd/shared";
  const prdNoPin = "## PRD\nno pin here either";

  const fetcherFor = (bodies: Record<number, string>) => {
    const calls: number[] = [];
    return {
      calls,
      fetchIssueBody: async (n: number) => {
        calls.push(n);
        return bodies[n];
      },
    };
  };

  it("prefers the issue's own pin over the PRD's", async () => {
    const deps = fetcherFor({ 59: prdWithPin });
    expect(await resolvePin({ issueBody: issueWithPin }, deps)).toBe("issue/own");
    // own pin wins without ever fetching the parent
    expect(deps.calls).toEqual([]);
  });

  it("inherits the parent PRD pin when the issue has none", async () => {
    const deps = fetcherFor({ 59: prdWithPin });
    expect(await resolvePin({ issueBody: issueNoPin }, deps)).toBe("prd/shared");
    expect(deps.calls).toEqual([59]);
  });

  it("defaults to main when no pin exists anywhere", async () => {
    const deps = fetcherFor({ 59: prdNoPin });
    expect(await resolvePin({ issueBody: issueNoPin }, deps)).toBe(DEFAULT_BRANCH);
    expect(DEFAULT_BRANCH).toBe("main");
  });

  it("defaults to main when the issue has no pin and no parent reference", async () => {
    const deps = fetcherFor({});
    expect(await resolvePin({ issueBody: "## What to build\nno pin, no parent" }, deps)).toBe("main");
    expect(deps.calls).toEqual([]);
  });

  it("defaults to main when the parent body cannot be fetched", async () => {
    const deps = fetcherFor({});
    expect(await resolvePin({ issueBody: issueNoPin }, deps)).toBe("main");
    expect(deps.calls).toEqual([59]);
  });

  // Trunk collapse (ADR 0083): a pinless item lands on the configured trunk.
  it("collapses a pinless item to the injected defaultBranch (the Trunk)", async () => {
    const deps = { ...fetcherFor({ 59: prdNoPin }), defaultBranch: "develop" };
    expect(await resolvePin({ issueBody: issueNoPin }, deps)).toBe("develop");
  });

  it("a real pin still wins over the defaultBranch", async () => {
    const deps = { ...fetcherFor({}), defaultBranch: "develop" };
    expect(await resolvePin({ issueBody: issueWithPin }, deps)).toBe("issue/own");
  });

  it("an empty/whitespace defaultBranch falls back to main", async () => {
    const empty = { ...fetcherFor({}), defaultBranch: "" };
    expect(await resolvePin({ issueBody: "no pin" }, empty)).toBe(DEFAULT_BRANCH);
    const blank = { ...fetcherFor({}), defaultBranch: " \t " };
    expect(await resolvePin({ issueBody: "no pin" }, blank)).toBe(DEFAULT_BRANCH);
  });

  it("trims the defaultBranch value", async () => {
    const deps = { ...fetcherFor({}), defaultBranch: " develop\n" };
    expect(await resolvePin({ issueBody: "no pin" }, deps)).toBe("develop");
  });
});
