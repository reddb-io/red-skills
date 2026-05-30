import { describe, expect, it } from "vitest";
import {
  processIssue,
  type ProcessIssueDeps,
  type ProcessIssueInput,
} from "../src/core/process-issue.js";
import type { HookName } from "../src/core/hook-config.js";
import type { ConfigValues } from "../src/core/config.js";
import type { SpawnInvocation } from "../src/core/runner-spawn.js";

// Everything injected is a fake — no real gh / git / spawn / pnpm / fs ever
// runs. The harness records the side-effect sequence (label edits, comments,
// close, sweep, hook order) so each test asserts the lifecycle as a trace
// rather than reaching into the modules being composed.

interface Trace {
  labelEdits: Array<{ issue: number; remove: string[]; add: string[] }>;
  comments: Array<{ issue: number; body: string }>;
  closed: number[];
  swept: number[];
  pushedInitial: string[][];
  deletedRemote: string[][];
  postedEnvelopes: Array<{ issue: number; status: string }>;
  worktreesDropped: string[];
  released: number[];
}

interface HarnessOptions {
  labels?: string[];
  acquire?: boolean;
  sentinel?: "done" | "blocked" | "no-sentinel" | "exhausted";
  feedbackOk?: boolean;
  locked?: boolean;
  worktreeAddOk?: boolean;
  config?: ConfigValues;
  abortHook?: HookName;
  changedFiles?: string[];
}

