// The floor every placement backend stands on: the daemon samples tree RSS once
// per tick and terminates a Worker over its budget, naming the budget it
// enforced — and never calling that a stall.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import { isRedskilledWorkerView, type RedskilledWorkerView } from "../src/host-state.js";
import {
  evaluateMemoryBudgets,
  evaluateProcessBudgets,
  parseProcStat,
  REDSKILLED_STALL_CLASSIFICATION,
  resolveEnforcedBudget,
  sampleWorkerTrees,
  type RedskilledTreeReading,
} from "../src/memory-sampler.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-floor-");
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

/** One synthetic `/proc/<pid>/stat` row, `utime`/`stime` in clock ticks. */
interface StatRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid?: number;
  readonly sid?: number;
  readonly starttime?: number;
  readonly rssPages: number;
  readonly utime?: number;
  readonly stime?: number;
}

/**
 * One `/proc/<pid>/stat` line, built by field index rather than by counting.
 *
 * The name carries spaces and parentheses on purpose: every fixture then proves
 * the reader walks past `comm` instead of splitting on it.
 */
function procStatLine(row: StatRow): string {
  // Fields after `comm`: index 0 `state`, 1 `ppid`, 2 `pgrp`, 3 `session`,
  // 11 `utime`, 12 `stime`, 19 `starttime`, 21 `rss`.
  const after = Array.from({ length: 22 }, () => "0");
  after[0] = "S";
  after[1] = String(row.ppid);
  after[2] = String(row.pgid ?? row.pid);
  after[3] = String(row.sid ?? row.pid);
  after[11] = String(row.utime ?? 0);
  after[12] = String(row.stime ?? 0);
  after[19] = String(row.starttime ?? 100);
  after[21] = String(row.rssPages);
  return `${row.pid} (my prog (x)) ${after.join(" ")}\n`;
}

/** A synthetic `/proc` the sampler can walk, one directory per row. */
async function procTable(rows: readonly StatRow[]): Promise<string> {
  const procRoot = await scratch("redskilled-proc-");
  const { mkdir, writeFile } = await import("node:fs/promises");
  for (const row of rows) {
    await mkdir(join(procRoot, String(row.pid)), { recursive: true });
    await writeFile(join(procRoot, String(row.pid), "stat"), procStatLine(row), "utf8");
  }
  return procRoot;
}

/** A Worker view with no process behind it — the sampler is injected, not probed. */
function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "w-1",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "/tmp/acme/w-1",
    isolated: true,
    unit: "red-worker-acme-widgets-w-1.service",
    budget: { memory_high: "512M" },
    warnings: [],
    ...overrides,
  };
}

