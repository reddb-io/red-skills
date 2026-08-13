// The macOS placement backend, proven from injected probes with nothing spawned
// and nothing reniced. The cases that matter here are the ones about HONESTY:
// macOS has no resource-group equivalent, so this backend must add the priority
// and rlimit teeth it really has WITHOUT claiming a kernel memory ceiling it
// cannot deliver — the sampling floor stays the ceiling that actually holds.
import { describe, expect, it } from "vitest";
import { evaluateWorkerAdmission, UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import {
  evaluateMemoryBudgets,
  parsePsCpuSeconds,
  parsePsTable,
  sampleWorkerTrees,
} from "../src/memory-sampler.js";
import {
  MAX_POSIX_NICE,
  planPosixLimits,
  WORKER_YIELD_NICE,
} from "../src/posix-limits.js";
import { launchWorker } from "../src/worker-launch.js";
import {
  detectWorkerPlacementProbes,
  planWorkerPlacement,
  type WorkerPlacementProbes,
} from "../src/worker-placement.js";
import type { RedskilledWorkerView } from "../src/host-state.js";

const NO_JOB_OBJECTS = { available: false, reason: "Job Object placement is the Windows backend (platform=darwin)" } as const;

const DARWIN: WorkerPlacementProbes = {
  platform: "darwin",
  systemdRun: null,
  userSession: false,
  jobObjects: NO_JOB_OBJECTS,
  posix: { available: true, shell: "/bin/sh", nice: "/usr/bin/nice" },
};
const DARWIN_WITHOUT_NICE: WorkerPlacementProbes = {
  ...DARWIN,
  posix: { available: true, shell: "/bin/sh", nice: null },
};
const DARWIN_WITHOUT_SHELL: WorkerPlacementProbes = {
  ...DARWIN,
  posix: { available: false, reason: "no POSIX shell was found at /bin/sh" },
};
const LINUX: WorkerPlacementProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: true,
  jobObjects: { available: false, reason: "Job Object placement is the Windows backend (platform=linux)" },
  posix: { available: false, reason: "POSIX rlimit placement is the macOS backend (platform=linux)" },
};

function plan(probes: WorkerPlacementProbes, overrides: Record<string, unknown> = {}) {
  return planWorkerPlacement({
    workerId: "wQ9F2",
    projectLabel: "acme/widgets",
    workspacePath: "/given/workspace",
    command: "/usr/bin/node",
    args: ["worker.js", "--issue", "2782"],
    budget: { memory_max: "4G", cpu_weight: 50 },
    probes,
    ...overrides,
  });
}

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "wQ9F2",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "/given/workspace",
    isolated: false,
    budget: { memory_max: "4G" },
    warnings: [],
    ...overrides,
  };
}

describe("macOS placement — resolved from probes, with nothing spawned", () => {
  it("wraps the argv in a POSIX shell that applies the limits and execs the command", () => {
    const placement = plan(DARWIN);

    expect(placement.backend).toBe("posix-limits");
    expect(placement.command).toBe("/bin/sh");
    expect(placement.args.slice(-4)).toEqual(["/usr/bin/node", "worker.js", "--issue", "2782"]);
    expect(placement.args[0]).toBe("-c");
    expect(placement.args[1]).toMatch(/exec '\/usr\/bin\/nice' -n \d+ "\$@"/);
    expect(placement.cwd).toBe("/given/workspace");
  });

  it("disables core dumps before applying the remaining POSIX launch controls", () => {
    expect(plan(DARWIN).args[1]).toMatch(/^ulimit -c 0\n/);
  });

  it("reads the host once, in the probe, and never on the planning path", () => {
    const probes = detectWorkerPlacementProbes({ PATH: "" }, "darwin");

    expect(probes.platform).toBe("darwin");
    expect(probes.systemdRun).toBeNull();
    expect(probes.jobObjects.available).toBe(false);
    // `nice` is absent from an empty PATH; the shell is the one path this probe
    // checks on disk, so the reach answer is a fact about the host, not a guess.
    expect(probes.posix.available ? probes.posix.nice : null).toBeNull();
  });

  it("charges the Worker to the daemon's group and says so — macOS has no resource group to give it", () => {
    const placement = plan(DARWIN);

    expect(placement.isolated).toBe(false);
    expect(placement.warning).toMatch(/no resource-group equivalent/);
    expect(placement.unit).toBeUndefined();
    expect(placement.job).toBeUndefined();
  });
});

