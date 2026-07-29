// The Windows placement backend, proven on a host that is not Windows: the
// planner is pure over injected probes, the native reach is an injected binding,
// and the one thing that must never happen — a silent degrade — is checked from
// both ends (no reach at plan time, and a reach that fails at launch time).
import { describe, expect, it } from "vitest";
import type { RedskilledWorkerView } from "../src/host-state.js";
import {
  classifyJobObjectExit,
  CPU_WEIGHT_FAIR_SHARE,
  JOB_MEMORY_EXIT_CODES,
  JOB_OBJECT_ADDON_BASENAME,
  jobObjectAddonCandidates,
  loadJobObjectBinding,
  planJobLimits,
  type RedskilledJobLimits,
  type RedskilledJobObjectBinding,
  type RedskilledJobObjectHandle,
} from "../src/job-object.js";
import { launchWorker } from "../src/worker-launch.js";
import {
  planWorkerPlacement,
  workerJobObjectName,
  type WorkerPlacementProbes,
} from "../src/worker-placement.js";
import { evaluateWorkerAdmission, UNBOUNDED_HOST_CEILING } from "../src/admission.js";

interface RecordedJob {
  readonly name: string;
  readonly limits: RedskilledJobLimits;
  readonly assigned: number[];
  closed: boolean;
}

/** A binding that records instead of reaching the kernel — the addon's whole surface. */
function fakeBinding(behaviour: { failCreate?: string; failAssign?: string } = {}): {
  binding: RedskilledJobObjectBinding;
  jobs: RecordedJob[];
} {
  const jobs: RecordedJob[] = [];
  const binding: RedskilledJobObjectBinding = {
    createJobObject: ({ name, limits }) => {
      if (behaviour.failCreate) throw new Error(behaviour.failCreate);
      const record: RecordedJob = { name, limits, assigned: [], closed: false };
      jobs.push(record);
      const handle: RedskilledJobObjectHandle = {
        name,
        assign: (pid) => {
          if (behaviour.failAssign) throw new Error(behaviour.failAssign);
          record.assigned.push(pid);
        },
        close: () => {
          record.closed = true;
        },
      };
      return handle;
    },
  };
  return { binding, jobs };
}

function windowsProbes(reach?: RedskilledJobObjectBinding): WorkerPlacementProbes {
  return {
    platform: "win32",
    systemdRun: null,
    userSession: false,
    jobObjects: reach
      ? { available: true, binding: reach }
      : { available: false, reason: "no Job Object addon was found for win32-x64" },
  };
}

function plan(probes: WorkerPlacementProbes, overrides: Record<string, unknown> = {}) {
  return planWorkerPlacement({
    workerId: "wQ9F2",
    projectLabel: "acme/widgets",
    workspacePath: "C:\\work\\acme",
    command: "node.exe",
    args: ["worker.js", "--issue", "2781"],
    budget: { memory_max: "4G", cpu_weight: 50 },
    probes,
    ...overrides,
  });
}

describe("windows placement — the planner resolves a Job Object from probes alone", () => {
  it("places the Worker in a Job Object of its own, spawning nothing", () => {
    const { binding } = fakeBinding();
    const placement = plan(windowsProbes(binding));

    expect(placement.isolated).toBe(true);
    expect(placement.backend).toBe("job-object");
    expect(placement.job?.name).toBe("red-worker-acme-widgets-wq9f2");
    expect(placement.warning).toBeUndefined();
  });

  it("leaves the argv untouched: Windows has no launcher to wrap the command in", () => {
    const { binding } = fakeBinding();
    const placement = plan(windowsProbes(binding));

    expect(placement.command).toBe("node.exe");
    expect(placement.args).toEqual(["worker.js", "--issue", "2781"]);
    expect(placement.cwd).toBe("C:\\work\\acme");
    expect(placement.unit).toBeUndefined();
  });

  it("carries the memory budget into the job as a byte ceiling, naming the budget", () => {
    const { binding } = fakeBinding();
    const limits = plan(windowsProbes(binding)).job?.limits;

    expect(limits?.memory_limit_bytes).toBe(4 * 1024 ** 3);
    expect(limits?.memory_budget_name).toBe("MemoryMax");
    expect(limits?.memory_budget_declared).toBe("4G");
  });

  it("names the Job Object like the unit, without pretending it is one", () => {
    expect(workerJobObjectName("Acme/Widgets.git", "wQ9F2/2781")).toBe("red-worker-acme-widgets-git-wq9f2-2781");
    expect(workerJobObjectName("p", "w", "red-gate")).toBe("red-gate-p-w");
    expect(workerJobObjectName("p", "w").endsWith(".service")).toBe(false);
  });
});

