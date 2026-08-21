// A restart costs nothing: the Workers keep running, the daemon finds them
// again by unit name, and the budget it reports afterwards is the budget it
// reported before. The lane is the only thing that carries that across the gap.
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBudgetAccounting, parseMemoryBudget } from "../src/budget-accounting.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import {
  createRedskilledEventLane,
  parseEventLane,
  readRedskilledEvents,
  rehydrateWorkers,
  type RedskilledHostEvent,
} from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import type { RedskilledWorkerSpec } from "../src/worker-launch.js";
import { REDSKILLED_WORKER_DISPLAY_ABSENT } from "../src/worker-display.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];
const spawnedPids: number[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-restart-");
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

/** A Worker that outlives the daemon that birthed it — the whole point of the slice. */
function longLivedSpec(workspacePath: string, overrides: Partial<RedskilledWorkerSpec> = {}): RedskilledWorkerSpec {
  return {
    project_label: "acme/widgets",
    workspace_path: workspacePath,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 30000);"],
    budget: { memory_high: "512M", memory_max: "1G", cpu_weight: 100 },
    ...overrides,
  };
}

/** Liveness by pid: the host under test may have no systemd --user session. */
function pidLiveness(worker: RedskilledWorkerView): boolean {
  try {
    process.kill(worker.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function workerView(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "w-fixture",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "/tmp/workspace",
    isolated: true,
    unit: "red-worker-acme-widgets-w-fixture.service",
    budget: { memory_high: "512M" },
    warnings: [],
    ...overrides,
  };
}

describe("a daemon restart re-attaches to its live Workers", () => {
  it("leaves them running and reports them with their original project labels", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const first = await startRedskilledDaemon({ paths, liveness: pidLiveness });
    running.push(first);

    const started = first.startWorker(longLivedSpec(workspace));
    spawnedPids.push(started.worker.pid);
    await first.flushEvents();
    await first.stop();

    // The Worker outlived the daemon: that is what makes re-attachment a thing
    // to do rather than a thing to mourn.
    expect(pidLiveness(started.worker)).toBe(true);

    const second = await startRedskilledDaemon({ paths, liveness: pidLiveness });
    running.push(second);

    const state = second.hostState();
    expect(state.workers.map((worker) => worker.worker_id)).toEqual([started.worker.worker_id]);
    expect(state.workers[0]!.project_label).toBe("acme/widgets");
    expect(state.workers[0]!.workspace_path).toBe(workspace);
    expect(state.projects).toEqual([{ project_label: "acme/widgets", worker_count: 1 }]);
    expect(second.reattached().map((worker) => worker.worker_id)).toEqual([started.worker.worker_id]);
  });

  it("re-attaches by unit name, never by pid, whenever the Worker has a unit", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    const unitWorker = workerView({ worker_id: "w-unit", pid: 1 });
    await lane.record({ event: "worker-birth", worker: unitWorker, ts: "2026-07-29T00:00:00.000Z" });

    // The probe answers on the unit and refuses the pid; a daemon that fell back
    // to the pid would adopt whatever process now wears the number 1.
    const asked: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      liveness: (worker) => {
        asked.push(worker.unit ?? `pid:${worker.pid}`);
        return worker.unit === unitWorker.unit;
      },
    });
    running.push(daemon);

    expect(asked).toEqual([unitWorker.unit]);
    expect(daemon.workerCount()).toBe(1);
    expect(daemon.hostState().workers[0]!.unit).toBe(unitWorker.unit);
  });

  it("records the death of a Worker that ended while no daemon was watching", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-gone" }), ts: "2026-07-29T00:00:00.000Z" });

    const daemon = await startRedskilledDaemon({ paths, liveness: () => false });
    running.push(daemon);
    await daemon.flushEvents();

    expect(daemon.workerCount()).toBe(0);
    const events = await readRedskilledEvents(paths.eventLanePath);
    // Nothing witnessed the end, so the death carries a postmortem too (#4176).
    expect(events.map((event) => event.event)).toEqual(["worker-birth", "worker-death", "worker-postmortem"]);
    expect(events[1]!.worker_id).toBe("w-gone");
    expect(events[1]!.detail).toMatch(/no daemon was watching/);
    expect(events[2]).toMatchObject({ worker_id: "w-gone", failure_mode: "host-vanished" });
  });
});

