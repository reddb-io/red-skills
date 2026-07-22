import { access, mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTmpJanitorReport, collectTmpJanitorReport } from "../src/runtime/tmp-janitor.js";
import { LOGS_TTL_S, SCRATCH_TTL_S } from "../src/core/tmp-janitor.js";

const NOW = 1_800_000_000;
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-janitor-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("tmp janitor runtime", () => {
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
});
