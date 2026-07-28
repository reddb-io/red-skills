// tmp-janitor-attempt-record.test.ts — the janitor reclaims on the ATTEMPT
// RECORD's verdict, not on a missing pid file (ADR 0128, issue #2705).
//
// Every tree below is built the way the failure that motivated this was shaped
// (#2679): the live lanes carry NO pid file at all, and the dead ones do. A
// janitor keyed on pid files gets each of these exactly backwards.

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCastleAttemptRecorder,
  createEnginePaths,
  type CastleAttemptEventFields,
} from "@reddb-io/red-castle/engine";
import { afterEach, describe, expect, it } from "vitest";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import {
  applyTmpJanitorReport,
  collectTmpJanitorReport,
  runTmpJanitor,
} from "../src/runtime/tmp-janitor.js";

const NOW = 1_800_000_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-attempt-janitor-"));
  roots.push(root);
  return root;
}

interface Tree {
  root: string;
  redRoot: string;
  tmp: string;
  /** Append one narrative line the way the resident does. */
  record: (
    identity: { worker: string; issue: number; try?: number },
    event: string,
    fields?: CastleAttemptEventFields,
  ) => Promise<void>;
}

async function tree(): Promise<Tree> {
  const root = await tempRoot();
  const redRoot = join(root, ".red");
  const paths = createEnginePaths(redRoot);
  const recorder = createCastleAttemptRecorder(paths);
  return {
    root,
    redRoot,
    tmp: join(redRoot, "tmp"),
    record: async (identity, event, fields) => {
      const result = await recorder
        .attempt({ worker_id: identity.worker, issue: identity.issue, try: identity.try ?? 1 })
        .record(event, fields);
      // The write path degrades rather than throwing, so a test that silently
      // wrote nothing would assert against an empty lane and pass for the wrong
      // reason. Fail loudly here instead.
      expect(result.diagnostic).toBeUndefined();
    },
  };
}

/** A worker workspace with a git worktree inside it, and no pid file at all. */
async function workspace(tmp: string, worker: string, issue: number): Promise<string> {
  const worktree = join(tmp, "workers", worker, String(issue), "worktree");
  await mkdir(join(worktree, "node_modules"), { recursive: true });
  await writeFile(join(tmp, "workers", worker, String(issue), "worker.log.toonl"), "", "utf8");
  return worktree;
}

