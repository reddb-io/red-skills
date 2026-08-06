import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processIssue,
  type ProcessIssueDeps,
  type ProcessIssueInput,
} from "../src/core/process-issue.js";
import { classifyMergeState } from "../src/core/merge.js";
import { readsPull, restPullBody } from "./support/gh-rest-fixtures.js";

// AFK end-to-end lifecycle harness against a REAL local git repo.
//
// process-issue.test.ts drives the SAME `processIssue(deps, input)` orchestrator
// but injects a fully-fake git/merge layer that string-matches every argv and
// returns a scripted ExecResult — so it can never catch a bug whose only symptom
// is what real git does (a real rebase that conflicts, a real fast-forward that
// lands, a `merge-base --is-ancestor` verdict on a genuine ancestry). This
// harness replaces ONLY the git/merge execution layer + the runner with real
// implementations: a temp bare "origin", a working clone, and real `git`
// subprocesses back `mergeExec` / `remoteGit` / the changed-file lookup. `gh`
// (which has no local forge) stays scripted, but `gh pr merge` performs a REAL
// git fast-forward of origin/main so a "land" is observable in the temp repo.
//
// It pins the class of bug that only surfaced when the real fleet ran (#2084 /
// #2096): a transient `mergeStateStatus:"BEHIND"` read must NOT be mistaken for a
// merge conflict. `classifyMergeState` maps BEHIND→pending (re-poll → CLEAN →
// merge), so a provably fast-forwardable branch LANDS instead of looping through
// blocked:merge-conflict → re-claim → BEHIND → forever. The paired failure
// scenario forces a GENUINE `git rebase origin/main` conflict and asserts the
// issue PARKS terminally — proving the fix is correct in BOTH directions
// (BEHIND lands, DIRTY parks), which the all-fake test cannot demonstrate.
//
// A deeper phantom-conflict layer (#2085) is pinned too: a transient DIRTY read
// carrying `mergeable:"UNKNOWN"` — taken before GitHub finishes computing
// mergeability — must ALSO re-poll and LAND. `classifyMergeState` gates on
// `mergeable` (UNKNOWN→pending, CONFLICTING→conflict), with DIRTY→conflict only a
// back-compat fallback, so only a genuine conflict parks.

interface ExecOut {
  code: number;
  stdout: string;
  stderr: string;
}

// Hermetic git: ignore the host's global/system config (no signing, no user
// hooks, deterministic identity) and never prompt. No machine-identity literals —
// identity + paths are synthetic. `process.env` is inherited only for PATH.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "AFK E2E",
  GIT_AUTHOR_EMAIL: "afk-e2e@example.invalid",
  GIT_COMMITTER_NAME: "AFK E2E",
  GIT_COMMITTER_EMAIL: "afk-e2e@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

/** Run a real subprocess, resolving the exit code instead of throwing — several
 * git probes (`merge-base --is-ancestor`, a conflicting `rebase`) communicate via
 * a non-zero exit that the production code branches on. */
function runReal(cmd: string, args: string[]): Promise<ExecOut> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: GIT_ENV, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = e == null ? 0 : typeof e.code === "number" ? e.code : 1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

const gitAt = (cwd: string, args: string[]): Promise<ExecOut> => runReal("git", ["-C", cwd, ...args]);
const revParse = async (cwd: string, ref: string): Promise<string> =>
  (await gitAt(cwd, ["rev-parse", ref])).stdout.trim();

const WORKER_BRANCH = "afk/9-fix-the-thing"; // deterministic per issue (#2416)
const WORKER_MARKER = "E2E-WORKER-CHANGE";
const MAINLINE_MARKER = "E2E-MAINLINE-CHANGE";
const SRC_FILE = ["src", "x.ts"];

interface Trace {
  labelEdits: Array<{ issue: number; remove: string[]; add: string[] }>;
  comments: Array<{ issue: number; body: string }>;
  bodyEdits: Array<{ issue: number; body: string }>;
  closed: number[];
  swept: number[];
  released: number[];
  ensuredLabels: string[];
  postedEnvelopes: Array<{ issue: number; status: string }>;
  runAgentCalls: number;
}

