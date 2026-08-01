// worker-state-reclaim.test.ts — the durable Worker STATE RECORD lane is
// reclaimed on the daemon's process truth plus a retention (#2978).
//
// The pile this covers is `.red/state/castle/workers/<id>/state.toon`: 345
// records where one Worker was live, because nothing ever reclaimed a record
// once its Worker died. The tmp-lane janitor reclaimed the workspace bytes and
// left the record that names them behind.

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encode } from "@reddb-io/toon";
import {
  WORKER_STATE_RECORD_RETENTION_MS,
  planWorkerStateRecordReclaim,
  type WorkerStateRecordEntry,
} from "../src/core/worker-state-reclaim.js";
import {
  applyWorkerStateRecordReclaim,
  castleWorkerStateRoot,
  collectWorkerStateRecordEntries,
} from "../src/runtime/worker-state-reclaim.js";
import { applyTmpJanitorReport, collectTmpJanitorReport } from "../src/runtime/tmp-janitor.js";
import type { DaemonWorkerSetReader } from "../src/runtime/liveness-anchor.js";

const NOW_MS = 1_800_000_000_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-worker-state-reclaim-"));
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

/** A daemon that did not answer at all. */
const noDaemon: DaemonWorkerSetReader = async () => null;

function entry(over: Partial<WorkerStateRecordEntry> = {}): WorkerStateRecordEntry {
  return {
    worker_id: "wDEAD",
    path: "/tmp/.red/state/castle/workers/wDEAD",
    liveness: "dead",
    updatedAtMs: NOW_MS - WORKER_STATE_RECORD_RETENTION_MS - 1,
    outcome: "terminal",
    ...over,
  };
}

