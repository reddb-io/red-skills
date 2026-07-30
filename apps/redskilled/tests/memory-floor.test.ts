// The floor every placement backend stands on: the daemon samples tree RSS once
// per tick and terminates a Worker over its budget, naming the budget it
// enforced — and never calling that a stall.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import {
  evaluateMemoryBudgets,
  parseProcStat,
  REDSKILLED_STALL_CLASSIFICATION,
  resolveEnforcedBudget,
  sampleTreeRss,
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
      memorySampler: () => ({ "w-1": 900 * 1024 * 1024 }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    const terminations = await daemon.sampleMemoryBudgets();

    expect(terminations).toHaveLength(1);
    expect(terminations[0]!.worker_id).toBe("w-1");
    expect(stopped).toEqual(["w-1"]);
    expect(daemon.workerCount()).toBe(0);
  });

  it("names the budget that was exceeded in the terminal outcome", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      stopWorker: () => true,
      memorySampler: () => ({ "w-1": 3 * 1024 ** 3 }),
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
      memorySampler: () => ({ "w-1": 900 * 1024 * 1024 }),
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
      memorySampler: () => ({ "w-1": 512 * 1024 * 1024, "w-2": 1024 }),
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
      memorySampler: (workers) => {
        samples += 1;
        sampledSets.push(workers.length);
        return {};
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
    const procRoot = await scratch("redskilled-proc-");
    // parent 100 → child 101 → grandchild 102, plus an unrelated 200.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const rows: Array<[number, number, number]> = [[100, 1, 10], [101, 100, 20], [102, 101, 30], [200, 1, 999]];
    for (const [pid, ppid, rssPages] of rows) {
      await mkdir(join(procRoot, String(pid)), { recursive: true });
      const trailing = Array.from({ length: 19 }, () => "0").join(" ");
      await writeFile(
        join(procRoot, String(pid), "stat"),
        `${pid} (node (worker)) S ${ppid} ${trailing} ${rssPages} 0\n`,
        "utf8",
      );
    }

    const reading = sampleTreeRss([worker({ worker_id: "tree", pid: 100 })], { procRoot, platform: "linux" });

    expect(reading.tree).toBe((10 + 20 + 30) * 4096);
  });

  it("reads a process name containing spaces and parentheses without shifting fields", () => {
    const trailing = Array.from({ length: 19 }, () => "0").join(" ");
    expect(parseProcStat(`77 (my prog (x)) S 5 ${trailing} 12 0\n`)).toEqual({ pid: 77, ppid: 5, rssPages: 12 });
  });

  it("measures a host with no /proc from its own process table instead of giving up", () => {
    // macOS is the platform where this floor IS the memory ceiling, so an empty
    // reading there would leave the only backend without kernel teeth unmeasured.
    const reading = sampleTreeRss([worker({ worker_id: "tree", pid: 100 })], {
      platform: "darwin",
      psTable: () => " 100 1 4096\n 200 100 2048\n",
    });

    expect(reading.tree).toBe((4096 + 2048) * 1024);
  });

  it("measures nothing when no process table can be read at all, rather than reporting zero", () => {
    expect(sampleTreeRss([worker()], { platform: "aix" })).toEqual({});
    expect(sampleTreeRss([worker()], { platform: "darwin", psTable: () => "" })).toEqual({});
  });
});
