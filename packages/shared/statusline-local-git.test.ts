import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  STATUSLINE_GIT_MICRO_TTL_MS,
  collectStatuslineLocalGit,
  statuslineGitCachePath,
  type StatuslineLocalGit,
  type StatuslineLocalGitDeps,
} from "./statusline-local-git.js";

const ROOT = "/tmp/statusline-micro-ttl-fixture";

/**
 * A fake filesystem and a fake clock, so the micro-TTL is proven by the ONE
 * thing it exists to control: how often the git subprocess reach is entered.
 * Nothing here touches a disk or a real `git`.
 */
function harness(facts: Partial<StatuslineLocalGit> = {}) {
  const files = new Map<string, string>();
  let now = 1_000_000;
  let gitReads = 0;
  const deps: StatuslineLocalGitDeps = {
    nowMs: () => now,
    readCache: (path) => files.get(path) ?? null,
    writeCache: (path, text) => {
      files.set(path, text);
    },
    readGitFacts: async () => {
      gitReads += 1;
      return {
        basename: "red-skills",
        branch: `branch-${gitReads}`,
        localAdded: 12,
        localRemoved: 3,
        ...facts,
      };
    },
  };
  return {
    deps,
    files,
    gitReads: () => gitReads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("statusline bedrock local git — the ~5s micro-TTL", () => {
  it("reads git once and serves every render inside the TTL from the cache", async () => {
    const h = harness();

    const first = await collectStatuslineLocalGit(ROOT, h.deps);
    expect(h.gitReads()).toBe(1);
    expect(first).toEqual({
      basename: "red-skills",
      branch: "branch-1",
      localAdded: 12,
      localRemoved: 3,
    });

    // Claude Code re-renders on every tick: the ticks inside the window must
    // cost a file read, never a fork.
    h.advance(1);
    expect(await collectStatuslineLocalGit(ROOT, h.deps)).toEqual(first);
    h.advance(STATUSLINE_GIT_MICRO_TTL_MS - 2);
    expect(await collectStatuslineLocalGit(ROOT, h.deps)).toEqual(first);
    expect(h.gitReads()).toBe(1);
  });

  it("refreshes once the TTL has passed", async () => {
    const h = harness();

    await collectStatuslineLocalGit(ROOT, h.deps);
    h.advance(STATUSLINE_GIT_MICRO_TTL_MS);
    const refreshed = await collectStatuslineLocalGit(ROOT, h.deps);

    expect(h.gitReads()).toBe(2);
    expect(refreshed.branch).toBe("branch-2");
  });

  it("writes the entry as TOON in the statusline state lane", async () => {
    const h = harness();

    await collectStatuslineLocalGit(ROOT, h.deps);

    const path = statuslineGitCachePath(ROOT);
    expect(path).toBe(`${ROOT}/.red/state/statusline/statusline-git-cache.toon`);
    const written = h.files.get(path) ?? "";
    expect(written.startsWith("{")).toBe(false);
    expect(decode(written)).toMatchObject({ basename: "red-skills", baseRef: "origin/main", tsMs: 1_000_000 });
  });

  it("invalidates the entry when the base ref changes", async () => {
    const h = harness();

    await collectStatuslineLocalGit(ROOT, h.deps);
    const rebased = await collectStatuslineLocalGit(ROOT, { ...h.deps, baseRef: "origin/release" });

    expect(h.gitReads()).toBe(2);
    expect(rebased.branch).toBe("branch-2");
  });

  it("serves the last-known facts when the git read fails", async () => {
    const h = harness();
    await collectStatuslineLocalGit(ROOT, h.deps);
    h.advance(STATUSLINE_GIT_MICRO_TTL_MS);

    const served = await collectStatuslineLocalGit(ROOT, {
      ...h.deps,
      readGitFacts: async () => {
        throw new Error("git is not on PATH");
      },
    });

    expect(served.branch).toBe("branch-1");
    expect(served.localAdded).toBe(12);
  });

  it("degrades to the path basename with neither a cache nor a working git", async () => {
    const h = harness();

    const served = await collectStatuslineLocalGit(ROOT, {
      ...h.deps,
      readGitFacts: async () => {
        throw new Error("not a repository");
      },
    });

    expect(served).toEqual({
      basename: "statusline-micro-ttl-fixture",
      localAdded: 0,
      localRemoved: 0,
    });
  });

  it("serves the last-known facts when the refresh misses its deadline", async () => {
    const h = harness();
    await collectStatuslineLocalGit(ROOT, h.deps);
    h.advance(STATUSLINE_GIT_MICRO_TTL_MS);

    const served = await collectStatuslineLocalGit(ROOT, {
      ...h.deps,
      deadlineMs: 1,
      readGitFacts: () => new Promise<StatuslineLocalGit>(() => undefined),
    });

    expect(served.branch).toBe("branch-1");
  });
});
