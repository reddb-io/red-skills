import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeSync } from "node:fs";
import type { SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn((
  _command: string,
  _args: readonly string[],
  _options: SpawnOptions,
) => ({ unref: vi.fn() })));
const readFile = vi.hoisted(() => vi.fn(async () => {
  throw new Error("missing");
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile,
}));

import { spawnSupervisor, resolveDevScriptPath } from "../src/runtime/supervisor-spawn.js";
import type { FleetScopeProbes } from "../src/runtime/fleet-scope.js";
import { afkPaths } from "../src/runtime/wire.js";

const roots: string[] = [];

// The legacy assertions below describe the unscoped argv, so pin the
// cgroup-isolation decision (#2697) off instead of inheriting the host's.
const unscoped = { settings: { enabled: false, memoryHigh: "" } };

// The launch reaches the host daemon before it spawns anything (#2851). These
// cases are about the ARGV and the pid probe, so the reach is stubbed to
// "answered" — a real socket here would make every one of them depend on
// whether the developer happens to be running a daemon.
const reachesDaemon = async (): Promise<void> => undefined;

const linuxProbes: FleetScopeProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: true,
};

afterEach(async () => {
  vi.useRealTimers();
  spawn.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "supervisor-spawn-"));
  roots.push(value);
  return value;
}