/** A supervisor lane in the #2679 shape: live, but with no pid FILE. */
async function liveFleetLane(tmp: string): Promise<string> {
  const fleetDir = join(tmp, "supervisors", "default");
  await mkdir(fleetDir, { recursive: true });
  await writeFile(
    join(fleetDir, "state.toon"),
    encodeDevSnapshotToon({
      ts: new Date(NOW * 1000).toISOString(),
      epoch: NOW,
      runner: "claude",
      pid: process.pid,
      ready_for_agent: 0,
      slots: { busy: 1, free: 0, total: 1, parked: 0 },
      slot_pids: [],
      spawns_this_tick: 0,
    }),
    "utf8",
  );
  return fleetDir;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

describe("the janitor reclaims on the attempt record", () => {
  it("leaves every live lane intact while running on a tree with a live fleet", async () => {
    const t = await tree();
    const fleetDir = await liveFleetLane(t.tmp);
    const liveWorktree = await workspace(t.tmp, "wLIVE", 2705);
    const landedWorktree = await workspace(t.tmp, "wDONE", 2704);

    await t.record({ worker: "wLIVE", issue: 2705 }, "attempt.claimed", {
      claim: { state: "claimed" },
    });
    await t.record({ worker: "wDONE", issue: 2704 }, "attempt.claimed", {
      claim: { state: "claimed" },
    });
    await t.record({ worker: "wDONE", issue: 2704 }, "attempt.closed", {
      branch: "afk/2704-surfaces",
      pr: 2712,
      outcome: { kind: "done" },
    });

    // Issues left OPEN so the pid/issue rule below cannot claim the credit:
    // whatever moves here moved because the record said so.
    const result = await runTmpJanitor(t.tmp, NOW, () => "OPEN", { fix: true });

    expect(await exists(fleetDir)).toBe(true);
    expect(await exists(liveWorktree)).toBe(true);
    expect(await exists(join(t.tmp, "workers", "wLIVE"))).toBe(true);
    expect(result.applied?.protectedLiveSupervisors).toEqual([fleetDir]);

    // The landed attempt's workspace goes; the evidence beside it stays.
    expect(result.applied?.attemptWorkspaces).toEqual([landedWorktree]);
    expect(await exists(landedWorktree)).toBe(false);
    expect(await exists(join(t.tmp, "workers", "wDONE", "2704", "worker.log.toonl"))).toBe(true);
  });

  it("spares a live attempt's workspace with no pid file anywhere on the tree", async () => {
    const t = await tree();
    const worktree = await workspace(t.tmp, "wLIVE", 2705);
    await t.record({ worker: "wLIVE", issue: 2705 }, "attempt.claimed", {
      claim: { state: "claimed" },
    });

    const report = await collectTmpJanitorReport(t.tmp, NOW, () => "CLOSED");

    expect(report.attemptReclaim.reclaim).toEqual([]);
    expect(report.attemptReclaim.retain.map((verdict) => verdict.verdict)).toEqual([
      "attempt-live",
    ]);
    // The pid/issue rule would otherwise reclaim this dir outright: dead pid
    // file (there is none) plus a closed issue. The record vetoes it.
    expect(report.staleWorkers.reclaim).toEqual([]);
    expect(report.staleWorkers.spare[0]).toMatchObject({
      path: join(t.tmp, "workers", "wLIVE"),
      workerPidLive: false,
      attemptLive: true,
    });

    const applied = await applyTmpJanitorReport(t.tmp, report);
    expect(applied.attemptWorkspaces).toEqual([]);
    expect(await exists(worktree)).toBe(true);
  });

  it("retains a failed attempt's evidence and pointers while reclaiming its workspace", async () => {
    const t = await tree();
    const worktree = await workspace(t.tmp, "wFAIL", 2707);
    await t.record({ worker: "wFAIL", issue: 2707 }, "attempt.claimed", {
      claim: { state: "claimed" },
    });
    await t.record({ worker: "wFAIL", issue: 2707 }, "attempt.artifact", {
      artifact: {
        kind: "log",
        path: join(t.tmp, "workers", "wFAIL", "2707", "worker.log.toonl"),
        reclaimable: true,
      },
    });
    await t.record({ worker: "wFAIL", issue: 2707 }, "attempt.closed", {
      branch: "afk/2707-budgets",
      pr: 2713,
      commit: "deadbee",
      outcome: { kind: "budget-exceeded", budget: "wall-clock 2700s" },
    });

    const result = await runTmpJanitor(t.tmp, NOW, () => "OPEN", { fix: true });

    expect(result.attemptReclaim.attempts[0]).toMatchObject({
      tier: "failed",
      pointers: { branch: "afk/2707-budgets", pr: 2713, commits: ["deadbee"] },
    });
    expect(result.applied?.attemptWorkspaces).toEqual([worktree]);
    expect(await exists(worktree)).toBe(false);
    expect(await exists(join(t.tmp, "workers", "wFAIL", "2707", "worker.log.toonl"))).toBe(true);
  });

  it("reports a worktree no attempt record accounts for and leaves it alone", async () => {
    const t = await tree();
    const ghost = await workspace(t.tmp, "wGHOST", 1234);

    const result = await runTmpJanitor(t.tmp, NOW, () => "OPEN", { fix: true });

    expect(result.attemptReclaim.dropped).toEqual([
      {
        reason: "no-record",
        path: ghost,
        detail: "no attempt record accounts for this path; the janitor leaves it alone",
      },
    ]);
    expect(result.applied?.attemptWorkspaces).toEqual([]);
    expect(await exists(ghost)).toBe(true);
  });

  it("never plans a workspace a retry already claimed, and does not call it orphaned", async () => {
    const t = await tree();
    const worktree = await workspace(t.tmp, "wRETRY", 2705);
    await t.record({ worker: "wRETRY", issue: 2705 }, "attempt.closed", {
      outcome: { kind: "blocked" },
    });
    await t.record({ worker: "wRETRY", issue: 2705, try: 2 }, "attempt.claimed", {
      claim: { state: "claimed" },
    });

    const report = await collectTmpJanitorReport(t.tmp, NOW, () => "OPEN");

    expect(report.attemptReclaim.reclaim).toEqual([]);
    // Owned by a live attempt, so it is retained — not reported as a path no
    // record accounts for.
    expect(report.attemptReclaim.dropped).toEqual([]);
    expect(report.attemptReclaim.retain.map((verdict) => verdict.artifact.path)).toEqual([
      worktree,
      worktree,
    ]);
  });

  it("re-reads the lane at apply time so a fresh attempt's workspace survives", async () => {
    const t = await tree();
    const worktree = await workspace(t.tmp, "wRETRY", 2705);
    await t.record({ worker: "wRETRY", issue: 2705 }, "attempt.closed", {
      outcome: { kind: "blocked" },
    });

    const report = await collectTmpJanitorReport(t.tmp, NOW, () => "OPEN");
    expect(report.attemptReclaim.reclaim.map((verdict) => verdict.artifact.path)).toEqual([
      worktree,
    ]);

    // A retry claims the same workspace between collect and apply.
    await t.record({ worker: "wRETRY", issue: 2705, try: 2 }, "attempt.claimed", {
      claim: { state: "claimed" },
    });

    const applied = await applyTmpJanitorReport(t.tmp, report);
    expect(applied.attemptWorkspaces).toEqual([]);
    expect(applied.protectedLiveAttempts).toEqual([worktree]);
    expect(await exists(worktree)).toBe(true);
  });

  it("refuses a record-named path outside the tmp tier and reports the refusal", async () => {
    const t = await tree();
    const outside = join(t.root, "precious");
    await mkdir(outside, { recursive: true });
    await t.record({ worker: "wODD", issue: 2705 }, "attempt.artifact", {
      artifact: { kind: "worktree", path: outside, reclaimable: true },
    });
    await t.record({ worker: "wODD", issue: 2705 }, "attempt.closed", {
      outcome: { kind: "done" },
    });

    const result = await runTmpJanitor(t.tmp, NOW, () => "OPEN", { fix: true });

    expect(result.applied?.refusedOutsideTmp).toEqual([outside]);
    expect(result.applied?.attemptWorkspaces).toEqual([]);
    expect(await exists(outside)).toBe(true);
  });

  it("plans nothing from a lane that does not exist yet", async () => {
    const t = await tree();
    await mkdir(join(t.tmp, "workers"), { recursive: true });

    const report = await collectTmpJanitorReport(t.tmp, NOW, () => "OPEN");

    expect(report.attemptReclaim.totals).toEqual({
      considered: 0,
      reclaim: 0,
      retain: 0,
      dropped: 0,
    });
  });
});