describe("budget accounting survives the restart", () => {
  it("reports the same totals after the restart as before it", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const first = await startRedskilledDaemon({ paths, liveness: pidLiveness });
    running.push(first);

    const started = first.startWorker(longLivedSpec(workspace));
    spawnedPids.push(started.worker.pid);
    await first.flushEvents();
    const before = first.hostState().budget_accounting;
    await first.stop();

    const second = await startRedskilledDaemon({ paths, liveness: pidLiveness });
    running.push(second);

    expect(second.hostState().budget_accounting).toEqual(before);
    expect(before.worker_count).toBe(1);
    expect(before.memory_high_bytes).toBe(512 * 1024 * 1024);
    expect(before.memory_max_bytes).toBe(1024 * 1024 * 1024);
    expect(before.cpu_weight_total).toBe(100);
  });

  it("names a budget it cannot reduce to bytes instead of counting it as nothing", () => {
    const accounting = buildBudgetAccounting([
      workerView({ worker_id: "w-bytes", budget: { memory_high: "512M" } }),
      workerView({ worker_id: "w-percent", budget: { memory_high: "40%" } }),
      workerView({ worker_id: "w-loose", isolated: false, budget: undefined }),
    ]);

    expect(accounting.memory_high_bytes).toBe(512 * 1024 * 1024);
    expect(accounting.unaccounted_workers).toEqual(["w-percent"]);
    expect(accounting.unisolated_workers).toEqual(["w-loose"]);
    expect(parseMemoryBudget("1.5G")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseMemoryBudget("2048")).toBe(2048);
    expect(parseMemoryBudget("infinity")).toBeNull();
  });
});

