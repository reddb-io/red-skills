import { describe, expect, it } from "vitest";
import {
  REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT,
  decideReaperSignal,
  deriveSnapshot,
  inspectProcessTree,
  type DecideReaperSignalInput,
  type ProcessSnapshotEntry,
} from "../src/core/reaper-signal.js";

// Fixed inputs throughout: threshold 600s, default cpu-busy line (5%).
const THRESH = 600;

function decide(over: Partial<DecideReaperSignalInput>): string {
  return decideReaperSignal({
    idleSeconds: 9999,
    idleThresholdSeconds: THRESH,
    activeDescendant: false,
    cpuPct: 0,
    ...over,
  });
}

describe("decideReaperSignal", () => {
  // ---------- AC1: active build/test descendant ⇒ busy, never killed ----------

  it("never kills when an active descendant exists, even idle past threshold with flat cpu", () => {
    expect(decide({ activeDescendant: true, cpuPct: 0 })).toBe("no-kill");
  });

  it("active descendant beats flat cpu (a build blocked on I/O sits at ~0%)", () => {
    expect(decide({ activeDescendant: true, cpuPct: 0.0 })).toBe("no-kill");
  });

  // ---------- AC2: non-trivial cpu ⇒ busy, never killed ----------

  it("never kills on high aggregate cpu with no named descendant", () => {
    expect(decide({ activeDescendant: false, cpuPct: 73.4 })).toBe("no-kill");
    expect(decide({ activeDescendant: false, cpuPct: 12.5 })).toBe("no-kill");
  });

  it("cpu exactly at the busy line counts as busy (ambiguity favours no-kill)", () => {
    expect(decide({ cpuPct: 5 })).toBe("no-kill");
  });

  it("honours a custom busy line", () => {
    expect(decide({ cpuPct: 2.0, cpuBusyPct: 1.5 })).toBe("no-kill");
    expect(decide({ cpuPct: 1.4, cpuBusyPct: 1.5 })).toBe("kill");
  });

  // ---------- AC3: kill only when idle past threshold AND no descendant AND flat cpu ----------

  it("kills when idle past threshold, no descendant, flat cpu", () => {
    expect(decide({ activeDescendant: false, cpuPct: 0 })).toBe("kill");
  });

  it("trivial-but-nonzero cpu below the busy line is still flat ⇒ kill", () => {
    expect(decide({ cpuPct: 0.3 })).toBe("kill");
  });

  // ---------- boundary: the idle-vs-threshold edge ----------

  it("never kills within the grace window, even with no descendant and flat cpu", () => {
    expect(decide({ idleSeconds: 599 })).toBe("no-kill");
  });

  it("treats idle == threshold as past (>=), like compute_stalled", () => {
    expect(decide({ idleSeconds: 600 })).toBe("kill");
    expect(decide({ idleSeconds: 599 })).toBe("no-kill");
  });

  // ---------- boundary: the cpu-busy edge ----------

  it("kills just under the default busy line, never kills just over", () => {
    expect(decide({ cpuPct: 4.999 })).toBe("kill");
    expect(decide({ cpuPct: 5.001 })).toBe("no-kill");
    expect(REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT).toBe(5);
  });

  // ---------- fail-safe: unparseable inputs favour NOT killing ----------

  it("never kills on a non-integer / negative threshold (cannot say 'past')", () => {
    expect(decide({ idleThresholdSeconds: NaN })).toBe("no-kill");
    expect(decide({ idleThresholdSeconds: 1.5 })).toBe("no-kill");
    expect(decide({ idleThresholdSeconds: -1 })).toBe("no-kill");
  });

  it("treats a non-integer idle as 0 (never past a positive threshold) ⇒ no-kill", () => {
    expect(decide({ idleSeconds: NaN })).toBe("no-kill");
    expect(decide({ idleSeconds: 1.5 })).toBe("no-kill");
  });

  it("treats a non-numeric cpu as 0 (flat) — past threshold, no descendant ⇒ kill", () => {
    expect(decide({ cpuPct: NaN })).toBe("kill");
  });
});

describe("deriveSnapshot", () => {
  const proc = (command: string, cpu: number): ProcessSnapshotEntry => ({ command, cpu });

  it("flags an active descendant when a vitest process is present", () => {
    const snap = deriveSnapshot([proc("node", 0), proc("vitest", 0)]);
    expect(snap.activeDescendant).toBe(true);
  });

  it("flags tsc and cargo descendants (anchored, case-insensitive)", () => {
    expect(deriveSnapshot([proc("tsc", 0)]).activeDescendant).toBe(true);
    expect(deriveSnapshot([proc("cargo", 0)]).activeDescendant).toBe(true);
    expect(deriveSnapshot([proc("CARGO", 0)]).activeDescendant).toBe(true);
    expect(deriveSnapshot([proc("python3.11", 0)]).activeDescendant).toBe(true);
  });

  it("does not flag a bare node / unrelated command (anchored match)", () => {
    expect(deriveSnapshot([proc("node", 0)]).activeDescendant).toBe(false);
    expect(deriveSnapshot([proc("vitestx", 0)]).activeDescendant).toBe(false);
    expect(deriveSnapshot([proc("xtsc", 0)]).activeDescendant).toBe(false);
  });

  it("sums aggregate cpu across the tree, ignoring non-finite entries", () => {
    const snap = deriveSnapshot([proc("node", 12.5), proc("sh", 0.3), proc("ps", Number.NaN)]);
    expect(snap.cpuPct).toBeCloseTo(12.8, 5);
  });

  it("an empty tree is idle and flat", () => {
    expect(deriveSnapshot([])).toEqual({ activeDescendant: false, cpuPct: 0 });
  });
});

describe("inspectProcessTree (injectable inspector — never spawns processes)", () => {
  it("derives the snapshot from an injected fake process tree", () => {
    const inspector = (pid: number): ProcessSnapshotEntry[] => {
      expect(pid).toBe(4242);
      return [{ command: "node", cpu: 1.1 }, { command: "tsc", cpu: 80.0 }];
    };
    const snap = inspectProcessTree(4242, inspector);
    expect(snap.activeDescendant).toBe(true);
    expect(snap.cpuPct).toBeCloseTo(81.1, 5);
  });

  it("composes with decideReaperSignal end-to-end: busy tree ⇒ no-kill, dead tree ⇒ kill", () => {
    const busy = inspectProcessTree(1, () => [{ command: "vitest", cpu: 0 }]);
    expect(
      decideReaperSignal({ idleSeconds: 9999, idleThresholdSeconds: THRESH, ...busy }),
    ).toBe("no-kill");

    const dead = inspectProcessTree(1, () => []);
    expect(
      decideReaperSignal({ idleSeconds: 9999, idleThresholdSeconds: THRESH, ...dead }),
    ).toBe("kill");
  });
});
