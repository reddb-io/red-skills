// tmp-janitor-daemon-reclaim.test.ts — the janitor reclaims on the DAEMON's
// process truth, not on a missing pid file (Spec #2772 US 46, ADR 0130).
//
// Every tree below is built the way the failure that motivated this was shaped
// (#2679): the live lanes carry NO pid file at all, and the dead ones do. A
// janitor keyed on pid files gets each of these exactly backwards.

import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  planWorkerReclaim,
  type WorkerArtifact,
  type WorkerProcessVerdict,
} from "../src/core/worker-reclaim.js";
import {
  applyTmpJanitorReport,
  collectTmpJanitorReport,
  runTmpJanitor,
} from "../src/runtime/tmp-janitor.js";
import type { DaemonWorkerSetReader } from "../src/runtime/liveness-anchor.js";

const NOW = 1_800_000_000;
const NOW_ISO = new Date(NOW * 1000).toISOString();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-daemon-janitor-"));
  roots.push(root);
  return root;
}

/** A fresh daemon answer naming exactly these Workers. */
function daemonNaming(...workerIds: readonly string[]): DaemonWorkerSetReader {
  return async () => ({
    staleness: { stale: false, age_ms: 120, threshold_ms: 90_000, reason: "measured 120ms ago" },
    workers: workerIds.map((worker_id, index) => ({
      worker_id,
      project_label: "red-skills",
      pid: 4_000 + index,
    })),
  });
}

/** A daemon that answered, but about a measurement too old to act on. */
const staleDaemon: DaemonWorkerSetReader = async () => ({
  staleness: { stale: true, age_ms: 900_000, threshold_ms: 90_000, reason: "this answer is stale" },
  workers: [],
});

/** A daemon that did not answer at all. */
const noDaemon: DaemonWorkerSetReader = async () => null;

