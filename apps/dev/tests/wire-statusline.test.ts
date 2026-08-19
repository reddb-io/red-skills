import { describe, expect, it } from "vitest";
import { createCastleLaneWriters } from "@reddb-io/worker/engine";
import { spawn } from "node:child_process";
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
  decode,
  dirname,
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
  withFakeGh,
  writeCastleStateSnapshot,
  writeFileSync,
  writeRenderableAttempt,
} from "./wire.helpers.js";

describe("collectStatuslineAfk — cache discipline", () => {
  it("counts a pid-live worker even when its activity is stale (#836)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
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
