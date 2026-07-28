import { describe, expect, it, vi } from "vitest";
import {
  CONSERVATIVE_BUSY_SNAPSHOT,
  collectTree,
  inspectProcessTree,
  inspectProcessTreeNative,
  parsePsRssTree,
  parsePsTree,
  sampleTreeRssMb,
} from "../src/runtime/proc-tree.js";
import { deriveSnapshot } from "../src/core/reaper-signal.js";

// A `ps -e -o pid=,ppid=,%cpu=,comm=` style dump:
//   1000 is the worker orchestrator; 1001 a pnpm-spawned node; 1002 vitest
//   under 1001; 2000 is an unrelated process tree the walk must NOT pull in.
const SAMPLE_PS = [
  "    1 0 0.0 systemd",
  " 1000 1 1.2 node",
  " 1001 1000 3.4 node",
  " 1002 1001 88.5 vitest",
  " 2000 1 50.0 firefox",
].join("\n");

describe("parsePsTree", () => {
  it("parses pid/ppid/cpu/comm and builds the child map + info", () => {
    const { children, info } = parsePsTree(SAMPLE_PS);
    expect(info.get(1000)).toEqual({ command: "node", cpu: 1.2 });
    expect(info.get(1002)).toEqual({ command: "vitest", cpu: 88.5 });
    expect(children.get(1000)).toEqual([1001]);
    expect(children.get(1001)).toEqual([1002]);
  });

  it("takes the comm basename and skips malformed lines", () => {
    const { info } = parsePsTree(
      ["", "  garbage", " 50 1 0.0 /usr/bin/tsc --watch", " x y z foo"].join("\n"),
    );
    expect(info.get(50)).toEqual({ command: "tsc", cpu: 0 });
    expect(info.size).toBe(1);
  });
});

describe("collectTree", () => {
  it("collects the pid + every transitive descendant, not siblings", () => {
    const { children, info } = parsePsTree(SAMPLE_PS);
    const tree = collectTree(1000, children, info);
    const commands = tree.map((e) => e.command).sort();
    expect(commands).toEqual(["node", "node", "vitest"]);
    // The unrelated firefox tree is excluded.
    expect(tree.some((e) => e.command === "firefox")).toBe(false);
    // The reaper reduction sees the active vitest descendant.
    const snap = deriveSnapshot(tree);
    expect(snap.activeDescendant).toBe(true);
  });

  it("a pid absent from the snapshot yields an empty tree", () => {
    const { children, info } = parsePsTree(SAMPLE_PS);
    expect(collectTree(99999, children, info)).toEqual([]);
  });
});

describe("inspectProcessTree — degrade / timeout paths", () => {
  it("an un-inspectable pid (<=1) returns [] without calling the runner", () => {
    const neverCalled = (): string => { throw new Error("must not be called"); };
    expect(inspectProcessTree(0, neverCalled)).toEqual([]);
    expect(inspectProcessTree(1, neverCalled)).toEqual([]);
    expect(inspectProcessTree(Number.NaN, neverCalled)).toEqual([]);
  });

  it("returns CONSERVATIVE_BUSY_SNAPSHOT when the runner throws (simulated ETIMEDOUT)", () => {
    const timeout = (): string => {
      throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });
    };
    expect(inspectProcessTree(process.pid, timeout)).toBe(CONSERVATIVE_BUSY_SNAPSHOT);
  });

  it("a runner timeout reads as busy — reaper must not kill (deriveSnapshot)", () => {
    const timeout = (): string => {
      throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });
    };
    const snap = deriveSnapshot(inspectProcessTree(process.pid, timeout));
    expect(snap.cpuPct).toBeGreaterThanOrEqual(5);
  });

  it("returns CONSERVATIVE_BUSY_SNAPSHOT when the runner throws (ENOENT — ps missing)", () => {
    const noent = (): string => {
      throw Object.assign(new Error("spawnSync ps ENOENT"), { code: "ENOENT" });
    };
    expect(inspectProcessTree(process.pid, noent)).toBe(CONSERVATIVE_BUSY_SNAPSHOT);
  });

  it("the conservative busy snapshot constant reads as busy (deriveSnapshot)", () => {
    // Guards the constant value independent of any code path.
    const snap = deriveSnapshot(CONSERVATIVE_BUSY_SNAPSHOT);
    expect(snap.cpuPct).toBeGreaterThanOrEqual(5);
  });
});

describe("inspectProcessTreeNative", () => {
  it("an un-inspectable pid (<=1) returns [] without running ps", () => {
    expect(inspectProcessTreeNative(0)).toEqual([]);
    expect(inspectProcessTreeNative(1)).toEqual([]);
    expect(inspectProcessTreeNative(Number.NaN)).toEqual([]);
  });

  it("a real self-inspection returns this process in its own tree", () => {
    // process.pid is inspectable; ps should list at least this node process.
    const tree = inspectProcessTreeNative(process.pid);
    // Either a real tree (length >= 1) or — on an exotic host where ps failed —
    // the conservative busy fallback. Both are non-empty and SAFE.
    expect(tree.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- per-attempt memory accounting (ADR 0128 §8, #2707) ----------

describe("sampleTreeRssMb", () => {
  //  1 ─ 100 (worker) ─ 200 (runner) ─ 300 (vitest fork)
  //    └ 101 (an unrelated process, never charged to the worker)
  const TABLE = [
    "  100     1  102400",
    "  200   100  512000",
    "  300   200  409600",
    "  101     1  999999",
  ].join("\n");

  it("charges a pid its whole tree, in MB, from ONE read", () => {
    const run = vi.fn(() => TABLE);
    expect(sampleTreeRssMb([100], run)).toEqual(new Map([[100, 1000]]));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("one read serves the whole fleet — cost does not scale with width", () => {
    const run = vi.fn(() => TABLE);
    const sample = sampleTreeRssMb([100, 101], run);
    expect(sample.get(100)).toBe(1000);
    expect(sample.get(101)).toBe(977);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a pid the table never listed is ABSENT, never a measured 0", () => {
    const sample = sampleTreeRssMb([100, 4242], () => TABLE);
    expect(sample.has(4242)).toBe(false);
  });

  it("a failed read measures nothing, so it can never terminate an in-budget attempt", () => {
    const boom = (): string => {
      throw Object.assign(new Error("spawnSync ps ENOENT"), { code: "ENOENT" });
    };
    expect(sampleTreeRssMb([100], boom).size).toBe(0);
  });

  it("un-inspectable pids are refused without running ps", () => {
    const run = vi.fn(() => TABLE);
    expect(sampleTreeRssMb([0, 1, Number.NaN], run).size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("parsePsRssTree skips malformed lines", () => {
    const { rssKb } = parsePsRssTree("garbage\n  7  1  2048\n\n");
    expect(rssKb).toEqual(new Map([[7, 2048]]));
  });
});