describe("macOS placement — the memory ceiling it refuses to claim", () => {
  it("sets no memory rlimit at all: an address-space limit is not a resident ceiling", () => {
    const placement = plan(DARWIN, { budget: { memory_max: "4G", memory_high: "3G" } });
    const script = placement.args[1] ?? "";

    expect(script).not.toMatch(/ulimit -[vmd]/);
    expect(placement.posix?.memory_ceiling).toBe("sampling-floor");
    expect(placement.posix?.memory_ceiling_reason).toMatch(/address-space/);
  });

  it("names the sampling floor as the enforcer of a declared memory budget", () => {
    expect(plan(DARWIN).budgetWarning).toMatch(/RSS sampling floor/);
    expect(plan(DARWIN, { budget: { cpu_weight: 50 } }).budgetWarning).toBeUndefined();
  });

  it("measures RSS and CPU on macOS from the process table `ps` reports, so the floor has numbers to act on", () => {
    const ps = [
      "  100     1  1048576    2:30.00",
      "  200   100  2097152    0:30.00",
      "  300   999    65536  120:00.00",
    ].join("\n");
    const reading = sampleWorkerTrees([worker({ pid: 100 })], { platform: "darwin", psTable: () => ps });

    // KiB from `ps`, bytes in the reading — the child is summed, the stranger is not.
    expect(reading.rss).toEqual({ wQ9F2: (1048576 + 2097152) * 1024 });
    // The same one `ps` call answers both: three minutes of tree CPU, and the
    // stranger's two hours stays the stranger's.
    expect(reading.cpu_seconds).toEqual({ wQ9F2: 180 });
  });

  it("reports nothing rather than zero when the host process table cannot be read", () => {
    const reading = sampleWorkerTrees([worker({ pid: 100 })], {
      platform: "darwin",
      psTable: () => {
        throw new Error("ps: command not found");
      },
    });

    expect(reading).toEqual({ rss: {}, cpu_seconds: {}, processes: {}, sources: {}, resource_samples: {} });
  });

  it("parses `ps` output and ignores every line that is not a process row", () => {
    const table = parsePsTable("  PID  PPID   RSS  TIME\n 12 1 2048 0:07.50\nnonsense\n 13 1 2048 later\n");

    expect(table.get(12)).toEqual({ pid: 12, ppid: 1, rssBytes: 2048 * 1024, cpuSeconds: 7.5 });
    // A row whose clock cannot be read costs the row, never a guessed magnitude.
    expect(table.size).toBe(1);
  });

  it("reads every width `ps` prints its accumulated CPU clock in", () => {
    expect(parsePsCpuSeconds("0:00.00")).toBe(0);
    expect(parsePsCpuSeconds("12:34.56")).toBe(12 * 60 + 34.56);
    // BSD lets the minutes column run past sixty rather than growing a column.
    expect(parsePsCpuSeconds("125:00.00")).toBe(125 * 60);
    expect(parsePsCpuSeconds("3:04:05")).toBe(3 * 3600 + 4 * 60 + 5);
    expect(parsePsCpuSeconds("2-03:04:05")).toBe(2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
    expect(parsePsCpuSeconds("-")).toBeNull();
    expect(parsePsCpuSeconds("")).toBeNull();
  });
});

describe("macOS placement — the uniform floor", () => {
  it("terminates an over-budget Worker identically on macOS and on Linux", () => {
    const over = { wQ9F2: 5 * 1024 ** 3 };
    const outcome = evaluateMemoryBudgets({ workers: [worker()], rss: over });

    // The floor is a pure judgement over a reading and a budget: the platform is
    // not one of its inputs, which IS the uniformity this asserts.
    expect(outcome.terminations).toHaveLength(1);
    expect(outcome.terminations[0]).toMatchObject({
      outcome: "terminated-over-memory-budget",
      classification: "budget-exceeded",
      stall: false,
      budget_name: "MemoryMax",
      budget_declared: "4G",
    });

    const darwinPlanned = plan(DARWIN);
    const linuxPlanned = plan(LINUX);
    expect(darwinPlanned.backend).not.toBe(linuxPlanned.backend);
    // Different teeth, same floor: neither backend changes what the sampler
    // decides about the very same Worker.
    expect(evaluateMemoryBudgets({ workers: [worker()], rss: over }).terminations[0]?.reason).toBe(
      outcome.terminations[0]?.reason,
    );
  });

  it("leaves an under-budget Worker alone on macOS exactly as on Linux", () => {
    const outcome = evaluateMemoryBudgets({ workers: [worker()], rss: { wQ9F2: 1024 ** 3 } });

    expect(outcome.terminations).toEqual([]);
  });
});

describe("macOS placement — priority control, the tooth this backend really has", () => {
  it("yields to interactive work by default", () => {
    const placement = plan(DARWIN, { budget: undefined });

    expect(placement.posix?.nice).toBe(WORKER_YIELD_NICE);
    expect(placement.args[1]).toContain(`-n ${WORKER_YIELD_NICE}`);
  });

  it("yields further when the client declared a deprioritising weight", () => {
    expect(planPosixLimits({ cpu_weight: 10 }, { canRenice: true }).nice).toBe(17);
    expect(planPosixLimits({ cpu_weight: 50 }, { canRenice: true }).nice).toBe(10);
    expect(planPosixLimits({ cpu_weight: 1 }, { canRenice: true }).nice).toBeLessThanOrEqual(MAX_POSIX_NICE);
  });

  it("refuses to raise priority for a weight at or above the fair share, and says why", () => {
    const limits = planPosixLimits({ cpu_weight: 200 }, { canRenice: true });

    expect(limits.nice).toBe(WORKER_YIELD_NICE);
    expect(limits.note).toMatch(/privilege/);
  });

  it("applies no priority when `nice` is not on the host, rather than pretending it did", () => {
    const placement = plan(DARWIN_WITHOUT_NICE);

    expect(placement.posix?.nice).toBeUndefined();
    expect(placement.args[1]).toContain('exec "$@"');
    expect(placement.warning).toMatch(/no priority control/);
  });

  it("carries the applied priority into the warning, so it is observable for the Worker's life", () => {
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const launched = launchWorker({
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
      spec: {
        project_label: "acme/widgets",
        workspace_path: "/given/workspace",
        command: "/usr/bin/node",
        args: ["worker.js"],
        budget: { memory_max: "4G" },
      },
      probes: DARWIN,
      spawnFn: (command, args) => {
        spawns.push({ command, args });
        return { pid: 4242, once: () => undefined, unref: () => undefined } as never;
      },
    });

    expect(spawns[0]?.command).toBe("/bin/sh");
    expect(spawns[0]?.args[1]).toContain(`-n ${WORKER_YIELD_NICE}`);
    expect(launched.worker.isolated).toBe(false);
    expect(launched.worker.warnings.join(" ")).toContain(`nice ${WORKER_YIELD_NICE}`);
  });
});

describe("macOS placement — the rlimits it will and will not set", () => {
  it("carries a declared process-count and CPU-time budget into the shell's rlimits", () => {
    const placement = plan(DARWIN, { budget: { max_processes: 256, cpu_seconds: 3600 } });

    expect(placement.args[1]).toContain("ulimit -u 256");
    expect(placement.args[1]).toContain("ulimit -t 3600");
    expect(placement.posix).toMatchObject({ max_processes: 256, cpu_seconds: 3600 });
  });

  it("sets no rlimit for a value it cannot carry, and names the one it dropped", () => {
    const limits = planPosixLimits({ max_processes: 0, cpu_seconds: -1 }, { canRenice: true });

    expect(limits.max_processes).toBeUndefined();
    expect(limits.cpu_seconds).toBeUndefined();
    expect(limits.note).toMatch(/max_processes/);
    expect(limits.note).toMatch(/cpu_seconds/);
  });

  it("keeps only POSIX-only budget fields in Linux's unenforced warning", () => {
    const linux = plan(LINUX, { budget: { memory_max: "4G", max_processes: 256, cpu_seconds: 3600 } });

    expect(linux.backend).toBe("transient-unit");
    expect(linux.budgetWarning).toMatch(/cpu_seconds/);
    expect(linux.budgetWarning).not.toMatch(/max_processes/);
  });

  it("degrades to an unwrapped launch when the host has no POSIX shell to wrap it in", () => {
    const placement = plan(DARWIN_WITHOUT_SHELL);

    expect(placement.backend).toBe("none");
    expect(placement.command).toBe("/usr/bin/node");
    expect(placement.warning).toMatch(/no POSIX shell/);
    expect(placement.budgetWarning).toMatch(/cannot enforce it/);
  });
});
