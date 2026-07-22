import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createEnginePaths,
  fleetRegistryPath,
  readFleetProfile,
  removeFleetProfile,
} from "@reddb-io/red-castle/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime/supervisor-spawn.js", () => ({
  spawnSupervisor: vi.fn(),
}));

vi.mock("@reddb-io/red-castle/engine", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@reddb-io/red-castle/engine")
  >();
  return {
    ...actual,
    removeFleetProfile: vi.fn(actual.removeFleetProfile),
  };
});

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
  vi.mocked(removeFleetProfile).mockClear();
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

  it("surfaces only this launch's supervisor death evidence and rolls back the profile", async () => {
    const cwd = await root();
    const paths = afkPaths(cwd, "fast-death");
    await mkdir(dirname(paths.supervisorLogPath), { recursive: true });
    await writeFile(
      paths.supervisorLogPath,
      "stale failure from an earlier launch\n",
      "utf8",
    );
    vi.mocked(spawnSupervisor).mockImplementation(async () => {
      await appendFile(
        paths.supervisorLogPath,
        [
          "supervisor booting",
          "hook configuration rejected",
          "unknown hook name: fatal_boot",
        ].join("\n"),
        "utf8",
      );
      return null;
    });

    const failure = await createDevAfkMcpDependencies(cwd)
      .fleetCreate({
        name: "fast-death",
        runner: "codex",
        target: 1,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /supervisor pid file did not appear[\s\S]*unknown hook name: fatal_boot/,
    );
    expect((failure as Error).message).not.toContain(
      "stale failure from an earlier launch",
    );

    await expect(
      readFleetProfile(
        fleetRegistryPath(createEnginePaths(join(cwd, ".red"))),
        "fast-death",
      ),
    ).resolves.toBeUndefined();
  });

  it("reports an unconfirmed rollback when removing the profile fails", async () => {
    const cwd = await root();
    vi.mocked(spawnSupervisor).mockResolvedValue(null);
    vi.mocked(removeFleetProfile).mockRejectedValueOnce(
      new Error("registry write failed"),
    );

    await expect(
      createDevAfkMcpDependencies(cwd).fleetCreate({
        name: "rollback-failure",
        runner: "codex",
        target: 1,
      }),
    ).rejects.toThrow(/profile rollback was attempted but could not be confirmed/);

    await expect(
      readFleetProfile(
        fleetRegistryPath(createEnginePaths(join(cwd, ".red"))),
        "rollback-failure",
      ),
    ).resolves.toMatchObject({ name: "rollback-failure", runner: "codex" });
  });
});
