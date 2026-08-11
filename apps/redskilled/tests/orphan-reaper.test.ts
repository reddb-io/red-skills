import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { createRedskilledEventLane, readRedskilledEvents } from "../src/event-lane.js";
import {
  censusRedskilledProcesses,
  createRedskilledOrphanReaperRuntime,
  DEFAULT_REDSKILLED_ORPHAN_REAPER_MS,
  reapStampedOrphan,
  redskilledOrphanReaperMode,
  selectOrphanReaperCandidates,
  type RedskilledProcessCensusRow,
} from "../src/orphan-reaper.js";
import { resolveRedskilledPaths } from "../src/paths.js";

const roots: string[] = [];
const daemons: RedskilledDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function procStat(row: { pid: number; ppid: number; pgid: number; sid: number; starttime: number }): string {
  const fields = Array.from({ length: 22 }, () => "0");
  fields[0] = "S";
  fields[1] = String(row.ppid);
  fields[2] = String(row.pgid);
  fields[3] = String(row.sid);
  fields[19] = String(row.starttime);
  return `${row.pid} (worker with spaces) ${fields.join(" ")}\n`;
}

function processRow(overrides: Partial<RedskilledProcessCensusRow> = {}): RedskilledProcessCensusRow {
  return {
    pid: 4_242,
    ppid: 1,
    pgid: 4_242,
    sid: 4_242,
    starttime: "1200",
    age_ms: 10 * 60_000,
    worker_id: "hLOST",
    born_at: "2026-08-11T10:00:00.000Z",
    cwd: "/repo/.red/tmp/workers/wLOST/3589/worktree",
    under_workers_lane: true,
    ...overrides,
  };
}

describe("the orphan reaper candidate selector", () => {
  it("selects an unknown stamped process-group leader after the orphan grace", () => {
    expect(selectOrphanReaperCandidates({
      processes: [processRow()],
      held_worker_ids: new Set(),
      live_birth_ids: new Set(),
    })).toEqual([{
      kind: "reap",
      process: processRow(),
      detail: "stamped Worker hLOST has no live birth and is at least 10 minutes old",
    }]);
  });

  it("adopts a stamped process with a live birth but no daemon holder", () => {
    expect(selectOrphanReaperCandidates({
      processes: [processRow({ age_ms: 1_000 })],
      held_worker_ids: new Set(),
      live_birth_ids: new Set(["hLOST"]),
    })).toEqual([{
      kind: "adopt",
      process: processRow({ age_ms: 1_000 }),
      detail: "stamped Worker hLOST has a live birth but no daemon holder",
    }]);
  });

  it("reports an aged unstamped process reparented under a workers lane", () => {
    expect(selectOrphanReaperCandidates({
      processes: [processRow({ worker_id: undefined, born_at: undefined, age_ms: 30 * 60_000 })],
      held_worker_ids: new Set(),
      live_birth_ids: new Set(),
    })).toEqual([{
      kind: "suspect",
      process: processRow({ worker_id: undefined, born_at: undefined, age_ms: 30 * 60_000 }),
      detail: "unstamped process 4242 was reparented under a workers lane and is at least 30 minutes old; it will never be signalled",
    }]);
  });

  it("ignores strangers, held Workers, young stamps and stamped descendants", () => {
    expect(selectOrphanReaperCandidates({
      processes: [
        processRow({ worker_id: undefined, under_workers_lane: false, cwd: "/srv/stranger", age_ms: 60 * 60_000 }),
        processRow({ worker_id: "hHELD" }),
        processRow({ worker_id: "hYOUNG", age_ms: 10 * 60_000 - 1 }),
        processRow({ worker_id: "hCHILD", pid: 4_243, pgid: 4_242 }),
      ],
      held_worker_ids: new Set(["hHELD"]),
      live_birth_ids: new Set(),
    })).toEqual([]);
  });
});

