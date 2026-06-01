import { describe, expect, it } from "vitest";
import {
  processIssue,
  type ProcessIssueDeps,
  type ProcessIssueInput,
} from "../src/core/process-issue.js";
import type { HookName } from "../src/core/hook-config.js";
import type { ConfigValues } from "../src/core/config.js";
import type { RunAgentInput, RunAgentResult } from "../src/core/execution.js";
import type { AttemptRecordPayload } from "../src/core/attempt-record.js";

// Everything injected is a fake — no real gh / git / sandcastle / pnpm / fs ever
// runs. The harness records the side-effect sequence (label edits, comments,
// close, sweep, hook order) so each test asserts the lifecycle as a trace rather
// than reaching into the modules being composed. Execution itself is the
// injected `runAgent` port (ADR 0033): a fake returning a scripted
// RunAgentResult, replacing the old fake runner-spawn + worktree-create deps.

interface Trace {
  labelEdits: Array<{ issue: number; remove: string[]; add: string[] }>;
  comments: Array<{ issue: number; body: string }>;
  closed: number[];
  swept: number[];
  pushedAttempt: string[][];
  deletedRemote: string[][];
  postedEnvelopes: Array<{ issue: number; status: string }>;
  released: number[];
  runAgentCalls: RunAgentInput[];
  /** Labels queried via gh.listByLabel during the close cascade. */
  listByLabelCalls: string[];
  /** Typed `blocked:<reason>` labels created on the fly via gh.ensureLabel. */
  ensuredLabels: string[];
  /** validation.jsonl writes: (path, lines) per write. */
  sidecarWrites: Array<{ path: string; lines: string[] }>;
  /** Memory reasoning-attempt records fired after a terminal envelope. */
  recordedAttempts: AttemptRecordPayload[];
}

