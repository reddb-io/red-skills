// The duration model behind an honest ETA (#3097).
//
// The claims pinned here are the issue's acceptance criteria, in the order it
// states them: phase durations are recorded, the estimate derives from THEM, and
// no surface reaches an ETA by extrapolating from the progress bar.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advancePhaseWatch,
  appendPhaseDuration,
  buildPhaseDurationRecord,
  createPhaseDurationTracker,
  estimatePhaseEtaSeconds,
  parsePhaseDurationsToonl,
  phaseDurationsPath,
  readPhaseDurations,
  remainingEtaSeconds,
  summarizePhaseDurations,
  type PhaseDurationRecord,
} from "../src/core/phase-durations.js";
import { AFK_COSTED_PHASE_ORDER } from "../src/core/mirror.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "phase-durations-"));
  roots.push(root);
  return root;
}

function sample(phase: string, duration: number, runner = "claude", index = 0): PhaseDurationRecord {
  return buildPhaseDurationRecord(
    { worker: "wZ2R4", issue: 3097, runner },
    phase,
    duration,
    { ts: "2026-08-03T00:00:00.000Z", epoch: 1_800_000_000 + index },
  );
}

/** A model with `count` observations of each phase at the given seconds. */
function history(costs: Record<string, number>, count = 3, runner = "claude"): PhaseDurationRecord[] {
  const records: PhaseDurationRecord[] = [];
  let index = 0;
  for (const [phase, seconds] of Object.entries(costs)) {
    for (let i = 0; i < count; i += 1) records.push(sample(phase, seconds, runner, index++));
  }
  return records;
}

describe("a phase is measured when it ends, and only then", () => {
  it("closes the previous phase and opens the next one", () => {
    const opened = advancePhaseWatch(null, "setup", 1_000);
    expect(opened.completed).toBeNull();
    expect(opened.watch).toEqual({ phase: "setup", since_epoch: 1_000 });

    const moved = advancePhaseWatch(opened.watch, "coding", 1_090);
    expect(moved.completed).toEqual({ phase: "setup", duration_s: 90 });
    expect(moved.watch).toEqual({ phase: "coding", since_epoch: 1_090 });
  });

  it("is idempotent on a re-stamped phase", () => {
    // `coding` is written on EVERY inner-agent stream event. A watch that reset
    // on each of those would measure the gap between two log lines and file it as
    // a phase duration.
    const opened = advancePhaseWatch(null, "coding", 1_000);
    const again = advancePhaseWatch(opened.watch, "coding", 1_400);
    expect(again.completed).toBeNull();
    expect(again.watch).toBe(opened.watch);
  });
});

describe("the lane is TOONL, and survives a truncated tail", () => {
  it("round-trips through the TOON encoder, not through JSON", async () => {
    const root = await tempRoot();
    const path = phaseDurationsPath(join(root, ".red"));
    await appendPhaseDuration(path, sample("setup", 42));
    await appendPhaseDuration(path, sample("coding", 900, "codex", 1));

    const text = await readFile(path, "utf8");
    expect(text.split("\n")[0]).toBe("[2]{ts,epoch,worker,issue,runner,phase,duration_s}:");
    expect(text.trimStart().startsWith("[")).toBe(true);
    expect(text).not.toContain('"duration_s":');

    const records = await readPhaseDurations(path);
    expect(records.map((record) => [record.phase, record.duration_s, record.runner])).toEqual([
      ["setup", 42, "claude"],
      ["coding", 900, "codex"],
    ]);
  });

  it("drops a crash-truncated tail row rather than the whole model", () => {
    const whole = parsePhaseDurationsToonl(
      "[2]{ts,epoch,worker,issue,runner,phase,duration_s}:\n" +
        '  "2026-08-03T00:00:00.000Z",1800000000,wZ2R4,3097,claude,setup,42\n' +
        '  "2026-08-03T00:0',
    );
    expect(whole.map((record) => record.phase)).toEqual(["setup"]);
  });
});

describe("what each phase costs", () => {
  it("summarizes by the median, so one hour-long lock wait moves it by one place", () => {
    const stats = summarizePhaseDurations([
      sample("validating", 100, "claude", 0),
      sample("validating", 120, "claude", 1),
      sample("validating", 3_600, "claude", 2),
    ]);
    expect(stats.get("validating")).toEqual({ median_s: 120, samples: 3 });
  });

  it("prefers the runner's own history and falls back rather than refusing", () => {
    const records = [
      ...history({ coding: 600 }, 3, "claude"),
      ...history({ coding: 1_800 }, 3, "codex"),
      ...history({ merging: 90 }, 3, "claude"),
    ];
    expect(summarizePhaseDurations(records, { runner: "codex" }).get("coding")?.median_s).toBe(1_800);
    // `codex` has no `merging` row at all; the broad answer beats no answer, and
    // the sample count travels with it so a caller can still judge.
    expect(summarizePhaseDurations(records, { runner: "codex" }).get("merging")).toEqual({
      median_s: 90,
      samples: 3,
    });
  });
});

