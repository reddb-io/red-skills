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

import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";
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
});
