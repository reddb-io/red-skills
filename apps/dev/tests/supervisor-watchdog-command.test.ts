import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import { readPidStartTime } from "../src/core/state.js";
import { afkPaths } from "../src/runtime/wire.js";

const spawnSupervisor = vi.hoisted(() => vi.fn(async () => process.pid));

vi.mock("../src/runtime/supervisor-spawn.js", () => ({ spawnSupervisor }));
vi.mock("../src/runtime/gh.js", () => ({ countReadyForAgent: vi.fn(async () => 3) }));
vi.mock("../src/runtime/wire.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/wire.js")>();
  return { ...actual, resolveRepoSlug: vi.fn(async () => "owner/repo") };
});

const { supervisorWatchdogCommand } = await import("../src/commands/supervisor-watchdog.js");

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  delete process.env.RED_AFK_POLL_S;
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  spawnSupervisor.mockClear();
});

describe("persistent supervisor watchdog command (#2442)", () => {
  it("respawns within one poll window after the pinned steady-state supervisor is killed", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "supervisor-watchdog-")),
    );
    roots.push(root);
    const paths = afkPaths(root);
    await mkdir(paths.supervisorRuntimeDir, { recursive: true });

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    expect(child.pid).toBeTypeOf("number");
    const pid = child.pid!;
    const startTime = readPidStartTime(pid);
    expect(startTime).not.toBeNull();
    await writeFile(paths.supervisorPidPath, String(pid), "utf8");
    await writeFile(paths.supervisorPidStartPath, startTime!, "utf8");
    const epoch = Math.floor(Date.now() / 1000);
    await writeFile(
      paths.fleetStatePath,
      encodeDevSnapshotToon({
        ts: new Date(epoch * 1000).toISOString(),
        epoch,
        last_progress_epoch: epoch,
        target: 1,
        runner: "codex",
        ready_for_agent: 3,
        slots: { busy: 0, free: 1, total: 1, parked: 0 },
        slot_pids: [],
        spawns_this_tick: 0,
      }),
      "utf8",
    );

    process.env.RED_AFK_POLL_S = "1";
    const started = Date.now();
    const watchdog = supervisorWatchdogCommand([], root);
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGKILL");
    await once(child, "exit");
    await watchdog;

    expect(spawnSupervisor).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
