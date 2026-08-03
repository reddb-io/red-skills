// The cache carries its own age (ADR 0132 Amendment 2, issue #3095).
import { describe, expect, it } from "vitest";
import {
  GITHUB_CACHE_TTL_MS,
  githubCacheKey,
  pruneGithubCache,
  readGithubCache,
  writeGithubCache,
  type GithubCache,
} from "./cache.js";

const NOW = Date.parse("2026-08-03T02:00:00.000Z");

describe("githubCacheKey", () => {
  it("separates a repo-wide answer from a per-object one", () => {
    expect(githubCacheKey("counts", "reddb-io/red-skills")).toBe("counts:reddb-io/red-skills");
    expect(githubCacheKey("issue", "reddb-io/red-skills", 3095)).toBe("issue:reddb-io/red-skills:3095");
  });
});

describe("readGithubCache", () => {
  it("is null for a key never written", () => {
    expect(readGithubCache({}, "issue:x:1", NOW)).toBeNull();
  });

  it("returns the value with its age attached", () => {
    const cache = writeGithubCache({}, "issue:x:1", { title: "t" }, "issue", NOW);
    const hit = readGithubCache<{ title: string }>(cache, "issue:x:1", NOW + 5_000);
    expect(hit?.value.title).toBe("t");
    expect(hit?.ageMs).toBe(5_000);
    expect(hit?.stale).toBe(false);
  });

  it("RETURNS a stale entry rather than dropping it", () => {
    // Dropping it leaves the caller with nothing exactly when the network or the
    // budget is why it went stale — the moment a remembered answer is worth most.
    const cache = writeGithubCache({}, "pull:x:9", "sha", "pull", NOW);
    const hit = readGithubCache<string>(cache, "pull:x:9", NOW + GITHUB_CACHE_TTL_MS.pull + 1);
    expect(hit?.value).toBe("sha");
    expect(hit?.stale).toBe(true);
  });

  it("never reports a negative age when the clock moves backwards", () => {
    const cache = writeGithubCache({}, "k", 1, "issue", NOW);
    expect(readGithubCache(cache, "k", NOW - 10_000)?.ageMs).toBe(0);
  });
});

describe("TTL by rate of change", () => {
  it("gives counts the shortest life and issues the longest", () => {
    // Chosen by how fast the answer changes, not by how much it matters.
    expect(GITHUB_CACHE_TTL_MS.pull).toBeLessThan(GITHUB_CACHE_TTL_MS.issue);
    expect(GITHUB_CACHE_TTL_MS.issue).toBeLessThan(GITHUB_CACHE_TTL_MS.counts);
  });
});

describe("pruneGithubCache", () => {
  it("forgets what is older than the bound and keeps the rest", () => {
    let cache: GithubCache = {};
    cache = writeGithubCache(cache, "old", 1, "issue", NOW - 600_000);
    cache = writeGithubCache(cache, "new", 2, "issue", NOW);
    const pruned = pruneGithubCache(cache, NOW, 300_000);
    expect(Object.keys(pruned)).toEqual(["new"]);
  });

  it("prunes by AGE, not by TTL — a stale entry may still be worth keeping", () => {
    const cache = writeGithubCache({}, "k", 1, "pull", NOW - GITHUB_CACHE_TTL_MS.pull - 1);
    expect(readGithubCache(cache, "k", NOW)?.stale).toBe(true);
    expect(Object.keys(pruneGithubCache(cache, NOW, 3_600_000))).toEqual(["k"]);
  });
});