interface HarnessOptions {
  labels?: string[];
  acquire?: boolean;
  outcome?: RunAgentResult["outcome"];
  /** Scripted per-call outcomes (overrides `outcome`); one entry per runAgent call. */
  outcomes?: RunAgentResult["outcome"][];
  feedbackOk?: boolean;
  locked?: boolean;
  config?: ConfigValues;
  abortHook?: HookName;
  /** FIX J: when set, a pre_worktree hook command emits this env as the mutated
   * context's `{env:{…}}` slice — proving it threads onto the runAgent input. */
  preWorktreeEnv?: Record<string, string>;
  changedFiles?: string[];
  /** FIX E: result of the worker-branch presence check. Defaults to true
   * (present). Set false to model "sandcastle commits never reached the host". */
  branchPresent?: boolean;
  fallbackRunner?: boolean;
  /** Records each git fetch-base call (the ADR 0031 start-point fetch). */
  fetchedBases?: string[];
  /** When set, the locked `git merge --no-ff` returns this rc (1 → conflict). */
  mergeNoFfCode?: number;
  /** When true, register a one-shot conflict resolver that "resolves" the merge
   * (no unmerged paths, MERGE_HEAD cleared). When "fail", it leaves the conflict
   * unresolved. When undefined, no resolver is registered. */
  conflictResolve?: "resolve" | "fail";
  /** Records calls into the conflict resolver dispatch. */
  resolverCalls?: string[];
  /** Close-cascade fixture: open dependents returned by gh.listByLabel(req:N),
   * keyed by the queried label (e.g. "req:7"). */
  dependentsByLabel?: Record<string, { number: number; labels: string[] }[]>;
  /** Close-cascade fixture: issues resolved as CLOSED by gh.issueClosed. The
   * just-closed issue is treated as closed without consulting this set. */
  closedIssues?: number[];
  /** Attempt number (1-based) the issue runs under — drives the BOUNDED
   * auto-recovery cap (recovery.ts). Defaults to 1. */
  attempt?: number;
  /** Env view the recovery policy reads RED_AFK_RETRY_* caps from. Defaults to {}. */
  recoveryEnv?: Record<string, string>;
  /** When set, register the ADR 0017 `recordAttempt` port. "throw" makes it
   * reject (proving a memory failure never fails the close); "ok" records the
   * payload; undefined omits the port entirely (older-caller safety). */
  recordAttempt?: "ok" | "throw";
  /** When false, omit the optional fs.writeValidationSidecar port (older-caller
   * safety). Defaults to true (port present + recorded). */
  withSidecarPort?: boolean;
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
    pushedAttempt: [],
    deletedRemote: [],
    postedEnvelopes: [],
    released: [],
    runAgentCalls: [],
    listByLabelCalls: [],
    ensuredLabels: [],
    sidecarWrites: [],
    recordedAttempts: [],
  };

  const outcome = opts.outcome ?? "done";
  const config: ConfigValues = opts.config ?? {};
  // Flipped true once the conflict resolver dispatch runs; the mergeExec
  // verification reads above key off it to model "the agent resolved the merge".
  let mergeResolved = false;

  const deps: ProcessIssueDeps = {
    gh: {
      async viewLabels() {
        return opts.labels ?? ["ready-for-agent"];
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
      async close(issue) {
        trace.closed.push(issue);
      },
      async listByLabel(label) {
        trace.listByLabelCalls.push(label);
        return opts.dependentsByLabel?.[label] ?? [];
      },
      async issueClosed(n) {
        return (opts.closedIssues ?? []).includes(n);
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
      // Optional sidecar port: present unless the test opts it out (older-caller
      // safety). Records every (path, lines) write for assertion.
      writeValidationSidecar:
        opts.withSidecarPort === false
          ? undefined
          : async (path, lines) => {
              trace.sidecarWrites.push({ path, lines });
            },
      async completionSweep(issue) {
        trace.swept.push(issue);
        return [`/tmp/workers/w/${issue}-a1`];
      },
    },
    git: {
      async headShortSha() {
        return "abc1234";
      },
      async deleteLocalBranch() {},
      async fetchBase(base) {
        if (opts.fetchedBases) opts.fetchedBases.push(base);
      },
    },
    mergeExec: async (argv) => {
      const j = argv.join(" ");
      // landPr reuses an open PR via `gh pr list`; reply with a number so it
      // resolves without a create round-trip.
      if (argv.includes("pr") && argv.includes("list")) {
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      // Locked merge --no-ff conflict injection.
      if (opts.mergeNoFfCode !== undefined && j.includes("merge --no-ff")) {
        return { code: opts.mergeNoFfCode, stdout: "", stderr: "" };
      }
      // Conflict-resolver verification reads. `mergeResolved` flips once the
      // resolver dispatch runs (see conflictResolver below).
      if (j.includes("diff --name-only --diff-filter=U")) {
        const unresolved = opts.conflictResolve === "fail" || !mergeResolved;
        return { code: 0, stdout: unresolved ? "src/x.ts\n" : "", stderr: "" };
      }
      if (j.includes("rev-parse -q --verify MERGE_HEAD")) {
        // rc 0 = a merge is still pending (uncommitted); rc 1 = cleared.
        const pending = opts.conflictResolve === "fail" || !mergeResolved;
        return { code: pending ? 0 : 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    remoteGit: async (argv) => {
      if (argv.includes("--delete")) trace.deletedRemote.push(argv);
      else trace.pushedAttempt.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
    pnpm: async () => ({ code: opts.feedbackOk === false ? 1 : 0, stdout: "", stderr: "" }),
    layout: {
      hasPackage: (scope) => scope === ".",
      hasScript: () => true,
    },
    // The sandcastle execution port: a fake returning a scripted outcome on the
    // worker branch sandcastle "committed" to. When `outcomes` is set, each call
    // pops the next scripted outcome (for fallback-swap sequences).
    async runAgent(input) {
      const callIdx = trace.runAgentCalls.length;
      trace.runAgentCalls.push(input);
      const thisOutcome = opts.outcomes ? (opts.outcomes[callIdx] ?? outcome) : outcome;
      return {
        outcome: thisOutcome,
        branch: input.branch,
        commits: thisOutcome === "exhausted" || thisOutcome === "runner-transient" ? [] : [{ sha: "deadbee" }],
        completionSignal:
          thisOutcome === "done"
            ? "<promise>DONE</promise>"
            : thisOutcome === "blocked"
              ? "<promise>BLOCKED</promise>"
              : undefined,
        stdout: thisOutcome === "no-sentinel" ? "Edit src/x.ts\nlast line, no sentinel" : "",
      };
    },
    model: "claude-opus-4-8",
    fallbackRunner: opts.fallbackRunner ?? false,
    conflictResolver: opts.conflictResolve
      ? async (prompt) => {
          if (opts.resolverCalls) opts.resolverCalls.push(prompt);
          if (opts.conflictResolve === "resolve") mergeResolved = true;
        }
      : undefined,
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
        // FIX J: a pre_worktree hook that mutates the context with an env slice
        // (mirrors cargo-pre-worktree.sh emitting {env:{CARGO_TARGET_DIR:…}}).
        if (opts.preWorktreeEnv && command === "emit-env") {
          return { code: 0, stdout: JSON.stringify({ env: opts.preWorktreeEnv }) };
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
      async priorAttemptContext() {
        return undefined;
      },
      async changedFiles() {
        return opts.changedFiles ?? ["packages/x/src/a.ts"];
      },
      async diffstat() {
        return "+1 -0 files=1";
      },
      async branchPresent() {
        return opts.branchPresent ?? true;
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
    recoveryEnv: opts.recoveryEnv ?? {},
    // ADR 0017 recording port: omitted by default (older-caller safety). "ok"
    // records the payload; "throw" rejects, proving a memory failure never
    // fails the close.
    recordAttempt: opts.recordAttempt
      ? async (payload) => {
          if (opts.recordAttempt === "throw") throw new Error("memory exploded");
          trace.recordedAttempts.push(payload);
        }
      : undefined,
  };

  // Wire the hook config + abort marker so dispatchHooks has a command to run.
  if (opts.abortHook) {
    config[`afk.hooks.${opts.abortHook}`] = `abort:${opts.abortHook}`;
  }
  // FIX J: register the env-emitting pre_worktree hook command.
  if (opts.preWorktreeEnv) {
    config["afk.hooks.pre_worktree"] = "emit-env";
  }

  const input: ProcessIssueInput = {
    issue: 9,
    title: "Fix the thing",
    body: "## Agent brief\nDo it.",
    runner: "claude",
    workerId: "wAAAA",
    tmpDir: "/tmp/afk",
    attempt: opts.attempt ?? 1,
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
  it("runs claim → runAgent → push → feedback → land → close with the full transition + sweep", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.issue).toBe(9);
    expect(result.branch).toBe("afk/wAAAA/9-fix-the-thing");
    expect(result.base).toBe("main");
    expect(result.locked).toBe(false);
    expect(result.mergeSha).toBe("abc1234");
    expect(result.swept).toBe(true);

    // sandcastle ran once, on the worker branch, with the handoff as promptFile.
    expect(trace.runAgentCalls.length).toBe(1);
    expect(trace.runAgentCalls[0]?.branch).toBe("afk/wAAAA/9-fix-the-thing");
    expect(trace.runAgentCalls[0]?.handoffPath).toBe("/tmp/afk/workers/wAAAA/9-a1/handoff.md");
    expect(trace.runAgentCalls[0]?.runner).toBe("claude");
    // cwd is anchored at the attempt dir so sandcastle's `.sandcastle/` lands
    // under .red/ (the attempt dir), never at the repo root.
    expect(trace.runAgentCalls[0]?.cwd).toBe("/tmp/afk/workers/wAAAA/9-a1");

    // claim: ready-for-agent → running ; close: remove running.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+"]);
    expect(trace.closed).toEqual([9]);
    expect(trace.swept).toEqual([9]);
    // done envelope posted, live remote branch deleted on close.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    expect(trace.deletedRemote.length).toBe(1);
    // worker branch pushed before landing; claim released.
    expect(trace.pushedAttempt.length).toBe(1);
    expect(trace.released).toEqual([9]);
  });

  it("fires the lifecycle hook points in order", async () => {
    const { deps, input } = harness({ outcome: "done", feedbackOk: true });
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
    const { deps, input } = harness({ outcome: "done", feedbackOk: true, locked: true });
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
    const { deps, input } = harness({ outcome: "done", feedbackOk: true, locked: false });
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
    const { deps, input, trace } = harness({ outcome: "blocked" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(result.preserved).toBe(true);
    expect(result.swept).toBe(false);
    // claim then ready-for-human + the typed blocked:spec tag; never closed.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:spec"]);
    // routing unchanged: ready-for-human still applied; typed label added alongside.
    const blockedEdit = trace.labelEdits.at(-1)!;
    expect(blockedEdit.add).toContain("ready-for-human");
    expect(blockedEdit.add).toContain("blocked:spec");
    expect(trace.ensuredLabels).toContain("blocked:spec");
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // no completion sweep, no remote delete, no land-push.
    expect(trace.swept).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.pushedAttempt).toEqual([]);
  });

  it("fires pre/post_attempt but never pre_merge on the BLOCKED path", async () => {
    const { deps, input } = harness({ outcome: "blocked" });
    const result = await processIssue(deps, input);
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
  });
});

describe("processIssue — no-sentinel (run ended without a <promise>)", () => {
  it("routes through on_attempt_error → ready-for-human, no post_attempt", async () => {
    const { deps, input, trace } = harness({ outcome: "no-sentinel" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("no-sentinel");
    expect(result.preserved).toBe(true);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:crashed"]);
    const nsEdit = trace.labelEdits.at(-1)!;
    expect(nsEdit.add).toContain("ready-for-human");
    expect(nsEdit.add).toContain("blocked:crashed");
    expect(trace.ensuredLabels).toContain("blocked:crashed");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "no-sentinel" }]);
    // on_attempt_error fires; post_attempt does NOT (ADR 0028).
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "on_attempt_error"]);
  });
});

describe("processIssue — feedback fail", () => {
  it("flips to ready-for-human with a failure envelope when validation fails", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(result.preserved).toBe(true);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:validation"]);
    const fbEdit = trace.labelEdits.at(-1)!;
    expect(fbEdit.add).toContain("ready-for-human");
    expect(fbEdit.add).toContain("blocked:validation");
    expect(trace.ensuredLabels).toContain("blocked:validation");
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // post_attempt fired (the run authored DONE), pre_merge never reached, and
    // the worker branch was not pushed for landing.
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
    expect(trace.pushedAttempt).toEqual([]);
  });
});

describe("processIssue — worker branch absent (FIX E: merge-gate bypass guard)", () => {
  it("escalates to the merge-conflict terminal path when the branch never reached the host", async () => {
    // DONE + green would normally merge, but the worker branch is absent on the
    // host (sandcastle push failed). The presence gate must STOP before feedback
    // so an empty changed-file set can't silently bypass validation + merge.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      branchPresent: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("merge-conflict");
    expect(result.preserved).toBe(true);
    // The issue was NOT closed and NOT merged — the gate held on unvalidated work.
    expect(trace.closed).toEqual([]);
    expect(trace.pushedAttempt).toEqual([]);
    // Routed through the merge-conflict BOUNDED-recovery reason: the terminal
    // edit carries the typed blocked:merge-conflict tag (retry-vs-escalate is the
    // recovery policy's call; what matters here is the gate diverted off merge).
    const finalEdit = trace.labelEdits.at(-1)!;
    expect(finalEdit.add).toContain("blocked:merge-conflict");
    expect(trace.ensuredLabels).toContain("blocked:merge-conflict");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "merge-conflict" }]);
    // The claim was released on this terminal path.
    expect(trace.released).toEqual([9]);
    // post_attempt fired (DONE authored), but pre_merge/post_merge never ran.
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
  });

  it("proceeds normally to merge when the branch IS present (default)", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, branchPresent: true });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
  });
});