describe("the host event lane", () => {
  it("records the full Budget grace sequence between birth and kill", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      liveness: pidLiveness,
      budgetGraceMs: 0,
      signalWorkerForBudgetGrace: () => true,
      stopWorker: () => true,
    });
    running.push(daemon);

    const born = daemon.startWorker(longLivedSpec(workspace));
    spawnedPids.push(born.worker.pid);
    const killed = daemon.startWorker(longLivedSpec(workspace, { project_label: "acme/gadgets" }));
    spawnedPids.push(killed.worker.pid);

    await daemon.killWorkerOverBudget(killed.worker.worker_id, "host memory high-water mark exceeded");
    await daemon.flushEvents();

    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.event)).toEqual([
      "worker-birth",
      "worker-birth",
      "worker-budget-verdict",
      "worker-budget-grace",
      "worker-budget-kill",
    ]);
    const kill = events[4]!;
    expect(kill.worker_id).toBe(killed.worker.worker_id);
    expect(kill.project_label).toBe("acme/gadgets");
    expect(kill.detail).toBe("host memory high-water mark exceeded");
    expect(daemon.hostState().budget_accounting.worker_count).toBe(1);
  });

  it("records admitted births, metrics, activity transitions and mechanical heals as typed facts", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      liveness: pidLiveness,
      stopWorker: () => true,
    });
    running.push(daemon);

    const born = daemon.startWorker(longLivedSpec(workspace));
    spawnedPids.push(born.worker.pid);
    daemon.publishWorkerHeartbeat({
      worker_id: born.worker.worker_id,
      last_log_line: "implementing",
      display: { ...REDSKILLED_WORKER_DISPLAY_ABSENT, phase: "coding", step: "implementing" },
      mechanical_heal: {
        heal_kind: "mechanical-regeneration",
        cause: "stale-base-drift",
        cycle: 1,
        cap: 2,
        free: true,
      },
    });
    await daemon.flushEvents();

    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.kind)).toEqual([
      "worker-birth",
      "worker-metrics",
      "worker-activity",
      "worker-heal",
    ]);
    expect(events[0]).toMatchObject({ admission_verdict: "admitted" });
    expect(events[1]).toMatchObject({ tokens: null, tools: null });
    expect(events[2]).toMatchObject({ phase: "coding", step: "implementing" });
    expect(events[3]).toMatchObject({ heal_kind: "mechanical-regeneration" });
  });

  it("only ever appends: earlier bytes are never rewritten", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);

    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-1" }), ts: "2026-07-29T00:00:00.000Z" });
    const afterFirst = await readFile(paths.eventLanePath, "utf8");
    await lane.record({ event: "worker-death", worker: workerView({ worker_id: "w-1" }), ts: "2026-07-29T00:00:01.000Z", detail: "exit code=0" });
    const afterSecond = await readFile(paths.eventLanePath, "utf8");

    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
  });

  it("is written with the TOON encoder as TOONL, not as JSON", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-toon" }), ts: "2026-07-29T00:00:00.000Z" });

    const text = await readFile(paths.eventLanePath, "utf8");
    const [header, row] = text.split("\n");

    // A TOONL segment header declares the schema once; the row is positional.
    expect(header).toMatch(/^\[\]\{[a-z_,]+\}:$/);
    expect(header).toContain("worker_id");
    expect(row?.startsWith("{")).toBe(false);
    expect(parseRecords(text)[0]).toMatchObject({ event: "worker-birth", worker_id: "w-toon" });
  });

  it("stays readable after a writer crashed mid-append", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-1" }), ts: "2026-07-29T00:00:00.000Z" });
    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-2", pid: 4243 }), ts: "2026-07-29T00:00:01.000Z" });

    // Cut the last row in half — a writer that died between the bytes and the
    // newline. The complete events before it must survive intact.
    const whole = await readFile(paths.eventLanePath, "utf8");
    await truncate(paths.eventLanePath, whole.lastIndexOf("\n") - 5);

    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.worker_id)).toEqual(["w-1"]);

    // And the lane is still writable: the next append lands after the ruins.
    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-3", pid: 4244 }), ts: "2026-07-29T00:00:02.000Z" });
    const recovered = await readRedskilledEvents(paths.eventLanePath);
    expect(recovered.map((event) => event.worker_id)).toEqual(["w-1", "w-3"]);
  });

  it("rehydrates the daemon from a lane whose tail a crash truncated", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-live" }), ts: "2026-07-29T00:00:00.000Z" });
    await lane.record({ event: "worker-death", worker: workerView({ worker_id: "w-live" }), ts: "2026-07-29T00:00:01.000Z" });
    const whole = await readFile(paths.eventLanePath, "utf8");
    // The death was the record still in flight, so the Worker is believed alive.
    await truncate(paths.eventLanePath, whole.lastIndexOf("\n") - 3);

    const daemon = await startRedskilledDaemon({ paths, liveness: () => true });
    running.push(daemon);

    expect(daemon.hostState().workers.map((worker) => worker.worker_id)).toEqual(["w-live"]);
  });

  it("keeps a half-written trailing line out, and names a malformed middle line rather than dying on it", async () => {
    // Only an unterminated FINAL line is a crash. A broken line in the MIDDLE is
    // a format bug — and #3651 is what treating it as fatal actually costs: one
    // mixed-arity row a previous daemon generation had written took every
    // `worker_dispatch` on the machine down, reported as "the daemon did not
    // answer", pointing the operator at `provision` — the wrong repair for a
    // healthy daemon. An append-only lane spanning generations WILL hold rows an
    // older reader wrote differently, so a malformed row is skipped and COUNTED
    // out loud. Skipping silently is what the warning exists to refuse.
    const lane = createRedskilledEventLane(join(await scratch("redskilled-lane-"), "lane.toonl"));
    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-1" }), ts: "2026-07-29T00:00:00.000Z" });
    const whole = await readFile(lane.path, "utf8");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(parseEventLane(`${whole}birth,w-2,`)).toHaveLength(1);
      expect(warned).not.toHaveBeenCalled();

      // The good row before the ruins still comes back, and the ruins are named.
      const survivors = parseEventLane(`${whole}birth,w-2,\nfine\n`);
      expect(survivors.map((event) => event.worker_id)).toEqual(["w-1"]);
      expect(warned.mock.calls.flat().join(" ")).toMatch(/malformed/);

      expect(parseEventLane("")).toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });

  it("replays into the Workers still alive, last event per Worker winning", () => {
    const events: RedskilledHostEvent[] = [
      laneEvent("worker-birth", "w-1"),
      laneEvent("worker-birth", "w-2"),
      laneEvent("worker-death", "w-1"),
      laneEvent("worker-birth", "w-3"),
      laneEvent("worker-budget-kill", "w-3"),
      laneEvent("worker-birth", "w-1"),
    ];

    expect(rehydrateWorkers(events).map((worker) => worker.worker_id)).toEqual(["w-2", "w-1"]);
  });
});