describe("the estimate derives from measured phase durations, and refuses otherwise", () => {
  it("sums the median of this phase and of every phase ahead", () => {
    const stats = summarizePhaseDurations(history({ setup: 60, coding: 1_200, validating: 300, merging: 120 }));
    expect(estimatePhaseEtaSeconds({ stats, order: AFK_COSTED_PHASE_ORDER, phase: "coding" })).toBe(1_620);
    expect(estimatePhaseEtaSeconds({ stats, order: AFK_COSTED_PHASE_ORDER, phase: "merging" })).toBe(120);
  });

  it("publishes NO estimate when a phase ahead is short of samples", () => {
    const stats = summarizePhaseDurations([
      ...history({ setup: 60, coding: 1_200, validating: 300 }),
      sample("merging", 120, "claude", 99),
    ]);
    // Every phase but `merging` is well measured. The estimate is refused whole
    // rather than published as a floor — a partial model prints with the same
    // confidence as a complete one.
    expect(estimatePhaseEtaSeconds({ stats, order: AFK_COSTED_PHASE_ORDER, phase: "setup" })).toBeNull();
    expect(estimatePhaseEtaSeconds({ stats, order: AFK_COSTED_PHASE_ORDER, phase: "validating" })).toBeNull();
  });

  it("refuses a phase outside the costed order — `blocked` has no position", () => {
    const stats = summarizePhaseDurations(history({ setup: 60, coding: 1_200, validating: 300, merging: 120 }));
    expect(estimatePhaseEtaSeconds({ stats, order: AFK_COSTED_PHASE_ORDER, phase: "blocked" })).toBeNull();
    expect(estimatePhaseEtaSeconds({ stats, order: AFK_COSTED_PHASE_ORDER, phase: "done" })).toBeNull();
  });

  it("is NOT a linear extrapolation: the same bar position gives different answers", () => {
    // Two Workers, both at index 1 of 4 with a full model behind them. A linear
    // extrapolation from `phase_index/phase_total` would hand them the SAME
    // remaining fraction; the measured cost of the phases ahead does not.
    const cheapAhead = summarizePhaseDurations(history({ coding: 600, validating: 60, merging: 30 }));
    const dearAhead = summarizePhaseDurations(history({ coding: 600, validating: 1_800, merging: 900 }));
    const from = { order: AFK_COSTED_PHASE_ORDER, phase: "coding" } as const;

    expect(estimatePhaseEtaSeconds({ stats: cheapAhead, ...from })).toBe(690);
    expect(estimatePhaseEtaSeconds({ stats: dearAhead, ...from })).toBe(3_300);
    // And the ratio is nothing like the bar's: 1 of 4 cells done in both cases.
    expect(estimatePhaseEtaSeconds({ stats: dearAhead, ...from })).toBeGreaterThan(
      estimatePhaseEtaSeconds({ stats: cheapAhead, ...from })! * 4,
    );
  });

  it("counts down against the estimate and floors at zero", () => {
    expect(remainingEtaSeconds(600, 120)).toBe(480);
    expect(remainingEtaSeconds(600, 900)).toBe(0);
    expect(remainingEtaSeconds(null, 120)).toBeNull();
  });
});

describe("the tracker measures as it goes and estimates from what it measured", () => {
  it("records each phase it leaves and answers with a shrinking estimate", async () => {
    const root = await tempRoot();
    const path = phaseDurationsPath(join(root, ".red"));
    // A model from previous issues, already on disk.
    for (const record of history({ setup: 60, coding: 1_200, validating: 300, merging: 120 })) {
      await appendPhaseDuration(path, record);
    }
    const tracker = createPhaseDurationTracker({ path, order: AFK_COSTED_PHASE_ORDER });
    const identity = { worker: "wZ2R4", issue: 3097, runner: "claude" };

    // The first observation only ANCHORS: this Worker may have attached mid-phase
    // and does not know when `setup` began.
    await tracker.observe({ phase: "setup", identity, nowEpoch: 10_000, nowIso: "2026-08-03T01:00:00.000Z" });
    expect(tracker.etaSeconds(10_000)).toBeNull();
    expect(tracker.phaseStartedAt()).toBe("2026-08-03T01:00:00.000Z");

    // The transition is witnessed: `setup` is measured, and the estimate for
    // `coding` onward is founded.
    await tracker.observe({ phase: "coding", identity, nowEpoch: 10_090, nowIso: "2026-08-03T01:01:30.000Z" });
    expect(tracker.etaSeconds(10_090)).toBe(1_620);
    expect(tracker.etaSeconds(10_690)).toBe(1_020);
    expect(tracker.phaseStartedAt()).toBe("2026-08-03T01:01:30.000Z");

    const written = await readPhaseDurations(path);
    expect(written.at(-1)).toMatchObject({ phase: "setup", duration_s: 90, issue: 3097, runner: "claude" });
  });

  it("says nothing at all when the model is too thin to speak", async () => {
    const root = await tempRoot();
    const tracker = createPhaseDurationTracker({
      path: phaseDurationsPath(join(root, ".red")),
      order: AFK_COSTED_PHASE_ORDER,
    });
    const identity = { worker: "wZ2R4", issue: 3097, runner: "claude" };
    await tracker.observe({ phase: "setup", identity, nowEpoch: 10_000, nowIso: "2026-08-03T01:00:00.000Z" });
    await tracker.observe({ phase: "coding", identity, nowEpoch: 10_090, nowIso: "2026-08-03T01:01:30.000Z" });
    // One measurement of one phase. Absent is `null` — never a zero, and never a
    // number assembled from the one phase that happened to be measured.
    expect(tracker.etaSeconds(10_090)).toBeNull();
  });
});
