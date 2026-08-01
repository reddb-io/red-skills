// A Worker is born in its own scope with a STATED ceiling, and the scope is what
// contains a memory-pressure kill to the Worker that earned it (#3029, Spec
// #3022). Three facts are proven here and nothing is spawned to prove them: the
// ceiling comes out of the accounting the host already keeps, the scope and the
// ceiling reach the Worker's own environment (so its death record can name
// them), and a host with no systemd degrades with the degradation NAMED.
import { describe, expect, it } from "vitest";
import {
  UNSCOPED_PROCESS,
  WORKER_SCOPE_CEILING_ENV,
  WORKER_SCOPE_DEGRADATION_ENV,
  WORKER_SCOPE_ENV,
  readWorkerScopeFacts,
} from "@reddb-io/shared/worker-scope.js";
import { buildProcessDeathRecord, sampleProcessResources, type DeathRecorderHost } from "@reddb-io/shared/death-record.js";
import { deriveWorkerScopeCeiling, type RedskilledHostCeiling } from "../src/admission.js";
import { evaluateMemoryBudgets, resolveEnforcedBudget } from "../src/memory-sampler.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { planWorkerPlacement, type WorkerPlacementProbes } from "../src/worker-placement.js";

const NO_JOB_OBJECTS = { available: false, reason: "Job Object placement is the Windows backend (platform=linux)" } as const;
const NO_POSIX = { available: false, reason: "POSIX rlimit and priority placement is the macOS backend (platform=linux)" } as const;

const LINUX_WITH_SESSION: WorkerPlacementProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: true,
  jobObjects: NO_JOB_OBJECTS,
  posix: NO_POSIX,
};
const LINUX_WITHOUT_SYSTEMD: WorkerPlacementProbes = {
  platform: "linux",
  systemdRun: null,
  userSession: false,
  jobObjects: NO_JOB_OBJECTS,
  posix: NO_POSIX,
};

const GIB = 1024 ** 3;

function hostCeiling(overrides: Partial<RedskilledHostCeiling> = {}): RedskilledHostCeiling {
  return { memory_bytes: 12 * GIB, worker_count: null, source: "host-fraction", ...overrides };
}

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "wLIVE",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-01T20:00:00.000Z",
    workspace_path: "/given/workspace",
    isolated: true,
    warnings: [],
    ...overrides,
  };
}

describe("the ceiling a Worker is born under, derived from the accounting", () => {
  it("takes the headroom under the host ceiling when the host declares no slots", () => {
    const derived = deriveWorkerScopeCeiling({ ceiling: hostCeiling(), workers: [] });

    expect(derived.memory_max).toBe(String(12 * GIB));
    expect(derived.reason).toContain("headroom");
  });

  it("shares the host ceiling across the Worker slots an operator declared", () => {
    const derived = deriveWorkerScopeCeiling({
      ceiling: hostCeiling({ worker_count: 3, source: "declared" }),
      workers: [],
    });

    expect(derived.memory_max).toBe(String(4 * GIB));
    expect(derived.reason).toContain("3 Worker slot(s)");
  });

  it("subtracts what the live Workers already declared, so the ceiling is never fiction", () => {
    const derived = deriveWorkerScopeCeiling({
      ceiling: hostCeiling(),
      workers: [worker({ budget: { memory_max: "4G" } })],
    });

    expect(derived.memory_max).toBe(String(8 * GIB));
  });

  it("never narrows a ceiling the client declared for itself", () => {
    const derived = deriveWorkerScopeCeiling({
      ceiling: hostCeiling({ worker_count: 3 }),
      workers: [],
      budget: { memory_max: "9G" },
    });

    expect(derived.memory_max).toBe("9G");
    expect(derived.reason).toContain("the client declared");
  });

  it("states that an unbounded host leaves the sampling floor as the only ceiling", () => {
    const derived = deriveWorkerScopeCeiling({
      ceiling: { memory_bytes: null, worker_count: null, source: "declared" },
      workers: [],
    });

    expect(derived.memory_max).toBeNull();
    expect(derived.reason).toContain("RSS sampling floor");
  });

  it("derives nothing rather than a zero ceiling when the host is already fully committed", () => {
    const derived = deriveWorkerScopeCeiling({
      ceiling: hostCeiling(),
      workers: [worker({ budget: { memory_max: "12G" } })],
    });

    expect(derived.memory_max).toBeNull();
    expect(derived.reason).toContain("fully committed");
  });

  // The derived ceiling is a containment wall, never a reservation: were it
  // charged to the host, the first Worker born would commit the whole machine
  // and every Worker after it would be refused.
  it("is NOT what the host charges: a Worker's declared budget stays the client's", () => {
    const derived = deriveWorkerScopeCeiling({ ceiling: hostCeiling(), workers: [] });
    const born = worker({ memory_ceiling: derived.memory_max!, budget: undefined });

    const next = deriveWorkerScopeCeiling({ ceiling: hostCeiling(), workers: [born] });
    expect(next.memory_max).toBe(String(12 * GIB));
  });
});