describe("a sweep retires a re-attached Worker the host stopped confirming", () => {
  it("forgets it and records its death", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({ event: "worker-birth", worker: workerView({ worker_id: "w-fading" }), ts: "2026-07-29T00:00:00.000Z" });

    let alive = true;
    const daemon = await startRedskilledDaemon({ paths, liveness: () => alive });
    running.push(daemon);
    expect(daemon.workerCount()).toBe(1);

    alive = false;
    const retired = await daemon.sweepWorkerLiveness();
    await daemon.flushEvents();

    expect(retired.map((worker) => worker.worker_id)).toEqual(["w-fading"]);
    expect(daemon.workerCount()).toBe(0);
    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.event)).toContain("worker-death");
    // A Worker the host stopped confirming died silently (#4176).
    expect(events.at(-1)!.event).toBe("worker-postmortem");
    expect(events.at(-1)!.detail).toContain("failure-mode=");
  });
});

describe("a lane written by an older bundle", () => {
  it("is read through, and appended to, without a rewrite", async () => {
    const root = await scratch("redskilled-legacy-");
    const path = join(root, "lane.toonl");
    // A whole segment written by a previous process, header and all.
    await writeFile(
      path,
      "[]{version,ts,event,worker_id,project_label,pid,workspace_path,isolated,unit,memory_high,memory_max,cpu_weight,detail}:\n" +
        "1,2026-07-29T00:00:00.000Z,worker-birth,w-old,acme/widgets,4242,/tmp/ws,true,red-worker-old.service,512M,,,\n",
      "utf8",
    );
    await appendFile(path, "", "utf8");

    const events = await readRedskilledEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0]!.worker_id).toBe("w-old");
    expect(events[0]!.memory_high).toBe("512M");
    expect(events[0]!.cpu_weight).toBeNull();

    const lane = createRedskilledEventLane(path);
    await lane.record({ event: "worker-death", worker: workerView({ worker_id: "w-old" }), ts: "2026-07-29T00:00:01.000Z" });
    expect((await readRedskilledEvents(path)).map((event) => event.event)).toEqual(["worker-birth", "worker-death"]);
    expect(rehydrateWorkers(await readRedskilledEvents(path))).toEqual([]);
  });
});

function laneEvent(event: RedskilledHostEvent["event"], workerId: string): RedskilledHostEvent {
  return {
    version: 1,
    ts: "2026-07-29T00:00:00.000Z",
    kind: event,
    event,
    worker_id: workerId,
    project_label: "acme/widgets",
    pid: 4242,
    workspace_path: "/tmp/ws",
    log_path: null,
    isolated: true,
    unit: `red-worker-${workerId}.service`,
    memory_high: "512M",
    memory_max: null,
    cpu_weight: null,
    admission_verdict: null,
    phase: null,
    step: null,
    base_head_sha: null,
    base_commits_ahead: null,
    heal_kind: null,
    detail: null,
    exit_code: null,
    signal: null,
    systemd_result: null,
    memory_peak_bytes: null,
    memory_swap_peak_bytes: null,
    pids_peak: null,
    journal_tail: null,
    sender_class: null,
    confidence: null,
    reason: null,
  };
}
