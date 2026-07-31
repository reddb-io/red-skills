// Cgroup isolation (#2697) belongs to the LAUNCH, not to whichever surface asked
// for it: a supervisor inherits the cgroup of the process that spawned it — on a
// desktop host, the terminal emulator's scope — so the transient scope has to be
// built where the spawn is. These tests drive the real `spawnSupervisor` and
// assert its argv, which is the one implementation every remaining launch lane
// shares.
//
// The MCP is no longer one of those lanes (#2902): since ADR 0130 Amendment 4 the
// project's MCP registers its project with the daemon and launches no process of
// its own, so `project_start` has no supervisor argv left to isolate.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import type { SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn((
  _command: string,
  _args: readonly string[],
  _options: SpawnOptions,
) => ({ unref: vi.fn() })));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));

// Since the ADR 0130 cutover (#2851) a launch reaches the host daemon before it
// starts anything, and refuses when nothing answers. These cases are about the
// SUPERVISOR's cgroup argv, so the host is stubbed to "answered": a real socket
// would make them depend on whether a daemon happens to be running, which is a
// fact about the developer's machine rather than about the launch.
vi.mock("../src/runtime/redskilled-birth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/redskilled-birth.js")>(),
  createRedskilledBirthPort: () => ({
    projectLabel: "scoped-host",
    socketPath: "/nonexistent/redskilled.sock",
    reach: async () => undefined,
    start: async () => {
      throw new Error("no Worker is born in a cgroup-argv test");
    },
    stop: async () => true,
    liveWorkers: async () => 0,
    drainEvents: async () => [],
  }),
}));

import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";
import { afkPaths } from "../src/runtime/wire.js";
import { readPidStartTime } from "../src/core/state.js";

const roots: string[] = [];
const platform = process.platform;

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  spawn.mockReset();
});

/**
 * A temp repo whose `.red/config.yaml` carries the fleet-scope knobs, plus a
 * fake host that looks like Linux with a live systemd `--user` session.
 */
async function scopedHost(config: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fleet-scope-"));
  roots.push(root);
  await mkdir(join(root, ".red"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), config, "utf8");

  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "systemd-run"), "#!/bin/sh\n", { mode: 0o755 });
  const runtimeDir = join(root, "run");
  await mkdir(join(runtimeDir, "systemd"), { recursive: true });
  await writeFile(join(runtimeDir, "systemd", "private"), "", "utf8");

  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  vi.stubEnv("PATH", bin);
  vi.stubEnv("XDG_RUNTIME_DIR", runtimeDir);
  return root;
}

/**
 * Stand in for a supervisor that booted: publish this process's own pid and
 * start-time token so the pinned-pid probe resolves on its first poll instead
 * of burning the boot window.
 */
function publishPidOnSpawn(root: string): void {
  const paths = afkPaths(root);
  spawn.mockImplementation(() => {
    writeFileSync(paths.supervisorPidPath, String(process.pid), "utf8");
    writeFileSync(paths.supervisorPidStartPath, readPidStartTime(process.pid) ?? "", "utf8");
    return { unref: vi.fn() };
  });
}

/**
 * The call that launched the SUPERVISOR.
 *
 * Selected by what it runs rather than by index: since #2851 a launch also runs
 * the one-time cutover migration, whose git calls land in the same mock, and an
 * index would silently start asserting about whichever process happened to run
 * first.
 */
function supervisorLaunch(): [string, readonly string[], SpawnOptions] {
  const call = spawn.mock.calls.find((entry) => (entry[1] ?? []).includes("__supervise"));
  if (call === undefined) throw new Error("no supervisor launch was spawned");
  return call as [string, readonly string[], SpawnOptions];
}

describe("supervisor cgroup isolation", () => {
  it("spawns the supervisor inside its own transient scope", async () => {
    const root = await scopedHost(
      "plugins:\n  dev:\n    enabled: true\n    afk:\n      fleet:\n        scope:\n          enabled: true\n          memory_high: 55%\n",
    );
    publishPidOnSpawn(root);

    await expect(spawnSupervisor({ root, runner: "claude", target: 1 })).resolves.toBe(process.pid);

    const [command, args] = supervisorLaunch();
    expect(command).toBe(join(root, "bin", "systemd-run"));
    expect(args).toContain("--user");
    expect(args).toContain("--scope");
    expect(args).toContain("--property=Delegate=yes");
    expect(args).toContain("--property=MemoryHigh=55%");
    // The scope is named for the project's supervisor lane, so a launch always
    // lands in a unit of its own rather than in the caller's cgroup.
    expect(args?.some((arg) => arg.startsWith("--unit=red-fleet-default-"))).toBe(true);
    // The supervisor argv survives intact behind the `--` separator.
    expect(args?.slice((args?.indexOf("--") ?? -1) + 1)).toContain("__supervise");
  });

  it("launches directly and warns when the host has no systemd user session", async () => {
    const root = await scopedHost(
      "plugins:\n  dev:\n    enabled: true\n    afk:\n      fleet:\n        scope:\n          enabled: true\n",
    );
    // No systemd `--user` socket: isolation is impossible, never silent.
    vi.stubEnv("XDG_RUNTIME_DIR", join(root, "absent"));
    publishPidOnSpawn(root);

    const warnings: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      warnings.push(String(chunk));
      return true;
    });
    try {
      await expect(spawnSupervisor({ root, runner: "claude", target: 1 })).resolves.toBe(process.pid);
    } finally {
      stderr.mockRestore();
    }

    expect(supervisorLaunch()[0]).toBe(process.execPath);
    expect(supervisorLaunch()[1]).toContain("__supervise");
    expect(warnings.join("\n")).toContain("fleet cgroup isolation unavailable");
  });
});