/** A Worker workspace with a git worktree and a log beside it, and no pid file. */
async function workspace(tmp: string, worker: string, issue: number): Promise<{
  issueDir: string;
  worktree: string;
  log: string;
}> {
  const issueDir = join(tmp, "workers", worker, String(issue));
  const worktree = join(issueDir, "worktree");
  await mkdir(join(worktree, "node_modules"), { recursive: true });
  const log = join(dirname(issueDir), "worker.log.toonl");
  await writeFile(log, "", "utf8");
  return { issueDir, worktree, log };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

describe("the janitor reclaims on the daemon's process truth", () => {
  it("spares a live Worker's workspace with no pid file anywhere on the tree", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const { worktree } = await workspace(tmp, "wLIVE", 2790);

    // Issues CLOSED so the issue rule cannot claim the credit: whatever survives
    // here survives because the daemon said so.
    const report = await collectTmpJanitorReport(tmp, NOW, () => "CLOSED", {
      daemon: daemonNaming("wLIVE"),
    });

    expect(report.workerReclaim.reclaim).toEqual([]);
    expect(report.workerReclaim.retain.map((verdict) => verdict.verdict)).toEqual([
      "worker-live",
      "worker-live",
    ]);
    expect(report.staleWorkers.reclaim).toEqual([]);

    const applied = await applyTmpJanitorReport(tmp, report, { daemon: daemonNaming("wLIVE") });
    expect(applied.workerWorkspaces).toEqual([]);
    expect(await exists(worktree)).toBe(true);
  });

  it("strips a dead Worker's OPEN-issue worktree at 14 days and leaves a tombstone with its evidence", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const { issueDir, worktree, log } = await workspace(tmp, "wDONE", 2789);
    const threshold = NOW - 14 * 86_400;
    await utimes(issueDir, threshold, threshold);
    await utimes(dirname(issueDir), threshold, threshold);

    // Issue OPEN, so the whole-dir rule stays out of it: the workspace goes
    // because the daemon does not name its Worker, with nothing else to help.
    const result = await runTmpJanitor(tmp, NOW, () => "OPEN", {
      fix: true,
      daemon: daemonNaming("wOTHER"),
    });

    expect(result.applied?.workerWorkspaces).toEqual([worktree]);
    expect(await exists(worktree)).toBe(false);
    expect(await exists(log)).toBe(true);
    expect(await exists(issueDir)).toBe(true);
    expect(await readFile(join(issueDir, "worktree.reclaimed"), "utf8")).toBe(
      `worktree reclaimed at ${NOW_ISO}\n`,
    );
  });

  it("reclaims a dead Worker's whole OPEN-issue directory at 45 days", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const { issueDir } = await workspace(tmp, "wEXPIRED", 3585);
    const workerDir = dirname(issueDir);
    const threshold = NOW - 45 * 86_400;
    await utimes(issueDir, threshold, threshold);
    await utimes(workerDir, threshold, threshold);

    const result = await runTmpJanitor(tmp, NOW, () => "OPEN", {
      fix: true,
      daemon: daemonNaming(),
    });

    expect(result.applied?.staleWorkers).toEqual([workerDir]);
    expect(await exists(workerDir)).toBe(false);
  });

  it("never reclaims through a pid file: an unanswered daemon spares everything", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const { worktree } = await workspace(tmp, "wGHOST", 2790);
    // A DEAD pid file — the exact input the predecessor read as permission.
    await writeFile(join(tmp, "workers", "wGHOST", "worker.pid"), "999999999", "utf8");

    for (const daemon of [noDaemon, staleDaemon]) {
      const result = await runTmpJanitor(tmp, NOW, () => "CLOSED", { fix: true, daemon });

      expect(result.workerReclaim.reclaim).toEqual([]);
      expect(result.workerReclaim.retain.map((verdict) => verdict.verdict)).toContain(
        "liveness-unknown",
      );
      expect(result.staleWorkers.reclaim).toEqual([]);
      expect(result.applied?.workerWorkspaces).toEqual([]);
      expect(await exists(worktree)).toBe(true);
    }
  });

  it("re-reads the daemon at apply time so a Worker born mid-sweep survives", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const { worktree } = await workspace(tmp, "wRETRY", 2790);

    const report = await collectTmpJanitorReport(tmp, NOW, () => "OPEN", {
      daemon: daemonNaming(),
    });
    expect(report.workerReclaim.reclaim.map((verdict) => verdict.artifact.path)).toEqual([worktree]);

    const applied = await applyTmpJanitorReport(tmp, report, { daemon: daemonNaming("wRETRY") });
    expect(applied.workerWorkspaces).toEqual([]);
    expect(applied.protectedLiveWorkspaces).toEqual([worktree]);
    expect(await exists(worktree)).toBe(true);
  });

  it("refuses a plan-named path outside the tmp tier and reports the refusal", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const outside = join(root, "precious");
    await mkdir(outside, { recursive: true });

    const report = await collectTmpJanitorReport(tmp, NOW, () => "OPEN", { daemon: daemonNaming() });
    // A plan from an older bundle, or a hand-built one, may name any path at all.
    report.workerReclaim.reclaim.push({
      worker_id: "wODD",
      artifact: { worker_id: "wODD", kind: "worktree", path: outside },
      class: "workspace",
      liveness: "dead",
      reclaim: true,
      verdict: "workspace-reclaimable",
      reason: "test-built plan",
    });

    const applied = await applyTmpJanitorReport(tmp, report, { daemon: daemonNaming() });

    expect(applied.refusedOutsideTmp).toEqual([outside]);
    expect(applied.workerWorkspaces).toEqual([]);
    expect(await exists(outside)).toBe(true);
  });

  it("plans nothing from a lane that does not exist yet", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    await mkdir(join(tmp, "workers"), { recursive: true });

    const report = await collectTmpJanitorReport(tmp, NOW, () => "OPEN", { daemon: daemonNaming() });

    expect(report.workerReclaim.totals).toEqual({
      considered: 0,
      reclaim: 0,
      retain: 0,
      dropped: 0,
    });
  });
});