describe("the daemon orphan-reaper control", () => {
  it("runs every five minutes and obeys off/report kill-switch values", () => {
    expect(DEFAULT_REDSKILLED_ORPHAN_REAPER_MS).toBe(5 * 60_000);
    expect(redskilledOrphanReaperMode({})).toBe("reap");
    expect(redskilledOrphanReaperMode({ REDSKILLED_ORPHAN_REAPER: "report" })).toBe("report");
    expect(redskilledOrphanReaperMode({ REDSKILLED_ORPHAN_REAPER: "off" })).toBe("off");
  });
});

describe("the orphan reaper process census", () => {
  it("reads stamp, cwd, pgid, sid and starttime for a reparented candidate", async () => {
    const root = await scratch("redskilled-orphan-proc-");
    const processDir = join(root, "4242");
    const cwd = join(root, "repo", ".red", "tmp", "workers", "wLOST", "3589", "worktree");
    await mkdir(processDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, "uptime"), "10000.00 0.00\n", "utf8");
    await writeFile(join(processDir, "stat"), procStat({ pid: 4242, ppid: 1, pgid: 4242, sid: 4000, starttime: 900000 }), "utf8");
    await writeFile(
      join(processDir, "environ"),
      "RED_WORKER_ID=hLOST\0RED_WORKER_BORN_AT=2026-08-11T10:00:00.000Z\0",
      "utf8",
    );
    await symlink(cwd, join(processDir, "cwd"));

    await expect(censusRedskilledProcesses({ proc_root: root })).resolves.toEqual([processRow({
      sid: 4000,
      starttime: "900000",
      age_ms: 1_000_000,
      cwd,
    })]);
  });

  it("turns a census failure into an empty snapshot", async () => {
    await expect(censusRedskilledProcesses({ proc_root: join(tmpdir(), "missing-redskilled-proc") }))
      .resolves.toEqual([]);
  });
});

