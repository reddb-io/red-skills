// What a surface SHOWS about a Worker, said by the project that owns it (#3097).
//
// The record carried no execution time, no context figure and no ETA, so the
// three cells the dashboard was missing could not be filled by anything. These
// pin the three: `started_at` (the render derives `elapsed` from it), `context`,
// and an `eta` computed from measured phase durations — or `null`, loudly, when
// nothing may be claimed.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RedskilledWorkerDisplay } from "@reddb-io/redskilled/worker-display";
import { AFK_COSTED_PHASE_ORDER } from "../src/core/mirror.js";
import { createCastleWorkerLaneBridge } from "../src/core/castle-worker-lane-bridge.js";
import {
  appendPhaseDuration,
  buildPhaseDurationRecord,
  createPhaseDurationTracker,
  phaseDurationsPath,
  readPhaseDurations,
} from "../src/core/phase-durations.js";
import { initStateSync } from "../src/core/state.js";
import { AfkStateSchema } from "../src/types/state.js";
import { workerDisplayFromState } from "../src/core/worker-display-record.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "worker-display-"));
  roots.push(root);
  return root;
}

const NOW = Date.parse("2026-08-03T01:30:00.000Z");

function state(current: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return AfkStateSchema.parse({
    worker_id: "wZ2R4",
    runner: "claude",
    origin: "afk",
    started_at: "2026-08-03T00:00:00.000Z",
    ...top,
    current: {
      number: 3097,
      runner: "claude",
      model: "opus",
      effort: "high",
      phase: "coding",
      activity: "impl",
      started_at: "2026-08-03T01:00:00.000Z",
      last_event_at: "2026-08-03T01:29:57.000Z",
      ...current,
    },
  });
}

describe("the three fields the record was missing", () => {
  it("publishes the age anchors, context and eta", () => {
    const display = workerDisplayFromState(state({
      context_tokens: 108_000,
      last_commit_at: "2026-08-03T01:20:00.000Z",
      last_loc_progress_at: "2026-08-03T01:25:00.000Z",
    }), {
      etaSeconds: 1_020,
      nowMs: NOW,
      phaseStartedAt: "2026-08-03T01:10:00.000Z",
    });

    expect(display.started_at).toBe("2026-08-03T01:00:00.000Z");
    expect(display.phase_started_at).toBe("2026-08-03T01:10:00.000Z");
    expect(display.progress_at).toBe("2026-08-03T01:25:00.000Z");
    expect(display.context).toBe(108_000);
    expect(display.eta).toBe(1_020);
    // `elapsed` is deliberately NOT on the record: two surfaces publishing their
    // own would disagree about now within one sampling interval.
    expect(display).not.toHaveProperty("elapsed");
  });

  it("renders no ETA as null — never as a zero", () => {
    const display = workerDisplayFromState(state(), { etaSeconds: null, nowMs: NOW });

    expect(display.eta).toBeNull();
    expect(display.eta).not.toBe(0);
  });

  it("says null for a context nothing has measured", () => {
    // claude reports usage at the iteration boundary, not on the stream, so a
    // Worker can be minutes in with no observation at all. A `0` there would read
    // as an empty context window, which is the opposite fact.
    expect(workerDisplayFromState(state(), { etaSeconds: null, nowMs: NOW }).context).toBeNull();
  });
});

describe("operator-facing activity vocabulary", () => {
  it.each([
    ["coding", "setup", "preparing"],
    ["coding", "review", "reading"],
    ["coding", "explore", "searching"],
    ["coding", "impl", "editing"],
    ["coding", "tests", "testing"],
    ["coding", "typecheck", "typechecking"],
    ["coding", "lint", "linting"],
    ["coding", "build", "building"],
    ["coding", "commit", "committing"],
    ["coding", "push", "pushing"],
    ["validating", "review", "reviewing"],
    ["gate", "landing", "landing"],
  ])("renders %s/%s as %s", (phase, activity, expected) => {
    const display = workerDisplayFromState(state({ phase, activity }), { etaSeconds: null, nowMs: NOW });
    expect(display.step).toBe(expected);
  });
});

describe("the bar travels as two integers and no vocabulary", () => {
  it("places the macro phase in the five-phase order", () => {
    const display = workerDisplayFromState(state({ phase: "coding" }), { etaSeconds: null, nowMs: NOW });
    expect([display.phase_index, display.phase_total]).toEqual([1, 5]);
  });

  it("folds a landing step into merging rather than growing the bar", () => {
    const display = workerDisplayFromState(state({ phase: "push-pr" }), { etaSeconds: null, nowMs: NOW });
    expect([display.phase, display.phase_index, display.phase_total]).toEqual(["push-pr", 3, 5]);
  });

  it("gives an out-of-vocabulary phase no position at all", () => {
    const display = workerDisplayFromState(state({ phase: "blocked" }), { etaSeconds: null, nowMs: NOW });
    expect([display.phase_index, display.phase_total]).toEqual([null, null]);
    expect(display.failed).toBe(true);
  });
});

