import { describe, expect, it } from "vitest";
import {
  REQUEUE_ADOPT_WORKER,
  REQUEUE_ORIGIN,
  withAdoptPresence,
  type AdoptPresenceIo,
  type AdoptPresenceSeed,
  type AdoptPresenceStage,
} from "../src/core/adopt-presence.js";

interface Recorder {
  io: AdoptPresenceIo;
  seeds: AdoptPresenceSeed[];
  stages: Array<{ statePath: string; stage: AdoptPresenceStage }>;
  teardowns: Array<{ statePath: string; attemptDir: string }>;
  events: string[];
}

function recorder(): Recorder {
  const seeds: AdoptPresenceSeed[] = [];
  const stages: Array<{ statePath: string; stage: AdoptPresenceStage }> = [];
  const teardowns: Array<{ statePath: string; attemptDir: string }> = [];
  const events: string[] = [];
  const io: AdoptPresenceIo = {
    seed(input) {
      seeds.push(input);
      events.push("seed");
    },
    async setStage(statePath, stage) {
      stages.push({ statePath, stage });
      events.push(`stage:${stage}`);
    },
    async teardown(statePath, attemptDir) {
      teardowns.push({ statePath, attemptDir });
      events.push("teardown");
    },
  };
  return { io, seeds, stages, teardowns, events };
}

const params = { tmpDir: "/tmp/.red/tmp", issue: 42, title: "Fix the thing", runner: "claude" };

describe("withAdoptPresence — seed", () => {
  it("seeds one live presence row under the canonical workers root before the body runs", async () => {
    const r = recorder();
    let seenAtBodyStart = 0;

    await withAdoptPresence(r.io, params, async () => {
      seenAtBodyStart = r.seeds.length;
      return "landed" as const;
    });

    // The row is seeded BEFORE the body executes.
    expect(seenAtBodyStart).toBe(1);
    const seed = r.seeds[0]!;
    expect(seed.worker).toBe(REQUEUE_ADOPT_WORKER);
    expect(seed.issue).toBe(42);
    expect(seed.title).toBe("Fix the thing");
    expect(seed.runner).toBe("claude");
    expect(seed.stage).toBe("validating");
    // Canonical `workers/` root (never go-workers/scout-workers) + stable issue id.
    expect(seed.attemptDir).toBe("/tmp/.red/tmp/workers/requeue-adopt/42");
    expect(seed.statePath).toBe("/tmp/.red/tmp/workers/requeue-adopt/42/afk.state.toon");
  });

  it("uses a distinct requeue provenance constant", () => {
    // Guards the value the (origin-agnostic) reader renders as the source count.
    expect(REQUEUE_ORIGIN).toBe("requeue");
  });
});

describe("withAdoptPresence — teardown on every exit path", () => {
  it("marks not-live + tears down after a LANDED body, and returns its value", async () => {
    const r = recorder();

    const outcome = await withAdoptPresence(r.io, params, async () => "landed" as const);

    expect(outcome).toBe("landed");
    expect(r.teardowns).toHaveLength(1);
    expect(r.teardowns[0]!.attemptDir).toBe("/tmp/.red/tmp/workers/requeue-adopt/42");
    // Seed happens before teardown.
    expect(r.events).toEqual(["seed", "teardown"]);
  });

  it("marks not-live + tears down after a PARKED body too", async () => {
    const r = recorder();

    const outcome = await withAdoptPresence(r.io, params, async () => "parked" as const);

    expect(outcome).toBe("parked");
    expect(r.teardowns).toHaveLength(1);
    expect(r.events[r.events.length - 1]).toBe("teardown");
  });

  it("tears down even when the body THROWS, and re-throws the error", async () => {
    const r = recorder();

    await expect(
      withAdoptPresence(r.io, params, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The presence row is still cleaned up — no residue on the failure path.
    expect(r.teardowns).toHaveLength(1);
    expect(r.events).toEqual(["seed", "teardown"]);
  });
});

describe("withAdoptPresence — stage progression", () => {
  it("advances the row through validate → land via the handle", async () => {
    const r = recorder();

    await withAdoptPresence(r.io, params, async (handle) => {
      await handle.markStage("validating");
      await handle.markStage("landing");
      return "landed" as const;
    });

    expect(r.stages.map((s) => s.stage)).toEqual(["validating", "landing"]);
    // Stage updates target the seeded presence state file.
    for (const s of r.stages) {
      expect(s.statePath).toBe("/tmp/.red/tmp/workers/requeue-adopt/42/afk.state.toon");
    }
    // Order: seed → stages → teardown last.
    expect(r.events).toEqual(["seed", "stage:validating", "stage:landing", "teardown"]);
  });
});
