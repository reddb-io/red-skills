import { describe, expect, it } from "vitest";
import {
  afkPaths,
  appendCastleHistoryRecord,
  applyStatuslineCountCacheLabelDelta,
  buildMinimalBootDeps,
  castleStateSnapshotPath,
  collectMonitorInputs,
  collectStatuslineAfk,
  collectStatuslineDocs,
  collectStatuslineRepo,
  collectStatuslineWorkers,
  createEnginePaths,
  decode,
  dirname,
  editLabelsWithStatuslineCache,
  encode,
  existsSync,
  fakeBinDir,
  inferGitHubRepoSlug,
  join,
  mkdirSync,
  mkdtempSync,
  nowS,
  detachedSpawnRecorder,
  parseGitHubRepoSlugFromRemoteUrl,
  readFleetState,
  readFileSync,
  readToonCache,
  resolveAttemptProbeArming,
  resolveAttemptHead,
  resolveRunSettings,
  resolveStatuslineCacheTtl,
  rmSync,
  runBoot,
  scratch,
  startDetachedStatuslineCountRefresh,
  statuslineCountCachePath,
  STATUSLINE_CACHE_TTL_S,
  tmpdir,
  type ExecOutput,
  withTimeout,
  withFakeGh,
  writeCastleStateSnapshot,
  writeFileSync,
  writeRenderableAttempt,
} from "./wire.helpers.js";

describe("withTimeout — bounded cold-cache refresh", () => {
  it("resolves with the promise value when it settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve(42), 500, -1);
    expect(result).toBe(42);
  });

  it("resolves with the fallback when the promise does not settle within the deadline", async () => {
    const never = new Promise<number>(() => { /* intentionally never resolves */ });
    const result = await withTimeout(never, 20, -1);
    expect(result).toBe(-1);
  });

  it("resolves with fallback when promise settles after the deadline (no unhandled rejection)", async () => {
    const lateResolve = new Promise<number>((resolve) => {
      setTimeout(() => resolve(99), 200);
    });
    const result = await withTimeout(lateResolve, 20, -1);
    expect(result).toBe(-1);
  });

  it("propagates rejection when the promise rejects before the deadline", async () => {
    const failing = Promise.reject(new Error("gh auth failed"));
    await expect(withTimeout(failing, 500, -1)).rejects.toThrow("gh auth failed");
  });

  it("returns fallback and avoids unhandled rejection when promise rejects after deadline", async () => {
    let lateReject!: (err: Error) => void;
    const lateRejecting = new Promise<number>((_, reject) => {
      lateReject = reject;
    });
    const result = await withTimeout(lateRejecting.catch(() => -1), 20, -1);
    lateReject(new Error("network gone"));
    expect(result).toBe(-1);
  });
});