describe("windows placement — kill-on-close", () => {
  it("sets kill-on-close on every job it plans, budget or no budget", () => {
    const { binding } = fakeBinding();
    for (const budget of [undefined, {}, { memory_max: "1G" }, { cpu_weight: 10 }]) {
      expect(plan(windowsProbes(binding), { budget }).job?.limits.kill_on_close).toBe(true);
    }
  });

  it("assigns the live Worker to the job it planned, so nothing outlives it", () => {
    const { binding, jobs } = fakeBinding();
    const launched = launchWorker({
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
      spec: {
        project_label: "acme/widgets",
        workspace_path: "C:\\work\\acme",
        command: "node.exe",
        budget: { memory_max: "2G" },
      },
      probes: windowsProbes(binding),
      spawnFn: () => ({ pid: 7331, once: () => undefined, unref: () => undefined }) as never,
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.limits.kill_on_close).toBe(true);
    expect(jobs[0]!.assigned).toEqual([7331]);
    expect(launched.worker.isolated).toBe(true);
    expect(launched.warnings).toEqual([]);
    expect(launched.job?.name).toBe(jobs[0]!.name);
  });

  it("holds the job for the Worker's life and closes it when the Worker is gone", () => {
    const { binding, jobs } = fakeBinding();
    const handlers: Array<(code: number | null, signal: null) => void> = [];
    launchWorker({
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
      spec: { project_label: "acme", workspace_path: "C:\\work", command: "node.exe" },
      probes: windowsProbes(binding),
      spawnFn: () =>
        ({
          pid: 4242,
          once: (event: string, handler: (code: number | null, signal: null) => void) => {
            if (event === "exit") handlers.push(handler);
          },
          unref: () => undefined,
        }) as never,
    });

    expect(jobs[0]!.closed).toBe(false);
    for (const handler of handlers) handler(0, null);
    expect(jobs[0]!.closed).toBe(true);
  });
});

describe("windows placement — a kernel kill names the budget it broke", () => {
  const worker: RedskilledWorkerView = {
    worker_id: "w-1",
    project_label: "acme/widgets",
    pid: 7331,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "C:\\work\\acme",
    isolated: true,
    budget: { memory_max: "2G" },
    warnings: [],
  };
  const limits = planJobLimits(worker.budget);

  it("reads a memory-limit death as a budget termination, not a stall", () => {
    const outcome = classifyJobObjectExit({
      worker,
      jobName: "red-worker-acme-widgets-w-1",
      limits,
      exitCode: 0xc0000017,
    });

    expect(outcome?.outcome).toBe("terminated-over-memory-budget");
    expect(outcome?.classification).toBe("budget-exceeded");
    expect(outcome?.stall).toBe(false);
    expect(outcome?.enforced_by).toBe("job-object");
    expect(outcome?.budget_name).toBe("MemoryMax");
    expect(outcome?.budget_declared).toBe("2G");
    expect(outcome?.budget_bytes).toBe(2 * 1024 ** 3);
    expect(outcome?.exit_status).toBe("STATUS_NO_MEMORY");
    expect(outcome?.reason).toContain("MemoryMax budget of 2G");
    expect(outcome?.reason).toContain("not a stall");
    expect(outcome?.workspace_path).toBe("C:\\work\\acme");
    expect(outcome?.reason).toContain(JSON.stringify("C:\\work\\acme"));
  });

  it("claims every documented job-memory status, and only those", () => {
    for (const code of Object.keys(JOB_MEMORY_EXIT_CODES).map(Number)) {
      expect(classifyJobObjectExit({ worker, jobName: "j", limits, exitCode: code })).not.toBeNull();
    }
    for (const code of [0, 1, 137, null]) {
      expect(classifyJobObjectExit({ worker, jobName: "j", limits, exitCode: code })).toBeNull();
    }
  });

  it("attributes nothing to a job that carried no memory ceiling", () => {
    const noCeiling = planJobLimits({ cpu_weight: 10 });

    expect(classifyJobObjectExit({ worker, jobName: "j", limits: noCeiling, exitCode: 0xc0000017 })).toBeNull();
  });
});

describe("windows placement — the budget the job cannot carry is named, never assumed", () => {
  it("caps CPU only for a weight below the fair share, and says why when it does not", () => {
    expect(planJobLimits({ cpu_weight: 25 }).cpu_rate_percent).toBe(25);
    expect(planJobLimits({ cpu_weight: CPU_WEIGHT_FAIR_SHARE }).cpu_rate_percent).toBeUndefined();
    expect(planJobLimits({ cpu_weight: 400 }).note).toMatch(/absolute cap rather than a share/);
  });

  it("says the memory budget it could not reduce to bytes is now the floor's problem", () => {
    const { binding } = fakeBinding();
    const placement = plan(windowsProbes(binding), { budget: { memory_max: "50%" } });

    expect(placement.job?.limits.memory_limit_bytes).toBeUndefined();
    expect(placement.budgetWarning).toMatch(/sampling floor/);
  });
});

describe("windows placement — degrading to the sampling floor is explicit", () => {
  it("names the missing native reach when the addon is not there", () => {
    const placement = plan(windowsProbes());

    expect(placement.isolated).toBe(false);
    expect(placement.backend).toBe("none");
    expect(placement.job).toBeUndefined();
    expect(placement.warning).toMatch(/Job Object placement unavailable/);
    expect(placement.warning).toMatch(/no Job Object addon was found/);
    expect(placement.warning).toMatch(/sampling floor is the only remaining ceiling/);
    expect(placement.budgetWarning).toMatch(/cannot enforce it/);
  });

  it("still launches when the addon refuses to mint the job, and says the floor is the ceiling", () => {
    const { binding, jobs } = fakeBinding({ failCreate: "ERROR_ACCESS_DENIED" });
    const launched = launchWorker({
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
      spec: { project_label: "acme", workspace_path: "C:\\work", command: "node.exe", budget: { memory_max: "1G" } },
      probes: windowsProbes(binding),
      spawnFn: () => ({ pid: 4242, once: () => undefined, unref: () => undefined }) as never,
    });

    expect(jobs).toHaveLength(0);
    expect(launched.worker.pid).toBe(4242);
    expect(launched.worker.isolated).toBe(false);
    expect(launched.job).toBeUndefined();
    expect(launched.warnings.join(" ")).toMatch(/could not be created: ERROR_ACCESS_DENIED/);
    expect(launched.warnings.join(" ")).toMatch(/sampling floor/);
  });

  it("closes a job it could not put the Worker into rather than leaving it armed", () => {
    const { binding, jobs } = fakeBinding({ failAssign: "ERROR_ACCESS_DENIED" });
    const launched = launchWorker({
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
      spec: { project_label: "acme", workspace_path: "C:\\work", command: "node.exe" },
      probes: windowsProbes(binding),
      spawnFn: () => ({ pid: 4242, once: () => undefined, unref: () => undefined }) as never,
    });

    expect(jobs[0]!.closed).toBe(true);
    expect(launched.worker.isolated).toBe(false);
    expect(launched.warnings.join(" ")).toMatch(/could not be assigned to Job Object/);
  });

  it("honours the host kill-switch and an `inherit` client on Windows too", () => {
    const { binding } = fakeBinding();
    expect(plan(windowsProbes(binding), { enabled: false }).isolated).toBe(false);
    expect(plan(windowsProbes(binding), { target: { isolation: "inherit" } }).isolated).toBe(false);
    expect(plan(windowsProbes(binding), { target: { isolation: "job-object" } }).backend).toBe("job-object");
    // A client naming the Linux backend still gets isolated: the target says
    // "isolate me", and the host decides which backend that is.
    expect(plan(windowsProbes(binding), { target: { isolation: "transient-unit" } }).backend).toBe("job-object");
  });
});

describe("windows placement — loading the native reach never throws", () => {
  const ROOT = "C:\\app\\redskilled";

  it("looks for a prebuild for this platform and architecture, then a local build", () => {
    expect(jobObjectAddonCandidates("win32", "x64", ROOT)).toEqual([
      `${ROOT}/prebuilds/win32-x64/${JOB_OBJECT_ADDON_BASENAME}`.replaceAll("/", pathSep()),
      `${ROOT}/native/build/Release/${JOB_OBJECT_ADDON_BASENAME}`.replaceAll("/", pathSep()),
    ]);
  });

  it("refuses with the paths it looked in when no artifact matches the host", () => {
    const reach = loadJobObjectBinding({ platform: "win32", arch: "arm64", packageRoot: ROOT, exists: () => false });

    expect(reach.available).toBe(false);
    expect(reach.available === false && reach.reason).toMatch(/win32-arm64/);
    expect(reach.available === false && reach.reason).toMatch(/prebuilds/);
  });

  it("refuses rather than throwing when the artifact is there but will not load", () => {
    const reach = loadJobObjectBinding({
      platform: "win32",
      arch: "x64",
      packageRoot: ROOT,
      exists: () => true,
      requireFn: () => {
        throw new Error("The specified module could not be found.");
      },
    });

    expect(reach.available === false && reach.reason).toMatch(/could not be loaded/);
  });

  it("refuses an artifact that loads but is not the binding", () => {
    const reach = loadJobObjectBinding({
      platform: "win32",
      arch: "x64",
      packageRoot: ROOT,
      exists: () => true,
      requireFn: () => ({ somethingElse: true }),
    });

    expect(reach.available === false && reach.reason).toMatch(/does not export createJobObject/);
  });

  it("accepts an artifact that exports createJobObject", () => {
    const { binding } = fakeBinding();
    const reach = loadJobObjectBinding({
      platform: "win32",
      arch: "x64",
      packageRoot: ROOT,
      exists: () => true,
      requireFn: () => binding,
    });

    expect(reach.available).toBe(true);
  });

  it("says off Windows that there is no native reach to load, without reading the disk", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const reach = loadJobObjectBinding({
        platform,
        exists: () => {
          throw new Error("the disk must not be read here");
        },
      });
      expect(reach.available === false && reach.reason).toContain(`platform=${platform}`);
    }
  });
});

function pathSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