describe("processIssue — pre_worktree env threading (FIX J)", () => {
  it("threads the pre_worktree hook's env slice onto the runAgent input", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      preWorktreeEnv: { CARGO_TARGET_DIR: "/opt/cargo-target/slot-2" },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    // The env computed by pre_worktree reached the sandcastle execution port.
    expect(trace.runAgentCalls[0]?.env).toEqual({ CARGO_TARGET_DIR: "/opt/cargo-target/slot-2" });
  });

  it("leaves runAgent.env undefined when no pre_worktree hook mutates env", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    await processIssue(deps, input);
    expect(trace.runAgentCalls[0]?.env).toBeUndefined();
  });

  it("carries the pre_worktree env onto the fallback runner after an exhaustion swap", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["exhausted", "done"],
      feedbackOk: true,
      fallbackRunner: true,
      preWorktreeEnv: { CARGO_TARGET_DIR: "/opt/cargo-target/slot-5" },
    });
    await processIssue(deps, input);
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.runAgentCalls[0]?.env).toEqual({ CARGO_TARGET_DIR: "/opt/cargo-target/slot-5" });
    expect(trace.runAgentCalls[1]?.env).toEqual({ CARGO_TARGET_DIR: "/opt/cargo-target/slot-5" });
  });
});

describe("processIssue — claim lost", () => {
  it("skips when the local claim lock is already held", async () => {
    const { deps, input, trace } = harness({ acquire: false });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.labelEdits).toEqual([]);
    expect(result.hooksFired).toEqual([]);
    // never reached sandcastle.
    expect(trace.runAgentCalls).toEqual([]);
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

describe("processIssue — pre_worktree hook abort (BOUNDED-recoverable: policy)", () => {
  it("under the cap → RETRY: restores ready-for-agent and never runs the agent", async () => {
    // policy cap is 1 by default; raise it so attempt 1 is under-cap and retries.
    const { deps, input, trace } = harness({
      abortHook: "pre_worktree",
      attempt: 1,
      recoveryEnv: { RED_AFK_RETRY_POLICY: "2" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("hook-aborted");
    expect(result.preserved).toBe(true);
    // claim then restore ready-for-agent + the typed blocked:policy tag;
    // sandcastle was never invoked.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent+blocked:policy"]);
    const haEdit = trace.labelEdits.at(-1)!;
    expect(haEdit.add).toContain("ready-for-agent");
    expect(haEdit.add).toContain("blocked:policy");
    expect(trace.ensuredLabels).toContain("blocked:policy");
    expect(trace.runAgentCalls).toEqual([]);
    expect(result.hooksFired).toEqual(["pre_worktree"]);
    // the restore comment is posted on retry; no budget-exhausted page.
    expect(trace.comments.some((c) => /Restored `ready-for-agent`/.test(c.body))).toBe(true);
    expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
  });

  it("at the cap → ESCALATE: routes to ready-for-human + posts the budget-exhausted page", async () => {
    // default policy cap is 1, so attempt 1 is at-cap → escalate.
    const { deps, input, trace } = harness({ abortHook: "pre_worktree", attempt: 1 });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("hook-aborted");
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:policy"]);
    const haEdit = trace.labelEdits.at(-1)!;
    expect(haEdit.add).toContain("ready-for-human");
    expect(haEdit.add).toContain("blocked:policy");
    expect(trace.ensuredLabels).toContain("blocked:policy");
    expect(trace.runAgentCalls).toEqual([]);
    // the budget-exhausted page is posted; the restore comment is not.
    expect(
      trace.comments.some((c) =>
        /escalating to ready-for-human: blocked:policy retry budget exhausted \(attempt 1\/1\)/.test(c.body),
      ),
    ).toBe(true);
    expect(trace.comments.some((c) => /Restored `ready-for-agent`/.test(c.body))).toBe(false);
  });
});

describe("processIssue — runner exhaustion (no --fallback-runner)", () => {
  it("a single exhaustion is terminal: outcome exhausted, ready-for-agent restored, claim released", async () => {
    const { deps, input, trace } = harness({ outcome: "exhausted", fallbackRunner: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("exhausted");
    expect(result.preserved).toBe(true);
    expect(result.swept).toBe(false);
    // only one run; no swap.
    expect(trace.runAgentCalls.length).toBe(1);
    // claim → running, then restore ready-for-agent (not ready-for-human) + the
    // typed blocked:quota tag (routing unchanged).
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent+blocked:quota"]);
    const exEdit = trace.labelEdits.at(-1)!;
    expect(exEdit.add).toContain("ready-for-agent");
    expect(exEdit.add).toContain("blocked:quota");
    expect(trace.ensuredLabels).toContain("blocked:quota");
    expect(trace.closed).toEqual([]);
    expect(trace.released).toEqual([9]);
    // no post_attempt fired (exhaustion is terminal before the sentinel branch).
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt"]);
  });
});

describe("processIssue — runner exhaustion → fallback swap → retry", () => {
  it("swaps claude→codex on exhaustion, fires post_attempt(exhausted)+pre_attempt again, then succeeds", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["exhausted", "done"],
      fallbackRunner: true,
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    // two runs: first claude (exhausted), second codex (done).
    expect(trace.runAgentCalls.length).toBe(2);
    expect(trace.runAgentCalls[0]?.runner).toBe("claude");
    expect(trace.runAgentCalls[1]?.runner).toBe("codex");
    // both runs target the same worker branch + handoff (reused mid-issue).
    expect(trace.runAgentCalls[1]?.branch).toBe(trace.runAgentCalls[0]?.branch);
    expect(trace.runAgentCalls[1]?.handoffPath).toBe(trace.runAgentCalls[0]?.handoffPath);
    // the fallback run re-anchors at the same attempt dir cwd.
    expect(trace.runAgentCalls[1]?.cwd).toBe(trace.runAgentCalls[0]?.cwd);
    expect(trace.runAgentCalls[1]?.cwd).toBe("/tmp/afk/workers/wAAAA/9-a1");
    // per-runner cadence: pre_attempt fires twice, post_attempt twice
    // (exhausted close + terminal success), bracketing pre_merge/post_merge.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt", // exhausted attempt cycle closes
      "pre_attempt", // second firing for the swapped runner (#226)
      "post_attempt", // terminal success
      "pre_merge",
      "post_merge",
    ]);
    // the issue closed green.
    expect(trace.closed).toEqual([9]);
  });

  it("double-exhaustion (both runners) is terminal → outcome exhausted", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["exhausted", "exhausted"],
      fallbackRunner: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("exhausted");
    expect(result.preserved).toBe(true);
    expect(trace.runAgentCalls.length).toBe(2);
    // ready-for-agent restored (both-runners comment posted) + the typed
    // blocked:quota tag (routing unchanged), claim released.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent+blocked:quota"]);
    expect(trace.ensuredLabels).toContain("blocked:quota");
    expect(trace.released).toEqual([9]);
    expect(trace.closed).toEqual([]);
    // both attempts closed their post_attempt cycle; no merge ever reached.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_attempt",
      "post_attempt",
    ]);
  });
});

describe("processIssue — runner transient transport/setup failure", () => {
  it("routes through bounded recovery without throwing a worker crash", async () => {
    const { deps, input, trace } = harness({ outcome: "runner-transient", fallbackRunner: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("runner-transient");
    expect(result.preserved).toBe(true);
    expect(trace.runAgentCalls.length).toBe(1);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent+blocked:runner-transient"]);
    expect(trace.ensuredLabels).toContain("blocked:runner-transient");
    expect(trace.released).toEqual([9]);
    expect(trace.closed).toEqual([]);
    expect(trace.comments.some((c) => /transient transport\/setup failure/.test(c.body))).toBe(true);
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt"]);
  });

  it("uses --fallback-runner once before terminating the issue", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["runner-transient", "done"],
      fallbackRunner: true,
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls.length).toBe(2);
    expect(trace.runAgentCalls[0]?.runner).toBe("claude");
    expect(trace.runAgentCalls[1]?.runner).toBe("codex");
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_attempt",
      "post_attempt",
      "pre_merge",
      "post_merge",
    ]);
    expect(trace.closed).toEqual([9]);
  });
});

