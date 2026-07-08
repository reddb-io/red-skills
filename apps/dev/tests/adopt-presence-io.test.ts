import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAdoptPresenceIo } from "../src/commands/requeue.js";
import { withAdoptPresence } from "../src/core/adopt-presence.js";
import { readWorkerState } from "../src/core/worker-state-reader.js";

// End-to-end proof that the REAL presence IO seeds a state file the UNCHANGED
// Worker state reader renders as a live `origin="requeue"` row while the body
// runs, and that the row is torn down (dir removed) on every exit path. No
// reader code is touched — this reads through the shipped `readWorkerState`.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adopt-presence-io-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const attemptDir = (tmpDir: string, issue: number): string =>
  join(tmpDir, "workers", "requeue-adopt", `${issue}-a1`);

describe("makeAdoptPresenceIo — real state file, read through the shipped reader", () => {
  it("renders a live requeue-origin row mid-run, advances stage, then tears down on the landed path", async () => {
    const tmpDir = join(root, ".red", "tmp");
    const io = makeAdoptPresenceIo("claude");
    const dir = attemptDir(tmpDir, 42);
    const statePath = join(dir, "afk.state.json");

    const outcome = await withAdoptPresence(
      io,
      { tmpDir, issue: 42, title: "Fix the thing", runner: "claude" },
      async (handle) => {
        // Mid-run: the reader (unchanged) renders a live, requeue-origin row.
        const seeded = readWorkerState(statePath);
        expect(seeded).not.toBeNull();
        expect(seeded!.state.origin).toBe("requeue");
        expect(seeded!.state.current.number).toBe(42);
        expect(seeded!.state.current.stage).toBe("validating");
        expect(seeded!.renderableLive).toBe(true);

        await handle.markStage("landing");
        const landing = readWorkerState(statePath);
        expect(landing!.state.current.stage).toBe("landing");
        expect(landing!.renderableLive).toBe(true);

        return "landed" as const;
      },
    );

    expect(outcome).toBe("landed");
    // Teardown removed the short-lived attempt dir — no residue.
    expect(existsSync(dir)).toBe(false);
  });

  it("tears the row down on the failure path too (body throws)", async () => {
    const tmpDir = join(root, ".red", "tmp");
    const io = makeAdoptPresenceIo("claude");
    const dir = attemptDir(tmpDir, 7);

    await expect(
      withAdoptPresence(io, { tmpDir, issue: 7, title: "Boom", runner: "claude" }, async () => {
        // The row exists while the body runs.
        expect(existsSync(join(dir, "afk.state.json"))).toBe(true);
        throw new Error("gate exploded");
      }),
    ).rejects.toThrow("gate exploded");

    expect(existsSync(dir)).toBe(false);
  });
});