describe("the scope the Worker runs in, and what it is told about it", () => {
  function place(probes: WorkerPlacementProbes, ceilingBytes: string | null) {
    return planWorkerPlacement({
      workerId: "wQ9F2",
      projectLabel: "acme/widgets",
      workspacePath: "/given/workspace",
      command: "/usr/bin/node",
      args: ["worker.js"],
      memoryCeiling: { memory_max: ceilingBytes, reason: "derived from the headroom" },
      probes,
    });
  }

  it("carries the derived ceiling into the unit as MemoryMax", () => {
    const placement = place(LINUX_WITH_SESSION, String(4 * GIB));

    expect(placement.unit).toBe("red-worker-acme-widgets-wq9f2.service");
    expect(placement.args).toContain(`--property=MemoryMax=${4 * GIB}`);
    expect(placement.memoryCeiling).toBe(String(4 * GIB));
  });

  it("tells the Worker which scope holds it and what ceiling that scope carries", () => {
    const placement = place(LINUX_WITH_SESSION, String(4 * GIB));

    expect(placement.environment).toEqual({
      [WORKER_SCOPE_ENV]: "red-worker-acme-widgets-wq9f2.service",
      [WORKER_SCOPE_CEILING_ENV]: String(4 * GIB),
    });
    // The same facts travel as `--setenv`, which is the only way an environment
    // reaches a process the init system starts.
    expect(placement.args).toContain(`--setenv=${WORKER_SCOPE_ENV}=red-worker-acme-widgets-wq9f2.service`);
    expect(placement.args).toContain(`--setenv=${WORKER_SCOPE_CEILING_ENV}=${4 * GIB}`);
  });

  it("degrades on a host with no systemd, and NAMES the degradation to the Worker", () => {
    const placement = place(LINUX_WITHOUT_SYSTEMD, String(4 * GIB));

    expect(placement.isolated).toBe(false);
    expect(placement.backend).toBe("none");
    // The launch still happens — the ceiling just moves to the sampling floor.
    expect(placement.command).toBe("/usr/bin/node");
    expect(placement.warning).toContain("systemd-run is not on PATH");
    expect(placement.environment[WORKER_SCOPE_ENV]).toBeUndefined();
    expect(placement.environment[WORKER_SCOPE_CEILING_ENV]).toBe(String(4 * GIB));
    expect(placement.environment[WORKER_SCOPE_DEGRADATION_ENV]).toContain("systemd-run is not on PATH");
  });

  it("leaves a client's own declared budget untouched under the scope", () => {
    const placement = planWorkerPlacement({
      workerId: "wQ9F2",
      projectLabel: "acme/widgets",
      workspacePath: "/given/workspace",
      command: "/usr/bin/node",
      budget: { memory_max: "9G" },
      memoryCeiling: { memory_max: "9G", reason: "the client declared this Worker's memory ceiling (9G)" },
      probes: LINUX_WITH_SESSION,
    });

    expect(placement.args).toContain("--property=MemoryMax=9G");
    expect(placement.environment[WORKER_SCOPE_CEILING_ENV]).toBe("9G");
  });
});

