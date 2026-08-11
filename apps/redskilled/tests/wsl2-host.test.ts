// WSL2: the Linux-shaped host that lacks the two things the Linux path assumes.
//
// Everything here already "should work" by reading the code — and that is
// precisely the claim this file exists to stop trusting. The daemon entry
// resolver read correctly and could not start on a fresh host (#2961); the idle
// window and the upgrade check each read sensibly and together made
// self-replacement unreachable (#2968). So the WSL2 host is POSED rather than
// described: no `XDG_RUNTIME_DIR`, no `systemd-run` on PATH, no `--user`
// session, a relocated `TMPDIR`, and a `/proc` that is walked for real.
//
// **WSL2 only.** WSL1 has no real `/proc`, so the tree walk the memory floor
// stands on has nothing to read there; that boundary is stated in the app README
// where an operator will meet it, and the last case in this file holds the
// README to it.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive, UNIX_SOCKET_PATH_LIMIT } from "@reddb-io/shared/resident-core.js";
import { evaluateWorkerAdmission, UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { evaluateMemoryBudgets, sampleWorkerTrees } from "../src/memory-sampler.js";
import {
  createRedskilledMachineClaimStore,
  resolveMachineClaimDir,
  resolveMachineClaimPath,
} from "../src/machine-scope.js";
import { resolveRedskilledPaths, resolveSessionKey, REDSKILLED_SOCKET_FILE } from "../src/paths.js";
import { stopWorker } from "../src/reattach.js";
import { launchWorker } from "../src/worker-launch.js";
import { detectWorkerPlacementProbes, planWorkerPlacement } from "../src/worker-placement.js";
import type { RedskilledWorkerView } from "../src/host-state.js";

const roots: string[] = [];
const restoreEnv: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Point the host's own `tmpdir()` somewhere else, the way WSL and some distros do. */
function relocateTmpdir(dir: string): void {
  const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  restoreEnv.push(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
}

/**
 * The environment a WSL2 shell really hands a process.
 *
 * No `XDG_RUNTIME_DIR`, because nothing creates one without a login session. The
 * PATH names directories that do not exist on ANY host, which is how a machine
 * that happens to have `systemd-run` installed — this repository's own CI and
 * every maintainer's Linux box — can still pose as one that does not. The probe
 * looks the binary up on exactly this PATH, so posing the PATH poses the host.
 */
const WSL2_ENV: NodeJS.ProcessEnv = {
  PATH: "/wsl2-pose/usr/local/bin:/wsl2-pose/usr/bin:/wsl2-pose/bin",
  HOME: "/home/wsluser",
};

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "wWSL2",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-01T00:00:00.000Z",
    workspace_path: "/home/wsluser/acme",
    isolated: false,
    budget: { memory_max: "4G" },
    warnings: [],
    ...overrides,
  };
}

describe("WSL2 — the probes a host without systemd answers", () => {
  it("finds no systemd-run and no --user session, and says so as facts rather than absences", () => {
    const probes = detectWorkerPlacementProbes(WSL2_ENV, "linux");

    expect(probes.platform).toBe("linux");
    // Nothing was spawned to learn this: the binary is looked for on the PATH the
    // Worker would inherit, and the session is proven by its private socket.
    expect(probes.systemdRun).toBeNull();
    expect(probes.userSession).toBe(false);
    // The other two backends belong to other platforms, and each says which.
    expect(probes.jobObjects.available).toBe(false);
    expect(probes.posix.available).toBe(false);
  });

  it("still finds no session when XDG_RUNTIME_DIR names a directory with no systemd socket in it", async () => {
    // WSL2 with an operator-set XDG_RUNTIME_DIR is the near-miss case: the
    // variable exists, and there is still no session behind it.
    const runtimeDir = await scratch("redskilled-wsl-xdg-");
    const probes = detectWorkerPlacementProbes({ ...WSL2_ENV, XDG_RUNTIME_DIR: runtimeDir }, "linux");

    expect(probes.userSession).toBe(false);
  });
});

