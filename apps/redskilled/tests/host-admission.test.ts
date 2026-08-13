// Host-wide admission: the budget is spent once, by the host, over live process
// state — and when the daemon is not there to say so, nothing is born at all.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REDSKILLED_INTERACTIVE_RESERVATION_ENV,
  evaluateWorkerAdmission,
  measureHostConsumption,
  resolveHostCeiling,
  UNBOUNDED_HOST_CEILING,
  type RedskilledHostCeiling,
} from "../src/admission.js";
import { RedskilledUnreachableError, startRedskilledWorker } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { launchWorker, RedskilledAdmissionError, type RedskilledWorkerSpec } from "../src/worker-launch.js";

const GIB = 1024 ** 3;
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
  const root = await scratch("redskilled-admission-");
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

/** A Worker that outlives the next request, so the second project sees it alive. */
function projectSpec(
  projectLabel: string,
  workspacePath: string,
  memory: string,
): RedskilledWorkerSpec {
  return {
    project_label: projectLabel,
    workspace_path: workspacePath,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000);"],
    budget: { memory_high: memory },
  };
}

function workerView(id: string, memory?: string): RedskilledWorkerView {
  return {
    worker_id: id,
    project_label: "acme/widgets",
    pid: 1234,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "/tmp/workspace",
    isolated: true,
    ...(memory != null ? { budget: { memory_high: memory } } : {}),
    warnings: [],
  };
}

describe("two projects spend one host budget", () => {
  it("refuses the second project's Worker, which fits alone and not alongside the first", async () => {
    // The defect in one fixture: each project asks for 5 GiB against an 8 GiB
    // host. Alone, either is affordable. Together they are not, and only a host-
    // wide denominator can tell — a per-repository profile admits both.
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const ceiling: RedskilledHostCeiling = { memory_bytes: 8 * GIB, worker_count: null, source: "declared" };
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000, ceiling });
    running.push(daemon);

    const first = await startRedskilledWorker(
      paths,
      projectSpec("acme/widgets", workspace, "5G"),
      { readyTimeoutMs: 5_000 },
    );
    expect(first.admission.admitted).toBe(true);

    await expect(
      startRedskilledWorker(paths, projectSpec("globex/gizmos", workspace, "5G"), { readyTimeoutMs: 5_000 }),
    ).rejects.toThrow(/refused/i);

    // Refused means not born: the host still holds exactly the first project's
    // Worker, and the second project's label never reaches host state.
    const state = daemon.hostState();
    expect(state.workers).toHaveLength(1);
    expect(state.projects.map((project) => project.project_label)).toEqual(["acme/widgets"]);
  });

  it("names the ceiling and the current consumption in the refusal", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const ceiling: RedskilledHostCeiling = { memory_bytes: 8 * GIB, worker_count: null, source: "declared" };
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000, ceiling });
    running.push(daemon);

    await startRedskilledWorker(paths, projectSpec("acme/widgets", workspace, "5G"), { readyTimeoutMs: 5_000 });
    const refusal = await startRedskilledWorker(
      paths,
      projectSpec("globex/gizmos", workspace, "5G"),
      { readyTimeoutMs: 5_000 },
    ).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

    expect(refusal).toContain(String(8 * GIB));
    expect(refusal).toContain(String(5 * GIB));
    expect(refusal).toContain("globex/gizmos");
  });

  it("admits a Worker under the ceiling, with a verdict naming the ceiling and the consumption", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const ceiling: RedskilledHostCeiling = { memory_bytes: 8 * GIB, worker_count: null, source: "declared" };
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000, ceiling });
    running.push(daemon);

    const started = await startRedskilledWorker(
      paths,
      projectSpec("acme/widgets", workspace, "1G"),
      { readyTimeoutMs: 5_000 },
    );

    expect(started.admission.verdict).toBe("admitted");
    expect(started.admission.ceiling.memory_bytes).toBe(8 * GIB);
    expect(started.admission.consumption).toEqual({
      worker_count: 0,
      memory_bytes: 0,
      unaccounted_workers: [],
    });
    expect(started.admission.projected_memory_bytes).toBe(GIB);
    expect(started.admission.reason).toContain(String(8 * GIB));
  });
});

describe("no daemon, no Worker", () => {
  it("refuses the spawn when the daemon is unreachable, and says so", async () => {
    // The daemon "starts" by exiting immediately, so the socket never answers.
    // Failing open here would reinstate the very unbudgeted spawn this Spec
    // exists to prevent, and would do it silently.
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");

    const refusal = startRedskilledWorker(paths, projectSpec("acme/widgets", workspace, "1G"), {
      serverCommand: process.execPath,
      serverArgs: ["-e", "process.exit(0);"],
      readyTimeoutMs: 500,
    });

    await expect(refusal).rejects.toThrow(RedskilledUnreachableError);
    await expect(refusal).rejects.toThrow(/no Worker was started/i);
  });
});

describe("no code path spawns a Worker without an admission verdict", () => {
  it("refuses to launch when no verdict was handed over", () => {
    const spawns: string[] = [];
    expect(() =>
      launchWorker({
        spec: { project_label: "acme/widgets", workspace_path: "/tmp/workspace", command: "/bin/true" },
        admission: undefined as never,
        spawnFn: (command) => {
          spawns.push(command);
          return { pid: 1, once: () => undefined, unref: () => undefined } as never;
        },
      }),
    ).toThrow(RedskilledAdmissionError);
    expect(spawns).toEqual([]);
  });

  it("refuses to launch on a verdict that refused", () => {
    const refused = evaluateWorkerAdmission({
      ceiling: { memory_bytes: GIB, worker_count: null, source: "declared" },
      workers: [workerView("held", "1G")],
      budget: { memory_high: "1G" },
      projectLabel: "acme/widgets",
    });
    const spawns: string[] = [];

    expect(() =>
      launchWorker({
        spec: { project_label: "acme/widgets", workspace_path: "/tmp/workspace", command: "/bin/true" },
        admission: refused,
        spawnFn: (command) => {
          spawns.push(command);
          return { pid: 1, once: () => undefined, unref: () => undefined } as never;
        },
      }),
    ).toThrow(RedskilledAdmissionError);
    expect(spawns).toEqual([]);
  });
});

