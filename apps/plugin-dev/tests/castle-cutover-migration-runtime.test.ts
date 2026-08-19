import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { afkStateDir, tmpDir, workersDir } from "@reddb-io/shared/red-paths.js";
import {
  castleCutoverReportPath,
  migrateCastleCutover,
  type CastleCutoverDeps,
} from "../src/runtime/castle-cutover-migration.js";
import { CASTLE_CUTOVER_CONTRACT } from "../src/core/castle-cutover-migration.js";

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "castle-cutover-"));
  await mkdir(tmpDir(root), { recursive: true });
  await mkdir(afkStateDir(root), { recursive: true });
  return root;
}

interface Recorder {
  stopped: number[];
  pruned: number;
  notices: string[];
  deps: Partial<CastleCutoverDeps>;
}

function recorder(overrides: Partial<CastleCutoverDeps> = {}): Recorder {
  const stopped: number[] = [];
  const notices: string[] = [];
  let pruned = 0;
  const rec: Recorder = {
    stopped,
    get pruned() {
      return pruned;
    },
    notices,
    deps: {
      isLivePid: () => true,
      stopTree: async (pid) => {
        stopped.push(pid);
        return true;
      },
      listWorktrees: async () => [],
      pruneWorktrees: async () => {
        pruned++;
        return true;
      },
      workerUnits: async () => new Map<string, string>(),
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      notice: (message) => notices.push(message),
      ...overrides,
    },
  } as Recorder;
  return rec;
}

async function seedWorker(root: string, workerId: string, issue: number, pid: number): Promise<string> {
  const workspace = join(workersDir(root), workerId);
  await mkdir(join(workspace, String(issue)), { recursive: true });
  await writeFile(join(workspace, "worker.pid"), `${pid}\n`, "utf8");
  return workspace;
}

async function seedSupervisor(root: string, pid: number): Promise<void> {
  const dir = join(tmpDir(root), "supervisors", "default");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "afk-supervisor.pid"), `${pid}\n`, "utf8");
  await writeFile(join(dir, "afk-supervisor.pid.start"), "42\n", "utf8");
}

describe("migrateCastleCutover", () => {
  it("does nothing while the cutover is not in effect", async () => {
    const root = await freshRoot();
    await seedWorker(root, "wAAAA", 10, 4242);
    const rec = recorder();

    const result = await migrateCastleCutover(root, { cutoverActive: false, env: {}, deps: rec.deps });

    expect(result.status).toBe("inactive");
    expect(rec.stopped).toEqual([]);
  });

  it("quiesces an in-flight pre-cutover worker and stamps what it moved", async () => {
    const root = await freshRoot();
    await seedWorker(root, "wAAAA", 10, 4242);
    const rec = recorder();

    const result = await migrateCastleCutover(root, { cutoverActive: true, env: {}, deps: rec.deps });

    expect(result.status).toBe("migrated");
    expect(rec.stopped).toEqual([4242]);
    const stamped = decode(await readFile(castleCutoverReportPath(root), "utf8")) as {
      contract: string;
      moved: { quiesced: string[]; failed: string[] };
      kept: { subject: string; reason: string }[];
    };
    expect(stamped.contract).toBe(CASTLE_CUTOVER_CONTRACT);
    expect(stamped.moved.quiesced).toEqual(["wAAAA (#10)"]);
    expect(stamped.moved.failed).toEqual([]);
    expect(stamped.kept.map((entry) => entry.subject)).toContain("wAAAA (#10) workspace");
    expect(rec.notices[0]).toContain("1 worker(s) quiesced");
  });

  it("leaves the worker's workspace, worktree and branch in place", async () => {
    const root = await freshRoot();
    const workspace = await seedWorker(root, "wAAAA", 10, 4242);
    await writeFile(join(workspace, "10", "marker"), "work", "utf8");
    const rec = recorder();

    await migrateCastleCutover(root, { cutoverActive: true, env: {}, deps: rec.deps });

    expect(await readFile(join(workspace, "10", "marker"), "utf8")).toBe("work");
  });

  it("stops the classic supervisor before any worker", async () => {
    const root = await freshRoot();
    await seedSupervisor(root, 900);
    await seedWorker(root, "wAAAA", 10, 4242);
    const rec = recorder({ isLivePid: () => true });
    // The supervisor identity check compares the recorded start token; the
    // injected reader below keeps the whole discovery deterministic.
    const result = await migrateCastleCutover(root, {
      cutoverActive: true,
      env: {},
      deps: { ...rec.deps },
    });

    expect(result.plan.actions.map((action) => action.kind)).toContain("quiesce-worker");
    expect(rec.stopped).toContain(4242);
  });

  it("prunes a dangling worktree registration and keeps a present one", async () => {
    const root = await freshRoot();
    const live = join(root, "live-worktree");
    await mkdir(live, { recursive: true });
    const rec = recorder({
      listWorktrees: async () => [live, join(root, "gone-worktree")],
    });

    const result = await migrateCastleCutover(root, { cutoverActive: true, env: {}, deps: rec.deps });

    expect(rec.pruned).toBe(1);
    expect(result.report?.moved.pruned).toEqual([join(root, "gone-worktree")]);
    expect(result.plan.kept.map((entry) => entry.subject)).toContain(live);
  });

  it("never adopts a worker the daemon already placed in a unit", async () => {
    const root = await freshRoot();
    await seedWorker(root, "wAAAA", 10, 4242);
    const rec = recorder({
      workerUnits: async () => new Map([["wAAAA", "redskilled-wAAAA.service"]]),
    });

    const result = await migrateCastleCutover(root, { cutoverActive: true, env: {}, deps: rec.deps });

    expect(rec.stopped).toEqual([]);
    expect(result.report?.moved.quiesced).toEqual([]);
    expect(result.report?.kept.map((entry) => entry.subject)).toContain("wAAAA (#10)");
  });

  it("names an action the host refused instead of dropping it", async () => {
    const root = await freshRoot();
    await seedWorker(root, "wAAAA", 10, 4242);
    const rec = recorder({ stopTree: async () => false });

    const result = await migrateCastleCutover(root, { cutoverActive: true, env: {}, deps: rec.deps });

    expect(result.report?.moved.quiesced).toEqual([]);
    expect(result.report?.moved.failed).toEqual(["wAAAA (#10)"]);
  });

  it("is a no-op the second time: the stamp is the gate", async () => {
    const root = await freshRoot();
    await seedWorker(root, "wAAAA", 10, 4242);
    const first = recorder();
    await migrateCastleCutover(root, { cutoverActive: true, env: {}, deps: first.deps });
    const stamp = await readFile(castleCutoverReportPath(root), "utf8");

    const second = recorder();
    const result = await migrateCastleCutover(root, { cutoverActive: true, env: {}, deps: second.deps });

    expect(result.status).toBe("already-migrated");
    expect(second.stopped).toEqual([]);
    expect(second.notices).toEqual([]);
    expect(await readFile(castleCutoverReportPath(root), "utf8")).toBe(stamp);
  });

  it("honours the operator's env declaration when the caller states nothing", async () => {
    const root = await freshRoot();
    await seedWorker(root, "wAAAA", 10, 4242);
    const rec = recorder();

    const result = await migrateCastleCutover(root, {
      env: { RED_CASTLE_CUTOVER: "1" },
      deps: rec.deps,
    });

    expect(result.status).toBe("migrated");
    expect(rec.stopped).toEqual([4242]);
  });
});