interface E2EState {
  workerBranchRef?: string;
  workerCommitSha?: string;
  /** The concurrent-lander commit that advances origin/main in the conflict
   * scenario (a different worker landing the SAME line first). */
  mainlineCommitSha?: string;
  prNumber?: number;
  /** origin/main after the scripted `gh pr merge` really landed — the SHA the
   * #2986 merge confirmation reports back as the merge commit. */
  mergedTipSha?: string;
  prViewCalls: number;
  /** Every git/gh argv the merge + remote executors ran, for flow assertions. */
  execLog: string[][];
}

// Clean every temp repo the run created.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * Build a real temp repo (bare origin + working clone) seeded with one commit on
 * `main`, then a full {@link ProcessIssueDeps}/{@link ProcessIssueInput} whose
 * git/merge layer and runner are REAL. `opts.conflict` selects the runner's edit:
 *   - false → append a fresh line (a clean linear fast-forward over origin/main);
 *   - true  → rewrite the shared line AND land a conflicting concurrent commit on
 *             origin/main, so the real pre-merge `git rebase origin/main` conflicts.
 */
async function setup(opts: {
  conflict: boolean;
  /** Scripted `gh pr view` settle sequence (index = prior poll count; the last
   * entry repeats). Clean scenarios pass their own; the conflict scenario never
   * reaches the poll. */
  prView?: Array<{ mergeStateStatus: string; mergeable: string }>;
}): Promise<{
  deps: ProcessIssueDeps;
  input: ProcessIssueInput;
  trace: Trace;
  state: E2EState;
  originDir: string;
  repoDir: string;
  initialMainSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "afk-e2e-"));
  roots.push(root);
  const originDir = join(root, "origin.git");
  const repoDir = join(root, "repo");
  const agentWt = join(root, "agent-wt");

  // ---- seed origin/main with an initial commit ----
  await runReal("git", ["init", "--bare", originDir]);
  await runReal("git", ["init", repoDir]);
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "README.md"), "# AFK E2E fixture\n");
  await writeFile(join(repoDir, ...SRC_FILE), 'export const value = "initial";\n');
  await gitAt(repoDir, ["add", "-A"]);
  await gitAt(repoDir, ["commit", "-m", "initial"]);
  await gitAt(repoDir, ["branch", "-M", "main"]);
  await gitAt(repoDir, ["remote", "add", "origin", originDir]);
  await gitAt(repoDir, ["push", "-u", "origin", "main"]);
  const initialMainSha = await revParse(originDir, "refs/heads/main");

  const trace: Trace = {
    labelEdits: [],
    comments: [],
    bodyEdits: [],
    closed: [],
    swept: [],
    released: [],
    ensuredLabels: [],
    postedEnvelopes: [],
    runAgentCalls: 0,
  };
  const state: E2EState = { prViewCalls: 0, execLog: [] };
  let rebaseWtSeq = 0;

  // ---- scripted `gh` (no local forge) with a REAL fast-forward on merge ----
  const handleGh = async (argv: string[]): Promise<ExecOut> => {
    const prIdx = argv.indexOf("pr");
    const sub = prIdx >= 0 ? argv[prIdx + 1] : "";
    if (sub === "list") {
      // Reuse-or-create: empty until `pr create` mints a number.
      return { code: 0, stdout: state.prNumber ? `${state.prNumber}\n` : "", stderr: "" };
    }
    if (sub === "create") {
      state.prNumber = 101;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (readsPull(argv)) {
      // #2986 merge confirmation, now a REST single-object read (#3094). This
      // forge merges synchronously, so the probe reports MERGED exactly when the
      // scripted `pr merge` actually landed — and reports an unmerged, still-open
      // PR when it did not.
      if (!state.mergedTipSha) {
        return {
          code: 0,
          stdout: JSON.stringify(
            restPullBody({ state: "OPEN", mergedAt: null, mergeCommitOid: null, autoMerge: false }),
          ),
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify(
          restPullBody({
            state: "MERGED",
            mergedAt: "2026-08-01T00:00:00Z",
            mergeCommitOid: state.mergedTipSha,
            autoMerge: false,
          }),
        ),
        stderr: "",
      };
    }
    if (sub === "view") {
      // The reader now fetches `mergeStateStatus,mergeable,statusCheckRollup` and
      // gates primarily on `mergeable` (#2085): CONFLICTING→conflict, UNKNOWN→pending
      // (GitHub still computing mergeability → re-poll), with DIRTY→conflict only a
      // back-compat fallback when `mergeable` is absent. Each scenario scripts its
      // own settle sequence; the conflict scenario never reaches this poll (its real
      // pre-merge rebase parks first), so its default is a belt-and-suspenders read.
      const idx = state.prViewCalls;
      state.prViewCalls += 1;
      const sequence =
        opts.prView ??
        (opts.conflict
          ? [{ mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }]
          : [
              { mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" },
              { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" },
            ]);
      const pick = sequence[Math.min(idx, sequence.length - 1)];
      return {
        code: 0,
        stdout: JSON.stringify({
          mergeStateStatus: pick.mergeStateStatus,
          mergeable: pick.mergeable,
          statusCheckRollup: [],
        }),
        stderr: "",
      };
    }
    if (sub === "merge") {
      // A real land: fast-forward origin/main to the worker branch tip so the
      // "merge" is observable in the temp repo. Never lands in the conflict scenario.
      if (opts.conflict || !state.workerBranchRef) {
        return { code: 1, stdout: "", stderr: "refusing to merge a conflicting branch" };
      }
      const ff = await gitAt(originDir, ["update-ref", "refs/heads/main", `refs/heads/${state.workerBranchRef}`]);
      if (ff.code === 0) state.mergedTipSha = await revParse(originDir, "refs/heads/main");
      return { code: ff.code, stdout: "", stderr: ff.stderr };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  // merge.ts / landing.ts pass a full argv led by "git" or "gh".
  const mergeExec: ProcessIssueDeps["mergeExec"] = async (argv) => {
    state.execLog.push(argv);
    if (argv[0] === "gh") return handleGh(argv);
    return runReal("git", argv.slice(1)); // strip the leading "git"
  };
  // remote-branch.ts passes a bare git argv (no leading "git"): real push/delete.
  const remoteGit: ProcessIssueDeps["remoteGit"] = async (argv) => {
    state.execLog.push(["git", ...argv]);
    return runReal("git", argv);
  };

  // ---- the runner: make a REAL commit on the worker branch ----
  const runAgent: ProcessIssueDeps["runAgent"] = async (agentInput) => {
    trace.runAgentCalls += 1;
    const branch = agentInput.branch;
    // Fork the worker branch off the CURRENT origin/main (the initial commit).
    await gitAt(repoDir, ["worktree", "add", "-b", branch, agentWt, "origin/main"]);
    if (opts.conflict) {
      // Rewrite the shared line — this collides with the concurrent lander below.
      await writeFile(join(agentWt, ...SRC_FILE), `export const value = "worker"; // ${WORKER_MARKER}\n`);
    } else {
      // Append a fresh line — a clean fast-forward over an unchanged origin/main.
      await appendFile(join(agentWt, ...SRC_FILE), `export const added = true; // ${WORKER_MARKER}\n`);
    }
    await gitAt(agentWt, ["add", "-A"]);
    await gitAt(agentWt, ["commit", "-m", `feat: implement #9 (${WORKER_MARKER})`]);
    state.workerCommitSha = await revParse(agentWt, "HEAD");
    state.workerBranchRef = branch;

    if (opts.conflict) {
      // Simulate a concurrent worker landing a conflicting edit to the SAME line
      // on origin/main AFTER this branch forked — so the pre-merge rebase onto the
      // freshly-fetched origin/main genuinely conflicts (not a scripted verdict).
      const mainWt = join(root, "mainline-wt");
      await gitAt(repoDir, ["worktree", "add", "--detach", mainWt, "origin/main"]);
      await writeFile(join(mainWt, ...SRC_FILE), `export const value = "mainline"; // ${MAINLINE_MARKER}\n`);
      await gitAt(mainWt, ["add", "-A"]);
      await gitAt(mainWt, ["commit", "-m", `fix: concurrent land (${MAINLINE_MARKER})`]);
      await gitAt(mainWt, ["push", "origin", "HEAD:refs/heads/main"]);
      state.mainlineCommitSha = await revParse(mainWt, "HEAD");
      await gitAt(repoDir, ["worktree", "remove", "--force", mainWt]);
    }

    return {
      outcome: "done",
      branch,
      commits: [{ sha: state.workerCommitSha }],
      completionSignal: "<promise>DONE</promise>",
      stdout: "",
    };
  };

  const deps: ProcessIssueDeps = {
    gh: {
      async viewLabels() {
        return ["ready-for-agent"];
      },
      async editLabels(issue, remove, add) {
        trace.labelEdits.push({ issue, remove, add });
        return true;
      },
      async ensureLabel(name) {
        trace.ensuredLabels.push(name);
      },
      async comment(issue, body) {
        trace.comments.push({ issue, body });
      },
      async editBody(issue, body) {
        trace.bodyEdits.push({ issue, body });
        return true;
      },
      async close(issue) {
        trace.closed.push(issue);
      },
      async listByLabel() {
        return [];
      },
      async issueClosed() {
        return false;
      },
    },
    claimLock: {
      async acquire() {
        return true;
      },
      async release(issue) {
        trace.released.push(issue);
      },
    },
    fs: {
      async ensureAttemptDir() {},
      async writeHandoff() {},
      async writeValidationSidecar() {},
      async completionSweep(issue) {
        trace.swept.push(issue);
        return [];
      },
    },
    git: {
      async headShortSha() {
        return (await gitAt(repoDir, ["rev-parse", "--short", "HEAD"])).stdout.trim();
      },
      async deleteLocalBranch() {},
      async prepareFreshWorkerBranch() {
        return true;
      },
    },
    mergeExec,
    remoteGit,
    // Feedback gate is not the focus — pass green so the flow reaches landing.
    async pnpm() {
      return { code: 0, stdout: "", stderr: "" };
    },
    layout: {
      hasPackage: (scope) => scope === ".",
      hasScript: () => true,
    },
    async runAgent(agentInput) {
      return runAgent(agentInput);
    },
    model: "claude-opus-4-8",
    effort: "high",
    // Force the admin-PR landing so the real pre-merge rebase + the CI-aware
    // BEHIND→CLEAN poll are both exercised.
    worktreeLaunchesPr: true,
    // CI-aware merge (#812): drives the `gh pr view` merge-state poll where the
    // BEHIND regression lives. No-op sleep so the poll runs synchronously.
    ciAwait: { sleep: async () => {}, maxPolls: 5, intervalMs: 1 },
    // Pre-merge rebase runs in an isolated detached worktree on the worker branch
    // (#1006) — a mandatory PR-path precondition (#1212). Real worktrees so a real
    // `git rebase origin/main` decides the conflict.
    async makeRebaseWorktree(branch) {
      const dir = join(root, `rebase-wt-${rebaseWtSeq++}`);
      const r = await gitAt(repoDir, ["worktree", "add", "--detach", dir, branch]);
      return r.code === 0 ? dir : null;
    },
    async removeRebaseWorktree(dir) {
      await gitAt(repoDir, ["worktree", "remove", "--force", dir]);
    },
    // Direct-landing worktrees are never used on the openPr path, but wired real.
    async makeLandingWorktree(base) {
      const dir = join(root, `land-wt-${rebaseWtSeq++}`);
      const r = await gitAt(repoDir, ["worktree", "add", "--detach", dir, `origin/${base}`]);
      return r.code === 0 ? dir : null;
    },
    async removeLandingWorktree(dir) {
      await gitAt(repoDir, ["worktree", "remove", "--force", dir]);
    },
    hooks: {
      config: {},
      resolveOptions: { defaultCommand: () => undefined },
      exec: async () => ({ code: 0, stdout: "" }),
    },
    lookups: {
      base: {
        async readLockedBranch() {
          return undefined; // unlocked → base resolves to the default trunk "main"
        },
        configTrunk: undefined,
        async fetchIssueBody() {
          return undefined;
        },
      },
      async isLocked() {
        return false;
      },
      async comments() {
        return [];
      },
      async issueUrl() {
        return "https://github.com/o/r/issues/9";
      },
      async prevFailureContext() {
        return undefined;
      },
      async changedFiles(branch, base) {
        const r = await gitAt(repoDir, ["diff", "--name-only", `${base}...${branch}`]);
        return r.stdout.trim().split("\n").filter(Boolean);
      },
      async diffstat() {
        return "+1 -0 files=1";
      },
      async branchPresent(branch) {
        return (await gitAt(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
      },
      async branchMerged() {
        return false;
      },
    },
    envelope: {
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
      poster: async (issue, body) => {
        const status = /data-attempt-status="([^"]*)"/.exec(body)?.[1] ?? "?";
        trace.postedEnvelopes.push({ issue, status });
        return true;
      },
      async writeMarkers() {},
      async writePosted() {},
    },
    nowEpoch: () => 1000,
    nowIso: () => "2026-01-01T00:00:00Z",
    appendIterLog: () => {},
    markState: () => {},
  };

  const input: ProcessIssueInput = {
    issue: 9,
    title: "Fix the thing",
    body: "## Agent brief\nDo it.",
    runner: "claude",
    workerId: "wAAAA",
    claimant: "e2ehost:wAAAA",
    tmpDir: join(root, "tmp"),
    attempt: 1,
    attemptDir: join(root, "tmp", "workers", "wAAAA", "9"),
    repo: "o/r",
    repoDir,
    remote: "origin",
    forkSha: initialMainSha,
    baseInput: { issueBody: "## Agent brief\nDo it." },
  };

  return { deps, input, trace, state, originDir, repoDir, initialMainSha };
}

describe("AFK e2e (real local git) — full lifecycle through processIssue", () => {
  it("SUCCESS: transient BEHIND still LANDS — origin/main advances, issue closes, no merge-conflict park", async () => {
    const { deps, input, trace, state, originDir, initialMainSha } = await setup({ conflict: false });

    const result = await processIssue(deps, input);

    // Terminal outcome is a clean landed close.
    expect(result.outcome).toBe("done");
    expect(result.issue).toBe(9);
    expect(result.branch).toBe(WORKER_BRANCH);
    expect(result.base).toBe("main");
    expect(result.locked).toBe(false);

    // The agent ran exactly once — no re-run, no loop.
    expect(trace.runAgentCalls).toBe(1);

    // Lifecycle transitions: ready-for-agent → running (claim), then running dropped (close).
    expect(trace.labelEdits.some((e) => e.remove.includes("ready-for-agent") && e.add.includes("running"))).toBe(true);
    expect(trace.labelEdits.some((e) => e.remove.includes("running"))).toBe(true);
    expect(trace.closed).toContain(9);
    expect(trace.swept).toContain(9);
    expect(trace.released).toContain(9);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);

    // The BEHIND regression, positively: the merge state was re-polled after the
    // first BEHIND read (BEHIND→pending→re-poll→CLEAN→merge), never mis-parked.
    expect(state.prViewCalls).toBeGreaterThanOrEqual(2);
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    expect(trace.labelEdits.every((e) => !e.add.includes("blocked:merge-conflict"))).toBe(true);
    expect(trace.labelEdits.every((e) => !e.add.includes("ready-for-human"))).toBe(true);
    expect(trace.comments.every((c) => !/merge.conflict/i.test(c.body))).toBe(true);

    // The land is observable in the REAL repo: origin/main fast-forwarded to the
    // worker's commit and now carries the worker's change.
    const originMain = await revParse(originDir, "refs/heads/main");
    expect(originMain).toBe(state.workerCommitSha);
    expect(originMain).not.toBe(initialMainSha);
    const landed = (await gitAt(originDir, ["show", "main:src/x.ts"])).stdout;
    expect(landed).toContain(WORKER_MARKER);
  });

  it("FAILURE: a genuine rebase conflict PARKS terminally — origin/main unchanged by the worker, issue not closed, no loop", async () => {
    const { deps, input, trace, state, originDir } = await setup({ conflict: true });

    const result = await processIssue(deps, input);

    // A single terminal failure — the real `git rebase origin/main` conflicted,
    // so the PR path parked via pr-conflict (NOT an early feedback/push failure).
    expect(result.outcome).toBe("merge-conflict");
    expect(result.preserved).toBe(true);
    expect(trace.runAgentCalls).toBe(1); // ran once; no re-run / concede / re-claim loop
    expect(trace.released).toContain(9);

    // The park was driven by the REAL `git rebase origin/main` conflict in the
    // pre-merge rebase step — which returns BEFORE landPr's CI-aware poll — so the
    // scripted DIRTY `gh pr view` verdict is never even consulted here.
    expect(state.prViewCalls).toBe(0);

    // Parked to a human with the typed conflict label (the exact pr-conflict park).
    expect(trace.ensuredLabels).toContain("blocked:merge-conflict");
    expect(
      trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:merge-conflict")),
    ).toBe(true);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "merge-conflict" }]);

    // NOT landed: the issue stays open and origin/main was never moved by the
    // worker. main reflects only the concurrent lander's commit, never the worker's.
    expect(trace.closed).not.toContain(9);
    const originMain = await revParse(originDir, "refs/heads/main");
    expect(originMain).toBe(state.mainlineCommitSha);
    expect(originMain).not.toBe(state.workerCommitSha);
    const onMain = (await gitAt(originDir, ["show", "main:src/x.ts"])).stdout;
    expect(onMain).toContain(MAINLINE_MARKER);
    expect(onMain).not.toContain(WORKER_MARKER);
  });

  it("SUCCESS: a transient unsettled DIRTY/mergeable=UNKNOWN read still LANDS after re-poll (#2085)", async () => {
    // The deeper phantom-conflict layer the BEHIND fix (#2096) missed: GitHub can
    // report a spurious DIRTY with `mergeable=UNKNOWN` before it finishes computing
    // mergeability, then settle to CLEAN/MERGEABLE. The reader must gate on
    // `mergeable` (UNKNOWN→pending→re-poll), NOT classify the transient DIRTY as a
    // terminal conflict — else a fast-forwardable branch loops forever (#2085).
    const { deps, input, trace, state, originDir, initialMainSha } = await setup({
      conflict: false,
      prView: [
        { mergeStateStatus: "DIRTY", mergeable: "UNKNOWN" }, // still computing → re-poll
        { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, // settled → land
      ],
    });

    const result = await processIssue(deps, input);

    // Lands exactly like the BEHIND case — the transient unsettled read never parks.
    expect(result.outcome).toBe("done");
    expect(result.branch).toBe(WORKER_BRANCH);
    expect(result.base).toBe("main");
    expect(trace.runAgentCalls).toBe(1);

    // Re-polled after the unsettled read, then landed — never mis-parked.
    expect(state.prViewCalls).toBeGreaterThanOrEqual(2);
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    expect(trace.labelEdits.every((e) => !e.add.includes("blocked:merge-conflict"))).toBe(true);
    expect(trace.labelEdits.every((e) => !e.add.includes("ready-for-human"))).toBe(true);
    expect(trace.comments.every((c) => !/merge.conflict/i.test(c.body))).toBe(true);

    expect(trace.closed).toContain(9);
    expect(trace.swept).toContain(9);
    expect(trace.released).toContain(9);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);

    // Real land: origin/main fast-forwarded to the worker commit + carries the change.
    const originMain = await revParse(originDir, "refs/heads/main");
    expect(originMain).toBe(state.workerCommitSha);
    expect(originMain).not.toBe(initialMainSha);
    const landed = (await gitAt(originDir, ["show", "main:src/x.ts"])).stdout;
    expect(landed).toContain(WORKER_MARKER);
  });

  it("classifyMergeState honors the phantom-conflict fixes (BEHIND→pending + mergeable-gate)", () => {
    // The unit invariant the two real-git flows above exercise end-to-end: a
    // transient BEHIND must re-poll (land), a real DIRTY must park.
    const v = (mergeStateStatus: string, mergeable = "") => ({ mergeStateStatus, mergeable, anyFailed: false, anyPending: false });
    expect(classifyMergeState(v("BEHIND"))).toBe("pending");
    expect(classifyMergeState(v("CLEAN"))).toBe("merge");
    expect(classifyMergeState(v("DIRTY"))).toBe("conflict");
    // mergeable-gate (the deeper #2085 layer): a DIRTY read taken before GitHub
    // settles mergeability (mergeable=UNKNOWN) must NOT terminally park a
    // fast-forwardable branch — re-poll. Only mergeable=CONFLICTING is a conflict.
    expect(classifyMergeState(v("DIRTY", "UNKNOWN"))).toBe("pending");
    expect(classifyMergeState(v("DIRTY", "CONFLICTING"))).toBe("conflict");
    expect(classifyMergeState(v("CLEAN", "MERGEABLE"))).toBe("merge");
  });
});