describe("WSL2 — a Worker is born, unisolated, and the loss is named", () => {
  const WSL2_PROBES = detectWorkerPlacementProbes(WSL2_ENV, "linux");

  it("plans an unwrapped launch and names systemd-run as what it could not reach", () => {
    const plan = planWorkerPlacement({
      workerId: "wWSL2",
      projectLabel: "acme/widgets",
      workspacePath: "/home/wsluser/acme",
      command: "/usr/bin/node",
      args: ["worker.js"],
      budget: { memory_max: "4G" },
      probes: WSL2_PROBES,
    });

    expect(plan.backend).toBe("none");
    expect(plan.isolated).toBe(false);
    // The argv is the caller's own, untouched — there is no launcher to wrap it in.
    expect(plan.command).toBe("/usr/bin/node");
    expect(plan.args).toEqual(["worker.js"]);
    expect(plan.cwd).toBe("/home/wsluser/acme");
    expect(plan.unit).toBeUndefined();
    expect(plan.warning).toMatch(/systemd-run is not on PATH/);
    expect(plan.warning).toMatch(/charged to the daemon's own resource group/);
    // A declared budget the placement cannot carry is its own sentence, so the
    // floor that does carry it is never something an operator has to infer.
    expect(plan.budgetWarning).toMatch(/RSS sampling/);
  });

  it("really spawns one, in the workspace it was handed, and hands the warnings back to the caller", async () => {
    // A real process, not an injected spawn: "it should work" is the claim under
    // test, so the Worker has to actually run on this host and prove it did.
    const workspace = await scratch("redskilled-wsl-workspace-");
    const launched = launchWorker({
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
      spec: {
        worker_id: "wWSL2",
        project_label: "acme/widgets",
        workspace_path: workspace,
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync('proof.json', JSON.stringify({ cwd: process.cwd(), worker_id: process.env.RED_WORKER_ID, born_at: process.env.RED_WORKER_BORN_AT })); setTimeout(() => {}, 250);",
        ],
        budget: { memory_max: "4G" },
      },
      probes: WSL2_PROBES,
      env: WSL2_ENV,
    });

    expect(launched.worker.pid).toBeGreaterThan(0);
    expect(launched.worker.pgid).toBe(launched.worker.pid);
    expect(launched.worker.proc_start_time).toMatch(/^\d+$/);
    expect(launched.worker.isolated).toBe(false);
    expect(launched.worker.unit).toBeUndefined();
    // The warning reaches the caller AND stays on the record the Worker keeps for
    // its whole life — a downgrade nobody can read later is a silent one.
    expect(launched.warnings.join(" ")).toMatch(/systemd-run is not on PATH/);
    expect(launched.worker.warnings).toEqual(launched.warnings);

    const proof = join(workspace, "proof.json");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        expect(JSON.parse(await readFile(proof, "utf8"))).toEqual({
          cwd: workspace,
          worker_id: launched.worker.worker_id,
          born_at: launched.worker.started_at,
        });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`the Worker never wrote ${proof}`);
  });

  it("stops an unisolated Worker's whole process group, including a forked child", async () => {
    const workspace = await scratch("redskilled-wsl-stop-");
    const proof = join(workspace, "child-pid");
    const childProgram = "setInterval(() => {}, 30_000)";
    const leaderProgram = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { stdio: "ignore" });
      writeFileSync("child-pid", String(child.pid));
      setInterval(() => {}, 30_000);
    `;
    const launched = launchWorker({
      admission: evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] }),
      spec: {
        worker_id: "wTREE",
        project_label: "acme/widgets",
        workspace_path: workspace,
        command: process.execPath,
        args: ["-e", leaderProgram],
      },
      probes: WSL2_PROBES,
      env: WSL2_ENV,
    });
    let childPid = 0;

    try {
      await expect.poll(async () => {
        try {
          childPid = Number(await readFile(proof, "utf8"));
          return childPid > 1;
        } catch {
          return false;
        }
      }, { timeout: 2_000 }).toBe(true);

      expect(await stopWorker(launched.worker)).toBe(true);
      await expect.poll(() => [isPidAlive(launched.worker.pid), isPidAlive(childPid)], { timeout: 2_000 })
        .toEqual([false, false]);
    } finally {
      try {
        process.kill(-(launched.worker.pgid ?? launched.worker.pid), "SIGKILL");
      } catch {}
      if (childPid > 1) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
    }
  });
});

describe("WSL2 — the uniform sampling floor is the ceiling here", () => {
  /** A synthetic `/proc`, in the kernel's own layout: one directory, one `stat`. */
  async function procTable(rows: ReadonlyArray<{ pid: number; ppid: number; rssPages: number }>): Promise<string> {
    const procRoot = await scratch("redskilled-wsl-proc-");
    for (const row of rows) {
      const fields = new Array(50).fill("0");
      fields[1] = String(row.ppid); // ppid, once the (comm) field is read past
      fields[21] = String(row.rssPages); // rss, in pages
      await mkdir(join(procRoot, String(row.pid)), { recursive: true });
      await writeFile(join(procRoot, String(row.pid), "stat"), `${row.pid} (node) ${fields.join(" ")}\n`, "utf8");
    }
    return procRoot;
  }

  it("reads the Worker's whole tree out of /proc — the file system WSL2 has and WSL1 does not", async () => {
    const procRoot = await procTable([
      { pid: 4242, ppid: 1, rssPages: 512 * 1024 },
      { pid: 4243, ppid: 4242, rssPages: 256 * 1024 },
      { pid: 9999, ppid: 1, rssPages: 999 * 1024 },
    ]);

    const reading = sampleWorkerTrees([worker()], { procRoot, platform: "linux" });

    // The child is summed into the Worker; the stranger stays a stranger.
    expect(reading.rss.wWSL2).toBe((512 + 256) * 1024 * 4096);
  });

  it("terminates an over-budget Worker on a host with no cgroup to have stopped it", async () => {
    // This is the whole point of ADR 0130 rule 4: with no transient unit there is
    // no kernel ceiling, so the sampler's is the only one — and it must still hold.
    const procRoot = await procTable([{ pid: 4242, ppid: 1, rssPages: 5 * 1024 * 1024 * 1024 / 4096 }]);
    const rss = sampleWorkerTrees([worker()], { procRoot, platform: "linux" });
    const outcome = evaluateMemoryBudgets({ workers: [worker()], rss: rss.rss });

    expect(outcome.terminations).toHaveLength(1);
    expect(outcome.terminations[0]).toMatchObject({
      worker_id: "wWSL2",
      outcome: "terminated-over-memory-budget",
      classification: "budget-exceeded",
      budget_name: "MemoryMax",
      budget_declared: "4G",
    });
  });

  it("decides identically whether the Worker was isolated or not — the floor takes no platform input", () => {
    const over = { wWSL2: 5 * 1024 ** 3 };
    const unisolated = evaluateMemoryBudgets({ workers: [worker({ isolated: false })], rss: over });
    const isolated = evaluateMemoryBudgets({
      workers: [worker({ isolated: true, unit: "red-worker-acme-widgets-wwsl2.service" })],
      rss: over,
    });

    expect(unisolated.terminations[0]?.reason).toBe(isolated.terminations[0]?.reason);
  });
});

describe("WSL2 — the socket lands somewhere the kernel will actually bind", () => {
  it("falls back to tmpdir with no XDG_RUNTIME_DIR, and scopes the session by uid", () => {
    const paths = resolveRedskilledPaths({ env: WSL2_ENV, uid: 1000, host: "wsl-host" });

    expect(resolveSessionKey({ env: WSL2_ENV, uid: 1000 })).toBe("uid:1000");
    expect(paths.sessionKey).toBe("uid:1000");
    expect(paths.runtimeDir.startsWith(join(tmpdir(), "red-skills-1000"))).toBe(true);
    expect(paths.socketPath).toBe(join(paths.runtimeDir, REDSKILLED_SOCKET_FILE));
    expect(paths.socketPath.length).toBeLessThan(UNIX_SOCKET_PATH_LIMIT);
  });

  it("keeps the socket inside sun_path even when TMPDIR is long enough to overflow it", async () => {
    // The failure mode that would surface only on someone else's machine: a
    // relocated TMPDIR pushes the fallback past 108 bytes and `bind` returns
    // ENAMETOOLONG — an outage with no kernel error anyone reads as a path bug.
    const long = join(await scratch("redskilled-wsl-longtmp-"), "a".repeat(80));
    await mkdir(long, { recursive: true });
    relocateTmpdir(long);
    expect(tmpdir().length).toBeGreaterThan(UNIX_SOCKET_PATH_LIMIT);

    const paths = resolveRedskilledPaths({ env: WSL2_ENV, uid: 1000, host: "wsl-host" });

    expect(paths.socketPath.length).toBeLessThan(UNIX_SOCKET_PATH_LIMIT);
    // Every path the daemon lives by shares the directory, so a fitting socket
    // that left the lease behind in the overlong one would be half a fallback.
    expect(paths.lockPath.startsWith(paths.runtimeDir)).toBe(true);
    expect(paths.leasePath.startsWith(paths.runtimeDir)).toBe(true);
    expect(paths.eventLanePath).toBe(
      join(WSL2_ENV.HOME!, ".red", "redskilled", "redskilled.log.toonl"),
    );
  });

  it("prefers a fitting XDG_RUNTIME_DIR when one exists, so the fallback is a fallback", () => {
    const withXdg = resolveRedskilledPaths({ env: { ...WSL2_ENV, XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 });

    expect(withXdg.runtimeDir.startsWith("/run/user/1000/red-skills/")).toBe(true);
  });
});

describe("WSL2 — the machine claim on a relocated tmpdir", () => {
  it("resolves the shared directory from tmpdir, not from a hardcoded /tmp", async () => {
    const relocated = await scratch("redskilled-wsl-tmp-");
    relocateTmpdir(relocated);

    const dir = resolveMachineClaimDir({ env: WSL2_ENV, machineIdHash: "abc123def456", platform: "linux" });

    expect(dir).toBe(join(relocated, "redskilled-abc123def456"));
  });

  it("claims, refuses a live foreign holder, and releases — all under that relocated root", async () => {
    const relocated = await scratch("redskilled-wsl-claim-");
    relocateTmpdir(relocated);
    const claimPath = resolveMachineClaimPath({ env: WSL2_ENV, machineIdHash: "abc123def456", platform: "linux" });
    expect(claimPath.startsWith(relocated)).toBe(true);

    const labels = { machineIdHash: "abc123def456", sessionKeyHash: "0123456789ab", socketPath: "/tmp/x/redskilled.sock" };
    const store = createRedskilledMachineClaimStore(claimPath, labels, {
      clock: () => "2026-08-01T00:00:00.000Z",
      isPidAlive: () => true,
    });
    const owner = { pid: 111, startTime: "2026-08-01T00:00:00.000Z", uid: 1000 };

    const first = await store.claim(owner);
    expect(first).toMatchObject({ claimed: true });

    // A second daemon, another pid, still alive: refused with the holder named.
    const rival = createRedskilledMachineClaimStore(claimPath, { ...labels, socketPath: "/tmp/y/redskilled.sock" }, {
      clock: () => "2026-08-01T00:00:01.000Z",
      isPidAlive: () => true,
    });
    const second = await rival.claim({ pid: 222, startTime: "2026-08-01T00:00:01.000Z", uid: 1000 });
    expect(second).toMatchObject({ claimed: false, reason: "held" });

    expect(await store.release(owner)).toBe(true);
    expect(await store.read()).toBeUndefined();
  });
});

describe("WSL2 — the supported version is stated where an operator reads it", () => {
  it("names WSL2 and the /proc requirement in the app README", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toMatch(/WSL2/);
    expect(readme).toMatch(/WSL1/);
    expect(readme).toMatch(/\/proc/);
  });
});