describe("the reclaim planner stays total", () => {
  const dead = (): WorkerProcessVerdict => "dead";
  const artifact = (over: Partial<WorkerArtifact> = {}): WorkerArtifact => ({
    worker_id: "wDEAD",
    kind: "worktree",
    path: "/red/tmp/workers/wDEAD/1/worktree",
    ...over,
  });

  it("retains a dead Worker's session artifact as evidence while reclaiming its workspace", () => {
    const session = "/sessions/wDEAD/runner-session.toon";
    const plan = planWorkerReclaim(
      [artifact(), artifact({ kind: "session", path: session })],
      { liveness: dead, nowIso: NOW_ISO },
    );

    expect(plan.reclaim.map((verdict) => verdict.artifact.kind)).toEqual(["worktree"]);
    expect(plan.retain).toEqual([
      expect.objectContaining({
        class: "evidence",
        reclaim: false,
        verdict: "evidence-retained",
        artifact: expect.objectContaining({ kind: "session", path: session }),
      }),
    ]);
    expect(plan.dropped).toEqual([]);
    expect(plan.totals).toEqual({ considered: 2, reclaim: 1, retain: 1, dropped: 0 });
  });

  it("accounts for every artifact exactly once, and states the identity", () => {
    const plan = planWorkerReclaim(
      [
        artifact(),
        artifact({ kind: "log", path: "/red/tmp/workers/wDEAD/worker.log.toonl" }),
        artifact({ kind: "branch", path: undefined }),
        artifact({ kind: "moonbeam", path: "/red/tmp/workers/wDEAD/1/moonbeam" }),
      ],
      { liveness: dead, nowIso: NOW_ISO, observedPaths: ["/red/tmp/workers/wSTRAY/9/worktree"] },
    );

    expect(plan.totals).toEqual({ considered: 5, reclaim: 1, retain: 3, dropped: 1 });
    expect(plan.totals.reclaim + plan.totals.retain + plan.totals.dropped).toBe(
      plan.totals.considered,
    );
    expect(plan.retain.map((verdict) => verdict.verdict)).toEqual([
      "evidence-retained",
      "pointer-retained",
      "unclassified",
    ]);
  });

  it("reports a path no Worker accounts for instead of touching it", () => {
    const stray = "/red/tmp/workers/wSTRAY/9/worktree";
    const plan = planWorkerReclaim([], {
      liveness: dead,
      nowIso: NOW_ISO,
      observedPaths: [stray],
    });

    expect(plan.reclaim).toEqual([]);
    expect(plan.dropped).toEqual([
      {
        reason: "no-worker",
        path: stray,
        detail: "no Worker accounts for this path; the janitor leaves it alone",
      },
    ]);
  });

  it("reports a capped artifact as dropped rather than truncating it away", () => {
    const plan = planWorkerReclaim(
      [artifact(), artifact({ path: "/red/tmp/workers/wDEAD/2/worktree" })],
      { liveness: dead, nowIso: NOW_ISO, limit: 1 },
    );

    expect(plan.truncated).toBe(true);
    expect(plan.totals).toEqual({ considered: 2, reclaim: 1, retain: 0, dropped: 1 });
    expect(plan.dropped[0]).toMatchObject({ reason: "limit", path: "/red/tmp/workers/wDEAD/2/worktree" });
  });

  it("honours a pinned artifact and a hold-until instant over a dead Worker", () => {
    const pinned = planWorkerReclaim([artifact({ reclaimable: false, reason: "under post-mortem" })], {
      liveness: dead,
      nowIso: NOW_ISO,
    });
    const held = planWorkerReclaim(
      [artifact({ reclaim_after: new Date((NOW + 3_600) * 1000).toISOString() })],
      { liveness: dead, nowIso: NOW_ISO },
    );
    const released = planWorkerReclaim(
      [artifact({ reclaim_after: new Date((NOW - 3_600) * 1000).toISOString() })],
      { liveness: dead, nowIso: NOW_ISO },
    );

    expect(pinned.reclaim).toEqual([]);
    expect(pinned.retain[0]).toMatchObject({ verdict: "pinned", reason: "under post-mortem" });
    expect(held.reclaim).toEqual([]);
    expect(held.retain[0]?.verdict).toBe("grace-period");
    expect(released.reclaim.map((verdict) => verdict.verdict)).toEqual(["workspace-reclaimable"]);
  });

  it("lets a Worker the daemon has not called dead hold a path a dead one also names", () => {
    const shared = "/red/tmp/workers/wSHARED/1/worktree";
    const plan = planWorkerReclaim(
      [
        { worker_id: "wDEAD", kind: "worktree", path: shared },
        { worker_id: "wLIVE", kind: "worktree", path: shared },
      ],
      { liveness: (workerId) => (workerId === "wLIVE" ? "alive" : "dead"), nowIso: NOW_ISO },
    );

    expect(plan.reclaim).toEqual([]);
    expect(plan.retain.map((verdict) => verdict.verdict)).toEqual(["worker-live", "worker-live"]);
  });
});

describe("reclaiming a worktree also drops git's registration of it (#2866)", () => {
  it("prunes after removing a dead Worker's workspace", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    const { worktree } = await workspace(tmp, "wDONE", 2866);
    let pruned = 0;

    const result = await runTmpJanitor(tmp, NOW, () => "OPEN", {
      fix: true,
      daemon: daemonNaming("wOTHER"),
      worktreePrune: async () => {
        pruned += 1;
      },
    });

    expect(result.applied?.workerWorkspaces).toEqual([worktree]);
    // Without this, git keeps pointing at a path that no longer exists — the
    // stale registration that blocked a gate worktree from being created.
    expect(pruned).toBe(1);
  });

  it("does not prune when nothing was removed", async () => {
    const root = await tempRoot();
    const tmp = join(root, ".red", "tmp");
    await workspace(tmp, "wLIVE", 2866);
    let pruned = 0;

    await runTmpJanitor(tmp, NOW, () => "OPEN", {
      fix: true,
      daemon: daemonNaming("wLIVE"),
      worktreePrune: async () => {
        pruned += 1;
      },
    });

    expect(pruned).toBe(0);
  });
});
