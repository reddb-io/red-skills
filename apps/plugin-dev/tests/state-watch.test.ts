import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStateChangeWake } from "../src/runtime/state-watch.js";

/** Resolve true if `p` settles before `ms`, false on timeout — lets a test assert
 * an event DID / DID NOT fire without hanging the suite. */
function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe("buildStateChangeWake", () => {
  it("resolves when a worker rewrites its afk.state.toon (event-driven wake)", async () => {
    const root = mkdtempSync(join(tmpdir(), "rs-statewatch-"));
    const workersRoot = join(root, "workers");
    const workerDir = join(workersRoot, "w1");
    mkdirSync(workerDir, { recursive: true });
    try {
      const wake = buildStateChangeWake(workersRoot);
      const controller = new AbortController();
      const fired = wake.waitForEvent(controller.signal);
      // Give the watcher a beat to attach, then write the state file.
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(join(workerDir, "afk.state.toon"), '{"stage":"impl"}');
      expect(await settledWithin(fired, 1000)).toBe(true);
      controller.abort();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves on abort when no event ever fires (timer-wins teardown)", async () => {
    const root = mkdtempSync(join(tmpdir(), "rs-statewatch-"));
    const workersRoot = join(root, "workers");
    mkdirSync(workersRoot, { recursive: true });
    try {
      const wake = buildStateChangeWake(workersRoot);
      const controller = new AbortController();
      const fired = wake.waitForEvent(controller.signal);
      // No state file is written; only the abort should settle it.
      expect(await settledWithin(fired, 60)).toBe(false);
      controller.abort();
      expect(await settledWithin(fired, 1000)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades to abort-only when the workers root does not exist (timer fallback)", async () => {
    const wake = buildStateChangeWake(join(tmpdir(), "rs-statewatch-does-not-exist-12345"));
    const controller = new AbortController();
    const fired = wake.waitForEvent(controller.signal);
    // No spurious resolve from a failed watch setup.
    expect(await settledWithin(fired, 60)).toBe(false);
    controller.abort();
    expect(await settledWithin(fired, 1000)).toBe(true);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const wake = buildStateChangeWake(tmpdir());
    const controller = new AbortController();
    controller.abort();
    expect(await settledWithin(wake.waitForEvent(controller.signal), 1000)).toBe(true);
  });
});