describe("absent is null, never a zero", () => {
  it("distinguishes a runner that reports no tokens from a Worker that spent none", () => {
    const display = workerDisplayFromState(state(), { etaSeconds: null, nowMs: NOW });
    expect(display.tokens).toBeNull();
    // A tool count of zero, by contrast, is a real measurement of a Worker that
    // has called no tool yet.
    expect(display.tools).toBe(0);
    expect(display.added).toBe(0);
  });

  it("spells proof-of-life from the last stream event", () => {
    expect(workerDisplayFromState(state(), { etaSeconds: null, nowMs: NOW }).heartbeat).toBe("3s");
    expect(
      workerDisplayFromState(state({ last_event_at: "" }), { etaSeconds: null, nowMs: NOW }).heartbeat,
    ).toBeNull();
  });
});

describe("the beat carries the record, and the model behind its ETA", () => {
  it("publishes a display beside the line, with an ETA measured from real phases", async () => {
    const root = await scratch();
    const redRoot = join(root, ".red");
    const attemptDir = join(redRoot, "tmp", "workers", "wZ2R4", "3097");
    await mkdir(attemptDir, { recursive: true });
    initStateSync(join(attemptDir, "afk.state.toon"), {
      worker_id: "wZ2R4",
      pid: 42,
      runner: "claude",
      origin: "afk",
      started_at: "2026-08-03T00:00:00.000Z",
      "current.number": 3097,
      "current.phase": "coding",
      "current.activity": "impl",
      "current.started_at": "2026-08-03T01:00:00.000Z",
      "current.context_tokens": 96_000,
    });

    // A model from previous issues, and a tracker that has already witnessed the
    // setup → coding transition on this one.
    const path = phaseDurationsPath(redRoot);
    let index = 0;
    for (const [phase, seconds] of Object.entries({ setup: 60, coding: 1_200, validating: 300, merging: 120 })) {
      for (let i = 0; i < 3; i += 1) {
        await appendPhaseDuration(
          path,
          buildPhaseDurationRecord({ worker: "wOLD", issue: 1, runner: "claude" }, phase, seconds, {
            ts: "2026-08-02T00:00:00.000Z",
            epoch: 1_800_000_000 + index++,
          }),
        );
      }
    }
    const phaseDurations = createPhaseDurationTracker({ path, order: AFK_COSTED_PHASE_ORDER });
    const identity = { worker: "wZ2R4", issue: 3097, runner: "claude" };
    await phaseDurations.observe({ phase: "setup", identity, nowEpoch: 1_800_100, nowIso: "2026-08-03T00:58:00.000Z" });
    await phaseDurations.observe({ phase: "coding", identity, nowEpoch: 1_800_200, nowIso: "2026-08-03T01:00:00.000Z" });

    const published: Array<{ line: string; display?: RedskilledWorkerDisplay }> = [];
    const bridge = createCastleWorkerLaneBridge({
      redRoot,
      workerId: "wZ2R4",
      attemptDir: () => attemptDir,
      nowIso: () => "2026-08-03T01:05:00.000Z",
      nowMs: () => 1_800_500 * 1000,
      phaseDurations,
      publishHostLogLine: async (line, display) => {
        published.push({ line, ...(display == null ? {} : { display }) });
      },
    });

    await bridge.record("worker.heartbeat", { signal: "vitals-sampler" });

    expect(published).toHaveLength(1);
    const display = published[0]!.display;
    expect(display?.issue).toBe("3097");
    expect(display?.phase).toBe("coding");
    expect(display?.started_at).toBe("2026-08-03T01:00:00.000Z");
    expect(display?.context).toBe(96_000);
    // 1200 (coding) + 300 (validating) + 120 (merging), counted down by the 300s
    // this Worker has already spent in `coding`.
    expect(display?.eta).toBe(1_320);
  });

  it("measures each phase the Worker leaves, from the one place that sees them all", async () => {
    const root = await scratch();
    const redRoot = join(root, ".red");
    const attemptDir = join(redRoot, "tmp", "workers", "wZ2R4", "3097");
    await mkdir(attemptDir, { recursive: true });
    initStateSync(join(attemptDir, "afk.state.toon"), {
      worker_id: "wZ2R4",
      pid: 42,
      runner: "codex",
      origin: "afk",
      "current.number": 3097,
      "current.phase": "setup",
    });

    let now = 1_800_000;
    const bridge = createCastleWorkerLaneBridge({
      redRoot,
      workerId: "wZ2R4",
      attemptDir: () => attemptDir,
      nowIso: () => new Date(now * 1000).toISOString(),
      nowMs: () => now * 1000,
    });
    await bridge.snapshot();

    // The gate stamps `current.phase` directly; nothing calls a recorder. The
    // bridge sees it on the next beat, which is why measuring lives there.
    initStateSync(join(attemptDir, "afk.state.toon"), {
      worker_id: "wZ2R4",
      pid: 42,
      runner: "codex",
      origin: "afk",
      "current.number": 3097,
      "current.phase": "validating",
    });
    now += 240;
    await bridge.snapshot();

    const recorded = await readPhaseDurations(phaseDurationsPath(redRoot));
    expect(recorded).toEqual([
      expect.objectContaining({ phase: "setup", duration_s: 240, issue: 3097, runner: "codex", worker: "wZ2R4" }),
    ]);
  });
});