describe("the memory floor", () => {
  it("names TasksMax in the termination for an over-limit unisolated tree", () => {
    const { terminations } = evaluateProcessBudgets({
      workers: [worker({ isolated: false, unit: undefined, budget: { max_processes: 2 } })],
      processes: { "w-1": 3 },
    });

    expect(terminations).toEqual([
      expect.objectContaining({
        version: 1,
        worker_id: "w-1",
        outcome: "terminated-over-process-budget",
        classification: "budget-exceeded",
        stall: false,
        budget_name: "TasksMax",
        budget_declared: 2,
        observed_processes: 3,
      }),
    ]);
    expect(terminations[0]!.reason).toContain("TasksMax");
  });

  it("never terminates a process-budgeted Worker from an absent count", () => {
    const outcome = evaluateProcessBudgets({
      workers: [worker({ isolated: false, unit: undefined, budget: { max_processes: 1 } })],
      processes: {},
    });

    expect(outcome.terminations).toEqual([]);
  });

  it("terminates a Worker over its budget against a synthetic sampler", async () => {
    const paths = await sessionPaths();
    const stopped: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      // Unarmed: this test drives the tick itself, so nothing races it.
      sampleMs: 0,
      stopWorker: (w) => {
        stopped.push(w.worker_id);
        return true;
      },
      treeSampler: () => ({ rss: { "w-1": 900 * 1024 * 1024 }, cpu_seconds: {} }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    const terminations = await daemon.sampleMemoryBudgets();

    expect(terminations).toHaveLength(1);
    expect(terminations[0]!.worker_id).toBe("w-1");
    expect(stopped).toEqual(["w-1"]);
    expect(daemon.workerCount()).toBe(0);
  });

  it("routes an over-limit process tree through worker-budget-kill", async () => {
    const paths = await sessionPaths();
    const stopped: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      stopWorker: (w) => {
        stopped.push(w.worker_id);
        return true;
      },
      treeSampler: () => ({ rss: {}, cpu_seconds: {}, processes: { "w-1": 3 } }),
    });
    running.push(daemon);
    daemon.trackWorker(worker({ isolated: false, unit: undefined, budget: { max_processes: 2 } }));

    const terminations = await daemon.sampleMemoryBudgets();
    await daemon.flushEvents();

    expect(terminations[0]).toMatchObject({ budget_name: "TasksMax", observed_processes: 3 });
    expect(stopped).toEqual(["w-1"]);
    expect(daemon.workerCount()).toBe(0);
    expect((await readRedskilledEvents(paths.eventLanePath)).at(-1)).toMatchObject({
      event: "worker-budget-kill",
      worker_id: "w-1",
    });
  });

  it("names the budget that was exceeded in the terminal outcome", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      stopWorker: () => true,
      treeSampler: () => ({ rss: { "w-1": 3 * 1024 ** 3 }, cpu_seconds: {} }),
    });
    running.push(daemon);
    daemon.trackWorker(worker({ budget: { memory_high: "512M", memory_max: "2G" } }));

    const [termination] = await daemon.sampleMemoryBudgets();

    // MemoryMax is the wall, MemoryHigh only pressure: the floor enforces the wall.
    expect(termination!.budget_name).toBe("MemoryMax");
    expect(termination!.budget_declared).toBe("2G");
    expect(termination!.budget_bytes).toBe(2 * 1024 ** 3);
    expect(termination!.observed_rss_bytes).toBe(3 * 1024 ** 3);
    expect(termination!.reason).toContain("MemoryMax");
    expect(termination!.reason).toContain("2G");
    // The branch or PR is handed forward: the workspace rides on the outcome.
    expect(termination!.workspace_path).toBe("/tmp/acme/w-1");
    expect(termination!.reason).toContain("/tmp/acme/w-1");
  });

  it("records a budget kill as its own event, never as a death", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      stopWorker: () => true,
      treeSampler: () => ({ rss: { "w-1": 900 * 1024 * 1024 }, cpu_seconds: {} }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    await daemon.sampleMemoryBudgets();
    await daemon.flushEvents();

    const events = await readRedskilledEvents(paths.eventLanePath);
    const kills = events.filter((event) => event.event === "worker-budget-kill");
    expect(kills).toHaveLength(1);
    expect(kills[0]!.detail).toContain("MemoryHigh");
    expect(events.some((event) => event.event === "worker-death")).toBe(false);
  });

  it("classifies a budgeted termination as budget-exceeded, never as a stall", () => {
    const { terminations } = evaluateMemoryBudgets({
      workers: [worker()],
      rss: { "w-1": 900 * 1024 * 1024 },
    });

    expect(terminations[0]!.classification).toBe("budget-exceeded");
    expect(terminations[0]!.classification).not.toBe(REDSKILLED_STALL_CLASSIFICATION);
    expect(terminations[0]!.outcome).toBe("terminated-over-memory-budget");
    // A Worker killed for memory and a Worker that hung are different facts.
    expect(terminations[0]!.stall).toBe(false);
  });

  it("never terminates a Worker under its budget", async () => {
    const paths = await sessionPaths();
    let stops = 0;
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      stopWorker: () => {
        stops += 1;
        return true;
      },
      // Exactly at the ceiling, and comfortably under it: neither is over.
      treeSampler: () => ({ rss: { "w-1": 512 * 1024 * 1024, "w-2": 1024 }, cpu_seconds: {} }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());
    daemon.trackWorker(worker({ worker_id: "w-2", pid: 4243 }));

    expect(await daemon.sampleMemoryBudgets()).toEqual([]);
    expect(stops).toBe(0);
    expect(daemon.workerCount()).toBe(2);
  });

  it("costs one sample per tick, whatever the Worker count", async () => {
    const paths = await sessionPaths();
    let samples = 0;
    const sampledSets: number[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      stopWorker: () => true,
      treeSampler: (workers) => {
        samples += 1;
        sampledSets.push(workers.length);
        return { rss: {}, cpu_seconds: {} };
      },
    });
    running.push(daemon);
    for (let i = 0; i < 5; i++) daemon.trackWorker(worker({ worker_id: `w-${i}`, pid: 5000 + i }));

    await daemon.sampleMemoryBudgets();
    await daemon.sampleMemoryBudgets();

    expect(samples).toBe(2);
    // One call per tick, handed the whole set — never one call per Worker.
    expect(sampledSets).toEqual([5, 5]);
  });

  it("leaves an unmeasured or unaccountable Worker running, and says why", () => {
    const outcome = evaluateMemoryBudgets({
      workers: [
        worker({ worker_id: "unmeasured" }),
        worker({ worker_id: "opaque", budget: { memory_high: "infinity" } }),
        worker({ worker_id: "budgetless", budget: undefined }),
      ],
      rss: { opaque: 1024 ** 4, budgetless: 1024 ** 4 },
    });

    expect(outcome.terminations).toEqual([]);
    expect(outcome.unenforceable.map((entry) => entry.worker_id).sort())
      .toEqual(["budgetless", "opaque", "unmeasured"]);
    expect(outcome.unenforceable.find((e) => e.worker_id === "unmeasured")!.reason).toContain("no RSS reading");
  });

  it("resolves the enforced budget: MemoryMax over MemoryHigh, and null when opaque", () => {
    expect(resolveEnforcedBudget(worker({ budget: { memory_high: "512M" } }))).toEqual({
      name: "MemoryHigh",
      declared: "512M",
      bytes: 512 * 1024 * 1024,
    });
    expect(resolveEnforcedBudget(worker({ budget: { memory_max: "1G", memory_high: "512M" } }))!.name)
      .toBe("MemoryMax");
    expect(resolveEnforcedBudget(worker({ budget: { memory_max: "50%" } }))).toBeNull();
    expect(resolveEnforcedBudget(worker({ budget: undefined }))).toBeNull();
  });

  it("reads a whole process tree out of one /proc snapshot", async () => {
    // parent 100 → child 101 → grandchild 102, plus an unrelated 200.
    const procRoot = await procTable([
      { pid: 100, ppid: 1, rssPages: 10 },
      { pid: 101, ppid: 100, rssPages: 20 },
      { pid: 102, ppid: 101, rssPages: 30 },
      { pid: 200, ppid: 1, rssPages: 999 },
    ]);

    const reading = sampleWorkerTrees([worker({ worker_id: "tree", pid: 100 })], { procRoot, platform: "linux" });

    expect(reading.rss.tree).toBe((10 + 20 + 30) * 4096);
    expect(reading.processes.tree).toBe(3);
  });

  it("reads a process name containing spaces and parentheses without shifting fields", () => {
    expect(parseProcStat(procStatLine({
      pid: 77,
      ppid: 5,
      pgid: 70,
      sid: 60,
      starttime: 12_345,
      rssPages: 12,
      utime: 300,
      stime: 100,
    }))).toEqual({
      pid: 77,
      ppid: 5,
      pgid: 70,
      sid: 60,
      starttime: "12345",
      rssPages: 12,
      cpuTicks: 400,
    });
  });

  it("measures a host with no /proc from its own process table instead of giving up", () => {
    // macOS is the platform where this floor IS the memory ceiling, so an empty
    // reading there would leave the only backend without kernel teeth unmeasured.
    const reading = sampleWorkerTrees([worker({ worker_id: "tree", pid: 100 })], {
      platform: "darwin",
      psTable: () => " 100 1 4096 0:04.00\n 200 100 2048 0:06.00\n",
    });

    expect(reading.rss.tree).toBe((4096 + 2048) * 1024);
    expect(reading.cpu_seconds.tree).toBe(10);
  });

  it("measures nothing when no process table can be read at all, rather than reporting zero", () => {
    const empty = { rss: {}, cpu_seconds: {}, sources: {} };
    expect(sampleWorkerTrees([worker()], { platform: "aix" })).toEqual(empty);
    expect(sampleWorkerTrees([worker()], { platform: "darwin", psTable: () => "" })).toEqual(empty);
  });
});

