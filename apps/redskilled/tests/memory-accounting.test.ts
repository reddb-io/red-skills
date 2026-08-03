// Memory accounting describes the machine the daemon is running on: the reported
// figure is the cgroup's own charge, the accounting totals what the units really
// carry, and an over-commitment the host cannot enforce is stated rather than
// hidden behind a zero (#3080).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveWorkerScopeCeiling, measureHostConsumption, type RedskilledHostCeiling } from "../src/admission.js";
import { appliedWorkerBudget, buildBudgetAccounting } from "../src/budget-accounting.js";
import { buildHostState, type RedskilledWorkerView } from "../src/host-state.js";
import { evaluateMemoryBudgets, resolveEnforcedBudget, sampleWorkerTrees } from "../src/memory-sampler.js";
import { buildStatuslinePayload } from "../src/statusline-payload.js";
import { detectWorkerPlacementProbes, planWorkerPlacement } from "../src/worker-placement.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "redskilled-accounting-"));
  roots.push(root);
  return root;
}

const GIB = 1024 ** 3;

function worker(overrides: Partial<RedskilledWorkerView> & { readonly worker_id: string }): RedskilledWorkerView {
  return {
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-03T00:00:00.000Z",
    workspace_path: "/tmp/ws",
    isolated: true,
    warnings: [],
    ...overrides,
  };
}

/**
 * A fake unified cgroup hierarchy holding one unit, charged at `bytes`.
 *
 * Built on disk rather than mocked, because the defect was a path the code never
 * reached: a mocked reader would have passed against the very tree that produced
 * `14.6M` for 5.38 GiB.
 */
function cgroupHost(units: Readonly<Record<string, { readonly bytes: number; readonly cpuUsec?: number }>>): {
  readonly cgroupRoot: string;
  readonly selfCgroupPath: string;
} {
  const cgroupRoot = scratch();
  const selfCgroupPath = "/user.slice/user-1000.slice/user@1000.service/app.slice/redskilled.service";
  const appSlice = join(cgroupRoot, "user.slice", "user-1000.slice", "user@1000.service", "app.slice");
  mkdirSync(join(appSlice, "redskilled.service"), { recursive: true });
  // The daemon's own cgroup carries a charge too — a reader that walked up to the
  // parent slice would hand every Worker this number instead of its own.
  writeFileSync(join(appSlice, "redskilled.service", "memory.current"), "104857600\n");
  for (const [unit, charge] of Object.entries(units)) {
    const dir = join(appSlice, unit);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memory.current"), `${charge.bytes}\n`);
    if (charge.cpuUsec != null) {
      writeFileSync(join(dir, "cpu.stat"), `usage_usec ${charge.cpuUsec}\nuser_usec 1\nsystem_usec 2\n`);
    }
  }
  return { cgroupRoot, selfCgroupPath };
}

/** One synthetic `/proc` tree, so the walk arm is provable without real processes. */
function procHost(rows: ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly rssPages: number }>): string {
  const procRoot = scratch();
  for (const row of rows) {
    const dir = join(procRoot, String(row.pid));
    mkdirSync(dir, { recursive: true });
    const fields = Array.from({ length: 50 }, () => "0");
    fields[0] = String(row.ppid);
    fields[10] = "0";
    fields[11] = "0";
    fields[20] = String(row.rssPages);
    writeFileSync(join(dir, "stat"), `${row.pid} (worker) S ${fields.join(" ")}\n`);
  }
  return procRoot;
}