describe("stamped orphan teardown", () => {
  it("keeps report mode free of daemon-map, signal and event-lane mutations", async () => {
    const mutations = { adopt: 0, kill: 0, laneWrites: 0 };
    const runtime = createRedskilledOrphanReaperRuntime({
      authorized: true,
      interval_ms: 0,
      mode: "report",
      census: () => [
        processRow(),
        processRow({ worker_id: "hLIVE", pid: 4_243, pgid: 4_243, age_ms: 1_000 }),
      ],
      clock: () => "2026-08-11T10:10:00.000Z",
      held_worker_ids: () => [],
      live_births: () => [{
        worker_id: "hLIVE",
        project_label: "acme/widgets",
        pid: 4_000,
        started_at: "2026-08-11T10:00:00.000Z",
        workspace_path: "/old/workspace",
        isolated: true,
        warnings: [],
      }],
      read_starttime: () => "1200",
      kill_group: async () => {
        mutations.kill += 1;
        return true;
      },
      report: () => undefined,
      adopt: (_worker, recordBirth) => {
        mutations.adopt += 1;
        if (recordBirth) mutations.laneWrites += 1;
      },
      record_reaped: () => {
        mutations.laneWrites += 1;
      },
    });

    await expect(runtime.sweep()).resolves.toEqual({ adopted: 0, reaped: 0, suspects: 0 });
    expect(mutations).toEqual({ adopt: 0, kill: 0, laneWrites: 0 });
  });

  it("does not let an injected census authorize a non-arbiter daemon", async () => {
    const root = await scratch("redskilled-orphan-authority-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}` },
      runtimeDir: root,
      machineClaimPath: join(root, "sandbox-machine-claim.toon"),
    });
    const mutations = { census: 0, adopt: 0, kill: 0 };
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      unitInventory: () => [],
      orphanReaperMs: 0,
      orphanCensus: async () => {
        mutations.census += 1;
        return [processRow()];
      },
      orphanStarttime: () => {
        mutations.adopt += 1;
        return "1200";
      },
      orphanKillGroup: async () => {
        mutations.kill += 1;
        return true;
      },
    });
    daemons.push(daemon);

    await expect(daemon.sweepOrphanProcesses()).resolves.toEqual({ adopted: 0, reaped: 0, suspects: 0 });
    expect(mutations).toEqual({ census: 0, adopt: 0, kill: 0 });
  });

  it("refuses to signal when the leader starttime changed after the census", async () => {
    const signalled: number[] = [];
    await expect(reapStampedOrphan(processRow(), {
      read_starttime: () => "1201",
      kill_group: async (pgid) => {
        signalled.push(pgid);
        return true;
      },
    })).resolves.toEqual({ reaped: false, reason: "leader-starttime-changed" });
    expect(signalled).toEqual([]);
  });

  it("writes adopted birth before orphan-reaped death", async () => {
    const root = await scratch("redskilled-orphan-daemon-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const killed: number[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      unitInventory: () => [],
      orphanReaperMs: 0,
      orphanCensus: async () => [processRow()],
      orphanStarttime: () => "1200",
      orphanKillGroup: async (pgid) => {
        killed.push(pgid);
        return true;
      },
    });
    daemons.push(daemon);

    await expect(daemon.sweepOrphanProcesses()).resolves.toEqual({ adopted: 1, reaped: 1, suspects: 0 });
    await daemon.flushEvents();

    expect(killed).toEqual([4_242]);
    expect(daemon.workerCount()).toBe(0);
    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.kind)).toEqual(["worker-birth", "worker-death"]);
    expect(events[0]!.detail).toMatch(/adopted stamped orphan/);
    expect(events[1]!.detail).toMatch(/orphan-reaped/);
  });

  it("adopts a stamped process whose live birth has no holder", async () => {
    const root = await scratch("redskilled-orphan-adopt-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    let snapshot: RedskilledProcessCensusRow[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      unitInventory: () => [],
      orphanReaperMs: 0,
      orphanCensus: async () => snapshot,
      orphanReport: () => undefined,
    });
    daemons.push(daemon);
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.recordWorker({
      kind: "worker-birth",
      worker: {
        worker_id: "hLOST",
        project_label: "acme/widgets",
        pid: 4_000,
        started_at: "2026-08-11T10:00:00.000Z",
        workspace_path: "/old/workspace",
        isolated: true,
        unit: "red-worker-hLOST.service",
        warnings: [],
      },
      ts: "2026-08-11T10:00:00.000Z",
    });
    snapshot = [processRow({ age_ms: 1_000 })];

    await expect(daemon.sweepOrphanProcesses()).resolves.toEqual({ adopted: 1, reaped: 0, suspects: 0 });
    expect(daemon.hostState().workers[0]).toMatchObject({
      worker_id: "hLOST",
      project_label: "acme/widgets",
      pid: 4_242,
      isolated: false,
    });
    expect(daemon.hostState().workers[0]!.unit).toBeUndefined();
  });

  it("reports unstamped suspects and report-mode stamped orphans without signalling either", async () => {
    const root = await scratch("redskilled-orphan-report-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const reports: string[] = [];
    const signalled: number[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      unitInventory: () => [],
      orphanReaperMs: 0,
      orphanReaperMode: "report",
      orphanCensus: async () => [
        processRow(),
        processRow({ worker_id: undefined, born_at: undefined, pid: 5_000, pgid: 5_000, age_ms: 30 * 60_000 }),
      ],
      orphanKillGroup: async (pgid) => {
        signalled.push(pgid);
        return true;
      },
      orphanReport: (detail) => reports.push(detail),
    });
    daemons.push(daemon);

    await expect(daemon.sweepOrphanProcesses()).resolves.toEqual({ adopted: 0, reaped: 0, suspects: 1 });
    expect(signalled).toEqual([]);
    expect(reports).toHaveLength(2);
    expect(reports.join(" ")).toMatch(/never be signalled/);
    expect(reports.join(" ")).toMatch(/report mode withheld adoption and signalling/);
  });
});