describe("the CPU reading — what RSS alone cannot tell apart", () => {
  it("separates a working Worker from a hung one at the same RSS", async () => {
    // Same memory, different work: the busy tree burned 90s of CPU across its
    // children, the wedged one has burned 0.30s since it was born.
    const procRoot = await procTable([
      { pid: 100, ppid: 1, rssPages: 500, utime: 4000, stime: 1000 },
      { pid: 101, ppid: 100, rssPages: 500, utime: 3000, stime: 1000 },
      { pid: 200, ppid: 1, rssPages: 500, utime: 20, stime: 10 },
      { pid: 201, ppid: 200, rssPages: 500, utime: 0, stime: 0 },
    ]);

    const reading = sampleWorkerTrees(
      [worker({ worker_id: "busy", pid: 100 }), worker({ worker_id: "hung", pid: 200 })],
      { procRoot, platform: "linux" },
    );

    // Equivalent RSS: the memory reading cannot distinguish them at all.
    expect(reading.rss.busy).toBe(reading.rss.hung);
    // Divergent CPU: the reading does, and by a factor no rounding explains.
    expect(reading.cpu_seconds.busy).toBe(90);
    expect(reading.cpu_seconds.hung).toBe(0.3);
  });

  it("sums CPU over the whole tree, never the Worker's own process alone", async () => {
    const procRoot = await procTable([
      { pid: 100, ppid: 1, rssPages: 1, utime: 100, stime: 0 },
      { pid: 101, ppid: 100, rssPages: 1, utime: 200, stime: 100 },
      { pid: 102, ppid: 101, rssPages: 1, utime: 0, stime: 600 },
      // A stranger the Worker never parented: its CPU is not the Worker's.
      { pid: 300, ppid: 1, rssPages: 1, utime: 999_999, stime: 0 },
    ]);

    const reading = sampleWorkerTrees([worker({ worker_id: "tree", pid: 100 })], { procRoot, platform: "linux" });

    expect(reading.cpu_seconds.tree).toBe(10);
  });

  it("costs ONE process-table read per tick, whatever the Worker count", () => {
    let tableReads = 0;
    const psTable = () => {
      tableReads += 1;
      return [
        " 100 1 1024 0:01.00",
        " 200 1 1024 0:02.00",
        " 300 1 1024 0:03.00",
        " 400 1 1024 0:04.00",
      ].join("\n");
    };
    const four = [100, 200, 300, 400].map((pid) => worker({ worker_id: `w-${pid}`, pid }));

    const one = sampleWorkerTrees(four.slice(0, 1), { platform: "darwin", psTable });
    const all = sampleWorkerTrees(four, { platform: "darwin", psTable });

    // Four Workers cost exactly what one Worker cost: one read each, not four.
    expect(tableReads).toBe(2);
    expect(Object.keys(one.cpu_seconds)).toHaveLength(1);
    expect(Object.keys(all.cpu_seconds)).toHaveLength(4);
    expect(all.cpu_seconds["w-400"]).toBe(4);
  });

  it("carries the sampled CPU on the Worker, dated by the tick that took it", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      clock: () => "2026-07-30T12:00:00.000Z",
      stopWorker: () => true,
      treeSampler: () => ({ rss: { "w-1": 1024, "w-2": 1024 }, cpu_seconds: { "w-1": 612.5, "w-2": 0.2 } }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());
    daemon.trackWorker(worker({ worker_id: "w-2", pid: 4243 }));

    await daemon.sampleMemoryBudgets();
    const workers = daemon.hostState().workers;

    // Same RSS, different CPU — the host state says which is which, and when.
    expect(workers.map((w) => w.cpu?.cpu_seconds)).toEqual([612.5, 0.2]);
    expect(workers[0]!.cpu?.sampled_at).toBe("2026-07-30T12:00:00.000Z");
    // A measurement the daemon took, never a verdict about the project's task.
    expect(workers.every((w) => isRedskilledWorkerView(w))).toBe(true);
  });

  it("leaves a Worker this tick could not measure holding its last reading", async () => {
    const paths = await sessionPaths();
    const readings: RedskilledTreeReading[] = [
      { rss: { "w-1": 1024 }, cpu_seconds: { "w-1": 4 } },
      { rss: {}, cpu_seconds: {} },
    ];
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      stopWorker: () => true,
      treeSampler: () => readings.shift() ?? { rss: {}, cpu_seconds: {} },
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    await daemon.sampleMemoryBudgets();
    const first = daemon.hostState().workers[0]!.cpu;
    await daemon.sampleMemoryBudgets();
    const second = daemon.hostState().workers[0]!.cpu;

    // The unmeasured tick neither erases the number nor re-dates it: an erased
    // reading loses the last thing known about a Worker exactly as it goes quiet.
    expect(second).toEqual(first);
    expect(second!.cpu_seconds).toBe(4);
  });
});