describe("processIssue — base reaches sandcastle (ADR 0031)", () => {
  it("fetches the resolved base and forks the worker branch off it (not HEAD)", async () => {
    const fetchedBases: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true, // lock value "main" → base resolves to main
      fetchedBases,
    });
    const result = await processIssue(deps, input);

    expect(result.base).toBe("main");
    // the base ref is fetched current before the run (ADR 0031 caller contract).
    expect(fetchedBases).toEqual(["main"]);
    // runAgent receives the base as the branch start point.
    expect(trace.runAgentCalls[0]?.base).toBe("main");
  });
});

describe("processIssue — merge-conflict one-shot self-resolve (gap 3)", () => {
  it("recovers a locked merge conflict via the resolver and closes done", async () => {
    const resolverCalls: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1, // landMerge's merge --no-ff conflicts
      conflictResolve: "resolve",
      resolverCalls,
    });
    const result = await processIssue(deps, input);
    // the resolver was dispatched with a conflict-resolver prompt.
    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0]).toContain("merge-conflict resolver");
    // resolved → the issue lands done, not ready-for-human.
    expect(result.outcome).toBe("done");
    expect(trace.closed).toContain(9);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human"))).toBe(false);
  });

  it("falls back to ready-for-human when the resolver cannot resolve the conflict (at the cap)", async () => {
    // merge-conflict cap is 3; run at attempt 3 (at-cap) so the unresolved
    // conflict ESCALATES to a human rather than re-queuing.
    const resolverCalls: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      conflictResolve: "fail",
      resolverCalls,
      attempt: 3,
    });
    const result = await processIssue(deps, input);
    expect(resolverCalls).toHaveLength(1);
    expect(result.outcome).toBe("merge-conflict");
    // unresolved + at-cap → ready-for-human + the typed blocked:merge-conflict tag,
    // issue not closed.
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human"))).toBe(true);
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:merge-conflict"))).toBe(true);
    expect(trace.ensuredLabels).toContain("blocked:merge-conflict");
    expect(trace.closed).not.toContain(9);
  });

  it("escalates to ready-for-human when no resolver is registered (at the cap)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      attempt: 3, // at the merge-conflict cap → escalate
      // conflictResolve undefined → deps.conflictResolver is undefined
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("merge-conflict");
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human"))).toBe(true);
  });
});