function harness(opts: HarnessOptions = {}): {
  deps: ProcessIssueDeps;
  input: ProcessIssueInput;
  trace: Trace;
} {
  const trace: Trace = {
    labelEdits: [],
    comments: [],
    closed: [],
    swept: [],
    pushedInitial: [],
    deletedRemote: [],
    postedEnvelopes: [],
    worktreesDropped: [],
    released: [],
  };

  const sentinel = opts.sentinel ?? "done";
  const scriptedLines = (() => {
    switch (sentinel) {
      case "done":
        return ["Edit src/x.ts", "<promise>DONE</promise>"];
      case "blocked":
        return ["Edit src/x.ts", "<promise>BLOCKED</promise>"];
      case "no-sentinel":
        return ["Edit src/x.ts", "last line, no sentinel"];
      case "exhausted":
        return ["usage limit reached, try again later"];
    }
  })();

  const config: ConfigValues = opts.config ?? {};

  const deps: ProcessIssueDeps = {
    gh: {
      async viewLabels() {
        return opts.labels ?? ["ready-for-agent"];
      },
      async editLabels(issue, remove, add) {
        trace.labelEdits.push({ issue, remove, add });
        return true;
      },
      async comment(issue, body) {
        trace.comments.push({ issue, body });
      },
      async close(issue) {
        trace.closed.push(issue);
      },
    },
    claimLock: {
      async acquire() {
        return opts.acquire ?? true;
      },
      async release(issue) {
        trace.released.push(issue);
      },
    },
    fs: {
      async ensureAttemptDir() {},
      async writeHandoff() {},
      async installPostCommitHook() {},
      async dropWorktree(worktree) {
        trace.worktreesDropped.push(worktree);
      },
      async completionSweep(issue) {
        trace.swept.push(issue);
        return [`/tmp/workers/w/${issue}-a1`];
      },
    },
    git: {
      async fetchBase() {},
      async worktreeAdd() {
        return opts.worktreeAddOk ?? true;
      },
      async headShortSha() {
        return "abc1234";
      },
      async deleteLocalBranch() {},
    },
    mergeExec: async (argv) => {
      // landPr reuses an open PR via `gh pr list`; reply with a number so it
      // resolves without a create round-trip.
      if (argv.includes("pr") && argv.includes("list")) {
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    remoteGit: async (argv) => {
      if (argv.includes("--delete")) trace.deletedRemote.push(argv);
      else trace.pushedInitial.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
    pnpm: async () => ({ code: opts.feedbackOk === false ? 1 : 0, stdout: "", stderr: "" }),
    layout: {
      hasPackage: (scope) => scope === ".",
      hasScript: () => true,
    },
    runner: {
      spawn: () => ({
        lines: (async function* () {
          for (const line of scriptedLines) yield line;
        })(),
      }),
      buildInvocation(): SpawnInvocation {
        return { command: "claude", args: ["--print", "x"] };
      },
    },
    hooks: {
      config,
      resolveOptions: {
        // Default resolver returns a sentinel command per default so the
        // dispatcher has something to run; the hook exec below decides rc.
        defaultCommand: () => undefined,
      },
      exec: async (command) => {
        // An aborting hook is keyed by a command marker the test injects.
        if (opts.abortHook && command === `abort:${opts.abortHook}`) {
          return { code: 1, stdout: "" };
        }
        return { code: 0, stdout: "" };
      },
    },
    lookups: {
      base: {
        async readLockedBranch() {
          return opts.locked ? "main" : undefined;
        },
        async fetchIssueBody() {
          return undefined;
        },
      },
      async isLocked() {
        return opts.locked ?? false;
      },
      async comments() {
        return [];
      },
      async issueUrl() {
        return "https://github.com/o/r/issues/9";
      },
      async recentCommits() {
        return "abc short log";
      },
      async priorAttemptContext() {
        return undefined;
      },
      async changedFiles() {
        return opts.changedFiles ?? ["packages/x/src/a.ts"];
      },
      async diffstat() {
        return "+1 -0 files=1";
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
    nowIso: () => "2026-05-30T00:00:00Z",
    appendIterLog: () => {},
    agentPromptBody: "AGENT BODY",
  };

  // Wire the hook config + abort marker so dispatchHooks has a command to run.
  if (opts.abortHook) {
    config[`afk.hooks.${opts.abortHook}`] = `abort:${opts.abortHook}`;
  }

  const input: ProcessIssueInput = {
    issue: 9,
    title: "Fix the thing",
    body: "## Agent brief\nDo it.",
    runner: "claude",
    workerId: "wAAAA",
    tmpDir: "/tmp/afk",
    attempt: 1,
    attemptDir: "/tmp/afk/workers/wAAAA/9-a1",
    repo: "o/r",
    repoDir: "/repo",
    remote: "origin",
    baseInput: { issueBody: "## Agent brief\nDo it." },
    prdRef: undefined,
  };

  return { deps, input, trace };
}

const labelTrace = (t: Trace): string[] =>
  t.labelEdits.map((e) => `-${e.remove.join("+")}|+${e.add.join("+")}`);

describe("processIssue — DONE + green + merged (unlocked, admin-PR landing)", () => {
  it("runs claim → … → close with the full label transition + completion sweep", async () => {
    const { deps, input, trace } = harness({ sentinel: "done", feedbackOk: true, locked: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.issue).toBe(9);
    expect(result.branch).toBe("afk/wAAAA/9-fix-the-thing");
    expect(result.base).toBe("main");
    expect(result.locked).toBe(false);
    expect(result.mergeSha).toBe("abc1234");
    expect(result.swept).toBe(true);

    // claim: ready-for-agent → running ; close: remove running.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+"]);
    expect(trace.closed).toEqual([9]);
    expect(trace.swept).toEqual([9]);
    // done envelope posted, live remote branch deleted on close.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    expect(trace.deletedRemote.length).toBe(1);
    // worktree dropped, claim released.
    expect(trace.worktreesDropped).toEqual(["/tmp/afk/workers/wAAAA/9-a1/worktree"]);
    expect(trace.released).toEqual([9]);
  });

  it("fires the lifecycle hook points in order", async () => {
    const { deps, input } = harness({ sentinel: "done", feedbackOk: true });
    const result = await processIssue(deps, input);
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_merge",
      "post_merge",
    ]);
  });
});

describe("processIssue — lock-toggled landing", () => {
  it("locked → landMerge (merge --no-ff into the locked branch + push)", async () => {
    const calls: string[][] = [];
    const { deps, input } = harness({ sentinel: "done", feedbackOk: true, locked: true });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.locked).toBe(true);
    // landMerge issues `git -C /repo merge --no-ff afk/wAAAA/9-fix-the-thing …`.
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes("merge --no-ff afk/wAAAA/9-fix-the-thing"))).toBe(true);
    // No PR list/create/merge on the locked path.
    expect(joined.some((c) => c.includes("pr list") || c.includes("pr merge"))).toBe(false);
  });

  it("unlocked → landPr (admin-merged PR into the pinned target)", async () => {
    const calls: string[][] = [];
    const { deps, input } = harness({ sentinel: "done", feedbackOk: true, locked: false });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.locked).toBe(false);
    const joined = calls.map((c) => c.join(" "));
    // landPr reuses the open PR (#42) and admin-merges it.
    expect(joined.some((c) => c.includes("pr list"))).toBe(true);
    expect(joined.some((c) => c.includes("pr merge 42 --admin --merge"))).toBe(true);
    // No direct `merge --no-ff` of the attempt branch into the locked target.
    expect(joined.some((c) => c.includes("merge --no-ff afk/"))).toBe(false);
  });
});