describe("the verdict is decided over live process state", () => {
  it("measures consumption from the Worker set, naming budgets it cannot reduce to bytes", () => {
    const consumption = measureHostConsumption([
      workerView("a", "2G"),
      workerView("b"),
      workerView("c", "60%"),
    ]);

    expect(consumption).toEqual({
      worker_count: 3,
      memory_bytes: 2 * GIB,
      unaccounted_workers: ["c"],
    });
  });

  it("refuses a request whose own budget cannot be proven to fit", () => {
    const verdict = evaluateWorkerAdmission({
      ceiling: { memory_bytes: 8 * GIB, worker_count: null, source: "declared" },
      workers: [],
      budget: { memory_max: "infinity" },
    });

    expect(verdict.verdict).toBe("refused-unaccountable-budget");
    expect(verdict.admitted).toBe(false);
  });

  it("charges a Worker its hard limit when it declares one", () => {
    const verdict = evaluateWorkerAdmission({
      ceiling: { memory_bytes: 4 * GIB, worker_count: null, source: "declared" },
      workers: [],
      budget: { memory_high: "1G", memory_max: "6G" },
    });

    expect(verdict.verdict).toBe("refused-over-memory-ceiling");
    expect(verdict.requested_memory_bytes).toBe(6 * GIB);
  });

  it("refuses over a Worker-count ceiling, whichever projects the Workers belong to", () => {
    const verdict = evaluateWorkerAdmission({
      ceiling: { memory_bytes: null, worker_count: 2, source: "declared" },
      workers: [workerView("a", "1G"), workerView("b", "1G")],
      budget: { memory_high: "1G" },
    });

    expect(verdict.verdict).toBe("refused-over-worker-ceiling");
    expect(verdict.projected_worker_count).toBe(3);
  });

  it("admits interactive work immediately into the bounded reservation above a saturated ceiling", () => {
    const ceiling: RedskilledHostCeiling = {
      memory_bytes: null,
      worker_count: 3,
      interactive_reservation: 1,
      source: "declared",
    };
    const saturated = [workerView("a"), workerView("b"), workerView("c")];

    const autonomous = evaluateWorkerAdmission({ ceiling, workers: saturated });
    const interactive = evaluateWorkerAdmission({
      ceiling,
      workers: saturated,
      reservation: "interactive",
    });
    const reservationFull = evaluateWorkerAdmission({
      ceiling,
      workers: [...saturated, workerView("go")],
      reservation: "interactive",
    });

    expect(autonomous.verdict).toBe("refused-over-worker-ceiling");
    expect(interactive.verdict).toBe("admitted-interactive-reservation");
    expect(interactive.reason).toContain("reserved interactive slot 1/1");
    expect(reservationFull.verdict).toBe("refused-over-interactive-reservation");
  });

  it("admits everything under an unbounded ceiling — the operator's explicit opt-out", () => {
    const verdict = evaluateWorkerAdmission({
      ceiling: UNBOUNDED_HOST_CEILING,
      workers: [workerView("a", "512G")],
      budget: { memory_max: "infinity" },
    });

    expect(verdict.admitted).toBe(true);
  });
});

// The machine these assertions are ABOUT, stated rather than inherited.
// `resolveHostCeiling` already accepts the CPU count; the tests just never
// passed it, so `validation_count` derived from whatever host ran them — 3 on a
// 12-core developer machine, something else on a 4-core CI runner. A test that
// reads the machine it runs on is a test that only holds on that machine.
const HOST = { availableParallelism: 12 } as const;

describe("the ceiling a host admits against", () => {
  it("takes an operator's declaration over the derived share", () => {
    expect(resolveHostCeiling({ REDSKILLED_MEMORY_CEILING: "6G", REDSKILLED_WORKER_CEILING: "4" }, 16 * GIB, HOST))
      .toEqual({
        memory_bytes: 6 * GIB,
        worker_count: 4,
        validation_count: 3,
        interactive_reservation: 1,
        source: "declared",
        memory_source: "environment",
        worker_source: "environment",
        validation_source: "derived-default",
      });
  });

  it("reads a percentage of the host, and `infinity` as no ceiling at all", () => {
    expect(resolveHostCeiling({ REDSKILLED_MEMORY_CEILING: "50%" }, 16 * GIB, HOST).memory_bytes).toBe(8 * GIB);
    expect(resolveHostCeiling({ REDSKILLED_MEMORY_CEILING: "infinity" }, 16 * GIB, HOST).memory_bytes).toBeNull();
  });

  it("still holds a real ceiling on a host nobody configured", () => {
    const ceiling = resolveHostCeiling({}, 16 * GIB, HOST);

    expect(ceiling.source).toBe("host-fraction");
    expect(ceiling.memory_bytes).toBeLessThan(16 * GIB);
    expect(ceiling.memory_bytes).toBeGreaterThan(0);
    expect(ceiling.interactive_reservation).toBe(1);
  });

  it("lets the host configure a small interactive reservation", () => {
    expect(resolveHostCeiling({ [REDSKILLED_INTERACTIVE_RESERVATION_ENV]: "2" }, 16 * GIB, HOST)
      .interactive_reservation).toBe(2);
  });
});