describe("processIssue — BOUNDED auto-recovery routing (the policy wired in)", () => {
  it("merge-conflict at attempt 1 (< cap 3) → RETRY: ready-for-agent + blocked:merge-conflict, no page", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1, // merge --no-ff conflicts; no resolver registered
      attempt: 1,
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("merge-conflict");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-agent");
    expect(edit.add).toContain("blocked:merge-conflict");
    expect(edit.add).not.toContain("ready-for-human");
    expect(trace.ensuredLabels).toContain("blocked:merge-conflict");
    // a retry never pages; no budget-exhausted comment.
    expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
    expect(trace.closed).not.toContain(9);
  });

  it("merge-conflict at attempt = cap (3) → ESCALATE: ready-for-human + blocked:merge-conflict + budget-exhausted page", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      attempt: 3,
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("merge-conflict");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).toContain("blocked:merge-conflict");
    expect(
      trace.comments.some((c) =>
        /escalating to ready-for-human: blocked:merge-conflict retry budget exhausted \(attempt 3\/3\)/.test(c.body),
      ),
    ).toBe(true);
  });

  it("quota (exhausted) at attempt < cap → RETRY: ready-for-agent + blocked:quota", async () => {
    const { deps, input, trace } = harness({ outcome: "exhausted", fallbackRunner: false, attempt: 2 });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("exhausted");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-agent");
    expect(edit.add).toContain("blocked:quota");
    expect(edit.add).not.toContain("ready-for-human");
    expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
  });

  it("quota (exhausted) at attempt = cap (3) → ESCALATE: ready-for-human + blocked:quota + budget-exhausted page", async () => {
    const { deps, input, trace } = harness({ outcome: "exhausted", fallbackRunner: false, attempt: 3 });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("exhausted");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).toContain("blocked:quota");
    expect(
      trace.comments.some((c) =>
        /escalating to ready-for-human: blocked:quota retry budget exhausted \(attempt 3\/3\)/.test(c.body),
      ),
    ).toBe(true);
  });

  it("crashed (no-sentinel) RETRIES once then escalates (cap 1)", async () => {
    // cap 1: attempt 1 is at-cap → escalate. Raise to 2 to see the single retry.
    const retry = harness({ outcome: "no-sentinel", attempt: 1, recoveryEnv: { RED_AFK_RETRY_CRASH: "2" } });
    const r1 = await processIssue(retry.deps, retry.input);
    expect(r1.outcome).toBe("no-sentinel");
    expect(retry.trace.labelEdits.at(-1)!.add).toContain("ready-for-agent");
    expect(retry.trace.labelEdits.at(-1)!.add).toContain("blocked:crashed");

    const escalate = harness({ outcome: "no-sentinel", attempt: 1 }); // default cap 1 → escalate
    const r2 = await processIssue(escalate.deps, escalate.input);
    expect(r2.outcome).toBe("no-sentinel");
    expect(escalate.trace.labelEdits.at(-1)!.add).toContain("ready-for-human");
    expect(escalate.trace.labelEdits.at(-1)!.add).toContain("blocked:crashed");
  });

  it("spec (BLOCKED) ALWAYS escalates to ready-for-human, even at attempt 1 and high attempts", async () => {
    for (const attempt of [1, 5, 99]) {
      const { deps, input, trace } = harness({ outcome: "blocked", attempt });
      const result = await processIssue(deps, input);
      expect(result.outcome).toBe("blocked");
      const edit = trace.labelEdits.at(-1)!;
      expect(edit.add).toContain("ready-for-human");
      expect(edit.add).toContain("blocked:spec");
      expect(edit.add).not.toContain("ready-for-agent");
      // non-recoverable → no budget-exhausted page (it was never auto-recovering).
      expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
    }
  });

  it("validation (feedback-failed) ALWAYS escalates to ready-for-human", async () => {
    for (const attempt of [1, 5, 99]) {
      const { deps, input, trace } = harness({ outcome: "done", feedbackOk: false, attempt });
      const result = await processIssue(deps, input);
      expect(result.outcome).toBe("feedback-failed");
      const edit = trace.labelEdits.at(-1)!;
      expect(edit.add).toContain("ready-for-human");
      expect(edit.add).toContain("blocked:validation");
      expect(edit.add).not.toContain("ready-for-agent");
      expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
    }
  });
});

