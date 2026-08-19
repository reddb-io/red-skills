import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPathSemaphore } from "../src/runtime/land-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file-backed validation semaphore", () => {
  it("admits K holders and queues the next one until a slot is released", async () => {
    const root = await mkdtemp(join(tmpdir(), "validation-semaphore-"));
    roots.push(root);
    const path = join(root, "validation-gate.lock");
    const first = await createPathSemaphore(path, "first", 2, { pollMs: 5 }).acquire();
    const second = await createPathSemaphore(path, "second", 2, { pollMs: 5 }).acquire();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    let acquired = false;
    const third = createPathSemaphore(path, "third", 2, { pollMs: 5 })
      .acquire()
      .then((release) => {
        acquired = true;
        return release;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(acquired).toBe(false);

    await first?.();
    const releaseThird = await third;
    expect(releaseThird).not.toBeNull();

    await second?.();
    await releaseThird?.();
  });

  it("uses the legacy lock path as the only slot when K = 1", async () => {
    const root = await mkdtemp(join(tmpdir(), "validation-semaphore-one-"));
    roots.push(root);
    const path = join(root, "validation-gate.lock");
    const release = await createPathSemaphore(path, "only", 1).acquire();

    expect(release).not.toBeNull();
    await expect(createPathSemaphore(path, "blocked", 1, { waitTimeoutMs: 0 }).acquire())
      .resolves.toBeNull();
    await release?.();
  });
});
