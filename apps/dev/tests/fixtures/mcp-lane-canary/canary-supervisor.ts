// The canary harness's supervisor role.
//
// It is deliberately thin around ONE piece of production code: the real
// `buildSupervisorDeps(...).proc.spawnSlot`, which is where #2677 lived — the
// slot's worker entry was inferred from argv[1], so an MCP-launched supervisor
// spawned every slot against a bundle that cannot route `run`. Everything else
// here (pid anchor, heartbeat snapshot, stop handling) is the minimum a fleet
// needs to be observable, so the harness needs no GitHub queue to drive the
// lane end to end.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSupervisorDeps } from "../../../src/commands/supervise.js";
import { readPidStartTime } from "../../../src/core/state.js";
import { encodeDevSnapshotToon } from "../../../src/core/toon-snapshot.js";
import { slotLogDir } from "../../../src/runtime/supervisor-fs.js";
import { afkPaths } from "../../../src/runtime/wire.js";

const HEARTBEAT_MS = 300;

export async function canarySupervise(_args: readonly string[]): Promise<number> {
  const root = process.cwd();
  const paths = afkPaths(root);
  const slotLogsDir = slotLogDir(paths.tmpDir);
  mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
  mkdirSync(slotLogsDir, { recursive: true });
  mkdirSync(join(paths.tmpDir, "workers"), { recursive: true });

  // The pinned identity anchor `project_start`'s launch probe and `project_status`
  // both read. Without it the launch reads as a fast death.
  const startTime = readPidStartTime(process.pid);
  if (startTime === null) {
    process.stderr.write("canary supervisor: cannot pin process start time\n");
    return 1;
  }
  writeFileSync(paths.supervisorPidStartPath, startTime, "utf8");
  writeFileSync(paths.supervisorPidPath, String(process.pid), "utf8");

  const runner = process.env.RED_AFK_RUNNER ?? "claude";
  const target = Number(process.env.RED_AFK_TARGET ?? "1") || 1;

  const deps = buildSupervisorDeps(
    root,
    paths.tmpDir,
    slotLogsDir,
    paths.fleetFirehosePath,
    paths.fleetStatePath,
    `s${process.pid}`,
    runner,
    300,
    { cwd: root, repo: "" },
    "main",
    [],
  );

  // THE assertion this harness exists for: the production slot spawn, with the
  // production entry resolution, against whichever bundle sits beside argv[1].
  const slot = await deps.proc.spawnSlot(0, undefined);

  const publish = (): void => {
    const epoch = Math.floor(Date.now() / 1000);
    const alive = slot.pid > 0 && isLive(slot.pid);
    const body = encodeDevSnapshotToon({
      ts: new Date(epoch * 1000).toISOString(),
      epoch,
      last_progress_epoch: epoch,
      target,
      runner,
      shrink_mode: "drain-then-retire",
      ready_for_agent: 0,
      slots: {
        busy: alive ? 1 : 0,
        free: alive ? target - 1 : target,
        total: target,
        parked: 0,
      },
      slot_pids: alive ? [{ slot: 0, pid: slot.pid }] : [],
      spawns_this_tick: 0,
    });
    const tmp = `${paths.fleetStatePath}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, paths.fleetStatePath);
  };
  publish();

  return new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      clearInterval(timer);
      rmSync(paths.supervisorPidPath, { force: true });
      rmSync(paths.supervisorPidStartPath, { force: true });
      resolve(code);
    };
    const timer = setInterval(() => {
      publish();
      // `project_stop` without --force publishes intent through the stop file.
      if (existsSync(paths.supervisorStopPath)) finish(0);
    }, HEARTBEAT_MS);
    process.once("SIGTERM", () => finish(143));
    process.once("SIGINT", () => finish(130));
  });
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