describe("processIssue — BLOCKED", () => {
  it("flips to ready-for-human, posts a failure envelope, preserves the attempt dir", async () => {
    const { deps, input, trace } = harness({ sentinel: "blocked" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(result.preserved).toBe(true);
    expect(result.swept).toBe(false);
    // claim then ready-for-human; never closed.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human"]);
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // worktree dropped but no completion sweep, no remote delete.
    expect(trace.worktreesDropped.length).toBe(1);
    expect(trace.swept).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
  });

  it("fires pre/post_attempt but never pre_merge on the BLOCKED path", async () => {
    const { deps, input } = harness({ sentinel: "blocked" });
    const result = await processIssue(deps, input);
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
  });
});

describe("processIssue — no-sentinel (EOF without a <promise>)", () => {
  it("routes through on_attempt_error → ready-for-human, no post_attempt", async () => {
    const { deps, input, trace } = harness({ sentinel: "no-sentinel" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("no-sentinel");
    expect(result.preserved).toBe(true);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human"]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "no-sentinel" }]);
    // on_attempt_error fires; post_attempt does NOT (ADR 0028).
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "on_attempt_error"]);
  });
});

describe("processIssue — feedback fail", () => {
  it("flips to ready-for-human with a failure envelope when validation fails", async () => {
    const { deps, input, trace } = harness({ sentinel: "done", feedbackOk: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(result.preserved).toBe(true);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human"]);
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // post_attempt fired (the runner authored DONE), pre_merge never reached.
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
  });
});

describe("processIssue — claim lost", () => {
  it("skips when the local claim lock is already held", async () => {
    const { deps, input, trace } = harness({ acquire: false });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.labelEdits).toEqual([]);
    expect(result.hooksFired).toEqual([]);
  });

  it("skips when ready-for-agent is no longer present (raced)", async () => {
    const { deps, input, trace } = harness({ labels: ["running"] });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // no claim edit submitted; the claim lock was released.
    expect(trace.labelEdits).toEqual([]);
    expect(trace.released).toEqual([9]);
  });
});

describe("processIssue — exhausted", () => {
  it("restores ready-for-agent and surfaces the exhausted outcome", async () => {
    const { deps, input, trace } = harness({ sentinel: "exhausted" });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("exhausted");
    expect(result.preserved).toBe(true);
    // running restored to ready-for-agent (not ready-for-human).
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    expect(trace.closed).toEqual([]);
  });
});

describe("processIssue — pre_worktree hook abort", () => {
  it("restores ready-for-agent and never creates the worktree", async () => {
    const { deps, input, trace } = harness({ abortHook: "pre_worktree" });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("hook-aborted");
    expect(result.preserved).toBe(true);
    // claim then restore ready-for-agent; the worktree-add never ran (no push).
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    expect(trace.pushedInitial).toEqual([]);
    expect(result.hooksFired).toEqual(["pre_worktree"]);
  });
});