describe("buildMinimalBootDeps — supervisor-owned-sweeps worker boot (#623)", () => {
  it("drives a real skipSweeps runBoot: bootstrap on disk, no sweep IO", async () => {
    const dir = scratch();
    try {
      const tmpDir = join(dir, ".red", "tmp");
      const deps = buildMinimalBootDeps({ root: dir, repo: "o/r", remote: "origin" }, 1_700_000_000);
      const result = await runBoot(deps, {
        precheck: {
          ghInstalled: true,
          ghAuthenticated: true,
          isGitRepo: true,
          remoteUrls: ["git@github.com:o/r.git"],
          hasMainBranch: true,
          currentBranch: "main",
          pnpmInstalled: true,
        },
        bootstrap: {
          tmpDir,
          stateDir: join(dir, ".red", "state"),
          workerDir: join(tmpDir, "workers", "wAAAA"),
          workerPidFile: join(tmpDir, "workers", "wAAAA", "worker.pid"),
          workerPid: 4242,
        },
        orphans: [],
        attemptCap: { byIssue: new Map() },
        branches: { remoteLiveRefs: [], localLiveRefs: [] },
        unblockCandidates: [],
        skipSweeps: true,
      });
      // Boot ran precheck + bootstrap then short-circuited; no sweep fields.
      expect(result.precheck.ok).toBe(true);
      expect(result.bootstrap).toEqual({ ok: true });
      expect(result.orphanCleanup).toBeUndefined();
      expect(result.straggler).toBeUndefined();
      // Bootstrap really wrote to disk (the real fs closures are wired).
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(tmpDir, "workers", "wAAAA", "worker.pid"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws if any sweep IO closure is invoked (guards a skip-boot regression)", async () => {
    const deps = buildMinimalBootDeps({ root: "/x", repo: "o/r", remote: "origin" }, 0);
    await expect(deps.gh.comment(1, "x")).rejects.toThrow(/skip-sweeps/);
    await expect(deps.lookups.blockerState(1)).rejects.toThrow(/skip-sweeps/);
    await expect(deps.lookups.straggler.unlabeled()).rejects.toThrow(/skip-sweeps/);
    expect(() => deps.lookups.branchIssue(1)).toThrow(/skip-sweeps/);
  });

  it("drives a real boot invocation that refuses a red operational probe before writing bootstrap state", async () => {
    const dir = scratch();
    try {
      const tmpDir = join(dir, ".red", "tmp");
      const workerPid = join(tmpDir, "workers", "wAAAA", "worker.pid");
      const deps = buildMinimalBootDeps({ root: dir, repo: "o/r", remote: "origin" }, 1_700_000_000);

      await expect(
        runBoot(deps, {
          precheck: {
            ghInstalled: true,
            ghAuthenticated: true,
            isGitRepo: true,
            remoteUrls: [{ name: "origin", url: "https://example.invalid/o/r.git" }],
            hasMainBranch: true,
            currentBranch: "main",
            pnpmInstalled: true,
          },
          bootstrap: {
            tmpDir,
            stateDir: join(dir, ".red", "state"),
            workerDir: join(tmpDir, "workers", "wAAAA"),
            workerPidFile: workerPid,
            workerPid: 4242,
          },
          orphans: [],
          attemptCap: { byIssue: new Map() },
          branches: { remoteLiveRefs: [], localLiveRefs: [] },
          unblockCandidates: [],
          skipSweeps: true,
        }),
      ).rejects.toMatchObject({
        phase: "operational-probe",
        probe: { name: "SSH-only git remotes" },
      });
      expect(existsSync(workerPid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe("statusline refresh lock — TOON round-trip seam", () => {
  const lockPathFor = (root: string): string => `${statuslineCountCachePath(root)}.refresh.lock`;

  it("writes a TOON lock (not JSON) and re-reads its ts to refuse a concurrent refresh", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-lock-"));
    try {
      const rec = detachedSpawnRecorder();
      const ctx = { root, repo: "o/r", remote: "origin" };
      const now = nowS();

      // WRITE half: acquire the lock (spawns one detached refresh).
      const first = startDetachedStatuslineCountRefresh(ctx, { spawn: rec.spawn, argv1: "/tmp/afk.mjs", nowS: now });
      expect(first).toBe(true);
      expect(rec.calls).toHaveLength(1);

      // On disk it is TOON, not JSON, and decodes back to the { pid, ts } payload.
      const raw = readFileSync(lockPathFor(root), "utf8");
      expect(raw.trimStart().startsWith("{")).toBe(false);
      const decoded = decode(raw) as { pid: number; ts: number };
      expect(decoded.pid).toBe(process.pid);
      expect(decoded.ts).toBe(now);

      // READ half: a second acquire re-reads the fresh TOON lock's ts and refuses
      // (no second spawn). If the sniff-read could not recover ts, it would treat
      // the lock as stale and re-acquire — so this proves the round-trip.
      const second = startDetachedStatuslineCountRefresh(ctx, { spawn: rec.spawn, argv1: "/tmp/afk.mjs", nowS: now + 1 });
      expect(second).toBe(false);
      expect(rec.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sniff-reads a legacy JSON lock written by an older bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-lock-"));
    try {
      const rec = detachedSpawnRecorder();
      const ctx = { root, repo: "o/r", remote: "origin" };
      const now = nowS();

      // Pre-seed a fresh legacy JSON lock, as an older bundle would have written.
      const lockPath = lockPathFor(root);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: now }), "utf8");

      // The read half sniff-decodes the legacy JSON ts and refuses (still fresh).
      const acquired = startDetachedStatuslineCountRefresh(ctx, { spawn: rec.spawn, argv1: "/tmp/afk.mjs", nowS: now + 1 });
      expect(acquired).toBe(false);
      expect(rec.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The repo collector used to AWAIT its stale refresh, putting up to 5s of `gh`
// on the path that redraws a terminal prompt — measured at 8s per render against
// a 15-minute TTL. Stale now means: serve the old value, date it, and hand the
// network to the same detached child the AFK collector has always used.
describe("collectStatuslineRepo — stale cache never blocks the render (#3546)", () => {
  const seedRepoCache = (root: string, ts: number, baseRef: string): void => {
    const cachePath = afkPaths(root).statuslineRepoCachePath;
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      encode({ baseRef, openPrs: 3, todayPrs: 1, openIssues: 7, localAdded: 4, localRemoved: 2, ts }),
      "utf8",
    );
  };

  it("serves the stale counts immediately and spawns the detached refresh with the base ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 60;
      seedRepoCache(root, staleTs, "origin/main");
      const rec = detachedSpawnRecorder();

      const started = Date.now();
      const repo = await collectStatuslineRepo(
        { root, repo: "o/r", remote: "origin" },
        STATUSLINE_CACHE_TTL_S,
        "origin/main",
        { spawn: rec.spawn, argv1: "/tmp/afk.mjs" },
      );
      const elapsedMs = Date.now() - started;

      // The old values render now; their age travels out instead of a wait.
      expect(repo.openPrs).toBe(3);
      expect(repo.openIssues).toBe(7);
      expect(repo.cacheAgeS).toBeGreaterThanOrEqual(STATUSLINE_CACHE_TTL_S);
      // One detached child, carrying the base ref so it can rewrite BOTH caches.
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]?.args).toContain("--base-ref");
      expect(rec.calls[0]?.args).toContain("origin/main");
      // No network wait on the render path: far under the 5s cold budget.
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a fresh cache spawns nothing and reports no age", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      seedRepoCache(root, nowS(), "origin/main");
      const rec = detachedSpawnRecorder();

      const repo = await collectStatuslineRepo(
        { root, repo: "o/r", remote: "origin" },
        STATUSLINE_CACHE_TTL_S,
        "origin/main",
        { spawn: rec.spawn, argv1: "/tmp/afk.mjs" },
      );

      expect(repo.openPrs).toBe(3);
      expect(repo.cacheAgeS).toBeUndefined();
      expect(rec.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