describe("an over-ceiling Worker: the scope contains the kill to the offender", () => {
  it("terminates the Worker over its derived ceiling and NAMES it, leaving its neighbours running", () => {
    const derived = deriveWorkerScopeCeiling({
      ceiling: hostCeiling({ worker_count: 3, source: "declared" }),
      workers: [],
    });
    const offender = worker({ worker_id: "wGREEDY", memory_ceiling: derived.memory_max! });
    const bystander = worker({ worker_id: "wQUIET", memory_ceiling: derived.memory_max! });

    const outcome = evaluateMemoryBudgets({
      workers: [offender, bystander],
      rss: { wGREEDY: 5 * GIB, wQUIET: GIB },
    });

    expect(outcome.terminations).toHaveLength(1);
    const [termination] = outcome.terminations;
    expect(termination?.worker_id).toBe("wGREEDY");
    expect(termination?.classification).toBe("budget-exceeded");
    expect(termination?.stall).toBe(false);
    expect(termination?.budget_bytes).toBe(4 * GIB);
    expect(termination?.reason).toContain("wGREEDY");
    expect(outcome.unenforceable).toEqual([]);
  });

  it("enforces the derived ceiling on the floor a host without systemd falls back to", () => {
    const unscoped = worker({ isolated: false, memory_ceiling: String(2 * GIB) });

    expect(resolveEnforcedBudget(unscoped)).toEqual({
      name: "MemoryMax",
      declared: String(2 * GIB),
      bytes: 2 * GIB,
    });
  });

  it("says out loud when a Worker has no ceiling at all rather than skipping it", () => {
    const outcome = evaluateMemoryBudgets({ workers: [worker({ worker_id: "wBARE" })], rss: { wBARE: 9 * GIB } });

    expect(outcome.terminations).toEqual([]);
    expect(outcome.unenforceable[0]?.reason).toContain("the host derived no ceiling");
  });

  it("is readable from the dead Worker's own record: the scope and the ceiling it died under", () => {
    const placement = planWorkerPlacement({
      workerId: "wQ9F2",
      projectLabel: "acme/widgets",
      workspacePath: "/given/workspace",
      command: "/usr/bin/node",
      memoryCeiling: { memory_max: String(4 * GIB), reason: "derived from the headroom" },
      probes: LINUX_WITH_SESSION,
    });

    // What the Worker itself would read on the way out — the environment the
    // host handed it at birth, and nothing it had to derive.
    const record = buildProcessDeathRecord(
      {
        ts: "2026-08-01T21:00:00.000Z",
        kind: "worker",
        id: "wQ9F2",
        pid: 4242,
        exit_path: "signal",
        signal: "SIGKILL",
        last_phase: "agent",
        scope: readWorkerScopeFacts(placement.environment),
      },
      sampleProcessResources(poseHost()),
    );

    expect(record.scope).toBe("red-worker-acme-widgets-wq9f2.service");
    expect(record.memory_ceiling).toBe(String(4 * GIB));
    expect(record.scope_degradation).toBeNull();
  });

  it("records the degradation, not silence, when the host could scope nothing", () => {
    const placement = planWorkerPlacement({
      workerId: "wQ9F2",
      projectLabel: "acme/widgets",
      workspacePath: "/given/workspace",
      command: "/usr/bin/node",
      memoryCeiling: { memory_max: String(4 * GIB), reason: "derived from the headroom" },
      probes: LINUX_WITHOUT_SYSTEMD,
    });

    const facts = readWorkerScopeFacts(placement.environment);
    expect(facts).not.toEqual(UNSCOPED_PROCESS);
    expect(facts.scope).toBeNull();
    expect(facts.scope_degradation).toContain("charged to the daemon's own resource group");
  });
});

/** A process whose rusage is stated, so a record needs no live process. */
function poseHost(): DeathRecorderHost {
  return {
    pid: 4242,
    on: () => undefined,
    off: () => undefined,
    uptime: () => 60,
    memoryUsage: () => ({ rss: 1024 }),
    resourceUsage: () => ({
      userCPUTime: 1,
      systemCPUTime: 2,
      maxRSS: 3,
      minorPageFault: 4,
      majorPageFault: 5,
      voluntaryContextSwitches: 6,
      involuntaryContextSwitches: 7,
    }),
  };
}
