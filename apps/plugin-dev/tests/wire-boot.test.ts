import { describe, expect, it } from "vitest";
import {
  afkPaths,
  appendCastleHistoryRecord,
  buildMinimalBootDeps,
  castleStateSnapshotPath,
  collectMonitorInputs,
  collectStatuslineAfk,
  collectStatuslineDocs,
  collectStatuslineWorkers,
  createEnginePaths,
  encode,
  existsSync,
  fakeBinDir,
  inferGitHubRepoSlug,
  join,
  mkdirSync,
  mkdtempSync,
  nowS,
  parseGitHubRepoSlugFromRemoteUrl,
  readFleetState,
  readFileSync,
  resolveAttemptProbeArming,
  resolveAttemptHead,
  resolveRunSettings,
  rmSync,
  runBoot,
  scratch,
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
