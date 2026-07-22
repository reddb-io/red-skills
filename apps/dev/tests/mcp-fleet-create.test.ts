import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSupervisor = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../src/runtime/supervisor-spawn.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/supervisor-spawn.js")>(),
  spawnSupervisor,
}));

import { createDevAfkMcpDependencies } from "../src/mcp-adapter.js";
import { afkPaths } from "../src/runtime/wire.js";

const roots: string[] = [];

afterEach(async () => {
  spawnSupervisor.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fleet_create startup failure", () => {
  it("includes the child stderr tail from the supervisor log", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-fleet-create-"));
    roots.push(root);
    const paths = afkPaths(root, "nightly");
    await mkdir(dirname(paths.supervisorLogPath), { recursive: true });
    await writeFile(paths.supervisorLogPath, "earlier line\nchild boot exploded\n", "utf8");

    await expect(
      createDevAfkMcpDependencies(root).fleetCreate({
        name: "nightly",
        runner: "codex",
        target: 1,
      }),
    ).rejects.toThrow(/failed to start[\s\S]*child boot exploded/);
  });
});