describe("close cascade (event-driven auto-unblock)", () => {
  it("promotes a dependent whose req:* deps are all closed, leaves a still-blocked one", async () => {
    // Issue 9 closes. Two open dependents carry req:9:
    //   #20 has req:9 only → all closed → promote
    //   #21 has req:9 + req:8 (8 still open) → stays blocked:dependency
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      dependentsByLabel: {
        "req:9": [
          { number: 20, labels: ["blocked:dependency", "req:9"] },
          { number: 21, labels: ["blocked:dependency", "req:9", "req:8"] },
        ],
      },
      closedIssues: [], // #8 is NOT closed; #9 is known-closed implicitly
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.closed).toContain(9);
    // queried the req:9 dependents exactly once.
    expect(trace.listByLabelCalls).toEqual(["req:9"]);

    const promote = trace.labelEdits.filter((e) => e.add.includes("ready-for-agent"));
    expect(promote).toEqual([{ issue: 20, remove: ["blocked:dependency"], add: ["ready-for-agent"] }]);
    expect(trace.comments).toContainEqual({
      issue: 20,
      body: "🤖 /afk unblocked: all dependencies closed (#9).",
    });
    // #21 is never promoted nor commented (req:8 still open).
    expect(trace.labelEdits.some((e) => e.issue === 21)).toBe(false);
    expect(trace.comments.some((c) => c.issue === 21)).toBe(false);
  });

  it("names every now-satisfied dep when a multi-req dependent fully unblocks", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      dependentsByLabel: {
        "req:9": [{ number: 30, labels: ["blocked:dependency", "req:9", "req:8"] }],
      },
      closedIssues: [8], // both deps closed (#9 implicit, #8 explicit)
    });
    await processIssue(deps, input);
    expect(trace.comments).toContainEqual({
      issue: 30,
      body: "🤖 /afk unblocked: all dependencies closed (#8, #9).",
    });
    expect(trace.labelEdits).toContainEqual({
      issue: 30,
      remove: ["blocked:dependency"],
      add: ["ready-for-agent"],
    });
  });

  it("does nothing when there are no req:N dependents", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    await processIssue(deps, input);
    expect(trace.listByLabelCalls).toEqual(["req:9"]);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
  });

  it("does not run the cascade on a non-done (blocked) close", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked" });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("blocked");
    expect(trace.listByLabelCalls).toEqual([]);
  });
});

