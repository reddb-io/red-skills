import { describe, expect, it } from "vitest";

import {
  DEFAULT_GITHUB_CACHE_CAPACITY,
  DEFAULT_GITHUB_CACHE_FRESH_MS,
  createGithubCache,
  describeGithubCacheRead,
} from "./cache.js";

const T0 = "2026-08-03T12:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

describe("a cached value travels with its own age", () => {
  it("hands back the age, not just the value", () => {
    const cache = createGithubCache();
    cache.put({ key: "issue:3095", kind: "issue-body", value: { title: "asked" }, fetchedAt: T0 });

    const read = cache.read<{ title: string }>("issue:3095", { now: at(30) });

    expect(read.outcome).toBe("fresh");
    expect(read.hit).toBe(true);
    expect(read.age_ms).toBe(30_000);
    expect(read.fetched_at).toBe(T0);
    expect(read.value).toEqual({ title: "asked" });
  });

  it("keeps serving a stale value and says that it is stale", () => {
    const cache = createGithubCache({ freshMs: 60_000 });
    cache.put({ key: "pr:1", kind: "pr-state", value: "OPEN", fetchedAt: T0 });

    const read = cache.read<string>("pr:1", { now: at(600) });

    expect(read.hit).toBe(true);
    expect(read.outcome).toBe("stale");
    expect(read.value).toBe("OPEN");
    expect(read.age_ms).toBe(600_000);
    expect(read.reason).toContain("stale");
  });

  it("is the precondition for a fallback: an empty cache has nothing to fall back to", () => {
    const cache = createGithubCache();

    const read = cache.read("issue:404", { now: T0 });

    expect(read.hit).toBe(false);
    expect(read.outcome).toBe("miss");
    expect(read.age_ms).toBeNull();
    expect(read.value).toBeUndefined();
    expect(read.reason).toContain("nothing was kept");
  });

  it("never presents a stale count as current, whatever the consumer does", () => {
    const cache = createGithubCache({ freshMs: 60_000 });
    cache.put({ key: "counts", kind: "counts", value: 7, fetchedAt: T0 });

    const fresh = describeGithubCacheRead(cache.read<number>("counts", { now: at(10) }));
    const stale = describeGithubCacheRead(cache.read<number>("counts", { now: at(1000) }));

    expect(fresh).toContain("10s old");
    expect(stale).toContain("stale");
    expect(stale).toContain("17m");
    expect(fresh).not.toBe(stale);
  });

  it("takes a per-entry freshness, because a body and a state do not age alike", () => {
    const cache = createGithubCache({ freshMs: 60_000 });
    cache.put({ key: "body", kind: "issue-body", value: "text", fetchedAt: T0, freshMs: 3_600_000 });

    expect(cache.read("body", { now: at(600) }).outcome).toBe("fresh");
    expect(cache.read("body", { now: at(4000) }).outcome).toBe("stale");
  });

  it("cannot age a value it holds no readable instant for", () => {
    const cache = createGithubCache();
    cache.put({ key: "broken", kind: "counts", value: 1, fetchedAt: "not-an-instant" });

    const read = cache.read("broken", { now: T0 });

    expect(read.hit).toBe(true);
    expect(read.outcome).toBe("stale");
    expect(read.age_ms).toBeNull();
    expect(read.reason).toContain("no readable instant");
  });
});

describe("the cache stays bounded and answers for itself", () => {
  it("evicts the oldest entry rather than growing without a ceiling", () => {
    const cache = createGithubCache({ capacity: 2 });
    cache.put({ key: "a", kind: "counts", value: 1, fetchedAt: T0 });
    cache.put({ key: "b", kind: "counts", value: 2, fetchedAt: at(1) });
    cache.put({ key: "c", kind: "counts", value: 3, fetchedAt: at(2) });

    expect(cache.size()).toBe(2);
    expect(cache.read("a", { now: at(3) }).hit).toBe(false);
    expect(cache.read("c", { now: at(3) }).hit).toBe(true);
  });

  it("replaces an entry rather than keeping two answers for one key", () => {
    const cache = createGithubCache();
    cache.put({ key: "pr:1", kind: "pr-state", value: "OPEN", fetchedAt: T0 });
    cache.put({ key: "pr:1", kind: "pr-state", value: "MERGED", fetchedAt: at(5) });

    const read = cache.read<string>("pr:1", { now: at(5) });

    expect(cache.size()).toBe(1);
    expect(read.value).toBe("MERGED");
    expect(read.age_ms).toBe(0);
  });

  it("states its own defaults rather than hiding them in a closure", () => {
    expect(DEFAULT_GITHUB_CACHE_FRESH_MS).toBeGreaterThan(0);
    expect(DEFAULT_GITHUB_CACHE_CAPACITY).toBeGreaterThan(0);
    expect(createGithubCache().entries()).toEqual([]);
  });
});
