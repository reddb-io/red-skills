import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-budget-grace-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function worker(): RedskilledWorkerView {
  return {
    worker_id: "wGRACE",
    project_label: "acme/widgets",
    pid: 4242,
    pgid: 4242,
    started_at: "2026-08-13T20:00:00.000Z",
    workspace_path: "/tmp/acme/wGRACE",
    isolated: false,
    budget: { memory_max: "1G" },
    warnings: [],
  };
}

describe("daemon Budget grace", () => {
  it("does not kill a Worker that checkpoints and exits inside the window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signals: string[] = [];
    const kills: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      sampleMs: 0,
      budgetGraceMs: 1_000,
      signalWorkerForBudgetGrace: (held) => { signals.push(held.worker_id); return true; },
      stopWorker: (held) => { kills.push(held.worker_id); return true; },
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    expect(await daemon.killWorkerOverBudget("wGRACE", "MemoryMax budget exceeded")).toBe(true);
    expect(signals).toEqual(["wGRACE"]);
    expect(daemon.workerCount()).toBe(1);

    daemon.releaseWorker("wGRACE");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(kills).toEqual([]);
    expect(daemon.workerCount()).toBe(0);
  });

  it("kills an overrunning checkpoint exactly at the machine-policy deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kills: string[] = [];
    let checkpointStarted = false;
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      sampleMs: 0,
      budgetGraceMs: 1_000,
      signalWorkerForBudgetGrace: () => { checkpointStarted = true; return true; },
      stopWorker: (held) => { kills.push(held.worker_id); return true; },
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    await daemon.killWorkerOverBudget("wGRACE", "MemoryMax budget exceeded");
    await vi.advanceTimersByTimeAsync(999);
    expect(checkpointStarted).toBe(true);
    expect(kills).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(kills).toEqual(["wGRACE"]);
    expect(daemon.workerCount()).toBe(0);
  });

  it("kills at the deadline even when the Worker ignores the signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kills: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      sampleMs: 0,
      budgetGraceMs: 1_000,
      signalWorkerForBudgetGrace: () => false,
      stopWorker: (held) => { kills.push(held.worker_id); return true; },
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    await daemon.killWorkerOverBudget("wGRACE", "MemoryMax budget exceeded");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(kills).toEqual(["wGRACE"]);
    expect(daemon.workerCount()).toBe(0);
  });

  it("records verdict, grace start, and kill as distinct events for one Worker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      budgetGraceMs: 1_000,
      signalWorkerForBudgetGrace: () => true,
      stopWorker: () => true,
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    await daemon.killWorkerOverBudget("wGRACE", "MemoryMax budget exceeded");
    await vi.advanceTimersByTimeAsync(1_000);
    await daemon.flushEvents();

    expect(
      (await readRedskilledEvents(paths.eventLanePath))
        .filter((event) => event.worker_id === "wGRACE" && event.kind.startsWith("worker-budget-"))
        .map((event) => event.kind),
    ).toEqual(["worker-budget-verdict", "worker-budget-grace", "worker-budget-kill"]);
  });
});
