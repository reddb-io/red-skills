import { describe, expect, it } from "vitest";
import { resolveBase } from "../src/core/base-resolver.js";
import { DEFAULT_BRANCH } from "../src/core/pin-reader.js";

describe("resolveBase", () => {
  const issueWithPin = "## What to build\nbranch: feature/some-pin";
  const issueNoPin = "## What to build\n## Parent\nSpec #59";
  const specWithPin = "## Spec\nbranch: spec/shared";

  // Injected fakes — no real fs / gh. `lock` is the locked branch (or undefined),
  // `bodies` backs the parent-Spec fetch used by pin resolution.
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
    const deps = depsFor("work-branch", { 59: specWithPin });
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

  it("inherits the parent Spec pin through resolvePin when unlocked", async () => {
    const deps = depsFor(undefined, { 59: specWithPin });
    expect(await resolveBase({ issueBody: issueNoPin }, deps)).toBe("spec/shared");
    expect(deps.fetchCalls).toEqual([59]);
  });

  // dev.lock.branch (config-level static lock) — precedence runtime > config > pin > main.
  it("uses the config lock (dev.lock.branch) when the runtime lock is unset", async () => {
    const deps = { ...depsFor(undefined, { 59: specWithPin }), configLockedBranch: "config/branch" };
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("config/branch");
    expect(deps.fetchCalls).toEqual([]); // config lock short-circuits pin resolution
  });

  it("lets the runtime lock override the config lock", async () => {
    const deps = { ...depsFor("runtime/branch"), configLockedBranch: "config/branch" };
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("runtime/branch");
  });

  it("config lock wins over a pin", async () => {
    const deps = { ...depsFor(undefined), configLockedBranch: "config/branch" };
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("config/branch");
  });

  it("an empty config lock falls through to the pin", async () => {
    const deps = { ...depsFor(undefined), configLockedBranch: "" };
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("feature/some-pin");
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

  // Trunk (`plugins.dev.trunk`, ADR 0083) — precedence lock > pin > trunk.
  it("falls through to the configured trunk when neither a lock nor a pin is set", async () => {
    const deps = { ...depsFor(undefined), configTrunk: "develop" };
    expect(await resolveBase({ issueBody: "## What to build\nno pin, no parent" }, deps)).toBe(
      "develop",
    );
  });

  it("collapses a pinless parent-Spec chain to the trunk, not to main", async () => {
    // The issue references a parent Spec, but neither carries a `branch:` pin —
    // the pin-reader collapse must land on the trunk (ADR 0083), not on `main`.
    const deps = {
      ...depsFor(undefined, { 59: "## Spec\nno pin here either" }),
      configTrunk: "workspace/forattini",
    };
    expect(await resolveBase({ issueBody: issueNoPin }, deps)).toBe("workspace/forattini");
    expect(deps.fetchCalls).toEqual([59]);
  });

  it("a pin wins over the trunk", async () => {
    const deps = { ...depsFor(undefined), configTrunk: "develop" };
    expect(await resolveBase({ issueBody: issueWithPin }, deps)).toBe("feature/some-pin");
  });

  it("a lock wins over the trunk", async () => {
    const deps = { ...depsFor("work-branch"), configTrunk: "develop" };
    expect(await resolveBase({ issueBody: issueNoPin }, deps)).toBe("work-branch");
  });

  it("the config lock wins over the trunk", async () => {
    const deps = {
      ...depsFor(undefined),
      configLockedBranch: "config/branch",
      configTrunk: "develop",
    };
    expect(await resolveBase({ issueBody: issueNoPin }, deps)).toBe("config/branch");
  });

  it("an empty/whitespace trunk falls back to main (pre-trunk behaviour)", async () => {
    const empty = { ...depsFor(undefined), configTrunk: "" };
    expect(await resolveBase({ issueBody: "no pin" }, empty)).toBe(DEFAULT_BRANCH);
    const blank = { ...depsFor(undefined), configTrunk: "  \t " };
    expect(await resolveBase({ issueBody: "no pin" }, blank)).toBe(DEFAULT_BRANCH);
  });

  it("trims the trunk value", async () => {
    const deps = { ...depsFor(undefined), configTrunk: " develop\n" };
    expect(await resolveBase({ issueBody: "no pin" }, deps)).toBe("develop");
  });
});
