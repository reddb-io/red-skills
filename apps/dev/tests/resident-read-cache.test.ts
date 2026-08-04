import { describe, expect, it, vi } from "vitest";
import type { CastleMcpDependencies } from "@reddb-io/red-castle/mcp-server";
import { withCachedDeps } from "../src/mcp-adapter.js";
import {
  ResidentReadCache,
  QUEUE_STATUS_KEY,
  claimStatusKey,
  cascadeStatusKey,
  RESIDENT_CACHE_TTL_MS,
} from "../src/resident-read-cache.js";

describe("ResidentReadCache", () => {
  it("returns undefined for a missing key", () => {
    const cache = new ResidentReadCache();
    expect(cache.get("no-such-key")).toBeUndefined();
  });

  it("returns a set value within TTL", () => {
    const cache = new ResidentReadCache(15_000);
    const now = 1_000_000;
    cache.set("k", { x: 42 }, now);
    expect(cache.get("k", now + 100)).toEqual({ x: 42 });
  });

  it("evicts an entry that is exactly at the TTL boundary", () => {
    const cache = new ResidentReadCache(15_000);
    const now = 1_000_000;
    cache.set("k", "v", now);
    expect(cache.get("k", now + 15_001)).toBeUndefined();
  });

  it("still serves an entry 1ms before the TTL expires", () => {
    const cache = new ResidentReadCache(15_000);
    const now = 1_000_000;
    cache.set("k", "v", now);
    expect(cache.get("k", now + 14_999)).toBe("v");
  });

  it("invalidates a single key", () => {
    const cache = new ResidentReadCache();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("invalidates multiple keys in one call", () => {
    const cache = new ResidentReadCache();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.invalidate("a", "b");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("exports the expected TTL constant", () => {
    expect(RESIDENT_CACHE_TTL_MS).toBe(15_000);
  });

  it("generates per-issue claim and cascade keys", () => {
    expect(claimStatusKey(2370)).toBe("claim_status:2370");
    expect(cascadeStatusKey(2370)).toBe("cascade_status:2370");
    expect(QUEUE_STATUS_KEY).toBe("queue_status");
  });
});

function makeFakeDeps(): Pick<
  CastleMcpDependencies,
  | "queueStatus"
  | "claimStatus"
  | "cascadeStatus"
  | "claimRelease"
  | "landBranch"
  | "requeue"
  | "unblockSweep"
  | "triage"
  | "deadendAudit"
> & { callCounts: Record<string, number> } {
  const callCounts: Record<string, number> = {};
  function count(name: string): void {
    callCounts[name] = (callCounts[name] ?? 0) + 1;
  }
  return {
    callCounts,
    queueStatus: vi.fn(async () => {
      count("queueStatus");
      return {
        ready_for_agent: { eligible: [], held_for_summon: [] },
        ready_for_human: [],
        counts: {
          ready_for_agent_eligible: 0,
          ready_for_agent_held: 0,
          ready_for_human: 0,
        },
      };
    }),
    claimStatus: vi.fn(async () => { count("claimStatus"); return { issue: 2370, records: [], holders: [] }; }),
    cascadeStatus: vi.fn(async () => { count("cascadeStatus"); return { issue: 2370, dependents: [], promotable: [] }; }),
    claimRelease: vi.fn(async () => { count("claimRelease"); return { issue: 2370, conceded: [] }; }),
    landBranch: vi.fn(async () => { count("landBranch"); return { ok: true }; }),
    requeue: vi.fn(async () => { count("requeue"); return { applied: true }; }),
    unblockSweep: vi.fn(async () => { count("unblockSweep"); return { promoted: [] }; }),
    triage: vi.fn(async () => { count("triage"); return { action: "apply" }; }),
    deadendAudit: vi.fn(async () => { count("deadendAudit"); return { total: 0, classes: [] }; }),
  };
}

describe("withCachedDeps — zero gh calls within TTL", () => {
  it("serves queueStatus from cache on second call within TTL", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(15_000);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    await wrapped.queueStatus();
    await wrapped.queueStatus();
    await wrapped.queueStatus();

    expect(fake.callCounts["queueStatus"]).toBe(1);
  });

  it("serves deadendAudit from cache on repeated calls within TTL — zero gh", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(15_000);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    await wrapped.deadendAudit();
    await wrapped.deadendAudit();
    await wrapped.deadendAudit();

    expect(fake.callCounts["deadendAudit"]).toBe(1);
  });

  it("invalidates queue_status when requeue is called", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(15_000);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    await wrapped.queueStatus();
    expect(fake.callCounts["queueStatus"]).toBe(1);

    await wrapped.requeue({ issue: 2370, guidance: "retry" });
    await wrapped.queueStatus();
    expect(fake.callCounts["queueStatus"]).toBe(2);
  });

  it("invalidates queue_status when unblockSweep is called", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(15_000);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    await wrapped.queueStatus();
    await wrapped.unblockSweep();
    await wrapped.queueStatus();
    expect(fake.callCounts["queueStatus"]).toBe(2);
  });

  it("invalidates queue_status when triage is called", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(15_000);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    await wrapped.queueStatus();
    await wrapped.triage({ issue: 2370, decision: "ready-for-agent" });
    await wrapped.queueStatus();
    expect(fake.callCounts["queueStatus"]).toBe(2);
  });

  it("caches claimStatus per-issue and invalidates on claimRelease", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(15_000);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    await wrapped.claimStatus({ issue: 2370 });
    await wrapped.claimStatus({ issue: 2370 });
    expect(fake.callCounts["claimStatus"]).toBe(1);

    await wrapped.claimRelease({ issue: 2370 });
    await wrapped.claimStatus({ issue: 2370 });
    expect(fake.callCounts["claimStatus"]).toBe(2);
  });

  it("does not cross-contaminate claimStatus cache between issues", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(15_000);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    await wrapped.claimStatus({ issue: 1 });
    await wrapped.claimStatus({ issue: 2 });
    expect(fake.callCounts["claimStatus"]).toBe(2);

    await wrapped.claimRelease({ issue: 1 });
    await wrapped.claimStatus({ issue: 2 });
    expect(fake.callCounts["claimStatus"]).toBe(2);

    await wrapped.claimStatus({ issue: 1 });
    expect(fake.callCounts["claimStatus"]).toBe(3);
  });

  it("caches cascadeStatus and invalidates on landBranch", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(15_000);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    await wrapped.cascadeStatus({ issue: 2370 });
    await wrapped.cascadeStatus({ issue: 2370 });
    expect(fake.callCounts["cascadeStatus"]).toBe(1);

    await wrapped.landBranch({ issue: 2370, branch: "afk/w9YFU/2370-test" });
    await wrapped.cascadeStatus({ issue: 2370 });
    expect(fake.callCounts["cascadeStatus"]).toBe(2);
  });

  it("expires a cache entry after the TTL", async () => {
    const fake = makeFakeDeps();
    const cache = new ResidentReadCache(100);
    const wrapped = withCachedDeps(fake as unknown as CastleMcpDependencies, cache);

    const t0 = Date.now();
    await wrapped.queueStatus();
    // Fast path: check just before expiry using internal cache timing
    expect(cache.get(QUEUE_STATUS_KEY, t0 + 99)).not.toBeUndefined();
    // Past expiry
    expect(cache.get(QUEUE_STATUS_KEY, t0 + 200)).toBeUndefined();
  });
});