// The cutover's own assertion (#2851, ADR 0130 rule 6). Since every Worker is
// born by the host daemon, a launch that could not reach one would produce a
// supervisor that ticks forever and drains nothing — which is exactly the shape
// that goes unnoticed. The launch must therefore refuse, and it must refuse
// BEFORE anything is spawned.
describe("spawnSupervisor without a reachable daemon", () => {
  it("refuses the launch instead of falling back to spawning the supervisor itself", async () => {
    const cwd = await root();
    const silence = new Error("nothing answered on the session socket");

    await expect(spawnSupervisor({
      reachDaemon: async () => {
        throw silence;
      },
      root: cwd,
      target: 1,
      runner: "codex",
      scope: unscoped,
      onNotice: () => undefined,
    })).rejects.toThrow(silence.message);

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("spawnSupervisor", () => {
  it("honours the configured pid-file probe deadline", async () => {
    const cwd = await root();
    const startedAt = performance.now();

    await expect(spawnSupervisor({
      reachDaemon: reachesDaemon,
      root: cwd,
      target: 1,
      runner: "codex",
      probeDeadlineMs: 1,
      scope: unscoped,
      onNotice: () => undefined,
    })).resolves.toBeNull();

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("captures child stderr in the named fleet supervisor log", async () => {
    const cwd = await root();
    const paths = afkPaths(cwd);
    spawn.mockImplementationOnce((_command, _args, options) => {
      const stdio = (options as { stdio: [string, string, number] }).stdio;
      writeSync(stdio[2], "supervisor boot failed\n");
      expect(readFileSync(paths.supervisorLogPath, "utf8"))
        .toContain("supervisor boot failed");
      return { unref: vi.fn() };
    });

    await spawnSupervisor({
      reachDaemon: reachesDaemon,
      root: cwd,
      target: 1,
      runner: "codex",
      probeDeadlineMs: 0,
      scope: unscoped,
      onNotice: () => undefined,
    });

    expect(readFileSync(paths.supervisorLogPath, "utf8"))
      .toContain("supervisor boot failed");
  });

  it("reaps stale supervisor state in the parent before spawning", async () => {
    const cwd = await root();
    const paths = afkPaths(cwd);
    await mkdir(paths.supervisorRuntimeDir, { recursive: true });
    await writeFile(paths.supervisorStopPath, "stale", "utf8");

    await spawnSupervisor({
      reachDaemon: reachesDaemon,
      root: cwd,
      target: 1,
      runner: "codex",
      probeDeadlineMs: 0,
      scope: unscoped,
      onNotice: () => undefined,
    });

    expect(existsSync(paths.supervisorStopPath)).toBe(false);
  });

  it("propagates the fleet profile base as the worker Trunk override", async () => {
    const cwd = await root();

    await spawnSupervisor({
      reachDaemon: reachesDaemon,
      root: cwd,
      target: 1,
      runner: "codex",
      base: " develop ",
      probeDeadlineMs: 0,
      scope: unscoped,
      onNotice: () => undefined,
    });

    const options = spawn.mock.calls.at(-1)?.[2] as SpawnOptions | undefined;
    expect(options?.env?.RED_AFK_TRUNK).toBe("develop");
  });

  it("resolves the sibling dev bundle when argv[1] is the castle-mcp bundle (MCP context)", async () => {
    const cwd = await root();
    const saved = process.argv[1];
    process.argv[1] = join("dist", "castle-mcp.bundle.min.mjs");
    try {
      await spawnSupervisor({
        reachDaemon: reachesDaemon,
        root: cwd,
        target: 1,
        runner: "claude",
        probeDeadlineMs: 0,
        scope: unscoped,
        onNotice: () => undefined,
      });
      const args = spawn.mock.calls.at(-1)?.[1] as string[] | undefined;
      expect(args?.[0]).toBe(join("dist", "dev.bundle.min.mjs"));
    } finally {
      process.argv[1] = saved;
    }
  });

  it("resolves the sibling dev bundle when argv[1] is a versioned castle-mcp bundle (MCP context)", async () => {
    const cwd = await root();
    const saved = process.argv[1];
    process.argv[1] = join("/npx-cache", "castle-mcp-2.76.1.bundle.min.mjs");
    try {
      await spawnSupervisor({
        reachDaemon: reachesDaemon,
        root: cwd,
        target: 1,
        runner: "claude",
        probeDeadlineMs: 0,
        scope: unscoped,
        onNotice: () => undefined,
      });
      const args = spawn.mock.calls.at(-1)?.[1] as string[] | undefined;
      expect(args?.[0]).toBe(join("/npx-cache", "dev-2.76.1.bundle.min.mjs"));
    } finally {
      process.argv[1] = saved;
    }
  });

  it("passes argv[1] through unchanged when already the dev bundle (CLI context)", async () => {
    const cwd = await root();
    const saved = process.argv[1];
    process.argv[1] = join("/npx-cache", "dev-2.76.1.bundle.min.mjs");
    try {
      await spawnSupervisor({
        reachDaemon: reachesDaemon,
        root: cwd,
        target: 1,
        runner: "claude",
        probeDeadlineMs: 0,
        scope: unscoped,
        onNotice: () => undefined,
      });
      const args = spawn.mock.calls.at(-1)?.[1] as string[] | undefined;
      expect(args?.[0]).toBe(join("/npx-cache", "dev-2.76.1.bundle.min.mjs"));
    } finally {
      process.argv[1] = saved;
    }
  });
});

describe("spawnSupervisor cgroup isolation (#2697)", () => {
  it("spawns the supervisor inside a transient scope named for its lane on Linux", async () => {
    const cwd = await root();

    await spawnSupervisor({
      reachDaemon: reachesDaemon,
      root: cwd,
      target: 1,
      runner: "claude",
      probeDeadlineMs: 0,
      scope: { probes: linuxProbes, settings: { enabled: true, memoryHigh: "70%" } },
      onNotice: () => undefined,
    });

    const [command, args] = spawn.mock.calls[0] as unknown as [string, string[], SpawnOptions];
    expect(command).toBe("/usr/bin/systemd-run");
    expect(args).toContain("--scope");
    expect(args).toContain("--property=Delegate=yes");
    expect(args).toContain("--property=MemoryHigh=70%");
    expect(args.find((a) => a.startsWith("--unit="))).toContain("red-fleet-default-");
    expect(args.slice(args.indexOf("--") + 1)).toContain("__supervise");
  });

  it("launches directly and notices the caller when no systemd user session exists", async () => {
    const cwd = await root();
    const notices: string[] = [];

    await spawnSupervisor({
      reachDaemon: reachesDaemon,
      root: cwd,
      target: 1,
      runner: "claude",
      probeDeadlineMs: 0,
      scope: {
        probes: { ...linuxProbes, userSession: false },
        settings: { enabled: true, memoryHigh: "70%" },
      },
      onNotice: (message) => notices.push(message),
    });

    const [command, args] = spawn.mock.calls.at(-1) as [string, string[], SpawnOptions];
    expect(command).toBe(process.execPath);
    expect(args).toContain("__supervise");
    expect(notices.join("\n")).toContain("no systemd --user session");
  });

  it("relaunches unscoped, loudly, when the scope yields no supervisor", async () => {
    const cwd = await root();
    const notices: string[] = [];

    await spawnSupervisor({
      reachDaemon: reachesDaemon,
      root: cwd,
      target: 1,
      runner: "claude",
      probeDeadlineMs: 0,
      scope: { probes: linuxProbes, settings: { enabled: true, memoryHigh: "70%" } },
      onNotice: (message) => notices.push(message),
    });

    expect(spawn.mock.calls).toHaveLength(2);
    expect(spawn.mock.calls[0]?.[0]).toBe("/usr/bin/systemd-run");
    expect(spawn.mock.calls[1]?.[0]).toBe(process.execPath);
    expect(notices.join("\n")).toContain("relaunching unscoped");
  });
});

describe("resolveDevScriptPath", () => {
  it("returns the sibling dev bundle for the generic castle-mcp bundle name", () => {
    expect(resolveDevScriptPath(join("dist", "castle-mcp.bundle.min.mjs")))
      .toBe(join("dist", "dev.bundle.min.mjs"));
  });

  it("returns the sibling dev bundle for a versioned castle-mcp bundle name", () => {
    expect(resolveDevScriptPath(join("cache", "castle-mcp-2.76.1.bundle.min.mjs")))
      .toBe(join("cache", "dev-2.76.1.bundle.min.mjs"));
  });

  it("passes through a dev bundle path unchanged", () => {
    const devBundle = join("dist", "dev.bundle.min.mjs");
    expect(resolveDevScriptPath(devBundle)).toBe(devBundle);
  });

  it("passes through an arbitrary CLI shim path unchanged (no PATH-dependent shim lookup)", () => {
    const shim = "/usr/local/bin/red-skills-dev";
    expect(resolveDevScriptPath(shim)).toBe(shim);
  });
});
