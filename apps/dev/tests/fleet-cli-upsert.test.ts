// CLI fleet N launch must upsert its profile into the registry so the
// registry never diverges from reality (#2358).

import { vi, describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnginePaths, fleetRegistryPath, readFleetProfile } from "@reddb-io/red-castle/engine";

vi.mock("../src/runtime/supervisor-spawn.js", () => ({
  spawnSupervisor: vi.fn(async () => 7777),
}));

vi.mock("../src/runtime/supervisor-watchdog-spawn.js", () => ({
  spawnSupervisorWatchdog: vi.fn(async () => 7778),
}));

// Import after mock is hoisted so launchFleet picks up the stub.
const { launchFleet } = await import("../src/commands/fleet.js");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "fleet-cli-upsert-"));
  roots.push(r);
  return r;
}

describe("CLI fleet N launch — profile upsert", () => {
  it("registers its profile in the fleet registry after a successful spawn", async () => {
    const cwd = await root();
    const silent = { write: () => true } as unknown as NodeJS.WritableStream;

    const result = await launchFleet(["2", "--runner", "claude"], cwd, silent);
    expect(result.status).toBe("launched");
    expect(result.pid).toBe(7777);

    const profile = await readFleetProfile(
      fleetRegistryPath(createEnginePaths(join(cwd, ".red"))),
      "default",
    );
    expect(profile).toMatchObject({ name: "default", runner: "claude" });
  });

  it("registers the named fleet's profile when --fleet is supplied", async () => {
    const cwd = await root();
    const silent = { write: () => true } as unknown as NodeJS.WritableStream;

    await launchFleet(["2", "--runner", "codex", "--fleet", "alpha"], cwd, silent);

    const profile = await readFleetProfile(
      fleetRegistryPath(createEnginePaths(join(cwd, ".red"))),
      "alpha",
    );
    expect(profile).toMatchObject({ name: "alpha", runner: "codex" });
  });
});
