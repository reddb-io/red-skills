import { describe, expect, it } from "vitest";
import { createCastleLaneWriters } from "@reddb-io/red-castle/engine";
import { spawn } from "node:child_process";
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
  refreshStatuslineCountCache,
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
  withRateLimitedGh,
  writeCastleStateSnapshot,
  writeFileSync,
  writeRenderableAttempt,
} from "./wire.helpers.js";

describe("collectStatuslineAfk — cache discipline", () => {
  it("cold cache: awaits gh + writes cache before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      // Cache now lives in the statusline state lane (issue #1685).
      const cachePath = statuslineCountCachePath(root);

      const before = nowS();
      await withFakeGh(() => collectStatuslineAfk({ root, repo: "", remote: "origin" }));

      const raw = readFileSync(cachePath, "utf8");
      expect(raw.trimStart().startsWith("{")).toBe(false);
      const cache = decode(raw) as { queue: number; human: number; ts: number };
      expect(cache.ts).toBeGreaterThanOrEqual(before);
      expect(cache.queue).toBe(0); // fake gh returns []
      expect(cache.human).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stale cache: serves stale values immediately and starts one detached refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });

      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(cachePath, JSON.stringify({ queue: 5, human: 3, ts: staleTs }), "utf8");
      writeRenderableAttempt(root, "w1", 55, new Date().toISOString());
      const rec = detachedSpawnRecorder();

      const result = await collectStatuslineAfk(
        { root, repo: "o/r", remote: "origin" },
        STATUSLINE_CACHE_TTL_S,
        { spawn: rec.spawn, argv1: "/tmp/afk.mjs" },
      );

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { queue: number; human: number; ts: number };
      expect(result?.queue).toBe(5);
      expect(result?.human).toBe(3);
      expect(result?.cacheAgeS).toBeGreaterThanOrEqual(STATUSLINE_CACHE_TTL_S);
      expect(cache.ts).toBe(staleTs);
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]!.args).toContain("statusline-refresh-counts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stale cache: concurrent renders share one detached refresh lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(
        cachePath,
        JSON.stringify({ queue: 8, human: 1, ts: nowS() - STATUSLINE_CACHE_TTL_S - 10 }),
        "utf8",
      );
      writeRenderableAttempt(root, "w1", 55, new Date().toISOString());
      const rec = detachedSpawnRecorder();

      const renders = await Promise.all(
        Array.from({ length: 8 }, () =>
          collectStatuslineAfk(
            { root, repo: "o/r", remote: "origin" },
            STATUSLINE_CACHE_TTL_S,
            { spawn: rec.spawn, argv1: "/tmp/afk.mjs" },
          ),
        ),
      );

      expect(renders.every((r) => r?.queue === 8 && r.human === 1 && r.cacheAgeS !== undefined)).toBe(true);
      expect(rec.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fresh cache: read without a gh refresh (ts and values unchanged)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });

      const freshTs = nowS();
      writeFileSync(cachePath, JSON.stringify({ queue: 7, human: 2, ts: freshTs }), "utf8");

      // Fake gh outputs a distinct count (3 items) so a call would change the
      // cached value from 7 → 3; if ts/queue stay the same, gh was not called.
      const dir = fakeBinDir();
      writeFileSync(join(dir, "gh"), "#!/bin/sh\necho '[{\"number\":1},{\"number\":2},{\"number\":3}]'\n", { mode: 0o755 });
      const orig = process.env.PATH;
      process.env.PATH = `${dir}:${orig ?? ""}`;
      try {
        await collectStatuslineAfk({ root, repo: "", remote: "origin" });
      } finally {
        process.env.PATH = orig;
        rmSync(dir, { recursive: true, force: true });
      }

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { queue: number; human: number; ts: number };
      expect(cache.ts).toBe(freshTs); // ts unchanged → no write
      expect(cache.queue).toBe(7); // cached value preserved
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fresh TOON cache: reads queue/human without a gh refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });
      const freshTs = nowS();
      writeFileSync(cachePath, encode({ queue: 11, human: 4, ts: freshTs }), "utf8");
      writeRenderableAttempt(root, "w1", 55, new Date().toISOString());

      const result = await collectStatuslineAfk({ root, repo: "", remote: "origin" });

      expect(result?.queue).toBe(11);
      expect(result?.human).toBe(4);
      expect(readToonCache<{ ts: number }>(cachePath).ts).toBe(freshTs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("0 live workers: still starts detached stale refresh before returning null", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });

      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(cachePath, JSON.stringify({ queue: 9, human: 1, ts: staleTs }), "utf8");
      const rec = detachedSpawnRecorder();

      const result = await collectStatuslineAfk(
        { root, repo: "o/r", remote: "origin" },
        STATUSLINE_CACHE_TTL_S,
        { spawn: rec.spawn, argv1: "/tmp/afk.mjs" },
      );

      expect(result).toBeNull(); // 0 workers → null
      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { ts: number };
      expect(cache.ts).toBe(staleTs);
      expect(rec.calls).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts a pid-live worker even when its activity is stale (#836)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      // Fresh gh cache → collectStatuslineAfk makes no gh call.
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ queue: 0, human: 0, ts: nowS() }), "utf8");

      // A worker whose orchestrator process is ALIVE (pid resolves) but whose
      // agent-stream activity froze long ago — exactly a long feedback-gate /
      // build phase, after the heartbeat stops at post_attempt. Pre-#836 this was
      // dropped (isStateActive freshness gate) and line 2 vanished mid-test.
      const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const dir = join(tmpDir, "workers", "wQ", "55-a1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "afk.state.toon"),
        JSON.stringify({
          pid: process.pid, // alive
          current: {
            number: 55,
            activity: "tests",
            started_at: stale,
            last_event_at: stale,
            last_commit_at: stale,
            loc_added: 5, // non-zero → no live git diffstat fallback (hermetic)
            loc_removed: 1,
          },
        }),
        "utf8",
      );

      const result = await collectStatuslineAfk({ root, repo: "", remote: "origin" });
      expect(result).not.toBeNull(); // pid-live worker keeps line 2 alive despite stale activity
      expect(result!.workers).toBe(1);
      expect(result!.issues).toContain(55);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("render performs NO git diffstat: 0/0 loc + a worktree falls to the sticky peak, never git (#1210)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      // Fresh gh cache → no gh subprocess either; this render must be fully
      // subprocess-free.
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ queue: 0, human: 0, ts: nowS() }), "utf8");

      // A live worker whose writer-stamped LOC is 0/0 but which points at a REAL
      // git worktree (the project root) with a non-empty diff vs origin/main. The
      // deleted fallback would have shelled `git diff --shortstat` and reported
      // that volume; the render must instead serve the sticky peak and touch no
      // git at all.
      const dir = join(tmpDir, "workers", "wZ", "77-a1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "afk.state.toon"),
        JSON.stringify({
          pid: process.pid,
          current: {
            number: 77,
            activity: "impl",
            started_at: new Date().toISOString(),
            loc_added: 0,
            loc_removed: 0,
            loc_peak_added: 84,
            loc_peak_removed: 5,
            worktree: root, // a real dir — the old fallback would diff it
          },
        }),
        "utf8",
      );

      const result = await collectStatuslineAfk({ root, repo: "", remote: "origin" });
      expect(result).not.toBeNull();
      // The volume comes from the sticky peak (writer-owned), flagged as peak —
      // proving the git fallback is gone.
      expect(result!.added).toBe(84);
      expect(result!.removed).toBe(5);
      expect(result!.locIsPeak).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectStatuslineWorkers — live pre-claim workers", () => {
  it("renders a live Worker before an attempt state exists", async () => {
    const root = scratch();
    try {
      const workerId = "wBOOT";
      const issue = 2488;
      const workerDir = join(root, ".red", "tmp", "workers", workerId);
      mkdirSync(join(workerDir, String(issue)), { recursive: true });
      writeFileSync(join(workerDir, "worker.pid"), String(process.pid), "utf8");
      const enginePaths = createEnginePaths(join(root, ".red"));
      await createCastleLaneWriters(enginePaths).worker(workerId).append({
        kind: "worker.heartbeat",
        worker_id: workerId,
        payload: { phase: "boot", activity: "reconcile-gate", runner: "codex" },
      });
      const heartbeatAt = new Date(Date.now() - 30_000).toISOString();
      await createCastleLaneWriters(enginePaths, { clock: () => heartbeatAt }).liveness(workerId).append({
        kind: "worker.heartbeat",
        worker_id: workerId,
        payload: {},
      });

      const workers = await collectStatuslineWorkers({
        root,
        repo: "reddb-io/red-skills",
        remote: "origin",
      });

      expect(workers).toHaveLength(1);
      expect(workers[0]).toMatchObject({
        state: {
          worker_id: workerId,
          runner: "codex",
          current: {
            number: issue,
            phase: "boot",
            activity: "reconcile-gate",
            started_at: heartbeatAt,
          },
        },
        pidLive: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders Workers owned by different named fleets with their attribution", async () => {
    const root = scratch();
    try {
      const paths = createEnginePaths(join(root, ".red"));
      const startedAt = new Date().toISOString();
      for (const [workerId, issue, fleet] of [
        ["wALPHA", 2481, "alpha"],
        ["wBETA", 2482, "beta"],
      ] as const) {
        writeRenderableAttempt(root, workerId, issue, startedAt);
        await writeCastleStateSnapshot(
          castleStateSnapshotPath(paths, "worker", workerId),
          {
            kind: "worker",
            id: workerId,
            worker_id: workerId,
            supervisor_id: fleet,
            version: 1,
            updated_at: startedAt,
            pid: process.pid,
            current: { number: issue, phase: "coding" },
          },
        );
      }

      const workers = await collectStatuslineWorkers({
        root,
        repo: "reddb-io/red-skills",
        remote: "origin",
      });

      expect(
        workers.map((worker) => ({
          id: worker.state.worker_id,
          fleet: worker.state.fleet,
        })),
      ).toEqual([
        { id: "wALPHA", fleet: "alpha" },
        { id: "wBETA", fleet: "beta" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("statusline count cache write-through", () => {
  it("applies claim, park, requeue, and close label deltas without count reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-write-through-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = join(tmpDir, "statusline-cache.toon");
      writeFileSync(cachePath, JSON.stringify({ queue: 4, human: 2, ts: 100 }), "utf8");

      expect(applyStatuslineCountCacheLabelDelta(cachePath, ["ready-for-agent"], ["running"], 200)).toBe(true);
      expect(readToonCache(cachePath)).toEqual({ queue: 3, human: 2, quarantine: 0, ts: 200 });

      expect(applyStatuslineCountCacheLabelDelta(cachePath, ["running"], ["ready-for-human", "blocked:validation"], 300)).toBe(true);
      expect(readToonCache(cachePath)).toEqual({ queue: 3, human: 3, quarantine: 0, ts: 300 });

      expect(applyStatuslineCountCacheLabelDelta(cachePath, ["ready-for-human", "blocked:validation"], ["ready-for-agent"], 400)).toBe(true);
      expect(readToonCache(cachePath)).toEqual({ queue: 4, human: 2, quarantine: 0, ts: 400 });

      expect(applyStatuslineCountCacheLabelDelta(cachePath, ["ready-for-human"], [], 500)).toBe(true);
      expect(readToonCache(cachePath)).toEqual({ queue: 4, human: 1, quarantine: 0, ts: 500 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wraps a successful mutation with write-through and does not add API calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-write-through-"));
    try {
      const cachePath = join(root, ".red", "tmp", "statusline-cache.toon");
      mkdirSync(join(root, ".red", "tmp"), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ queue: 1, human: 0, ts: 100 }), "utf8");
      let edits = 0;

      const ok = await editLabelsWithStatuslineCache(
        cachePath,
        async () => {
          edits += 1;
          return true;
        },
        ["ready-for-agent"],
        ["running"],
      );

      const cache = readToonCache<{ queue: number; human: number; ts: number }>(cachePath);
      expect(ok).toBe(true);
      expect(edits).toBe(1);
      expect(cache.queue).toBe(0);
      expect(cache.human).toBe(0);
      expect(cache.ts).toBeGreaterThan(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refreshStatuslineCountCache — an exhausted read writes nothing (#2801)", () => {
  it("leaves the known queue counts in place instead of caching zeroes", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-counts-"));
    try {
      const cachePath = statuslineCountCachePath(root);
      mkdirSync(dirname(cachePath), { recursive: true });
      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(cachePath, encode({ queue: 4, human: 1, quarantine: 0, ts: staleTs }), "utf8");

      await withRateLimitedGh(() => refreshStatuslineCountCache(root, "o/r"));

      expect(readToonCache<{ queue: number; human: number; ts: number }>(cachePath)).toMatchObject({
        queue: 4,
        human: 1,
        ts: staleTs,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("statusline repo slug inference", () => {
  it("parses GitHub ssh and https remotes", () => {
    expect(parseGitHubRepoSlugFromRemoteUrl("git@github.com:reddb-io/red-skills.git")).toBe("reddb-io/red-skills");
    expect(parseGitHubRepoSlugFromRemoteUrl("https://github.com/reddb-io/red-skills.git")).toBe("reddb-io/red-skills");
    expect(parseGitHubRepoSlugFromRemoteUrl("ssh://example.com/reddb-io/red-skills.git")).toBe("");
  });

  it("infers the repo slug from local .git/config without gh", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(
        join(root, ".git", "config"),
        "[remote \"origin\"]\n\turl = git@github.com:reddb-io/red-skills.git\n",
        "utf8",
      );
      expect(inferGitHubRepoSlug(root)).toBe("reddb-io/red-skills");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// collectStatuslineRepo — cache discipline (#818)
// ---------------------------------------------------------------------------

describe("collectStatuslineRepo — cache discipline", () => {
  // #3546 changed the stale contract: the render serves the old value and a
  // DETACHED child rewrites the cache. The render process itself must leave the
  // file untouched — awaiting the rewrite here is exactly the prompt freeze the
  // change removed (8s measured, once per TTL, per session).
  it("stale cache: serves the old value and leaves the rewrite to the detached child", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = afkPaths(root).statuslineRepoCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });

      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(cachePath, JSON.stringify({ openPrs: 3, openIssues: 5, ts: staleTs }), "utf8");

      const rec = detachedSpawnRecorder();
      const repo = await withFakeGh(() =>
        collectStatuslineRepo({ root, repo: "o/r", remote: "origin" }, undefined, "origin/main", {
          spawn: rec.spawn,
          argv1: "/tmp/afk.mjs",
        }),
      );

      // Old values render now, dated; the file is untouched by the render process.
      expect(repo.openPrs).toBe(3);
      expect(repo.cacheAgeS).toBeGreaterThanOrEqual(STATUSLINE_CACHE_TTL_S);
      // Still the exact JSON we seeded: the render process never rewrote it.
      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { ts: number };
      expect(cache.ts).toBe(staleTs);
      // Exactly one child, carrying the base ref so it rewrites BOTH caches.
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]?.args).toContain("--base-ref");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fresh cache: read without a gh refresh (ts unchanged)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const cachePath = afkPaths(root).statuslineRepoCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });

      const freshTs = nowS();
      writeFileSync(cachePath, JSON.stringify({ openPrs: 4, openIssues: 10, ts: freshTs }), "utf8");

      await withFakeGh(() => collectStatuslineRepo({ root, repo: "", remote: "origin" }));

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { openPrs: number; openIssues: number; ts: number };
      expect(cache.ts).toBe(freshTs); // ts unchanged → no write
      expect(cache.openPrs).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fresh cache: serves the local diffstat from cache without a git subprocess (#1178)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const cachePath = afkPaths(root).statuslineRepoCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });

      // root is NOT a git repo, so any live `git diff` would return 0/0. A
      // non-zero localAdded/localRemoved in the result can therefore only come
      // from the fresh cache — proving the diff is cached, not recomputed.
      const freshTs = nowS();
      writeFileSync(
        cachePath,
        JSON.stringify({ openPrs: 4, openIssues: 10, localAdded: 42, localRemoved: 7, ts: freshTs }),
        "utf8",
      );

      const result = await collectStatuslineRepo({ root, repo: "", remote: "origin" });
      expect(result.localAdded).toBe(42); // served from cache, no git subprocess
      expect(result.localRemoved).toBe(7);

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { ts: number };
      expect(cache.ts).toBe(freshTs); // ts unchanged → nothing refreshed
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fresh TOON repo cache: serves the local diffstat without a refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const cachePath = afkPaths(root).statuslineRepoCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });
      const freshTs = nowS();
      writeFileSync(
        cachePath,
        encode({ baseRef: "origin/main", openPrs: 6, todayPrs: 2, openIssues: 14, localAdded: 20, localRemoved: 3, ts: freshTs }),
        "utf8",
      );

      const result = await collectStatuslineRepo({ root, repo: "", remote: "origin" });

      expect(result.openPrs).toBe(6);
      expect(result.todayPrs).toBe(2);
      expect(result.openIssues).toBe(14);
      expect(result.localAdded).toBe(20);
      expect(result.localRemoved).toBe(3);
      expect(readToonCache<{ ts: number }>(cachePath).ts).toBe(freshTs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exhausted read: keeps the known open-PR count and never publishes a false zero (#2801)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = afkPaths(root).statuslineRepoCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });

      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(
        cachePath,
        encode({ baseRef: "origin/main", openPrs: 2, todayPrs: 1, openIssues: 5, ts: staleTs }),
        "utf8",
      );

      // The read cannot run, so "0 open pull requests" is not an answer this
      // surface is allowed to give: it keeps the last known 2 and reports the
      // staleness instead.
      const result = await withRateLimitedGh(() =>
        collectStatuslineRepo({ root, repo: "o/r", remote: "origin" }),
      );

      expect(result.openPrs).toBe(2);
      expect(result.cacheAgeS).toBeGreaterThan(0);
      expect(readToonCache<{ openPrs: number; ts: number }>(cachePath)).toMatchObject({
        openPrs: 2,
        ts: staleTs,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1178 folded the diffstat into the network refresh; #3546 moved that whole
  // refresh into the detached child. The fold is preserved there: one child,
  // one refresh, counts and diffstat together (`refreshStatuslineRepoCache`).
  it("stale cache: the diffstat travels with the refresh, in the child (#1178, #3546)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = afkPaths(root).statuslineRepoCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });

      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(
        cachePath,
        JSON.stringify({ openPrs: 3, openIssues: 5, localAdded: 99, localRemoved: 11, ts: staleTs }),
        "utf8",
      );

      const rec = detachedSpawnRecorder();
      const repo = await withFakeGh(() =>
        collectStatuslineRepo({ root, repo: "o/r", remote: "origin" }, undefined, "origin/main", {
          spawn: rec.spawn,
          argv1: "/tmp/afk.mjs",
        }),
      );

      // The stale diff fields render as-is; the child owns the re-measure.
      expect(repo.localAdded).toBe(99);
      expect(repo.localRemoved).toBe(11);
      expect(rec.calls).toHaveLength(1);
      // The child gets the base ref, which is what the diffstat is measured against.
      const argv = rec.calls[0]?.args ?? [];
      expect(argv[argv.indexOf("--base-ref") + 1]).toBe("origin/main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectStatuslineDocs — cached local git state only", () => {
  it("counts unlanded docs without fetching", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-docs-"));
    try {
      mkdirSync(join(root, ".red", "contexts", "dev"), { recursive: true });
      const exec = async (cmd: string, args: readonly string[]): Promise<ExecOutput> => {
        if (cmd !== "git") return { code: 127, stdout: "", stderr: "unexpected command" };
        if (args[0] === "fetch") throw new Error("statusline docs collector must not fetch");
        if (args[0] === "ls-tree") return { code: 0, stdout: ".red/CONTEXT-MAP.md\n", stderr: "" };
        if (args[0] === "status") {
          return {
            code: 0,
            stdout: " M .red/CONTEXT-MAP.md\n?? .red/contexts/dev/NEW.md\n?? README.md\n",
            stderr: "",
          };
        }
        if (args[0] === "diff") return { code: 0, stdout: ".red/adr/0100-local.md\nREADME.md\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected git command" };
      };

      await expect(collectStatuslineDocs({ root, repo: "", remote: "origin" }, "main", exec)).resolves.toEqual({
        count: 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// STATUSLINE_CACHE_TTL_S — the default TTL constant (#1178, lowered #1217, raised #1216)
// ---------------------------------------------------------------------------

describe("STATUSLINE_CACHE_TTL_S", () => {
  it("defaults to 900 s (15 minutes): TTL is reconciliation-only for statusline counts", () => {
    expect(STATUSLINE_CACHE_TTL_S).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// resolveStatuslineCacheTtl — env > config > 900, typo-safe fallback (#1217)
// ---------------------------------------------------------------------------

describe("resolveStatuslineCacheTtl (#1217)", () => {
  const noCfg = () => "";

  it("defaults to 900 when neither env nor config is set", () => {
    expect(resolveStatuslineCacheTtl({}, noCfg)).toBe(900);
    expect(resolveStatuslineCacheTtl({}, noCfg)).toBe(STATUSLINE_CACHE_TTL_S);
  });

  it("env RED_AFK_STATUSLINE_CACHE_TTL_S wins over config", () => {
    const getCfg = (key: string) => (key === "afk.statusline_cache_ttl" ? "240" : "");
    expect(resolveStatuslineCacheTtl({ RED_AFK_STATUSLINE_CACHE_TTL_S: "90" }, getCfg)).toBe(90);
  });

  it("uses the config value when env is absent", () => {
    const getCfg = (key: string) => (key === "afk.statusline_cache_ttl" ? "240" : "");
    expect(resolveStatuslineCacheTtl({}, getCfg)).toBe(240);
  });

  it("falls back to config when env is garbage (non-numeric / 0 / negative)", () => {
    const getCfg = (key: string) => (key === "afk.statusline_cache_ttl" ? "240" : "");
    expect(resolveStatuslineCacheTtl({ RED_AFK_STATUSLINE_CACHE_TTL_S: "nope" }, getCfg)).toBe(240);
    expect(resolveStatuslineCacheTtl({ RED_AFK_STATUSLINE_CACHE_TTL_S: "0" }, getCfg)).toBe(240);
    expect(resolveStatuslineCacheTtl({ RED_AFK_STATUSLINE_CACHE_TTL_S: "-5" }, getCfg)).toBe(240);
  });

  it("falls back to 900 when BOTH env and config are garbage — never 0", () => {
    const bad = (v: string) => resolveStatuslineCacheTtl({ RED_AFK_STATUSLINE_CACHE_TTL_S: v }, () => v);
    expect(bad("0")).toBe(900);
    expect(bad("-1")).toBe(900);
    expect(bad("abc")).toBe(900);
    // config-only garbage also falls through to the default
    expect(resolveStatuslineCacheTtl({}, () => "0")).toBe(900);
    expect(resolveStatuslineCacheTtl({}, () => "-9")).toBe(900);
    expect(resolveStatuslineCacheTtl({}, () => "xyz")).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// collectMonitorInputs — layout discovery (#1029)
// Both sandcastle and legacy layouts put afk.state.toon at the same path
// ({workersRoot}/{workerID}/{attemptDir}/afk.state.toon) — the difference is
// where the git worktree lives. This suite verifies both layouts are discovered
// by the Worker state reader, satisfying the "no monitor-private globbing" contract.
// ---------------------------------------------------------------------------

describe("collectMonitorInputs — layout discovery (#1029)", () => {
  it("keeps a pid-live wedged worker visible with the shared stalled verdict (#2480)", async () => {
    const root = scratch();
    const leaf = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      expect(leaf.pid).toBeTypeOf("number");
      const attemptDir = join(root, ".red", "tmp", "workers", "wWEDGE", "2480");
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(
        join(attemptDir, "afk.state.toon"),
        JSON.stringify({
          worker_id: "wWEDGE",
          pid: leaf.pid,
          runner: "codex",
          current: {
            number: 2480,
            phase: "gate",
            activity: "landing",
            started_at: new Date().toISOString(),
          },
        }),
      );

      const workers = await collectStatuslineWorkers({ root, repo: "", remote: "origin" });
      expect(workers).toHaveLength(1);
      expect(workers[0]).toMatchObject({
        pidLive: true,
        liveness: "dead",
        livenessVerdict: {
          status: "stalled",
          laneFresh: false,
          liveDescendants: false,
        },
      });
    } finally {
      leaf.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers a sandcastle-layout worker (state at attemptDir/afk.state.toon, worktree absent pre-heartbeat)", async () => {
    const root = scratch();
    try {
      // Sandcastle layout: state file at the standard path; worktree field not yet
      // set (simulates the pre-heartbeat window where current.worktree = "").
      // Live pid → survives the #1219 renderableLive gate so discovery is what's tested.
      const attemptDir = join(root, ".red", "tmp", "workers", "wSC", "42-a1");
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(
        join(attemptDir, "afk.state.toon"),
        JSON.stringify({ worker_id: "wSC", pid: process.pid, runner: "claude", total: 5, done: 2 }),
      );
      const { workers } = await collectMonitorInputs(root);
      // The worker must appear in the output — sandcastle layout does not hide the
      // state file from the Worker state reader.
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.worker_id).toBe("wSC");
      expect(workers[0]!.state.done).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers a legacy-layout worker (state at attemptDir/afk.state.toon, worktree at attemptDir/worktree)", async () => {
    const root = scratch();
    try {
      const attemptDir = join(root, ".red", "tmp", "workers", "wLG", "7-a1");
      mkdirSync(attemptDir, { recursive: true });
      // Legacy layout: current.worktree points to {attemptDir}/worktree (doesn't
      // exist here; git call fails gracefully, diffstat returns 0,0 safely).
      writeFileSync(
        join(attemptDir, "afk.state.toon"),
        JSON.stringify({
          // Live pid → survives the #1219 renderableLive gate; legacy-layout discovery is what's tested.
          worker_id: "wLG",
          pid: process.pid,
          runner: "codex",
          total: 3,
          done: 0,
          current: { worktree: join(attemptDir, "worktree") },
        }),
      );
      const { workers } = await collectMonitorInputs(root);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.worker_id).toBe("wLG");
      // Diffstat gracefully returns 0,0 when worktree path does not exist — no crash.
      expect(workers[0]!.diffAdded).toBe(0);
      expect(workers[0]!.diffRemoved).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a live worker under the sandcastle layout renders in the dashboard (not 'workers: none')", async () => {
    const root = scratch();
    try {
      // Use process.pid so isStateLive → true (pid is alive).
      const attemptDir = join(root, ".red", "tmp", "workers", "wLIVE", "99-a1");
      mkdirSync(attemptDir, { recursive: true });
      const stateFile = join(attemptDir, "afk.state.toon");
      writeFileSync(
        stateFile,
        JSON.stringify({
          worker_id: "wLIVE",
          pid: process.pid,
          runner: "claude",
          total: 1,
          done: 0,
          current: { number: 99, title: "test issue", activity: "impl", started_at: new Date().toISOString(), loc_added: 5 },
        }),
      );
      const { workers } = await collectMonitorInputs(root);
      // Regression guard: live worker must appear (workers.length > 0), not be hidden.
      expect(workers.length).toBeGreaterThan(0);
      const found = workers.find((w) => w.state.worker_id === "wLIVE");
      expect(found).toBeDefined();
      // pid-live worker is not dead — the liveness verdict must not be "dead".
      expect(found!.liveness).not.toBe("dead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// collectMonitorInputs — remote facts (TTL cache) (#1029)
// ---------------------------------------------------------------------------

describe("collectMonitorInputs — remote facts (TTL cache) (#1029)", () => {
  it("returns no remote facts when the statusline cache is absent", async () => {
    const root = scratch();
    try {
      const result = await collectMonitorInputs(root);
      expect(result.remoteQueue).toBeUndefined();
      expect(result.remoteHuman).toBeUndefined();
      expect(result.remoteCacheAgeS).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes queue/human from a fresh statusline cache with low age", async () => {
    const root = scratch();
    try {
      const freshTs = nowS();
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ queue: 4, human: 2, ts: freshTs }));
      const result = await collectMonitorInputs(root);
      expect(result.remoteQueue).toBe(4);
      expect(result.remoteHuman).toBe(2);
      expect(result.remoteCacheAgeS).toBeGreaterThanOrEqual(0);
      // Fresh cache age must be below the TTL.
      expect(result.remoteCacheAgeS).toBeLessThan(STATUSLINE_CACHE_TTL_S);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a stale age when the cache is older than the TTL", async () => {
    const root = scratch();
    try {
      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 30;
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ queue: 7, human: 1, ts: staleTs }));
      const result = await collectMonitorInputs(root);
      expect(result.remoteQueue).toBe(7);
      expect(result.remoteHuman).toBe(1);
      // Age must exceed the TTL so the render can show a stale marker.
      expect(result.remoteCacheAgeS).toBeGreaterThanOrEqual(STATUSLINE_CACHE_TTL_S);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT refresh the cache (monitor is read-only; statusline owns cache lifecycle)", async () => {
    const root = scratch();
    try {
      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 30;
      const cachePath = afkPaths(root).statuslineCachePath;
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ queue: 9, human: 3, ts: staleTs }));
      await collectMonitorInputs(root);
      // The cache timestamp must NOT have changed — the monitor never refreshes it.
      const after = JSON.parse(readFileSync(cachePath, "utf8")) as { ts: number };
      expect(after.ts).toBe(staleTs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
