import { access, mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTmpJanitorReport,
  collectTmpJanitorReport,
  runTmpJanitor,
  selectOrphanTestRunners,
} from "../src/runtime/tmp-janitor.js";
import { KNOWN_TMP_LANES, LOGS_TTL_S, SCRATCH_TTL_S } from "../src/core/tmp-janitor.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import { discoverLiveSupervisorPid } from "../src/runtime/supervisor-state.js";
import { readPidStartTime } from "../src/core/state.js";

const NOW = 1_800_000_000;
const roots: string[] = [];

/** A fleet `state.toon` whose supervisor liveness anchor is `pid`. */
function fleetSnapshot(pid: number): string {
  return encodeDevSnapshotToon({
    ts: new Date(NOW * 1000).toISOString(),
    epoch: NOW,
    runner: "claude",
    pid,
    ready_for_agent: 0,
    slots: { busy: 0, free: 1, total: 1, parked: 0 },
    slot_pids: [],
    spawns_this_tick: 0,
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-janitor-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tmp janitor runtime", () => {
  it("selects only old reparented test runners inside the tmp workspace", () => {
    const tmp = "/repo/.red/tmp";
    const base = {
      pid: 200,
      ppid: 10,
      pgid: 190,
      sid: 10,
      ageS: 600,
      cwd: `${tmp}/workers/wTEST/2432/worktree`,
      command: "node (vitest 2)",
    };

    expect(selectOrphanTestRunners([
      base,
      { ...base, pid: 201, ppid: 199 },
      { ...base, pid: 202, pgid: 10 },
      { ...base, pid: 203, ageS: 30 },
      { ...base, pid: 204, cwd: "/repo/packages/dev" },
      { ...base, pid: 205, command: "node server.js" },
    ], tmp)).toEqual([base]);
  });

  it("reaps and logs every orphan test-runner group during a fixing sweep", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const report = await collectTmpJanitorReport(tmp, NOW, () => "UNKNOWN");
    report.orphanTestRunners = [{
      pid: 200,
      ppid: 10,
      pgid: 190,
      sid: 10,
      ageS: 600,
      cwd: join(tmp, "workers", "wTEST", "2432", "worktree"),
      command: "node (vitest 2)",
    }];
    const reapProcessGroup = vi.fn(async () => true);
    const log = vi.fn();

    const applied = await applyTmpJanitorReport(tmp, report, { reapProcessGroup, log });

    expect(reapProcessGroup).toHaveBeenCalledWith(190);
    expect(applied.orphanTestRunners).toEqual([{ pid: 200, pgid: 190 }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pid=200 pgid=190"));
  });

  it("reports and fixes expired lanes, closed dead workers, and audited unknown root dirs", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    await mkdir(join(tmp, "scratch", "old"), { recursive: true });
    await mkdir(join(tmp, "work-old"), { recursive: true });
    await mkdir(join(tmp, "workers", "wOLD", "1961-a1"), { recursive: true });
    await writeFile(join(tmp, "afk-supervisor-slot-0.log"), "legacy slot log\n", "utf8");
    await writeFile(join(tmp, "workers", "wOLD", "worker.pid"), "999999999", "utf8");
    await utimes(join(tmp, "scratch", "old"), NOW - SCRATCH_TTL_S - 10, NOW - SCRATCH_TTL_S - 10);
    await utimes(join(tmp, "afk-supervisor-slot-0.log"), NOW - LOGS_TTL_S - 10, NOW - LOGS_TTL_S - 10);

    const report = await collectTmpJanitorReport(tmp, NOW, (issue) => issue === 1961 ? "CLOSED" : "UNKNOWN");

    expect(report.plan.scratch.reclaim.map((entry) => entry.path)).toEqual([join(tmp, "scratch", "old")]);
    expect(report.plan.legacySlotLogs.reclaim.map((entry) => entry.path)).toEqual([join(tmp, "afk-supervisor-slot-0.log")]);
    expect(report.plan.unknownTmpRoots).toEqual(["work-old"]);
    expect(report.staleWorkers.reclaim.map((entry) => entry.path)).toEqual([join(tmp, "workers", "wOLD")]);

    const applied = await applyTmpJanitorReport(tmp, report);
    expect(applied.expiredLanes).toEqual([join(tmp, "scratch", "old"), join(tmp, "afk-supervisor-slot-0.log")]);
    expect(applied.staleWorkers).toEqual([join(tmp, "workers", "wOLD")]);
    expect(applied.unknownTmpRoots).toEqual([join(tmp, "work-old")]);
    expect(await readdir(tmp)).toEqual(["scratch", "workers"]);
  });

  it("rechecks worker.pid during fix and refuses to delete a now-live worker anchor", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const worker = join(tmp, "workers", "wLIVE");
    await mkdir(join(worker, "1961-a1"), { recursive: true });
    await writeFile(join(worker, "worker.pid"), "999999999", "utf8");

    const report = await collectTmpJanitorReport(tmp, NOW, () => "CLOSED");
    await writeFile(join(worker, "worker.pid"), String(process.pid), "utf8");

    const applied = await applyTmpJanitorReport(tmp, report);
    expect(applied.staleWorkers).toEqual([]);
    expect(applied.protectedLiveWorkers).toEqual([worker]);
    expect(await readdir(worker)).toEqual(["1961-a1", "worker.pid"]);
  });

  it("never TTL-reclaims a feedback worktree owned by a live worker", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const worker = join(tmp, "workers", "wLIVE");
    const feedback = join(tmp, "worktrees", "feedback", "afk-wLIVE-2450-live-gate");
    await mkdir(worker, { recursive: true });
    await mkdir(join(feedback, "node_modules", "tinypool", "dist", "entry"), { recursive: true });
    await writeFile(join(worker, "worker.pid"), String(process.pid), "utf8");
    await writeFile(join(feedback, "node_modules", "tinypool", "dist", "entry", "process.js"), "export {};\n", "utf8");
    await utimes(feedback, 1, 1);

    const report = await collectTmpJanitorReport(tmp, NOW, () => "OPEN");

    expect(report.plan.feedbackWorktrees.reclaim).toEqual([]);
    expect(report.orphanFeedback.reclaim).toEqual([]);
    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(join(feedback, "node_modules", "tinypool", "dist", "entry", "process.js"))).resolves.toBeUndefined();
    expect(applied.protectedLiveFeedback).toEqual([feedback]);
  });

  it("rechecks feedback ownership at removal time and logs the liveness verdict", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const worker = join(tmp, "workers", "wRACE");
    const feedback = join(tmp, "worktrees", "feedback", "afk-wRACE-2450-race");
    await mkdir(worker, { recursive: true });
    await mkdir(feedback, { recursive: true });
    await writeFile(join(worker, "worker.pid"), "999999999", "utf8");
    await utimes(feedback, 1, 1);

    const report = await collectTmpJanitorReport(tmp, NOW, () => "CLOSED");
    await writeFile(join(worker, "worker.pid"), String(process.pid), "utf8");

    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(feedback)).resolves.toBeUndefined();
    expect(applied.protectedLiveFeedback).toEqual([feedback]);
    expect(applied.removals).not.toContainEqual(expect.objectContaining({ path: feedback }));
  });

  it("spares a resumed branch when its old worker is dead but the issue claim is live", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const oldWorker = join(tmp, "workers", "wOLD");
    const feedback = join(tmp, "worktrees", "feedback", "afk-wOLD-2450-resumed-branch");
    await mkdir(oldWorker, { recursive: true });
    await mkdir(feedback, { recursive: true });
    await mkdir(join(tmp, "claims", "2450"), { recursive: true });
    await writeFile(join(oldWorker, "worker.pid"), "999999999", "utf8");
    await writeFile(join(tmp, "claims", "2450", "pid"), String(process.pid), "utf8");
    await utimes(feedback, 1, 1);

    const report = await collectTmpJanitorReport(tmp, NOW, () => "OPEN");
    expect(report.plan.feedbackWorktrees.reclaim).toEqual([]);
    expect(report.orphanFeedback.reclaim).toEqual([]);

    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(feedback)).resolves.toBeUndefined();
    expect(applied.protectedLiveFeedback).toEqual([feedback]);
  });

  it("spares a supervisor fleet dir whose pid is live", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const supervisorDir = join(tmp, "supervisors", "default");
    await mkdir(supervisorDir, { recursive: true });
    await writeFile(join(supervisorDir, "afk-supervisor.pid"), String(process.pid), "utf8");
    await writeFile(join(supervisorDir, "state.toon"), "{}", "utf8");

    const report = await collectTmpJanitorReport(tmp, NOW, () => "UNKNOWN");

    expect(report.staleSupervisors.spare.map((e) => e.path)).toEqual([supervisorDir]);
    expect(report.staleSupervisors.reclaim).toEqual([]);
    expect(report.plan.unknownTmpRoots).not.toContain("supervisors");

    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(supervisorDir)).resolves.toBeUndefined();
    expect(applied.protectedLiveSupervisors).toContain(supervisorDir);
    expect(applied.staleSupervisors).toEqual([]);
  });

  it("reaps a supervisor fleet dir whose pid is dead", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const supervisorDir = join(tmp, "supervisors", "default");
    await mkdir(supervisorDir, { recursive: true });
    await writeFile(join(supervisorDir, "afk-supervisor.pid"), "999999999", "utf8");
    await writeFile(join(supervisorDir, "state.toon"), "{}", "utf8");

    const report = await collectTmpJanitorReport(tmp, NOW, () => "UNKNOWN");

    expect(report.staleSupervisors.reclaim.map((e) => e.path)).toEqual([supervisorDir]);
    expect(report.staleSupervisors.spare).toEqual([]);
    expect(report.plan.unknownTmpRoots).not.toContain("supervisors");

    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(supervisorDir)).rejects.toThrow();
    expect(applied.staleSupervisors).toContain(supervisorDir);
    expect(applied.protectedLiveSupervisors).toEqual([]);
  });

  it("re-checks supervisor pid at apply time and protects a now-live supervisor", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const supervisorDir = join(tmp, "supervisors", "default");
    await mkdir(supervisorDir, { recursive: true });
    await writeFile(join(supervisorDir, "afk-supervisor.pid"), "999999999", "utf8");

    const report = await collectTmpJanitorReport(tmp, NOW, () => "UNKNOWN");
    // Simulate supervisor coming alive between collect and apply
    await writeFile(join(supervisorDir, "afk-supervisor.pid"), String(process.pid), "utf8");

    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(supervisorDir)).resolves.toBeUndefined();
    expect(applied.protectedLiveSupervisors).toContain(supervisorDir);
    expect(applied.staleSupervisors).toEqual([]);
  });

  // ---------- #2679: the live lane must survive without a pid file ----------

  it("spares a supervisor fleet dir whose state snapshot names a live pid and has no pid file", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const supervisorDir = join(tmp, "supervisors", "default");
    await mkdir(supervisorDir, { recursive: true });
    await writeFile(join(supervisorDir, "state.toon"), fleetSnapshot(process.pid), "utf8");

    const report = await collectTmpJanitorReport(tmp, NOW, () => "UNKNOWN");

    expect(report.staleSupervisors.spare.map((e) => e.path)).toEqual([supervisorDir]);
    expect(report.staleSupervisors.reclaim).toEqual([]);

    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(supervisorDir)).resolves.toBeUndefined();
    expect(applied.protectedLiveSupervisors).toContain(supervisorDir);
    expect(applied.removals.map((r) => r.path)).not.toContain(supervisorDir);
  });

  it("reaps a supervisor fleet dir whose state snapshot names a dead pid", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const supervisorDir = join(tmp, "supervisors", "default");
    await mkdir(supervisorDir, { recursive: true });
    await writeFile(join(supervisorDir, "state.toon"), fleetSnapshot(999_999_999), "utf8");

    const report = await collectTmpJanitorReport(tmp, NOW, () => "UNKNOWN");

    expect(report.staleSupervisors.reclaim.map((e) => e.path)).toEqual([supervisorDir]);

    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(supervisorDir)).rejects.toThrow();
    expect(applied.staleSupervisors).toContain(supervisorDir);
  });

  it("spares a supervisor fleet dir whose s<pid> log dir names a live pid", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const supervisorDir = join(tmp, "supervisors", "default");
    await mkdir(join(supervisorDir, `s${process.pid}`), { recursive: true });
    await writeFile(join(supervisorDir, `s${process.pid}`, "supervisor.log.toonl"), "", "utf8");

    const report = await collectTmpJanitorReport(tmp, NOW, () => "UNKNOWN");

    expect(report.staleSupervisors.spare.map((e) => e.path)).toEqual([supervisorDir]);

    const applied = await applyTmpJanitorReport(tmp, report);
    await expect(access(supervisorDir)).resolves.toBeUndefined();
    expect(applied.protectedLiveSupervisors).toContain(supervisorDir);
  });

  it("never removes a registered lane through the unknown-entry path", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const supervisorDir = join(tmp, "supervisors", "default");
    await mkdir(supervisorDir, { recursive: true });
    await writeFile(join(supervisorDir, "state.toon"), fleetSnapshot(process.pid), "utf8");
    await mkdir(join(tmp, "work-old"), { recursive: true });

    const report = await collectTmpJanitorReport(tmp, NOW, () => "UNKNOWN");
    expect(report.plan.unknownTmpRoots).toEqual(["work-old"]);
    // Simulate a plan built by an older bundle (or a drifted lane registry) that
    // named a registered lane as unknown — apply must still refuse to delete it.
    report.plan.unknownTmpRoots = [...KNOWN_TMP_LANES, "work-old"];

    const applied = await applyTmpJanitorReport(tmp, report);
    for (const lane of KNOWN_TMP_LANES) {
      expect(applied.removals.map((r) => r.path)).not.toContain(join(tmp, lane));
      expect(applied.unknownTmpRoots).not.toContain(join(tmp, lane));
    }
    await expect(access(supervisorDir)).resolves.toBeUndefined();
    expect(applied.unknownTmpRoots).toEqual([join(tmp, "work-old")]);
  });

  it("keeps fleet-truth pid discovery working after a boot sweep on a live fleet", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const supervisorDir = join(tmp, "supervisors", "default");
    await mkdir(supervisorDir, { recursive: true });
    await writeFile(join(supervisorDir, "afk-supervisor.pid"), String(process.pid), "utf8");
    await writeFile(
      join(supervisorDir, "afk-supervisor.pid.start"),
      readPidStartTime(process.pid) ?? "",
      "utf8",
    );
    await writeFile(join(supervisorDir, "state.toon"), fleetSnapshot(process.pid), "utf8");

    await runTmpJanitor(tmp, NOW, () => "UNKNOWN", { fix: true });

    // This is what `fleet_status` resolves: an absent runtime dir reports
    // `pid 0, alive false` for a provably live supervisor (#2679).
    const discovered = await discoverLiveSupervisorPid(supervisorDir);
    expect(discovered).not.toBeNull();
    expect(discovered?.pid).toBe(process.pid);
  });
});
