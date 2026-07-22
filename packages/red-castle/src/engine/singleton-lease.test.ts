import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnginePaths } from "./paths.js";
import {
  createSingletonLeaseStore,
  SingletonLeaseOwnershipError,
  singletonLeasePath,
} from "./singleton-lease.js";

describe("castle singleton lease", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("acquires, renews, and releases one lease through injected IO", async () => {
    const root = join(
      tmpdir(),
      `castle-singleton-lease-${crypto.randomUUID()}`,
    );
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    let now = "2026-07-22T18:30:00.000Z";
    const isPidAlive = vi.fn(() => true);
    const store = createSingletonLeaseStore(paths, {
      fs: { mkdir, readFile, rename, rm, writeFile },
      clock: () => now,
      isPidAlive,
    });
    const owner = { pid: 4100, startTime: "2026-07-22T18:29:58.000Z" };

    const acquired = await store.acquire("github-webhook", owner);

    expect(acquired).toEqual({
      acquired: true,
      reaped: false,
      lease: {
        pid: 4100,
        start_time: "2026-07-22T18:29:58.000Z",
        acquired_at: "2026-07-22T18:30:00.000Z",
        renewed_at: "2026-07-22T18:30:00.000Z",
      },
    });
    expect(singletonLeasePath(paths, "github-webhook")).toBe(
      join(paths.castleStateRoot, "singletons", "github-webhook", "lease.toon"),
    );

    now = "2026-07-22T18:31:00.000Z";
    expect(await store.renew("github-webhook", owner)).toMatchObject({
      renewed_at: "2026-07-22T18:31:00.000Z",
    });
    expect(await store.read("github-webhook")).toMatchObject({
      pid: 4100,
      renewed_at: "2026-07-22T18:31:00.000Z",
    });

    expect(await store.release("github-webhook", owner)).toBe(true);
    expect(await store.read("github-webhook")).toBeUndefined();
    expect(isPidAlive).not.toHaveBeenCalled();
  });

  it("reaps a crashed holder when its recorded PID is dead", async () => {
    const root = join(tmpdir(), `castle-stale-lease-${crypto.randomUUID()}`);
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const fs = { mkdir, readFile, rename, rm, writeFile };
    const crashedOwner = { pid: 5100, startTime: "2026-07-22T18:40:00.000Z" };
    const replacement = { pid: 6100, startTime: "2026-07-22T18:42:00.000Z" };
    const first = createSingletonLeaseStore(paths, {
      fs,
      clock: () => "2026-07-22T18:40:01.000Z",
      isPidAlive: () => true,
    });
    await first.acquire("github-webhook", crashedOwner);
    const isPidAlive = vi.fn((pid: number) => pid !== crashedOwner.pid);
    const next = createSingletonLeaseStore(paths, {
      fs,
      clock: () => "2026-07-22T18:42:01.000Z",
      isPidAlive,
    });

    const acquired = await next.acquire("github-webhook", replacement);

    expect(acquired).toMatchObject({
      acquired: true,
      reaped: true,
      lease: { pid: 6100, start_time: "2026-07-22T18:42:00.000Z" },
    });
    expect(isPidAlive).toHaveBeenCalledWith(5100);
    await expect(
      first.release("github-webhook", crashedOwner),
    ).rejects.toBeInstanceOf(SingletonLeaseOwnershipError);
  });
});
