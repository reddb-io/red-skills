import { describe, expect, it, vi } from "vitest";
import {
  RedskilledResourceAdmissionTimeoutError,
  createRedskilledResourceLeaseRuntime,
  type RedskilledResourceLease,
} from "../src/resource-lease.js";

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe("generic host resource leases (#3802)", () => {
  it("atomically admits one of two simultaneous requests", async () => {
    const runtime = createRedskilledResourceLeaseRuntime({
      availableMemoryBytes: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return 10_000;
      },
      safetyPollMs: 5,
    });
    const request = (holder_id: string) => runtime.acquire({
      resource: "validation-heavy", holder_id,
      minimum_available_memory_bytes: 1, ttl_ms: 1_000, wait_timeout_ms: 100,
    });
    const firstRequest = request("w1");
    const secondRequest = request("w2");
    const winner = await Promise.race([firstRequest, secondRequest]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.snapshot()).toHaveLength(1);
    await runtime.release(winner.lease_id);
    const leases = await Promise.all([firstRequest, secondRequest]);
    expect(new Set(leases.map((lease) => lease.holder_id))).toEqual(new Set(["w1", "w2"]));
  });

  it("admits only after both the conflicting lease and memory pressure clear", async () => {
    const time = clock();
    let available = 8_192;
    const runtime = createRedskilledResourceLeaseRuntime({
      nowMs: time.now,
      availableMemoryBytes: () => available,
      safetyPollMs: 5,
    });
    const first = await runtime.acquire({
      resource: "validation-heavy",
      holder_id: "wFIRST",
      minimum_available_memory_bytes: 4_096,
      ttl_ms: 1_000,
      wait_timeout_ms: 100,
    });

    let second: RedskilledResourceLease | undefined;
    const waiting = runtime.acquire({
      resource: "validation-heavy",
      holder_id: "wSECOND",
      minimum_available_memory_bytes: 4_096,
      ttl_ms: 1_000,
      wait_timeout_ms: 100,
    }).then((lease) => { second = lease; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(second).toBeUndefined();

    available = 2_048;
    await runtime.release(first.lease_id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second).toBeUndefined();

    available = 8_192;
    await waiting;
    expect(second?.holder_id).toBe("wSECOND");
  });

  it("release, holder death and TTL expiry wake waiters", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRedskilledResourceLeaseRuntime({
        availableMemoryBytes: () => 10_000,
        safetyPollMs: 5_000,
      });
      const first = await runtime.acquire({
        resource: "validation-heavy", holder_id: "w1",
        minimum_available_memory_bytes: 1, ttl_ms: 10_000, wait_timeout_ms: 30_000,
      });
      const afterRelease = runtime.acquire({
        resource: "validation-heavy", holder_id: "w2",
        minimum_available_memory_bytes: 1, ttl_ms: 10_000, wait_timeout_ms: 30_000,
      });
      await runtime.release(first.lease_id);
      const second = await afterRelease;

      const afterDeath = runtime.acquire({
        resource: "validation-heavy", holder_id: "w3",
        minimum_available_memory_bytes: 1, ttl_ms: 10_000, wait_timeout_ms: 30_000,
      });
      await runtime.releaseHolder(second.holder_id);
      const third = await afterDeath;

      const afterExpiry = runtime.acquire({
        resource: "validation-heavy", holder_id: "w4",
        minimum_available_memory_bytes: 1, ttl_ms: 10_000, wait_timeout_ms: 30_000,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await afterExpiry).holder_id).toBe("w4");
      expect(third.holder_id).toBe("w3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores authority across daemon replacement and times out as infrastructure", async () => {
    vi.useFakeTimers();
    try {
      const first = createRedskilledResourceLeaseRuntime({ availableMemoryBytes: () => 10_000 });
      const held = await first.acquire({
        resource: "validation-heavy", holder_id: "w1",
        minimum_available_memory_bytes: 1, ttl_ms: 10_000, wait_timeout_ms: 30_000,
      });
      const successor = createRedskilledResourceLeaseRuntime({
        availableMemoryBytes: () => 10_000,
        restored: [held],
        safetyPollMs: 5_000,
      });
      const waiting = successor.acquire({
        resource: "validation-heavy", holder_id: "w2",
        minimum_available_memory_bytes: 1, ttl_ms: 10_000, wait_timeout_ms: 30_000,
      });
      await vi.advanceTimersByTimeAsync(9_999);
      let admitted = false;
      void waiting.then(() => { admitted = true; });
      await Promise.resolve();
      expect(admitted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await waiting).holder_id).toBe("w2");

      const timedOut = expect(successor.acquire({
        resource: "validation-heavy", holder_id: "w3",
        minimum_available_memory_bytes: 1, ttl_ms: 10_000, wait_timeout_ms: 1_000,
      })).rejects.toBeInstanceOf(RedskilledResourceAdmissionTimeoutError);
      await vi.advanceTimersByTimeAsync(1_000);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });
});