describe("reported memory tracks the cgroup", () => {
  it("reports the unit's own memory.current, not a walk over the recorded pid", () => {
    // The exact shape of the defect: the pid the daemon holds is the
    // `systemd-run --wait` client, a small process in the DAEMON's cgroup, while
    // the unit itself is charged gigabytes.
    const CGROUP_BYTES = 4_963_123_200;
    const { cgroupRoot, selfCgroupPath } = cgroupHost({
      "red-worker-acme-widgets-w1.service": { bytes: CGROUP_BYTES, cpuUsec: 12_000_000 },
    });
    const procRoot = procHost([
      { pid: 1, ppid: 0, rssPages: 100 },
      // 7.26 MiB of client, exactly the figure the walk used to report.
      { pid: 4242, ppid: 1, rssPages: 1_860 },
    ]);

    const reading = sampleWorkerTrees(
      [worker({ worker_id: "w1", unit: "red-worker-acme-widgets-w1.service" })],
      { platform: "linux", cgroupRoot, selfCgroupPath, procRoot, uid: 1000 },
    );

    expect(reading.rss.w1).toBe(CGROUP_BYTES);
    expect(reading.sources?.w1).toBe("cgroup");
    expect(reading.cpu_seconds.w1).toBe(12);
  });

  it("fails when the reported figure diverges from the cgroup by more than a small factor", () => {
    // The regression guard the defect asks for. `14.6M` against `5.38G` is a
    // factor of 377; anything past 1% of the kernel's own number is a bug.
    const TOLERANCE = 0.01;
    const charges = { "red-worker-acme-widgets-w1.service": 5_100_000_000, "red-worker-acme-widgets-w2.service": 677_000_000 };
    const { cgroupRoot, selfCgroupPath } = cgroupHost({
      "red-worker-acme-widgets-w1.service": { bytes: charges["red-worker-acme-widgets-w1.service"] },
      "red-worker-acme-widgets-w2.service": { bytes: charges["red-worker-acme-widgets-w2.service"] },
    });
    const workers = [
      worker({ worker_id: "w1", pid: 4242, unit: "red-worker-acme-widgets-w1.service" }),
      worker({ worker_id: "w2", pid: 4243, unit: "red-worker-acme-widgets-w2.service" }),
    ];
    // The process table the walk would have used, and which is nowhere near right.
    const procRoot = procHost([
      { pid: 4242, ppid: 1, rssPages: 1_860 },
      { pid: 4243, ppid: 1, rssPages: 1_000 },
    ]);

    const reading = sampleWorkerTrees(workers, { platform: "linux", cgroupRoot, selfCgroupPath, procRoot, uid: 1000 });

    for (const held of workers) {
      const cgroup = charges[held.unit as keyof typeof charges];
      const reported = reading.rss[held.worker_id]!;
      expect(Math.abs(reported - cgroup) / cgroup).toBeLessThanOrEqual(TOLERANCE);
    }
    // And the host total is the sum of the cgroups, not a rounding of the walk.
    const total = Object.values(reading.rss).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(charges["red-worker-acme-widgets-w1.service"] + charges["red-worker-acme-widgets-w2.service"]);
  });

  it("falls back to the walk for a Worker with no unit, and says which instrument answered", () => {
    const { cgroupRoot, selfCgroupPath } = cgroupHost({ "red-worker-acme-widgets-w1.service": { bytes: 8 * GIB } });
    const procRoot = procHost([
      { pid: 5000, ppid: 1, rssPages: 1_024 },
      { pid: 5001, ppid: 5000, rssPages: 2_048 },
    ]);

    const reading = sampleWorkerTrees(
      [
        worker({ worker_id: "w1", unit: "red-worker-acme-widgets-w1.service" }),
        worker({ worker_id: "w2", pid: 5000, isolated: false }),
      ],
      { platform: "linux", cgroupRoot, selfCgroupPath, procRoot, uid: 1000 },
    );

    expect(reading.sources?.w1).toBe("cgroup");
    expect(reading.sources?.w2).toBe("process-tree");
    // The walk's weaker guarantee is visible rather than silent: same shape of
    // number, explicitly different provenance.
    expect(reading.rss.w2).toBe(3_072 * 4096);
  });

  it("never charges a Worker with the daemon's own cgroup when its unit is gone", () => {
    const { cgroupRoot, selfCgroupPath } = cgroupHost({});
    const procRoot = procHost([{ pid: 4242, ppid: 1, rssPages: 512 }]);

    const reading = sampleWorkerTrees(
      [worker({ worker_id: "w1", unit: "red-worker-acme-widgets-gone.service" })],
      { platform: "linux", cgroupRoot, selfCgroupPath, procRoot, uid: 1000 },
    );

    expect(reading.sources?.w1).toBe("process-tree");
    expect(reading.rss.w1).toBe(512 * 4096);
  });
});

describe("the floor stands down where the kernel holds the wall", () => {
  it("does not kill a cgroup-measured Worker over its kernel-held MemoryMax", () => {
    const held = worker({ worker_id: "w1", unit: "u1", applied_budget: { memory_max: "1G" } });
    const over = { workers: [held], rss: { w1: 2 * GIB } };

    // Measured by a walk, the daemon is the only enforcer and acts.
    expect(evaluateMemoryBudgets({ ...over, sources: { w1: "process-tree" } }).terminations).toHaveLength(1);

    // Measured by the cgroup, `memory.current` counts reclaimable page cache and
    // the unit already carries the same MemoryMax — so the kernel decides.
    const kernelHeld = evaluateMemoryBudgets({ ...over, sources: { w1: "cgroup" } });
    expect(kernelHeld.terminations).toEqual([]);
    expect(kernelHeld.unenforceable[0]?.reason).toContain("held by the kernel on its own cgroup");
  });

  it("still enforces a MemoryHigh, which no kernel wall holds", () => {
    const held = worker({ worker_id: "w1", unit: "u1", applied_budget: { memory_high: "1G" } });
    const outcome = evaluateMemoryBudgets({ workers: [held], rss: { w1: 2 * GIB }, sources: { w1: "cgroup" } });
    expect(outcome.terminations[0]?.budget_name).toBe("MemoryHigh");
  });
});