// ---------- ADR 0017: validation.jsonl sidecar + AFK→Memory recording ----------

describe("processIssue — validation.jsonl sidecar (SKILL.md §Validation Sidecar)", () => {
  it("writes the feedback sidecar to <attemptDir>/validation.jsonl on the DONE close", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.sidecarWrites).toHaveLength(1);
    const write = trace.sidecarWrites[0]!;
    expect(write.path).toBe(`${input.attemptDir}/validation.jsonl`);
    expect(write.lines.length).toBeGreaterThan(0);
    // Each line is a red.afk.validation.v1 JSON record.
    for (const line of write.lines) {
      expect(JSON.parse(line).schema).toBe("red.afk.validation.v1");
    }
  });

  it("writes the sidecar on the feedback-FAILED close too", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.sidecarWrites).toHaveLength(1);
    expect(trace.sidecarWrites[0]!.path).toBe(`${input.attemptDir}/validation.jsonl`);
    expect(trace.sidecarWrites[0]!.lines.length).toBeGreaterThan(0);
  });

  it("does NOT write a sidecar on a path with no feedback result (BLOCKED)", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked" });
    await processIssue(deps, input);
    expect(trace.sidecarWrites).toEqual([]);
  });

  it("is a no-op (and the close still succeeds) when the sidecar port is absent", async () => {
    const { deps, input } = harness({ outcome: "done", feedbackOk: true, withSidecarPort: false });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(result.envelopePosted).toBe(true);
  });
});