/** Write one castle Worker state record with a chosen `updated_at` and pid. */
async function writeRecord(
  root: string,
  workerId: string,
  opts: { updatedAtMs?: number; pid?: number; phase?: string } = {},
): Promise<string> {
  const dir = join(castleWorkerStateRoot(root), workerId);
  await mkdir(dir, { recursive: true });
  const updatedAt = new Date(opts.updatedAtMs ?? NOW_MS).toISOString();
  await writeFile(
    join(dir, "state.toon"),
    encode({
      kind: "worker",
      id: workerId,
      version: 1,
      updated_at: updatedAt,
      worker_id: workerId,
      runner: "claude",
      pid: opts.pid ?? 0,
      started_at: updatedAt,
      current: { number: 1, phase: opts.phase ?? "terminal" },
    }),
    "utf8",
  );
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("the retention is declared once, with its reason", () => {
  it("is a single exported constant the planner defaults to", () => {
    expect(WORKER_STATE_RECORD_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    const settled = entry({ updatedAtMs: NOW_MS - WORKER_STATE_RECORD_RETENTION_MS - 1 });
    const fresh = entry({ updatedAtMs: NOW_MS - WORKER_STATE_RECORD_RETENTION_MS + 1 });
    expect(planWorkerStateRecordReclaim([settled], { nowMs: NOW_MS }).reclaim).toHaveLength(1);
    expect(planWorkerStateRecordReclaim([fresh], { nowMs: NOW_MS }).reclaim).toHaveLength(0);
  });
});

describe("planWorkerStateRecordReclaim", () => {
  it("reclaims a dead Worker's record once the retention has passed", () => {
    const plan = planWorkerStateRecordReclaim([entry()], { nowMs: NOW_MS });
    expect(plan.reclaim.map((v) => v.verdict)).toEqual(["settled-reclaimable"]);
    expect(plan.retain).toHaveLength(0);
    expect(plan.totals).toEqual({ considered: 1, reclaim: 1, retain: 0 });
  });

  it("NEVER reclaims a live Worker's record, however old the record is", () => {
    const plan = planWorkerStateRecordReclaim(
      [entry({ liveness: "alive", updatedAtMs: 0 })],
      { nowMs: NOW_MS },
    );
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.retain.map((v) => v.verdict)).toEqual(["worker-live"]);
  });

  it("retains a record the daemon could not answer for — unknown is not a death", () => {
    const plan = planWorkerStateRecordReclaim(
      [entry({ liveness: "unknown", updatedAtMs: 0 })],
      { nowMs: NOW_MS },
    );
    expect(plan.reclaim).toHaveLength(0);
    expect(plan.retain.map((v) => v.verdict)).toEqual(["liveness-unknown"]);
  });

  it("retains a dead Worker's record while it is still inside the retention", () => {
    const plan = planWorkerStateRecordReclaim(
      [entry({ updatedAtMs: NOW_MS - 60_000 })],
      { nowMs: NOW_MS },
    );
    expect(plan.retain.map((v) => v.verdict)).toEqual(["within-retention"]);
  });

  it("retains a record whose settled instant it cannot read, rather than guessing", () => {
    const plan = planWorkerStateRecordReclaim([entry({ updatedAtMs: null })], { nowMs: NOW_MS });
    expect(plan.retain.map((v) => v.verdict)).toEqual(["no-settled-instant"]);
  });

  it("reports every considered record exactly once — no silent truncation", () => {
    const entries = [
      entry({ worker_id: "wA" }),
      entry({ worker_id: "wB", liveness: "alive" }),
      entry({ worker_id: "wC", liveness: "unknown" }),
      entry({ worker_id: "wD", updatedAtMs: NOW_MS }),
    ];
    const plan = planWorkerStateRecordReclaim(entries, { nowMs: NOW_MS });
    expect(plan.totals.considered).toBe(4);
    expect(plan.totals.reclaim + plan.totals.retain).toBe(4);
    expect([...plan.reclaim, ...plan.retain].map((v) => v.worker_id).sort()).toEqual([
      "wA",
      "wB",
      "wC",
      "wD",
    ]);
  });

  it("carries the outcome the record last recorded into its verdict", () => {
    const plan = planWorkerStateRecordReclaim([entry({ outcome: "gate" })], { nowMs: NOW_MS });
    expect(plan.reclaim[0]?.outcome).toBe("gate");
  });
});

describe("the reclaim runs against real records on disk", () => {
  it("removes the dead Worker's record and keeps the live one", async () => {
    const root = await tempRoot();
    const deadDir = await writeRecord(root, "wDEAD", {
      updatedAtMs: NOW_MS - WORKER_STATE_RECORD_RETENTION_MS - 1,
    });
    const liveDir = await writeRecord(root, "wLIVE", { updatedAtMs: 0 });

    const collected = await collectWorkerStateRecordEntries(root, {
      nowMs: NOW_MS,
      daemon: daemonNaming("wLIVE"),
    });
    const plan = planWorkerStateRecordReclaim(collected, { nowMs: NOW_MS });
    const applied = await applyWorkerStateRecordReclaim(root, plan, {
      daemon: daemonNaming("wLIVE"),
    });

    expect(applied.removed).toEqual([deadDir]);
    expect(applied.refusedOutsideStateRoot).toEqual([]);
    expect(await exists(deadDir)).toBe(false);
    expect(await exists(liveDir)).toBe(true);
  });

  it("spares every record when the daemon is unreachable", async () => {
    const root = await tempRoot();
    const dir = await writeRecord(root, "wDEAD", { updatedAtMs: 0 });
    const collected = await collectWorkerStateRecordEntries(root, {
      nowMs: NOW_MS,
      daemon: noDaemon,
    });
    const plan = planWorkerStateRecordReclaim(collected, { nowMs: NOW_MS });
    expect(plan.reclaim).toHaveLength(0);
    const applied = await applyWorkerStateRecordReclaim(root, plan, { daemon: noDaemon });
    expect(applied.removed).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });

  it("spares a record whose own recorded pid is still running — pid liveness for records born outside the daemon", async () => {
    const root = await tempRoot();
    const dir = await writeRecord(root, "wSELF", { updatedAtMs: 0, pid: process.pid });
    const collected = await collectWorkerStateRecordEntries(root, {
      nowMs: NOW_MS,
      daemon: daemonNaming(),
    });
    expect(collected.map((e) => e.liveness)).toEqual(["unknown"]);
    const plan = planWorkerStateRecordReclaim(collected, { nowMs: NOW_MS });
    const applied = await applyWorkerStateRecordReclaim(root, plan, { daemon: daemonNaming() });
    expect(applied.removed).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });

  it("re-asks the daemon at apply time — a Worker born since the plan keeps its record", async () => {
    const root = await tempRoot();
    const dir = await writeRecord(root, "wRACE", { updatedAtMs: 0 });
    const collected = await collectWorkerStateRecordEntries(root, {
      nowMs: NOW_MS,
      daemon: daemonNaming(),
    });
    const plan = planWorkerStateRecordReclaim(collected, { nowMs: NOW_MS });
    expect(plan.reclaim).toHaveLength(1);
    // Between plan and apply the daemon births wRACE again.
    const applied = await applyWorkerStateRecordReclaim(root, plan, {
      daemon: daemonNaming("wRACE"),
    });
    expect(applied.removed).toEqual([]);
    expect(applied.protectedLive).toEqual([dir]);
    expect(await exists(dir)).toBe(true);
  });

  it("refuses a plan naming a path outside the Worker state root", async () => {
    const root = await tempRoot();
    const outside = join(root, "elsewhere");
    await mkdir(outside, { recursive: true });
    const applied = await applyWorkerStateRecordReclaim(
      root,
      planWorkerStateRecordReclaim([entry({ worker_id: "wOUT", path: outside })], {
        nowMs: NOW_MS,
      }),
      { daemon: daemonNaming() },
    );
    expect(applied.removed).toEqual([]);
    expect(applied.refusedOutsideStateRoot).toEqual([outside]);
    expect(await exists(outside)).toBe(true);
  });

  it("drains the pile the issue reported: many corpses go, the one live record stays", async () => {
    const root = await tempRoot();
    for (let index = 0; index < 40; index += 1) {
      await writeRecord(root, `wD${index}`, { updatedAtMs: 0 });
    }
    const liveDir = await writeRecord(root, "wLIVE", { updatedAtMs: 0 });

    const daemon = daemonNaming("wLIVE");
    const collected = await collectWorkerStateRecordEntries(root, { nowMs: NOW_MS, daemon });
    const plan = planWorkerStateRecordReclaim(collected, { nowMs: NOW_MS });
    const applied = await applyWorkerStateRecordReclaim(root, plan, { daemon });

    expect(applied.removed).toHaveLength(40);
    expect(await exists(liveDir)).toBe(true);
    const left = await collectWorkerStateRecordEntries(root, { nowMs: NOW_MS, daemon });
    expect(left.map((e) => e.worker_id)).toEqual(["wLIVE"]);
  });
});

describe("the janitor sweep owns the record lane", () => {
  it("plans and applies the record reclaim alongside the tmp lanes", async () => {
    const root = await tempRoot();
    const tmpDir = join(root, ".red", "tmp");
    await mkdir(tmpDir, { recursive: true });
    const deadDir = await writeRecord(root, "wDEAD", { updatedAtMs: 0 });
    const liveDir = await writeRecord(root, "wLIVE", { updatedAtMs: 0 });
    const daemon = daemonNaming("wLIVE");

    const report = await collectTmpJanitorReport(
      tmpDir,
      Math.floor(NOW_MS / 1000),
      () => "UNKNOWN",
      { daemon },
    );
    expect(report.workerStateRecords.reclaim.map((v) => v.worker_id)).toEqual(["wDEAD"]);
    expect(report.workerStateRecords.retain.map((v) => v.verdict)).toEqual(["worker-live"]);

    const applied = await applyTmpJanitorReport(tmpDir, report, { daemon });
    expect(applied.workerStateRecords).toEqual([deadDir]);
    expect(applied.removals).toContainEqual({ path: deadDir, livenessVerdict: "worker-dead" });
    expect(await exists(deadDir)).toBe(false);
    expect(await exists(liveDir)).toBe(true);
  });

  it("reclaims no record when the daemon is unreachable", async () => {
    const root = await tempRoot();
    const tmpDir = join(root, ".red", "tmp");
    await mkdir(tmpDir, { recursive: true });
    const dir = await writeRecord(root, "wDEAD", { updatedAtMs: 0 });
    const report = await collectTmpJanitorReport(
      tmpDir,
      Math.floor(NOW_MS / 1000),
      () => "UNKNOWN",
      { daemon: noDaemon },
    );
    const applied = await applyTmpJanitorReport(tmpDir, report, { daemon: noDaemon });
    expect(applied.workerStateRecords).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });
});
