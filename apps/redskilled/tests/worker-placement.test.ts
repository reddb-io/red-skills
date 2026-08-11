// The placement planner, proven from injected probes with nothing spawned.
// Both Linux cases matter and they matter differently: with a user session the
// Worker gets a transient SERVICE unit (never a scope — a scope dies with the
// caller), and without one the launch still happens but says so out loud.
import { describe, expect, it } from "vitest";
import { WORKER_BORN_AT_ENV, WORKER_ID_ENV } from "@reddb-io/shared/worker-scope.js";
import {
  DEFAULT_WORKER_UNIT_PREFIX,
  placementEnabled,
  planWorkerPlacement,
  REDSKILLED_PLACEMENT_ENV,
  workerUnitName,
  type WorkerPlacementProbes,
} from "../src/worker-placement.js";

const NO_JOB_OBJECTS = { available: false, reason: "Job Object placement is the Windows backend (platform=linux)" } as const;

const LINUX_POSIX = { available: true, shell: "/bin/sh", nice: null } as const;
const NO_POSIX = { available: false, reason: "no POSIX shell was found at /bin/sh" } as const;

const LINUX_WITH_SESSION: WorkerPlacementProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: true,
  jobObjects: NO_JOB_OBJECTS,
  posix: LINUX_POSIX,
};
const LINUX_WITHOUT_SESSION: WorkerPlacementProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: false,
  jobObjects: NO_JOB_OBJECTS,
  posix: LINUX_POSIX,
};
const LINUX_WITHOUT_SYSTEMD: WorkerPlacementProbes = {
  platform: "linux",
  systemdRun: null,
  userSession: false,
  jobObjects: NO_JOB_OBJECTS,
  posix: LINUX_POSIX,
};
const LINUX_WITHOUT_SHELL: WorkerPlacementProbes = { ...LINUX_WITHOUT_SYSTEMD, posix: NO_POSIX };
// An OS with neither backend: the case that proves an unknown platform still
// launches and still says what it gave up. macOS has its own backend now, so it
// is no longer the example of a host with nothing.
const UNKNOWN_PLATFORM: WorkerPlacementProbes = {
  platform: "aix",
  systemdRun: null,
  userSession: false,
  jobObjects: { available: false, reason: "Job Object placement is the Windows backend (platform=aix)" },
  posix: { available: false, reason: "POSIX rlimit and priority placement is the macOS backend (platform=aix)" },
};

function plan(probes: WorkerPlacementProbes, overrides: Record<string, unknown> = {}) {
  return planWorkerPlacement({
    workerId: "wQ9F2",
    projectLabel: "acme/widgets",
    workspacePath: "/given/workspace",
    command: "/usr/bin/node",
    args: ["worker.js", "--issue", "2774"],
    budget: { memory_high: "3G", memory_max: "4G", cpu_weight: 200 },
    probes,
    ...overrides,
  });
}

describe("worker placement — Linux with a user session", () => {
  it("places the Worker in a transient service unit of its own", () => {
    const placement = plan(LINUX_WITH_SESSION);

    expect(placement.isolated).toBe(true);
    expect(placement.command).toBe("/usr/bin/systemd-run");
    expect(placement.unit).toBe("red-worker-acme-widgets-wq9f2.service");
    expect(placement.args).toContain("--user");
    expect(placement.args).toContain(`--unit=${placement.unit}`);
    expect(placement.warning).toBeUndefined();
  });

  it("asks for a service unit, never a scope — a scope cannot outlive the daemon", () => {
    const placement = plan(LINUX_WITH_SESSION);

    expect(placement.args).not.toContain("--scope");
    expect(placement.unit?.endsWith(".service")).toBe(true);
  });

  it("carries the budget as unit properties and the argv after the separator", () => {
    const placement = plan(LINUX_WITH_SESSION);
    const separator = placement.args.indexOf("--");

    expect(placement.args.slice(0, separator)).toEqual(
      expect.arrayContaining(["--property=MemoryHigh=3G", "--property=MemoryMax=4G", "--property=CPUWeight=200"]),
    );
    expect(placement.args.slice(separator + 1)).toEqual([
      "/usr/bin/node",
      "worker.js",
      "--issue",
      "2774",
    ]);
    expect(placement.budgetWarning).toBeUndefined();
  });

  it("disables core dumps independently of the declared budget", () => {
    const declared = plan(LINUX_WITH_SESSION);
    const absent = plan(LINUX_WITH_SESSION, { budget: undefined });

    for (const placement of [declared, absent]) {
      const separator = placement.args.indexOf("--");
      expect(placement.args.slice(0, separator).filter((arg) => arg.startsWith("--property=LimitCORE="))).toEqual([
        "--property=LimitCORE=0",
      ]);
    }
  });

  it("carries max_processes as TasksMax exactly when it is declared", () => {
    const declared = plan(LINUX_WITH_SESSION, {
      budget: { max_processes: 32, cpu_seconds: 60 },
    });
    const absent = plan(LINUX_WITH_SESSION, { budget: { cpu_seconds: 60 } });

    expect(declared.args.filter((arg) => arg.startsWith("--property=TasksMax="))).toEqual([
      "--property=TasksMax=32",
    ]);
    expect(absent.args.some((arg) => arg.startsWith("--property=TasksMax="))).toBe(false);
    expect(declared.budgetWarning).toMatch(/cpu_seconds/);
    expect(declared.budgetWarning).not.toMatch(/max_processes/);
  });

  it("hands the workspace path to the unit verbatim", () => {
    const placement = plan(LINUX_WITH_SESSION, { workspacePath: "/nowhere/near/a/repo/x y" });

    expect(placement.args).toContain("--working-directory=/nowhere/near/a/repo/x y");
    expect(placement.args.filter((arg) => arg.startsWith("--working-directory="))).toHaveLength(1);
  });

  it("passes the Worker's environment through the unit, not through the daemon's", () => {
    const placement = plan(LINUX_WITH_SESSION, {
      bornAt: "2026-08-11T13:00:00.000Z",
      env: { RED_WORKER: "1" },
    });

    expect(placement.args).toContain("--setenv=RED_WORKER=1");
    expect(placement.args).toContain(`--setenv=${WORKER_ID_ENV}=wQ9F2`);
    expect(placement.args).toContain(`--setenv=${WORKER_BORN_AT_ENV}=2026-08-11T13:00:00.000Z`);
  });
});

