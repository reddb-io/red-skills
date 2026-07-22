import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createEnginePaths,
  fleetRegistryPath,
  readFleetProfile,
} from "@reddb-io/red-castle/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime/supervisor-spawn.js", () => ({
  spawnSupervisor: vi.fn(),
}));

import { createDevAfkMcpDependencies } from "../src/mcp-adapter.js";
import { spawnSupervisor } from "../src/runtime/supervisor-spawn.js";
import { afkPaths } from "../src/runtime/wire.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  vi.mocked(spawnSupervisor).mockReset();
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "mcp-fleet-create-"));
  roots.push(value);
  return value;
}

describe("fleet_create startup probe", () => {
  it("returns a launched profile when the supervisor survives the probe", async () => {
    const cwd = await root();
    vi.mocked(spawnSupervisor).mockResolvedValue(43120);

    await expect(
      createDevAfkMcpDependencies(cwd).fleetCreate({
        name: "healthy",
        runner: "codex",
        target: 2,
      }),
    ).resolves.toMatchObject({
      status: "launched",
      pid: 43120,
      target: 2,
      profile: { name: "healthy", runner: "codex" },
    });
  });

  it("surfaces the supervisor death evidence and rolls back the profile", async () => {
    const cwd = await root();
    const paths = afkPaths(cwd, "fast-death");
    await mkdir(dirname(paths.supervisorLogPath), { recursive: true });
    await writeFile(
      paths.supervisorLogPath,
      [
        "supervisor booting",
        "hook configuration rejected",
        "unknown hook name: fatal_boot",
      ].join("\n"),
      "utf8",
    );
    vi.mocked(spawnSupervisor).mockResolvedValue(null);

    await expect(
      createDevAfkMcpDependencies(cwd).fleetCreate({
        name: "fast-death",
        runner: "codex",
        target: 1,
      }),
    ).rejects.toThrow(
      /supervisor pid file did not appear[\s\S]*unknown hook name: fatal_boot/,
    );

    await expect(
      readFleetProfile(
        fleetRegistryPath(createEnginePaths(join(cwd, ".red"))),
        "fast-death",
      ),
    ).resolves.toBeUndefined();
  });
});
