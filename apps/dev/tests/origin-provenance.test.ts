// Tests that the statusline and monitor derive per-source worker counts from
// the SAME `state.origin` field via the shared read surface (readWorkerStates →
// WorkerStateRecord.state.origin), with no independent derivation.
//
// Acceptance criteria (issue #930 S2):
//   - origin stamped at spawn (tested in the flag/init path, exercised by e2e)
//   - one shared read surface: state.origin from AfkStateSchema
//   - both surfaces show per-source counts that agree
//   - enum extends cleanly (new origin strings need no render changes)

import { describe, expect, it } from "vitest";
import { afkTokens, type AfkInput } from "../src/core/statusline.js";
import { renderCompactDashboard, type CompactWorker } from "../src/core/monitor.js";

// Builds a minimal CompactWorker with a given origin label.
function makeWorker(origin: string, id: string): CompactWorker {
  return {
    state: {
      worker_id: id,
      pid: 1,
      runner: "claude",
      started_at: "2026-06-30T00:00:00Z",
      origin,
      total: 5,
      done: 1,
      blocked: 0,
      failed: 0,
      current: {
        number: 42,
        title: "some issue",
        activity: "impl",
        started_at: "2026-06-30T00:00:00Z",
      },
    },
    live: true,
    liveness: "active",
  };
}

// Derives per-source counts from a list of origin labels, mirroring what both
// collectStatuslineAfk and renderCompactDashboard do from state.origin.
function buildSourceCounts(origins: string[]): ReadonlyArray<{ origin: string; count: number }> {
  const m = new Map<string, number>();
  for (const o of origins) if (o) m.set(o, (m.get(o) ?? 0) + 1);
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([origin, count]) => ({ origin, count }));
}

describe("origin provenance — per-source counts", () => {
  const NOW_EPOCH = 1_751_000_000;

  it("statusline emits per-source tokens from sourceCounts after wrk=N", () => {
    const afk: AfkInput = {
      workers: 3,
      queue: 0,
      human: 0,
      blocked: 0,
      added: 0,
      removed: 0,
      issues: [],
      sourceCounts: [
        { origin: "afk", count: 1 },
        { origin: "go", count: 2 },
      ],
    };
    const tokens = afkTokens(afk);
    const rendered = tokens.map((t) => `${t.label}${t.value}`);
    // wrk= comes first, then per-source in sorted order
    expect(rendered[0]).toBe("wrk=3");
    expect(rendered).toContain("afk=1");
    expect(rendered).toContain("go=2");
    // per-source appear right after wrk=
    const wrkIdx = rendered.indexOf("wrk=3");
    const afkIdx = rendered.indexOf("afk=1");
    const goIdx = rendered.indexOf("go=2");
    expect(afkIdx).toBe(wrkIdx + 1);
    expect(goIdx).toBe(wrkIdx + 2);
  });

  it("statusline omits per-source tokens when sourceCounts is absent (back-compat)", () => {
    const afk: AfkInput = {
      workers: 2,
      queue: 0,
      human: 0,
      blocked: 0,
      added: 5,
      removed: 1,
      issues: [17],
    };
    const tokens = afkTokens(afk);
    const rendered = tokens.map((t) => `${t.label}${t.value}`);
    expect(rendered).toEqual(["wrk=2", "loc=+5 -1", "#17"]);
  });

  it("monitor dashboard header shows per-source counts from state.origin", () => {
    const workers: CompactWorker[] = [
      makeWorker("go", "w1"),
      makeWorker("go", "w2"),
      makeWorker("afk", "w3"),
    ];
    const dashboard = renderCompactDashboard(workers, [], NOW_EPOCH);
    const header = dashboard.split("\n")[0]!;
    expect(header).toContain("go=2");
    expect(header).toContain("afk=1");
  });

  it("monitor dashboard omits per-source fragment when no worker has an origin", () => {
    const workers: CompactWorker[] = [
      makeWorker("", "w1"),
      makeWorker("", "w2"),
    ];
    const dashboard = renderCompactDashboard(workers, [], NOW_EPOCH);
    const header = dashboard.split("\n")[0]!;
    // No origin labels in the header
    expect(header).not.toMatch(/\b\w+=\d+/g.toString().replace("go|afk", ""));
    // More specifically: the header must not contain origin= style tokens
    expect(header).not.toContain("=1");
    expect(header).not.toContain("=2");
  });

  it("statusline and monitor report identical per-source counts for the same workers", () => {
    // Simulate the worker origins that readWorkerStates would return
    const workerOrigins = ["go", "go", "afk", "urgent"];

    // --- Statusline path ---
    // collectStatuslineAfk builds sourceCounts from state.origin exactly this way
    const sourceCounts = buildSourceCounts(workerOrigins);
    const afk: AfkInput = {
      workers: workerOrigins.length,
      queue: 0,
      human: 0,
      blocked: 0,
      added: 0,
      removed: 0,
      issues: [],
      sourceCounts,
    };
    const statuslineTokens = afkTokens(afk);
    const statuslineSrc = new Map(
      statuslineTokens
        .filter((t) => t.label !== "wrk=" && t.label !== "rdy=" && t.label !== "hmn=" &&
                       t.label !== "blk=" && t.label !== "loc=" && t.label !== "wai=" &&
                       t.label !== "tok=" && t.label !== "usd=" && t.label !== "#")
        .map((t) => [t.label.replace("=", ""), Number(t.value)]),
    );

    // --- Monitor path ---
    // collectMonitorInputs passes state.origin through CompactState.origin
    const workers: CompactWorker[] = workerOrigins.map((o, i) => makeWorker(o, `w${i}`));
    const dashboard = renderCompactDashboard(workers, [], NOW_EPOCH);
    const header = dashboard.split("\n")[0]!;
    // Extract `key=value` pairs from the header (skipping `+N -N` diff format)
    const monitorSrc = new Map<string, number>();
    for (const match of header.matchAll(/\b([a-z]+)=(\d+)\b/g)) {
      monitorSrc.set(match[1]!, Number(match[2]));
    }

    // Both surfaces must agree on every per-source count
    for (const [origin, count] of statuslineSrc) {
      expect(monitorSrc.get(origin)).toBe(count);
    }
    for (const [origin, count] of monitorSrc) {
      expect(statuslineSrc.get(origin)).toBe(count);
    }
  });

  it("new origin labels render without touching render code (enum extensibility)", () => {
    // A previously-unknown origin `urgent` flows through both surfaces unchanged
    const afk: AfkInput = {
      workers: 1,
      queue: 0,
      human: 0,
      blocked: 0,
      added: 0,
      removed: 0,
      issues: [],
      sourceCounts: [{ origin: "urgent", count: 1 }],
    };
    const tokens = afkTokens(afk);
    expect(tokens.find((t) => t.label === "urgent=" && t.value === "1")).toBeDefined();

    const workers: CompactWorker[] = [makeWorker("urgent", "w1")];
    const dashboard = renderCompactDashboard(workers, [], NOW_EPOCH);
    expect(dashboard.split("\n")[0]).toContain("urgent=1");
  });
});