describe("worker placement — Linux without a user session", () => {
  it("still launches, and never silently: the warning names the cost", () => {
    const placement = plan(LINUX_WITHOUT_SESSION);

    expect(placement.isolated).toBe(false);
    expect(placement.command).toBe("/bin/sh");
    expect(placement.args).toEqual([
      "-c",
      'ulimit -c 0\nexec "$@"',
      "--",
      "/usr/bin/node",
      "worker.js",
      "--issue",
      "2774",
    ]);
    expect(placement.cwd).toBe("/given/workspace");
    expect(placement.unit).toBeUndefined();
    expect(placement.warning).toMatch(/no systemd --user session/);
  });

  it("says the declared budget is now unenforceable rather than pretending it holds", () => {
    expect(plan(LINUX_WITHOUT_SESSION).budgetWarning).toMatch(/cannot enforce it/);
    expect(plan(LINUX_WITHOUT_SESSION, { budget: undefined }).budgetWarning).toBeUndefined();
  });

  it("warns about the missing binary when systemd-run is not on PATH", () => {
    expect(plan(LINUX_WITHOUT_SYSTEMD).warning).toMatch(/systemd-run is not on PATH/);
  });

  it("degrades loudly when /bin/sh is absent and cannot cap core dumps", () => {
    const placement = plan(LINUX_WITHOUT_SHELL);

    expect(placement.command).toBe("/usr/bin/node");
    expect(placement.args).toEqual(["worker.js", "--issue", "2774"]);
    expect(placement.warning).toMatch(/core dumps are not capped/);
    expect(placement.warning).toMatch(/no POSIX shell/);
  });
});

describe("worker placement — every unisolated launch carries a warning", () => {
  it("warns on a platform with no backend at all", () => {
    const placement = plan(UNKNOWN_PLATFORM);

    expect(placement.isolated).toBe(false);
    expect(placement.warning).toMatch(/platform=aix/);
  });

  it("warns when the host kill-switch declined isolation", () => {
    const placement = plan(LINUX_WITH_SESSION, { enabled: false });

    expect(placement.isolated).toBe(false);
    expect(placement.warning).toContain(REDSKILLED_PLACEMENT_ENV);
  });

  it("warns even when the client asked for `inherit` out loud", () => {
    const placement = plan(LINUX_WITH_SESSION, { target: { isolation: "inherit" } });

    expect(placement.isolated).toBe(false);
    expect(placement.warning).toMatch(/inherit/);
  });

  it("leaves no unisolated plan without a warning, over every probe combination", () => {
    for (const probes of [LINUX_WITH_SESSION, LINUX_WITHOUT_SESSION, LINUX_WITHOUT_SYSTEMD, UNKNOWN_PLATFORM]) {
      for (const enabled of [true, false]) {
        for (const isolation of ["transient-unit", "inherit"] as const) {
          const placement = plan(probes, { enabled, target: { isolation } });
          expect(placement.isolated ? placement.warning === undefined : (placement.warning ?? "").length > 0).toBe(true);
        }
      }
    }
  });
});

describe("worker placement — naming and the kill-switch", () => {
  it("slugifies both opaque labels instead of parsing them", () => {
    expect(workerUnitName("Acme/Widgets.git", "wQ9F2/2774")).toBe("red-worker-acme-widgets-git-wq9f2-2774.service");
    expect(workerUnitName("", "")).toBe(`${DEFAULT_WORKER_UNIT_PREFIX}-project-worker.service`);
    expect(workerUnitName("p", "w", "red-gate")).toBe("red-gate-p-w.service");
  });

  it("reads the kill-switch off the environment, defaulting to enabled", () => {
    expect(placementEnabled({})).toBe(true);
    expect(placementEnabled({ [REDSKILLED_PLACEMENT_ENV]: "off" })).toBe(false);
    expect(placementEnabled({ [REDSKILLED_PLACEMENT_ENV]: "0" })).toBe(false);
    expect(placementEnabled({ [REDSKILLED_PLACEMENT_ENV]: "on" })).toBe(true);
  });
});
