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
import { afkPaths } from "../src/runtime/wire.js";

const roots: string[] = [];

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

describe("spawnSupervisor", () => {
  it("honours the configured pid-file probe deadline", async () => {
    const cwd = await root();
    const startedAt = performance.now();

    await expect(spawnSupervisor({
      root: cwd,
      target: 1,
      runner: "codex",
      probeDeadlineMs: 1,
    })).resolves.toBeNull();

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("captures child stderr in the named fleet supervisor log", async () => {
    const cwd = await root();
    const paths = afkPaths(cwd, "nightly");
    spawn.mockImplementationOnce((_command, _args, options) => {
      const stdio = (options as { stdio: [string, string, number] }).stdio;
      writeSync(stdio[2], "supervisor boot failed\n");
      expect(readFileSync(paths.supervisorLogPath, "utf8"))
        .toContain("supervisor boot failed");
      return { unref: vi.fn() };
    });

    await spawnSupervisor({
      root: cwd,
      target: 1,
      runner: "codex",
      fleet: "nightly",
      probeDeadlineMs: 0,
    });

    expect(readFileSync(paths.supervisorLogPath, "utf8"))
      .toContain("supervisor boot failed");
  });

  it("reaps stale supervisor state in the parent before spawning", async () => {
    const cwd = await root();
    const paths = afkPaths(cwd, "nightly");
    await mkdir(paths.supervisorRuntimeDir, { recursive: true });
    await writeFile(paths.supervisorStopPath, "stale", "utf8");

    await spawnSupervisor({
      root: cwd,
      target: 1,
      runner: "codex",
      fleet: "nightly",
      probeDeadlineMs: 0,
    });

    expect(existsSync(paths.supervisorStopPath)).toBe(false);
  });

  it("propagates the fleet profile base as the worker Trunk override", async () => {
    const cwd = await root();

    await spawnSupervisor({
      root: cwd,
      target: 1,
      runner: "codex",
      base: " develop ",
      probeDeadlineMs: 0,
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
        root: cwd,
        target: 1,
        runner: "claude",
        probeDeadlineMs: 0,
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
        root: cwd,
        target: 1,
        runner: "claude",
        probeDeadlineMs: 0,
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
        root: cwd,
        target: 1,
        runner: "claude",
        probeDeadlineMs: 0,
      });
      const args = spawn.mock.calls.at(-1)?.[1] as string[] | undefined;
      expect(args?.[0]).toBe(join("/npx-cache", "dev-2.76.1.bundle.min.mjs"));
    } finally {
      process.argv[1] = saved;
    }
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