describe("processIssue — AFK→Memory reasoning-attempt recording (ADR 0017)", () => {
  it("records the attempt AFTER the DONE envelope with the mapped payload", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, recordAttempt: "ok" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.recordedAttempts).toHaveLength(1);
    const p = trace.recordedAttempts[0]!;
    expect(p.repository).toBe("o/r");
    expect(p.issueNumber).toBe(9);
    expect(p.attemptNumber).toBe(1);
    expect(p.status).toBe("done");
    expect(p.issueTitle).toBe("Fix the thing");
    expect(p.branch).toBe("afk/wAAAA/9-fix-the-thing");
    expect(p.mergeCommit).toBe("abc1234");
    expect(p.workerId).toBe("wAAAA");
    expect(p.validationSummary).toBeTruthy();
  });

  it("records the attempt on a terminal FAILURE (blocked) with the failure status", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked", recordAttempt: "ok" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(trace.recordedAttempts).toHaveLength(1);
    expect(trace.recordedAttempts[0]!.status).toBe("blocked");
  });

  it("records the attempt on the merge-conflict path", async () => {
    // A locked merge --no-ff conflict with no resolver → merge-conflict terminal.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      recordAttempt: "ok",
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("merge-conflict");
    expect(trace.recordedAttempts).toHaveLength(1);
    expect(trace.recordedAttempts[0]!.status).toBe("merge-conflict");
  });

  // THE key ADR 0017 guarantee: a memory failure never fails the close.
  it("completes the DONE close normally when recordAttempt is UNDEFINED", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    // No recordAttempt opt → the port is undefined.
    expect(deps.recordAttempt).toBeUndefined();
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.envelopePosted).toBe(true);
    expect(result.swept).toBe(true);
    expect(trace.closed).toEqual([9]);
    expect(trace.recordedAttempts).toEqual([]);
  });

  it("completes the DONE close normally when recordAttempt THROWS", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, recordAttempt: "throw" });
    const result = await processIssue(deps, input);

    // The envelope + close + sweep are unaffected by the memory failure.
    expect(result.outcome).toBe("done");
    expect(result.envelopePosted).toBe(true);
    expect(result.swept).toBe(true);
    expect(trace.closed).toEqual([9]);
    expect(trace.postedEnvelopes).toContainEqual({ issue: 9, status: "done" });
  });

  it("completes a FAILURE close normally when recordAttempt THROWS", async () => {
    const { deps, input } = harness({ outcome: "blocked", recordAttempt: "throw" });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("blocked");
    expect(result.envelopePosted).toBe(true);
    expect(result.preserved).toBe(true);
  });
});