describe("the accounting totals what the units carry", () => {
  it("records the applied budget at placement, derived ceiling included", () => {
    const plan = planWorkerPlacement({
      workerId: "w1",
      projectLabel: "acme/widgets",
      workspacePath: "/tmp/ws",
      command: "node",
      memoryCeiling: { memory_max: "11709286400", reason: "derived from the host ceiling" },
      probes: { ...detectWorkerPlacementProbes({}, "linux"), platform: "linux", systemdRun: "/usr/bin/systemd-run", userSession: true },
    });

    expect(plan.args).toContain("--property=MemoryMax=11709286400");
    // The plan states the very object those flags were written from.
    expect(plan.budget).toEqual({ memory_max: "11709286400" });
  });

  it("makes HOST and PROJECTS agree on one frame", () => {
    const CEILING = 11_709_286_400;
    const workers = [
      worker({ worker_id: "w1", unit: "u1", applied_budget: { memory_max: String(CEILING) }, memory_ceiling: String(CEILING) }),
      worker({ worker_id: "w2", unit: "u2", applied_budget: { memory_max: String(CEILING) }, memory_ceiling: String(CEILING) }),
    ];
    const ceiling: RedskilledHostCeiling = { memory_bytes: CEILING, worker_count: null, source: "host-fraction" };
    const hostState = buildHostState({
      daemonVersion: "3.3.9",
      machineIdHash: "m",
      sessionKeyHash: "s",
      pid: 1,
      startedAt: "2026-08-03T00:00:00.000Z",
      workers,
      hostCeilingBytes: ceiling.memory_bytes,
    });

    const payload = buildStatuslinePayload({
      hostState,
      ceiling,
      now: "2026-08-03T00:00:10.000Z",
      rss: { w1: 4_963_123_200, w2: 4_800_000_000 },
      sampledAt: "2026-08-03T00:00:09.000Z",
    });

    // HOST: what the units carry, not `0B`.
    expect(payload.host.budget_accounting.memory_max_bytes).toBe(2 * CEILING);
    // PROJECTS: the same number, because both come from one resolver.
    const declared = payload.projects.reduce((sum, project) => sum + project.declared_memory_bytes, 0);
    expect(declared).toBe(payload.host.budget_accounting.memory_max_bytes);
    // And the observed figure is the sum of the samples, not a rounding of zero.
    expect(payload.host.observed_rss_bytes).toBe(4_963_123_200 + 4_800_000_000);
  });

  it("resolves a derived ceiling the same way the floor enforces it", () => {
    const held = worker({ worker_id: "w1", unit: "u1", memory_ceiling: "10G" });
    expect(appliedWorkerBudget(held)).toEqual({ memory_max: "10G" });
    expect(resolveEnforcedBudget(held)).toEqual({ name: "MemoryMax", declared: "10G", bytes: 10 * GIB });
    expect(buildBudgetAccounting([held]).memory_max_bytes).toBe(10 * GIB);
  });

  it("keeps the admission charge on the DECLARED budget alone", () => {
    // The applied ceiling is a wall, never memory set aside — counting it as
    // committed would let the first Worker born spend the whole host's accounting.
    const held = worker({ worker_id: "w1", unit: "u1", applied_budget: { memory_max: "10G" }, memory_ceiling: "10G" });
    expect(measureHostConsumption([held]).memory_bytes).toBe(0);
  });
});

describe("an unenforceable host promise is reported as such", () => {
  it("states the over-commitment unbounded slots create", () => {
    const CEILING = 11_709_286_400;
    const workers = [
      worker({ worker_id: "w1", unit: "u1", applied_budget: { memory_max: String(CEILING) } }),
      worker({ worker_id: "w2", unit: "u2", applied_budget: { memory_max: String(CEILING) } }),
    ];

    const accounting = buildBudgetAccounting(workers, { hostCeilingBytes: CEILING });

    expect(accounting.memory_max_bytes).toBe(2 * CEILING);
    expect(accounting.memory_ceiling_bytes).toBe(CEILING);
    expect(accounting.over_committed_bytes).toBe(CEILING);
    expect(accounting.over_commitment_reason).toContain("wall rather than a reservation");
  });

  it("reports no over-commitment on a host inside its ceiling", () => {
    const accounting = buildBudgetAccounting(
      [worker({ worker_id: "w1", unit: "u1", applied_budget: { memory_max: "1G" } })],
      { hostCeilingBytes: 8 * GIB },
    );
    expect(accounting.over_committed_bytes).toBe(0);
    expect(accounting.over_commitment_reason).toBeNull();
  });

  it("says plainly that an undeclared slot count makes the ceiling per-Worker", () => {
    const derived = deriveWorkerScopeCeiling({
      ceiling: { memory_bytes: 11_709_286_400, worker_count: null, source: "host-fraction" },
      workers: [],
    });
    expect(derived.memory_max).toBe("11709286400");
    expect(derived.reason).toContain("per-Worker wall and not memory the host sets aside");
  });

  it("shares the ceiling across declared slots, so the walls sum to it", () => {
    const CEILING = 11_709_286_400;
    const derived = deriveWorkerScopeCeiling({
      ceiling: { memory_bytes: CEILING, worker_count: 2, source: "declared" },
      workers: [],
    });
    const accounting = buildBudgetAccounting(
      [
        worker({ worker_id: "w1", unit: "u1", applied_budget: { memory_max: derived.memory_max! } }),
        worker({ worker_id: "w2", unit: "u2", applied_budget: { memory_max: derived.memory_max! } }),
      ],
      { hostCeilingBytes: CEILING },
    );
    expect(accounting.over_committed_bytes).toBe(0);
  });
});
