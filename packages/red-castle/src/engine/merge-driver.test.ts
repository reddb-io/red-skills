import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MERGE_DRIVER_MAX_ATTEMPTS,
  armPr,
  createFileMergeDriverStore,
  releasePr,
  runMergeDriverPass,
  type MergeDriverIo,
  type MergeDriverPrView,
  type MergeDriverState,
  type MergeDriverStore,
} from "./merge-driver.js";
import { createEnginePaths } from "./paths.js";

const NOW = 1_800_000_000;

function memoryStore(initial?: MergeDriverState): MergeDriverStore & { value: MergeDriverState } {
  return {
    value: initial ?? { version: 1, prs: {} },
    async read() {
      return this.value;
    },
    async write(state) {
      this.value = state;
    },
  };
}

function io(views: Record<number, MergeDriverPrView[]>): MergeDriverIo & {
  updateBranch: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
} {
  const cursor = new Map<number, number>();
  return {
    viewPr: vi.fn(async (pr: number) => {
      const seq = views[pr] ?? [];
      const index = Math.min(cursor.get(pr) ?? 0, seq.length - 1);
      cursor.set(pr, (cursor.get(pr) ?? 0) + 1);
      const view = seq[index];
      if (!view) throw new Error(`no view for #${pr}`);
      return view;
    }),
    updateBranch: vi.fn(async () => undefined),
    merge: vi.fn(async () => undefined),
  };
}

describe("merge driver (#2512)", () => {
  it("green+BEHIND: update-branch first, merge once green at head — native auto-merge absent", async () => {
    const store = memoryStore();
    await armPr(store, 42, NOW);
    const gh = io({
      42: [
        { state: "OPEN", mergeStateStatus: "BEHIND", checks: "green" },
        { state: "OPEN", mergeStateStatus: "UNSTABLE", checks: "pending" },
        { state: "OPEN", mergeStateStatus: "CLEAN", checks: "green" },
      ],
    });

    const first = await runMergeDriverPass(gh, store, { nowEpoch: NOW + 1 });
    expect(first).toEqual([{ pr: 42, action: "updated-branch" }]);
    expect(gh.updateBranch).toHaveBeenCalledWith(42);
    expect(gh.merge).not.toHaveBeenCalled();

    const second = await runMergeDriverPass(gh, store, { nowEpoch: NOW + 2 });
    expect(second).toEqual([{ pr: 42, action: "waiting" }]);

    const third = await runMergeDriverPass(gh, store, { nowEpoch: NOW + 3 });
    expect(third).toEqual([{ pr: 42, action: "merged" }]);
    expect(store.value.prs["42"]!.status).toBe("merged");
  });

  it("DIRTY: classified terminal needs-medic and never retried in a loop", async () => {
    const store = memoryStore();
    await armPr(store, 7, NOW);
    const gh = io({ 7: [{ state: "OPEN", mergeStateStatus: "DIRTY", checks: "green" }] });

    const first = await runMergeDriverPass(gh, store, { nowEpoch: NOW + 1 });
    expect(first).toEqual([{ pr: 7, action: "terminal-medic", note: "merge conflict" }]);
    expect(store.value.prs["7"]!.status).toBe("needs-medic");

    // Terminal records are skipped on every subsequent pass — no loop.
    const second = await runMergeDriverPass(gh, store, { nowEpoch: NOW + 2 });
    expect(second).toEqual([]);
    expect(gh.viewPr).toHaveBeenCalledTimes(1);
  });

  it("failing checks: terminal needs-medic", async () => {
    const store = memoryStore();
    await armPr(store, 8, NOW);
    const gh = io({ 8: [{ state: "OPEN", mergeStateStatus: "BLOCKED", checks: "failing" }] });

    const entries = await runMergeDriverPass(gh, store, { nowEpoch: NOW + 1 });
    expect(entries).toEqual([{ pr: 8, action: "terminal-medic", note: "failing checks" }]);
  });

  it("merges with the merge-commit strategy and the port has no admin override", async () => {
    const store = memoryStore();
    await armPr(store, 9, NOW);
    const gh = io({ 9: [{ state: "OPEN", mergeStateStatus: "CLEAN", checks: "green" }] });

    await runMergeDriverPass(gh, store, { nowEpoch: NOW + 1 });
    expect(gh.merge).toHaveBeenCalledExactlyOnceWith(9, "merge");
  });

  it("attempts bound: exhausting the budget classifies terminal needs-human", async () => {
    const store = memoryStore({
      version: 1,
      prs: {
        "5": {
          pr: 5,
          status: "armed",
          armedAtEpoch: NOW,
          attempts: MERGE_DRIVER_MAX_ATTEMPTS,
          updatedAtEpoch: NOW,
        },
      },
    });
    const gh = io({ 5: [{ state: "OPEN", mergeStateStatus: "BLOCKED", checks: "pending" }] });

    const entries = await runMergeDriverPass(gh, store, { nowEpoch: NOW + 1 });
    expect(entries).toEqual([
      { pr: 5, action: "terminal-human", note: "attempts bound exhausted" },
    ]);
    expect(store.value.prs["5"]!.status).toBe("needs-human");
    expect(gh.viewPr).not.toHaveBeenCalled();
  });

  it("already-merged and closed-without-merge resolve without driver mutations", async () => {
    const store = memoryStore();
    await armPr(store, 11, NOW);
    await armPr(store, 12, NOW);
    const gh = io({
      11: [{ state: "MERGED", mergeStateStatus: "UNKNOWN", checks: "green" }],
      12: [{ state: "CLOSED", mergeStateStatus: "UNKNOWN", checks: "green" }],
    });

    const entries = await runMergeDriverPass(gh, store, { nowEpoch: NOW + 1 });
    expect(entries).toContainEqual({ pr: 11, action: "already-merged" });
    expect(entries).toContainEqual({ pr: 12, action: "terminal-human", note: "closed without merge" });
    expect(gh.updateBranch).not.toHaveBeenCalled();
    expect(gh.merge).not.toHaveBeenCalled();
  });

  it("release stops driver ownership; re-arming resets the budget", async () => {
    const store = memoryStore();
    await armPr(store, 13, NOW);
    await releasePr(store, 13, NOW + 1);
    const gh = io({ 13: [{ state: "OPEN", mergeStateStatus: "CLEAN", checks: "green" }] });

    expect(await runMergeDriverPass(gh, store, { nowEpoch: NOW + 2 })).toEqual([]);

    await armPr(store, 13, NOW + 3);
    expect(store.value.prs["13"]!.attempts).toBe(0);
    expect(store.value.prs["13"]!.status).toBe("armed");
  });
});

describe("merge driver file store", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("driver state survives a resident restart (armed set reloads from disk)", async () => {
    dir = mkdtempSync(join(tmpdir(), "merge-driver-"));
    const paths = createEnginePaths(join(dir, ".red"));
    const store = createFileMergeDriverStore(paths);
    await armPr(store, 21, NOW);

    // A brand-new store instance (fresh resident) sees the same armed set.
    const reloaded = createFileMergeDriverStore(paths);
    const state = await reloaded.read();
    expect(state.prs["21"]).toMatchObject({ pr: 21, status: "armed", attempts: 0 });
  });
});
