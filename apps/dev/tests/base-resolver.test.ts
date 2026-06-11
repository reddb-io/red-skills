import { describe, expect, it } from "vitest";
import { resolveBase } from "../src/core/base-resolver.js";
import { DEFAULT_BRANCH } from "../src/core/pin-reader.js";

describe("resolveBase", () => {
  const issueWithPin = "## What to build\nbranch: feature/some-pin";
  const issueNoPin = "## What to build\n## Parent\nPRD #59";
  const prdWithPin = "## PRD\nbranch: prd/shared";

  // Injected fakes — no real fs / gh. `lock` is the locked branch (or undefined),
  // `bodies` backs the parent-PRD fetch used by pin resolution.
  const depsFor = (lock: string | undefined, bodies: Record<number, string> = {}) => {
    const lockCalls: number[] = [];
    const fetchCalls: number[] = [];
    return {
      lockCalls,
      fetchCalls,
      readLockedBranch: async () => {
        lockCalls.push(1);
        return lock;
      },
      fetchIssueBody: async (n: number) => {
        fetchCalls.push(n);
        return bodies[n];
      },
    };
  };

  it("lock wins over a pin (the key ADR 0031 wiring)", async () => {
    const deps = depsFor("work-branch", { 59: prdWithPin });
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("work-branch");
    // lock short-circuits: pin resolution never runs, so the parent is never fetched
    expect(deps.fetchCalls).toEqual([]);
  });

  it("lock wins even when the issue carries no pin", async () => {
    const deps = depsFor("work-branch");
    expect(await resolveBase({ issueBody: issueNoPin }, deps)).toBe("work-branch");
    expect(deps.fetchCalls).toEqual([]);
  });

  it("falls through to the pin when there is no lock", async () => {
    const deps = depsFor(undefined);
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("feature/some-pin");
  });

  it("inherits the parent PRD pin through resolvePin when unlocked", async () => {
    const deps = depsFor(undefined, { 59: prdWithPin });
    expect(await resolveBase({ issueBody: issueNoPin }, deps)).toBe("prd/shared");
    expect(deps.fetchCalls).toEqual([59]);
  });

  it("defaults to main when neither a lock nor a pin is set", async () => {
    const deps = depsFor(undefined);
    expect(await resolveBase({ issueBody: "## What to build\nno pin, no parent" }, deps)).toBe(DEFAULT_BRANCH);
    expect(DEFAULT_BRANCH).toBe("main");
  });

  it("treats an absent lock (undefined) as unlocked", async () => {
    const deps = depsFor(undefined);
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("feature/some-pin");
  });

  it("treats an empty lock file as unlocked (pin wins)", async () => {
    const deps = depsFor("");
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("feature/some-pin");
  });

  it("treats a whitespace-only lock as unlocked (pin wins)", async () => {
    const deps = depsFor("  \t ");
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("feature/some-pin");
  });

  it("whitespace-only lock and no pin falls through to main", async () => {
    const deps = depsFor("   ");
    expect(await resolveBase({ issueBody: "## What to build\nno pin, no parent" }, deps)).toBe("main");
  });

  it("trims surrounding whitespace off a real locked branch", async () => {
    const deps = depsFor(" work-branch\n");
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("work-branch");
  });
});
