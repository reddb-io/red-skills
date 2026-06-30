import { describe, expect, it } from "vitest";
import {
  processIssue,
  type ProcessIssueDeps,
  type ProcessIssueInput,
} from "../src/core/process-issue.js";
import type { HookName } from "../src/core/hook-config.js";
import type { ConfigValues } from "../src/core/config.js";
import type { AgentEffort, RunAgentInput, RunAgentResult } from "../src/core/execution.js";
import type { AttemptRecordPayload } from "../src/core/attempt-record.js";
import type { IssueClassificationMetadata } from "../src/core/issue-classifier.js";
import { parseCurrentBlocker, upsertCurrentBlocker } from "../src/core/blocker-state.js";
import type { AttemptProgressInfo } from "../src/core/execution.js";

// Everything injected is a fake — no real gh / git / sandcastle / pnpm / fs ever
// runs. The harness records the side-effect sequence (label edits, comments,
// close, sweep, hook order) so each test asserts the lifecycle as a trace rather
// than reaching into the modules being composed. Execution itself is the
// injected `runAgent` port (ADR 0033): a fake returning a scripted
// RunAgentResult, replacing the old fake runner-spawn + worktree-create deps.

interface Trace {
  labelEdits: Array<{ issue: number; remove: string[]; add: string[] }>;
  comments: Array<{ issue: number; body: string }>;
  bodyEdits: Array<{ issue: number; body: string }>;
  closed: number[];
  swept: number[];
  pushedAttempt: string[][];
  deletedRemote: string[][];
  postedEnvelopes: Array<{ issue: number; status: string }>;
  envelopeBodies: string[];
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
  /** Worker branches passed to the commit-leftovers salvage port. */
  salvageCalls: string[];
  /** Metadata handed to the per-issue classifier before runAgent. */
  classifierCalls: IssueClassificationMetadata[];
  /** Lines appended to the iteration log (deps.appendIterLog). */
  iterLogs: string[];
}

interface HarnessOptions {
  labels?: string[];
  acquire?: boolean;
  /** Inject the ADR 0066 GitHub-native claim arbiter. When set, the claim path
   * is the authority and `running` is a projection. The `winner` field decides
   * the verdict for the test (self worker is "h:w"). */
  claim?: { winner: "self" | "other" };
  outcome?: RunAgentResult["outcome"];
  /** Scripted per-call outcomes (overrides `outcome`); one entry per runAgent call. */
  outcomes?: RunAgentResult["outcome"][];
  feedbackOk?: boolean;
  /** Scripted per-feedback-gate outcomes. Each feedback run executes the four
   * standard scripts; this controls the aggregate pass/fail for each run. */
  feedbackResults?: boolean[];
  /** Operator-declared backpressure commands (afk.backpressure, #430). When set,
   * the backpressure gate runs after feedback against the worker branch. */
  backpressureCommands?: string[];
  /** When false, the backpressure exec returns a non-zero code (a failing gate).
   * Defaults to passing. Only consulted when `backpressureCommands` is set. */
  backpressureOk?: boolean;
  locked?: boolean;
  /**
   * Landing-mode flag (#842), decoupled from the lock. Defaults to `!locked` so
   * the pre-#842 coupling (locked → direct merge, unlocked → admin PR) holds for
   * the existing path/conflict tests; the decoupling tests set it explicitly.
   */
  worktreeLaunchesPr?: boolean;
  config?: ConfigValues;
  /** Trust-gate provenance (#621) returned by gh.issueTrust. When set, the port
   * is registered; absent → no port (gate never fires). */
  trust?: { author?: string; readyForAgentActor?: string };
  abortHook?: HookName;
  /** FIX J: when set, a pre_worktree hook command emits this env as the mutated
   * context's `{env:{…}}` slice — proving it threads onto the runAgent input. */
  preWorktreeEnv?: Record<string, string>;
  changedFiles?: string[];
  /** FIX E: result of the worker-branch presence check. Defaults to true
   * (present). Set false to model "sandcastle commits never reached the host". */
  branchPresent?: boolean;
  /** Goal predicate own-merge signal (ADR 0057): result of lookups.branchMerged.
   * true → the worker branch already landed in <base> (own-merge close → done);
   * false (default) → a foreign lander closed it (claim-lost). */
  branchMerged?: boolean;
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
  /** Commits sandcastle reports runAgent landed on the worker branch. Defaults
   * to one commit on a real outcome / none on exhaustion. Set `[]` to model the
   * codex DONE-without-commit case the salvage port rescues. */
  commits?: { sha: string }[];
  /** When set, register the commit-leftovers `salvageUncommitted` port and have
   * it return this count (files committed). undefined omits the port (legacy
   * caller — no salvage). */
  salvage?: number;
  /** Issue body threaded into processIssue. */
  body?: string;
  /** Optional ADR 0049 tier resolver injected by the production wiring. */
  resolveTier?: ProcessIssueDeps["resolveTier"];
  /** Optional ADR 0049 issue classifier injected by the production wiring. */
  classifyIssue?: ProcessIssueDeps["classifyIssue"];
  /** PR review gate (ADR 0064 §10, #749). When set, processIssue may hand the
   * unlocked landing off for a fresh-agent review instead of fast-merging. */
  reviewGate?: ProcessIssueDeps["reviewGate"];
  /** CI-aware merge (#812). When set, register the `ciAwait` port and drive the
   * `gh pr view` verdict the unlocked landing polls before admin-merging. */
  ciAware?: "merge" | "ci-failed" | "ci-pending" | "conflict";
  /** Exit code for the final `gh pr merge` command. Defaults to 0. */
  prMergeCode?: number;
}

function harness(opts: HarnessOptions = {}): {
  deps: ProcessIssueDeps;
  input: ProcessIssueInput;
  trace: Trace;
} {
  const trace: Trace = {
    labelEdits: [],
    comments: [],
    bodyEdits: [],
    closed: [],
    swept: [],
    pushedAttempt: [],
    deletedRemote: [],
    postedEnvelopes: [],
    envelopeBodies: [],
    released: [],
    runAgentCalls: [],
    listByLabelCalls: [],
    ensuredLabels: [],
    sidecarWrites: [],
    recordedAttempts: [],
    salvageCalls: [],
    classifierCalls: [],
    iterLogs: [],
  };

  const outcome = opts.outcome ?? "done";
  const config: ConfigValues = opts.config ?? {};
  // Flipped true once the conflict resolver dispatch runs; the mergeExec
  // verification reads above key off it to model "the agent resolved the merge".
  let mergeResolved = false;
  let pnpmCalls = 0;

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
      async editBody(issue, body) {
        trace.bodyEdits.push({ issue, body });
        return true;
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
      // Trust-gate provenance port (#621): registered only when the test opts in,
      // so legacy-shaped tests omit it and the gate never fires (permissive).
      issueTrust: opts.trust ? async () => opts.trust! : undefined,
    },
    claimGh: opts.claim
      ? {
          async postClaim(_issue, body) {
            trace.comments.push({ issue: 9, body });
            return 100; // our claim gets id 100
          },
          async listClaims() {
            // "other" wins by posting an earlier id (50); "self" wins solo.
            return opts.claim?.winner === "other"
              ? [{ id: 50, body: "<!-- afk:claim v1 worker=otherhost:wZZZZ kind=claim -->" }]
              : [];
          },
          async concede(_issue, body) {
            trace.comments.push({ issue: 9, body });
          },
        }
      : undefined,
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
      // Zero-commit guard: report 3 commits ahead so normal locked landings proceed.
      if (j.includes("rev-list") && j.includes("--count")) {
        return { code: 0, stdout: "3\n", stderr: "" };
      }
      // #812 CI-aware poll: drive the mergeStateStatus + rollup per opts.ciAware.
      if (j.includes("pr view")) {
        const map: Record<string, { mergeStateStatus: string; statusCheckRollup: unknown[] }> = {
          merge: { mergeStateStatus: "CLEAN", statusCheckRollup: [] },
          "ci-failed": { mergeStateStatus: "BLOCKED", statusCheckRollup: [{ state: "FAILURE" }] },
          "ci-pending": { mergeStateStatus: "BLOCKED", statusCheckRollup: [{ status: "IN_PROGRESS" }] },
          conflict: { mergeStateStatus: "DIRTY", statusCheckRollup: [] },
        };
        return { code: 0, stdout: JSON.stringify(map[opts.ciAware ?? "merge"]), stderr: "" };
      }
      if (j.includes("pr merge")) {
        return { code: opts.prMergeCode ?? 0, stdout: "", stderr: opts.prMergeCode ? "merge rejected" : "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    remoteGit: async (argv) => {
      if (argv.includes("--delete")) trace.deletedRemote.push(argv);
      else trace.pushedAttempt.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
    pnpm: async (args) => {
      // AFK runner improvement: feedback now optionally probes the base branch
      // (the `baselineWorktree` passed to `runFeedback`) when the worker run
      // fails. The baseline probe re-runs ONLY the failing checks; every other
      // invocation is the normal worker run. For the test harness, the worker's
      // branch result is governed by `feedbackOk`/`feedbackResults`; the
      // baseline probe always passes (a fake probe — the real harness isn't
      // trying to model a pre-existing main failure). This way a test that
      // intends "worker fails, no baseline probe would have helped" still
      // lands the issue as `feedback-failed` and isn't accidentally downgraded
      // by the new baseline-probe logic. The detection is by dir path: the
      // base resolves to "main" in the test, so the baseline invocation's
      // -C dir is "main" or "main/<scope>".
      const cIdx = Array.isArray(args) ? args.indexOf("-C") : -1;
      const dir = cIdx >= 0 ? (args[cIdx + 1] ?? "") : "";
      if (dir === "main" || dir.startsWith("main/")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      const feedbackRun = Math.floor(pnpmCalls / 4);
      pnpmCalls += 1;
      const ok = opts.feedbackResults
        ? (opts.feedbackResults[feedbackRun] ?? opts.feedbackResults.at(-1) ?? true)
        : opts.feedbackOk !== false;
      return { code: ok ? 0 : 1, stdout: "", stderr: "" };
    },
    layout: {
      hasPackage: (scope) => scope === ".",
      hasScript: () => true,
    },
    // Backpressure gate (#430): a fake shell exec that fails when opted out. The
    // failing-command output is captured so the envelope/sidecar carry the tail.
    backpressure: async ({ command }) => ({
      code: opts.backpressureOk === false ? 1 : 0,
      stdout: opts.backpressureOk === false ? `${command} exploded\nstack trace here\n` : "",
      stderr: "",
    }),
    backpressureCommands: opts.backpressureCommands,
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
        commits:
          opts.commits ??
          (thisOutcome === "exhausted" || thisOutcome === "runner-transient" ? [] : [{ sha: "deadbee" }]),
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
    effort: "high" as AgentEffort,
    classifyIssue: opts.classifyIssue
      ? async (metadata) => {
          trace.classifierCalls.push(metadata);
          return opts.classifyIssue!(metadata);
        }
      : undefined,
    resolveTier: opts.resolveTier,
    // Landing mode is decoupled from the lock (#842); default to the pre-#842
    // coupling so existing locked/unlocked path tests keep their behaviour.
    worktreeLaunchesPr: opts.worktreeLaunchesPr ?? !(opts.locked ?? false),
    reviewGate: opts.reviewGate,
    reviewGateLabel: "ready-for-review",
    ciAwait: opts.ciAware ? { sleep: async () => {}, maxPolls: 2 } : undefined,
    fallbackRunner: opts.fallbackRunner ?? false,
    conflictResolver: opts.conflictResolve
      ? async (prompt) => {
          if (opts.resolverCalls) opts.resolverCalls.push(prompt);
          if (opts.conflictResolve === "resolve") mergeResolved = true;
        }
      : undefined,
    // Isolated landing worktree for the LOCKED path (#572): a fixed fake dir so
    // the locked merge/push/rollback runs there instead of the primary checkout.
    makeLandingWorktree: async () => "/wt",
    removeLandingWorktree: async () => {},
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
      async branchMerged() {
        return opts.branchMerged ?? false;
      },
    },
    envelope: {
      git: async () => ({ code: 0, stdout: "", stderr: "" }),
      poster: async (issue, body) => {
        const status = /data-attempt-status="([^"]*)"/.exec(body)?.[1] ?? "?";
        trace.postedEnvelopes.push({ issue, status });
        trace.envelopeBodies.push(body);
        return true;
      },
      async writeMarkers() {},
      async writePosted() {},
    },
    nowEpoch: () => 1000,
    nowIso: () => "2026-05-30T00:00:00Z",
    appendIterLog: (line) => {
      trace.iterLogs.push(line);
    },
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
    // Commit-leftovers salvage port (codex DONE-without-commit). Omitted unless
    // opted in, so legacy-shaped tests keep today's behaviour.
    salvageUncommitted:
      opts.salvage === undefined
        ? undefined
        : async (branch) => {
            trace.salvageCalls.push(branch);
            return opts.salvage as number;
          },
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
    body: opts.body ?? "## Agent brief\nDo it.",
    runner: "claude",
    workerId: "wAAAA",
    claimant: "testhost:wAAAA",
    tmpDir: "/tmp/afk",
    attempt: opts.attempt ?? 1,
    attemptDir: "/tmp/afk/workers/wAAAA/9-a1",
    repo: "o/r",
    repoDir: "/repo",
    remote: "origin",
    baseInput: { issueBody: opts.body ?? "## Agent brief\nDo it." },
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
    expect(trace.runAgentCalls[0]?.model).toBe("claude-opus-4-8");
    expect(trace.runAgentCalls[0]?.effort).toBe("high");
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
      "pre_feedback",
      "post_feedback",
      "pre_merge",
      "post_merge",
    ]);
  });

  it("passes the resolved default think tier model and effort into runAgent", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      resolveTier: () => ({ model: "claude-tier-model", effort: "max" }),
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-tier-model");
    expect(trace.runAgentCalls[0]?.effort).toBe("max");
  });

  it("passes the classified task class into model/effort resolution before runAgent", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      body: "## What to build\nTouch apps/dev/src/core/process-issue.ts and apps/dev/tests/process-issue.test.ts.",
      outcome: "done",
      feedbackOk: true,
      classifyIssue: async () => "complex",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return { model: `${runner}-${taskClass}-model`, effort: "medium" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.classifierCalls).toHaveLength(1);
    expect(trace.classifierCalls[0]?.extensions).toEqual(["ts"]);
    expect(tiers).toEqual([{ runner: "claude", taskClass: "complex" }]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-complex-model");
    expect(trace.runAgentCalls[0]?.effort).toBe("medium");
  });
});

describe("processIssue — CI-aware unlocked landing (#812)", () => {
  it("CLEAN → polls merge state then admin-merges + closes (no bounce, no re-run)", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, ciAware: "merge" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    // exactly ONE agent run — the completed work is never re-run.
    expect(trace.runAgentCalls.length).toBe(1);
  });

  it("a FAILED required check → ci-failed, blocked:ci (NOT merge-conflict), PR preserved, agent not re-run", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, ciAware: "ci-failed" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("ci-failed");
    // Truthful envelope: blocked, NEVER merge-conflict on a MERGEABLE PR.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // Parked to ready-for-human with the distinct blocked:ci label.
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:ci"))).toBe(true);
    expect(trace.ensuredLabels).toContain("blocked:ci");
    // NEVER mislabelled merge-conflict.
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:merge-conflict"))).toBe(false);
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    // The work is the durable artifact: open PR preserved (no remote branch delete),
    // issue NOT closed, agent NOT re-run.
    expect(trace.deletedRemote.length).toBe(0);
    expect(trace.closed).toEqual([]);
    expect(trace.runAgentCalls.length).toBe(1);
    // Never admin-merged on a failed check.
    expect(trace.released).toEqual([9]);
  });

  it("PENDING past the timeout → ci-pending, parked (NOT ready-for-agent), no token re-spend", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, ciAware: "ci-pending" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("ci-pending");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // Pending NEVER recovers to ready-for-agent (which would re-run the agent).
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:ci"))).toBe(true);
    // Open PR preserved; agent ran exactly once.
    expect(trace.deletedRemote.length).toBe(0);
    expect(trace.closed).toEqual([]);
    expect(trace.runAgentCalls.length).toBe(1);
  });

  it("a real DIRTY conflict still classifies as merge-conflict (correct here)", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, ciAware: "conflict" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("merge-conflict");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "merge-conflict" }]);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:merge-conflict"))).toBe(true);
    expect(trace.runAgentCalls.length).toBe(1);
  });

  it("admin-merge rejected after PR exists parks the PR instead of re-queueing for a fresh agent", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, prMergeCode: 1 });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("ci-failed");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:ci"))).toBe(true);
    expect(trace.closed).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.runAgentCalls.length).toBe(1);
    expect(trace.released).toEqual([9]);
  });
});

describe("processIssue — landing mode decoupled from the lock (#842)", () => {
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
    // landMerge issues `git -C /repo merge --no-ff --no-verify afk/wAAAA/9-fix-the-thing …`.
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes("merge --no-ff --no-verify afk/wAAAA/9-fix-the-thing"))).toBe(true);
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

  it("locked + flag true → admin PR (no direct merge), even though locked", async () => {
    // Decoupled: a lock no longer forces a direct merge. With the default flag the
    // locked session lands via an admin-merged PR to its base (the lock branch).
    const calls: string[][] = [];
    const { deps, input } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      worktreeLaunchesPr: true,
    });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    // result.locked still echoes the lock state (observational), not the mode.
    expect(result.locked).toBe(true);
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes("pr merge 42 --admin --merge"))).toBe(true);
    expect(joined.some((c) => c.includes("merge --no-ff afk/"))).toBe(false);
  });

  it("unlocked + flag false → direct merge to main, no PR (offline)", async () => {
    // Decoupled: no lock no longer forces a PR. With the flag off the unlocked
    // session lands via a direct merge into main (no PR, offline).
    const calls: string[][] = [];
    const { deps, input } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      worktreeLaunchesPr: false,
    });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.locked).toBe(false);
    const joined = calls.map((c) => c.join(" "));
    // Direct merge of the attempt branch; no PR list/merge anywhere.
    expect(joined.some((c) => c.includes("merge --no-ff --no-verify afk/wAAAA/9-fix-the-thing"))).toBe(true);
    expect(joined.some((c) => c.includes("pr list") || c.includes("pr merge"))).toBe(false);
  });
});

describe("processIssue — PR review gate (ADR 0064 §10, #749)", () => {
  function recordingMerge(deps: ProcessIssueDeps): string[][] {
    const calls: string[][] = [];
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    return calls;
  }

  it("non-mechanical change → opens the PR, applies ready-for-review, parks instead of merging", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "complex",
      reviewGate: { enabled: true, threshold: "complex" },
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("review-requested");
    expect(result.preserved).toBe(true);
    expect(result.swept).toBe(false);
    // The PR is opened/reused and labelled — firing the advisory review.
    expect(joined.some((c) => c.includes("pr edit 42 --add-label ready-for-review"))).toBe(true);
    // The merge is HELD for the fresh-agent review.
    expect(joined.some((c) => c.includes("pr merge"))).toBe(false);
    // The issue is parked to ready-for-human (running dropped) and NOT closed.
    expect(
      trace.labelEdits.some((e) => e.remove.includes("running") && e.add.includes("ready-for-human")),
    ).toBe(true);
    expect(trace.closed).not.toContain(9);
    // The worker branch is left in place (the review runs against it).
    expect(trace.deletedRemote).toHaveLength(0);
    expect(trace.released).toContain(9);
    expect(trace.comments.some((c) => c.body.includes("ready-for-review"))).toBe(true);
  });

  it("mechanical change → fast-merge path untouched (no review hop)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "simple",
      reviewGate: { enabled: true, threshold: "complex" },
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("done");
    expect(joined.some((c) => c.includes("pr merge 42 --admin --merge"))).toBe(true);
    expect(joined.some((c) => c.includes("--add-label ready-for-review"))).toBe(false);
    expect(trace.closed).toContain(9);
  });

  it("disabled gate → non-mechanical change still fast-merges", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "complex",
      // reviewGate omitted → gate off (today's behaviour).
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("done");
    expect(joined.some((c) => c.includes("pr merge 42 --admin --merge"))).toBe(true);
    expect(joined.some((c) => c.includes("--add-label ready-for-review"))).toBe(false);
    expect(trace.closed).toContain(9);
  });

  it("locked path never opens a PR even when non-mechanical", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      classifyIssue: async () => "think",
      reviewGate: { enabled: true, threshold: "complex" },
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("done");
    expect(joined.some((c) => c.includes("--add-label ready-for-review"))).toBe(false);
    expect(trace.closed).toContain(9);
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
    // #568: the shared terminalFailure tail must release the per-issue claim so a
    // retry-routed / re-queued issue is immediately re-claimable — it previously
    // leaked the lock until the worker process died and boot reclaimed the dir.
    expect(trace.released).toEqual([9]);
  });

  it("writes Current blocker state when a terminal blocker pages a human", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked" });
    await processIssue(deps, input);

    expect(trace.bodyEdits).toHaveLength(1);
    expect(parseCurrentBlocker(trace.bodyEdits[0]!.body)).toMatchObject({
      status: "blocked",
      kind: "spec",
      next: "Review the blocker envelope and add human guidance.",
    });
  });

  it("fires pre/post_attempt but never pre_merge on the BLOCKED path", async () => {
    const { deps, input } = harness({ outcome: "blocked" });
    const result = await processIssue(deps, input);
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
  });
});

describe("processIssue — no-sentinel (run ended without a <promise>)", () => {
  it("EMPTY branch → on_attempt_error → ready-for-human, no post_attempt", async () => {
    // No work on the branch: a real crash, kept as today's terminal no-sentinel.
    const { deps, input, trace } = harness({ outcome: "no-sentinel", changedFiles: [] });
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
    // #568: the no-sentinel terminal also releases the per-issue claim.
    expect(trace.released).toEqual([9]);
  });

  it("preserves an earlier actionable blocker when a later empty no-sentinel crashes (#862)", async () => {
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "merge-conflict",
      summary: "Attempt 1 preserved a merge-conflict branch.",
      next: "Resolve the merge conflict or add guidance for the next agent attempt.",
    });
    const { deps, input, trace } = harness({ outcome: "no-sentinel", changedFiles: [], body });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("no-sentinel");
    // Byte-exact editing: the body already canonically carries the actionable
    // merge-conflict blocker, so preservation is a no-op write rather than a
    // re-render. What matters is that the generic runner blocker never clobbers
    // it — assert no edit overwrites the merge-conflict blocker.
    const clobbered = trace.bodyEdits.some(
      (edit) =>
        edit.body.includes("Review the attempt log and decide whether to retry") ||
        parseCurrentBlocker(edit.body)?.kind === "runner",
    );
    expect(clobbered).toBe(false);
    // The merge-conflict blocker survives in the (unchanged) issue body.
    expect(parseCurrentBlocker(body)).toMatchObject({
      kind: "merge-conflict",
      summary: "Attempt 1 preserved a merge-conflict branch.",
      next: "Resolve the merge conflict or add guidance for the next agent attempt.",
    });
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "no-sentinel" }]);
  });

  it("branch carries work + passes feedback → SALVAGE: lands like DONE, closes (issue #332)", async () => {
    // The agent finished + committed but exited without the sentinel (the #300
    // loop). Branch is ahead of base and green → salvage through the same gate.
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done"); // salvaged → lands exactly like a DONE attempt
    expect(result.mergeSha).toBe("abc1234");
    expect(result.swept).toBe(true);
    expect(trace.closed).toEqual([9]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    // post_attempt(success) + the full land tail fire; on_attempt_error does NOT.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_feedback",
      "post_feedback",
      "pre_merge",
      "post_merge",
    ]);
  });

  it("branch carries work but FAILS feedback → feedback-failed, never merged, not an error", async () => {
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.closed).toEqual([]);
    expect(result.hooksFired).not.toContain("on_attempt_error");
  });

  it("salvaged branch passes feedback but FAILS backpressure → parked like a feedback fail, never merged (#432)", async () => {
    // #432: a no-sentinel attempt salvaged through the gate (branch carries work +
    // feedback green) is held to the SAME backpressure bar as a DONE attempt — a
    // failing operator command blocks the merge and parks to ready-for-human, and
    // it is NOT an error. The gate already lives in the shared DONE/salvage tail
    // (#430); this locks that coverage in.
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: false,
      locked: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.closed).toEqual([]);
    expect(labelTrace(trace)).toEqual([
      "-ready-for-agent|+running",
      "-running|+ready-for-human+blocked:validation",
    ]);
    expect(trace.pushedAttempt).toEqual([]);
    expect(result.hooksFired).not.toContain("on_attempt_error");
    const lastSidecar = trace.sidecarWrites.at(-1)!;
    const bp = lastSidecar.lines
      .map((l) => JSON.parse(l) as { name: string; status: string })
      .find((r) => r.name === "backpressure:npm run e2e")!;
    expect(bp.status).toBe("failed");
  });

  it("salvaged branch merges + closes when feedback AND backpressure both pass (#432)", async () => {
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done"); // salvaged + both gates green → lands like DONE
    expect(trace.closed).toEqual([9]);
  });

  it("exposes the configured backpressure command to the inner-agent handoff as the binding <merge-gate> (#849)", async () => {
    // Acceptance #849: the inner agent must SEE the exact orchestrator gate it
    // has to satisfy before DONE, not discover it only when the post-DONE
    // backpressure gate bounces it as blocked:validation.
    const { deps, input, trace } = harness({
      outcome: "done",
      backpressureCommands: ["cargo fmt --all -- --check", "npm run e2e"],
      backpressureOk: true,
    });
    await processIssue(deps, input);

    const handoff = trace.runAgentCalls[0]?.handoffContent ?? "";
    expect(handoff).toContain("<merge-gate>");
    expect(handoff).toContain("- cargo fmt --all -- --check");
    expect(handoff).toContain("- npm run e2e");
  });

  it("omits <merge-gate> from the handoff when no backpressure command is configured (#849)", async () => {
    const { deps, input, trace } = harness({ outcome: "done" });
    await processIssue(deps, input);
    expect(trace.runAgentCalls[0]?.handoffContent ?? "").not.toContain("<merge-gate>");
  });
});

describe("processIssue — commit-leftovers salvage (codex DONE-without-commit)", () => {
  it("DONE but zero commits → salvages the dirty worktree, then lands + closes like a normal DONE", async () => {
    // The codex symptom: the inner agent edits, passes the gates, emits DONE, but
    // never commits — sandcastle collects zero commits. Salvage commits the
    // worktree so the feedback gate + landing see the work.
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [],
      salvage: 5,
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    // The salvage port was asked to commit the worktree of the live worker branch.
    expect(trace.salvageCalls).toHaveLength(1);
    expect(trace.salvageCalls[0]).toMatch(/^afk\/wAAAA\//);
    expect(trace.salvageCalls[0]).toBe(result.branch);
    expect(result.outcome).toBe("done"); // salvaged → lands + closes like DONE
    expect(trace.closed).toContain(9);
  });

  it("DONE with commits + clean worktree → probes salvage but creates no extra salvage log", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [{ sha: "deadbee" }],
      salvage: 0,
      feedbackOk: true,
    });
    await processIssue(deps, input);
    expect(trace.salvageCalls).toHaveLength(1);
    expect(trace.iterLogs.some((line) => line.includes("salvaged"))).toBe(false);
  });

  it("DONE with commits + dirty leftovers → salvages the remaining work before validation", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [{ sha: "deadbee" }],
      salvage: 2,
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);
    expect(trace.salvageCalls).toHaveLength(1);
    expect(trace.iterLogs.some((line) => line.includes("left dirty worktree paths after 1 commit(s)"))).toBe(true);
    expect(result.outcome).toBe("done");
    expect(trace.closed).toContain(9);
  });

  it("DONE but zero commits + salvaged dirty worktree + feedback fail explains both facts", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [],
      salvage: 1,
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.salvageCalls).toHaveLength(1);
    expect(trace.iterLogs.some((line) => line.includes("salvaged 1 uncommitted file(s)"))).toBe(true);
    const body = trace.envelopeBodies.at(-1) ?? "";
    expect(body).toContain("Inner agent emitted done with zero commits");
    expect(body).toContain("AFK salvaged 1 uncommitted file(s)");
    expect(body).toContain("feedback validation failed");
  });

  it("DONE with commits + salvaged leftovers + feedback fail explains partial dirty state", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [{ sha: "deadbee" }],
      salvage: 1,
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    const body = trace.envelopeBodies.at(-1) ?? "";
    expect(body).toContain("after 1 commit(s) and left dirty worktree paths");
    expect(body).toContain("AFK salvaged 1 uncommitted file(s)");
    expect(body).toContain("feedback validation failed");
  });

  it("no-sentinel + zero commits → salvage runs; a clean worktree (0 files) stays the empty-branch terminal", async () => {
    // Salvage returns 0 (clean worktree) → the no-sentinel branch carries no work
    // → today's terminal no-sentinel behaviour is preserved (ready-for-human).
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      commits: [],
      salvage: 0,
      changedFiles: [],
    });
    const result = await processIssue(deps, input);
    expect(trace.salvageCalls).toHaveLength(1);
    expect(result.outcome).toBe("no-sentinel");
  });

  it("legacy caller (no salvage port) keeps today's behaviour on a zero-commit DONE", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [],
      // salvage omitted → port absent
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);
    expect(trace.salvageCalls).toEqual([]);
    expect(result.outcome).toBe("done");
  });
});

describe("processIssue — active Current blocker preflight", () => {
  it("moves the issue back to ready-for-human without starting an attempt", async () => {
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "decision",
      ref: "#856",
      summary: "Measurement did not prove a win.",
      next: "Decide whether to stop, redesign, or continue anyway.",
    });
    const { deps, input, trace } = harness({ body });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(result.preserved).toBe(false);
    expect(result.swept).toBe(false);
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([]);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+ready-for-human+blocked:spec"]);
    expect(trace.comments[0]?.body).toContain("active Current blocker (decision)");
    expect(trace.released).toEqual([9]);
  });

  it("does not escalate a mechanical Current blocker before reconcile can handle it", async () => {
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "stalled",
      summary: "Worker stopped after pushing a branch.",
      next: "Reconcile the owned branch.",
    });
    const { deps, input, trace } = harness({
      body,
      labels: ["ready-for-agent", "blocked:stalled"],
      outcome: "done",
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls.length).toBe(1);
    expect(labelTrace(trace)[0]).toBe("-ready-for-agent+blocked:stalled|+running");
    expect(trace.comments.map((c) => c.body).some((body) => body.includes("preflight stopped"))).toBe(false);
    expect(trace.ensuredLabels).not.toContain("blocked:spec");
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
    // post_attempt fired (the run authored DONE); the feedback gate ran and
    // FAILED (pre_feedback → on_baseline_probe → post_feedback → on_feedback_classify),
    // so pre_merge was never reached and the worker branch was not pushed.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_feedback",
      "on_baseline_probe",
      "post_feedback",
      "on_feedback_classify",
    ]);
    expect(trace.pushedAttempt).toEqual([]);
  });

  it("retries a simple-classified feedback failure once on the complex tier, then lands when green", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, true],
      classifyIssue: async () => "simple",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return { model: `${runner}-${taskClass}-model`, effort: taskClass === "complex" ? "medium" : "high" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(tiers).toEqual([
      { runner: "claude", taskClass: "simple" },
      { runner: "claude", taskClass: "complex" },
    ]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-simple-model");
    expect(trace.runAgentCalls[1]?.model).toBe("claude-complex-model");
    expect(trace.runAgentCalls[1]?.effort).toBe("medium");
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+"]);
    expect(trace.closed).toEqual([9]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_feedback",
      "on_baseline_probe", // gate 1 FAILED → the baseline probe ran
      "post_feedback",
      "on_feedback_classify", // SEMANTIC → simple→complex retry
      "pre_attempt", // the complex-tier retry
      "post_attempt",
      "pre_feedback",
      "post_feedback", // gate 2 passed → no baseline probe
      "pre_merge",
      "post_merge",
    ]);
  });

  it("does not escalate a simple-classified attempt when feedback passes", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      classifyIssue: async () => "simple",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return { model: `${runner}-${taskClass}-model`, effort: "high" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(tiers).toEqual([{ runner: "claude", taskClass: "simple" }]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-simple-model");
  });

  it("bounds simple feedback escalation to one complex retry", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, false, true],
      classifyIssue: async () => "simple",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return { model: `${runner}-${taskClass}-model`, effort: "high" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(tiers).toEqual([
      { runner: "claude", taskClass: "simple" },
      { runner: "claude", taskClass: "complex" },
    ]);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:validation"]);
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
  });
});

describe("processIssue — backpressure fail (#430)", () => {
  it("flips to ready-for-human exactly like a feedback fail when a backpressure command fails", async () => {
    // Feedback passes; the operator-declared backpressure command fails AFTER it.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: false,
    });
    const result = await processIssue(deps, input);

    // Parks exactly like a feedback failure (same outcome + labels + envelope).
    expect(result.outcome).toBe("feedback-failed");
    expect(result.preserved).toBe(true);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:validation"]);
    expect(trace.ensuredLabels).toContain("blocked:validation");
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // The worker branch was NOT pushed for landing (the gate blocked the merge).
    expect(trace.pushedAttempt).toEqual([]);

    // The validation sidecar carries the failing backpressure command + output
    // tail, named `backpressure:<cmd>`.
    const lastSidecar = trace.sidecarWrites.at(-1)!;
    const records = lastSidecar.lines.map((l) => JSON.parse(l) as { schema: string; name: string; status: string; command?: string; summary?: string });
    const bp = records.find((r) => r.name === "backpressure:npm run e2e")!;
    expect(bp.schema).toBe("red.afk.validation.v1");
    expect(bp.status).toBe("failed");
    expect(bp.command).toBe("npm run e2e");
    expect(bp.summary).toBe("npm run e2e exploded stack trace here");
  });

  it("merges + closes when feedback and backpressure both pass, sidecar carrying both", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
    // The DONE-path sidecar union includes the passed backpressure record.
    const sidecar = trace.sidecarWrites.at(-1)!;
    const names = sidecar.lines.map((l) => (JSON.parse(l) as { name: string }).name);
    expect(names).toContain("backpressure:npm run e2e");
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
    // Routed through the merge-conflict BOUNDED-recovery reason. At the default
    // attempt this is a retry (< cap 3), so #402 routes back to ready-for-agent
    // CLEAN — no blocked:* tag — while the merge-conflict envelope records the
    // reason; what matters here is the gate diverted off merge.
    const finalEdit = trace.labelEdits.at(-1)!;
    expect(finalEdit.add).toContain("ready-for-agent");
    expect(finalEdit.add).not.toContain("blocked:merge-conflict");
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
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

  // ADR 0066: with the GitHub-native arbiter wired, `running` is a projection and
  // the claim comment decides the winner.
  it("concedes cleanly when it loses the GitHub-native claim (claim-lost, no agent)", async () => {
    // `running` is even PRESENT here — proving it is no longer consulted as the
    // lock; the earlier claim comment is what makes us lose.
    const { deps, input, trace } = harness({ claim: { winner: "other" }, labels: ["ready-for-agent", "running"] });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.labelEdits).toEqual([]); // never projected running — we lost
    expect(trace.released).toEqual([9]);
    expect(trace.runAgentCalls).toEqual([]); // no agent spawned
    // posted a claim then a concede (both recorded as comments).
    expect(trace.comments.some((c) => /conceded/.test(c.body))).toBe(true);
  });

  it("wins the GitHub-native claim solo and proceeds (running projected best-effort)", async () => {
    const { deps, input, trace } = harness({ claim: { winner: "self" } });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // running was PROJECTED (label edit applied) but is not the lock.
    expect(trace.labelEdits.some((e) => e.add.includes("running"))).toBe(true);
    expect(trace.comments.some((c) => /AFK claim by worker/.test(c.body))).toBe(true);
  });
});

describe("processIssue — goal predicate (ADR 0057)", () => {
  it("maps a foreign close to claim-lost: releases the claim, drops running, no envelope spam", async () => {
    const { deps, input, trace } = harness({ outcome: "goal-moot", branchMerged: false });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // The attempt is moot — nothing is landed/closed and no terminal envelope is posted.
    expect(trace.postedEnvelopes).toEqual([]);
    expect(trace.closed).toEqual([]);
    // The claim lock is released so the slot is not leaked.
    expect(trace.released).toEqual([9]);
    // Best-effort hygiene: our stale `running` label is shed.
    expect(trace.labelEdits.some((e) => e.remove.includes("running") && e.add.length === 0)).toBe(true);
    // At most one concise local record; the issue thread stays readable.
    const moot = trace.iterLogs.filter((l) => /goal predicate/.test(l));
    expect(moot).toHaveLength(1);
    expect(moot[0]).toMatch(/another lander.*claim-lost/);
  });

  it("maps this attempt's own merge to done (the close carries our landed branch)", async () => {
    const { deps, input, trace } = harness({ outcome: "goal-moot", branchMerged: true });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // Still no re-landing / re-close — the work is already in the world.
    expect(trace.postedEnvelopes).toEqual([]);
    expect(trace.closed).toEqual([]);
    expect(trace.released).toEqual([9]);
    const moot = trace.iterLogs.filter((l) => /goal predicate/.test(l));
    expect(moot).toHaveLength(1);
    expect(moot[0]).toMatch(/own merge.*done/);
  });

  it("threads the goalProbe onto the runAgent input so the guard polls issue state", async () => {
    const { deps, input, trace } = harness({ outcome: "goal-moot", branchMerged: false });
    await processIssue(deps, input);
    expect(typeof trace.runAgentCalls[0]?.goalProbe).toBe("function");
  });
});

describe("processIssue — trust gate (#621)", () => {
  const ALLOW: ConfigValues = { "afk.trust-gate.allowlist": "alice,bob" };

  it("refuses a non-executable issue BEFORE any claim edit / worktree, with a clear log line", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      trust: { author: "stranger", readyForAgentActor: "alice" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // No promotion edit, no agent spawn — refused before any work.
    expect(trace.labelEdits).toEqual([]);
    expect(trace.runAgentCalls).toEqual([]);
    // Claim lock released so the slot is not leaked.
    expect(trace.released).toEqual([9]);
    // A clear, attributable log line names the gate + the reason.
    expect(trace.iterLogs.some((l) => /trust gate refused #9.*untrusted author 'stranger'/.test(l))).toBe(true);
  });

  it("refuses when ready-for-agent was applied by a non-allowlisted actor", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      trust: { author: "alice", readyForAgentActor: "github-actions[bot]" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.iterLogs.some((l) => /trust gate refused.*github-actions\[bot\]/.test(l))).toBe(true);
  });

  it("claims normally when author AND label actor are both allowlisted", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      outcome: "done",
      feedbackOk: true,
      trust: { author: "alice", readyForAgentActor: "bob" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // The promotion-to-running claim edit ran (the gate passed).
    expect(trace.labelEdits[0]!.add).toEqual(["running"]);
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("is permissive when no allowlist is configured — the gate never fires even with an untrusted author", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      trust: { author: "stranger", readyForAgentActor: "anybody" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.iterLogs.some((l) => /trust gate/.test(l))).toBe(false);
  });
});

describe("processIssue — trust gate (#621)", () => {
  const ALLOW: ConfigValues = { "afk.trust-gate.allowlist": "alice,bob" };

  it("refuses a non-executable issue BEFORE any claim edit / worktree, with a clear log line", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      trust: { author: "stranger", readyForAgentActor: "alice" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // No promotion edit, no agent spawn — refused before any work.
    expect(trace.labelEdits).toEqual([]);
    expect(trace.runAgentCalls).toEqual([]);
    // Claim lock released so the slot is not leaked.
    expect(trace.released).toEqual([9]);
    // A clear, attributable log line names the gate + the reason.
    expect(trace.iterLogs.some((l) => /trust gate refused #9.*untrusted author 'stranger'/.test(l))).toBe(true);
  });

  it("refuses when ready-for-agent was applied by a non-allowlisted actor", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      trust: { author: "alice", readyForAgentActor: "github-actions[bot]" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.iterLogs.some((l) => /trust gate refused.*github-actions\[bot\]/.test(l))).toBe(true);
  });

  it("claims normally when author AND label actor are both allowlisted", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      outcome: "done",
      feedbackOk: true,
      trust: { author: "alice", readyForAgentActor: "bob" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // The promotion-to-running claim edit ran (the gate passed).
    expect(trace.labelEdits[0]!.add).toEqual(["running"]);
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("is permissive when no allowlist is configured — the gate never fires even with an untrusted author", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      trust: { author: "stranger", readyForAgentActor: "anybody" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.iterLogs.some((l) => /trust gate/.test(l))).toBe(false);
  });
});

describe("processIssue — claim sheds stale blocked:* on promote to running (#402)", () => {
  it("removes every blocked:* label the issue carried in the SAME claim edit", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      // A ready-for-agent issue that still drags two stale typed blocks.
      labels: ["ready-for-agent", "blocked:stalled", "blocked:dependency"],
    });
    await processIssue(deps, input);
    // The first edit is the claim: promote to running while removing
    // ready-for-agent AND both blocked:* reasons — one atomic edit, so no live
    // issue is ever `running` together with `blocked:*`.
    const claimEdit = trace.labelEdits[0]!;
    expect(claimEdit.add).toEqual(["running"]);
    expect(claimEdit.remove).toContain("ready-for-agent");
    expect(claimEdit.remove).toContain("blocked:stalled");
    expect(claimEdit.remove).toContain("blocked:dependency");
  });

  it("removes only the blocked:* labels actually present (never asks gh to drop absent ones)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent"],
    });
    await processIssue(deps, input);
    const claimEdit = trace.labelEdits[0]!;
    // No blocked:* present → the claim edit is the plain promotion, unchanged.
    expect(claimEdit.remove).toEqual(["ready-for-agent"]);
    expect(claimEdit.add).toEqual(["running"]);
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
    // claim then CLEAN restore of ready-for-agent (#402: no blocked:* on a
    // re-queue); sandcastle was never invoked.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    const haEdit = trace.labelEdits.at(-1)!;
    expect(haEdit.add).toContain("ready-for-agent");
    expect(haEdit.add).not.toContain("blocked:policy");
    expect(trace.ensuredLabels).not.toContain("blocked:policy");
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
    // claim → running, then CLEAN restore of ready-for-agent (not ready-for-human),
    // with NO blocked:quota tag riding the re-queue (#402).
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    const exEdit = trace.labelEdits.at(-1)!;
    expect(exEdit.add).toContain("ready-for-agent");
    expect(exEdit.add).not.toContain("blocked:quota");
    expect(trace.ensuredLabels).not.toContain("blocked:quota");
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
      "pre_feedback",
      "post_feedback",
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
    // ready-for-agent restored CLEAN (both-runners comment posted); #402: no
    // blocked:quota tag rides the re-queue, claim released.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    expect(trace.ensuredLabels).not.toContain("blocked:quota");
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

  it("resolves a fresh model and effort for the fallback runner", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      outcomes: ["exhausted", "done"],
      fallbackRunner: true,
      feedbackOk: true,
      classifyIssue: async () => "simple",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return runner === "codex"
          ? { model: "gpt-fallback", effort: "medium" }
          : { model: "claude-primary", effort: "high" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(tiers).toEqual([
      { runner: "claude", taskClass: "simple" },
      { runner: "codex", taskClass: "simple" },
    ]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-primary");
    expect(trace.runAgentCalls[0]?.effort).toBe("high");
    expect(trace.runAgentCalls[1]?.model).toBe("gpt-fallback");
    expect(trace.runAgentCalls[1]?.effort).toBe("medium");
  });
});

describe("processIssue — runner transient transport/setup failure", () => {
  it("routes through bounded recovery without throwing a worker crash", async () => {
    const { deps, input, trace } = harness({ outcome: "runner-transient", fallbackRunner: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("runner-transient");
    expect(result.preserved).toBe(true);
    expect(trace.runAgentCalls.length).toBe(1);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    expect(trace.ensuredLabels).not.toContain("blocked:runner-transient");
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
      "pre_feedback",
      "post_feedback",
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
    // runAgent receives the remote-tracking ref so sandcastle forks from the
    // freshly-fetched ref, not the potentially-stale local branch.
    expect(trace.runAgentCalls[0]?.base).toBe("origin/main");
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
  it("merge-conflict at attempt 1 (< cap 3) → RETRY: CLEAN ready-for-agent, no blocked:* tag, no page (#402)", async () => {
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
    // #402: a re-queue routes back CLEAN — no blocked:* rides the promotion.
    expect(edit.add).not.toContain("blocked:merge-conflict");
    expect(edit.add).not.toContain("ready-for-human");
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
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

  it("quota (exhausted) at attempt < cap → RETRY: CLEAN ready-for-agent, no blocked:* tag (#402)", async () => {
    const { deps, input, trace } = harness({ outcome: "exhausted", fallbackRunner: false, attempt: 2 });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("exhausted");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-agent");
    expect(edit.add).not.toContain("blocked:quota");
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
    // changedFiles:[] = a real crash (empty branch), so the no-sentinel salvage
    // (issue #332) does NOT apply and the crash-retry path is exercised.
    const retry = harness({ outcome: "no-sentinel", attempt: 1, changedFiles: [], recoveryEnv: { RED_AFK_RETRY_CRASH: "2" } });
    const r1 = await processIssue(retry.deps, retry.input);
    expect(r1.outcome).toBe("no-sentinel");
    expect(retry.trace.labelEdits.at(-1)!.add).toContain("ready-for-agent");
    // #402: clean re-queue — the crash reason no longer tags the ready-for-agent promotion.
    expect(retry.trace.labelEdits.at(-1)!.add).not.toContain("blocked:crashed");

    const escalate = harness({ outcome: "no-sentinel", attempt: 1, changedFiles: [] }); // default cap 1 → escalate
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
    expect(promote).toEqual([{ issue: 20, remove: ["blocked:dependency", "req:9"], add: ["ready-for-agent"] }]);
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
      remove: ["blocked:dependency", "req:8", "req:9"],
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

describe("processIssue — timeout (attempt progress guard fired)", () => {
  it("reconcile skip (no commits) → on_attempt_error → ready-for-human + blocked:stalled, no post_attempt", async () => {
    // No commits on the branch → the ADR 0055 reconcile skips (nothing to land)
    // and the original stalled escalation fires unchanged.
    const { deps, input, trace } = harness({ outcome: "timeout", changedFiles: [] });
    const result = await processIssue(deps, input);

    // The execution-layer `timeout` maps to the `stalled` terminal outcome.
    expect(result.outcome).toBe("stalled");
    expect(result.preserved).toBe(true);
    // Escalates to a human (non-recoverable) with the typed blocked:stalled tag.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:stalled"]);
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).toContain("blocked:stalled");
    expect(trace.ensuredLabels).toContain("blocked:stalled");
    // The failure envelope rides the generic `blocked` status bucket.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // on_attempt_timeout fires when the guard trips; on_reconcile reports the
    // ADR 0055 skip; then on_attempt_error escalates. post_attempt does NOT fire.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "on_attempt_timeout",
      "on_reconcile",
      "on_attempt_error",
    ]);
  });

  it("reconcile lands the stalled-but-green branch WITHOUT re-running the agent (no escalation)", async () => {
    // ADR 0055: the agent stalled on a final non-committing step, but its branch
    // carries complete, green work. reconcile re-validates through the same gate
    // and lands it — the issue closes as `done`, never reaching the escalation.
    const { deps, input, trace } = harness({ outcome: "timeout", feedbackOk: true, locked: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.mergeSha).toBe("abc1234");
    expect(result.swept).toBe(true);
    expect(trace.closed).toEqual([9]);
    // The agent ran exactly once — reconcile NEVER re-spawns it.
    expect(trace.runAgentCalls.length).toBe(1);
    // Closed cleanly: running shed, no blocked:stalled escalation label.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+"]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
  });

  it("reconcile parks the stalled branch to ready-for-human when re-validation fails", async () => {
    // The branch carries work but the scoped gate fails on re-validation → park
    // to ready-for-human with blocked:validation (the real reason), not landed.
    const { deps, input, trace } = harness({ outcome: "timeout", feedbackOk: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(result.preserved).toBe(true);
    expect(trace.closed).toEqual([]);
    expect(trace.runAgentCalls.length).toBe(1);
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).toContain("blocked:validation");
    // The park envelope rides the generic `blocked` status bucket.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
  });
});

describe("processIssue — emitHeartbeat receives resolved base (issue #570)", () => {
  it("passes the resolved non-main base to emitHeartbeat when the issue body pins a branch", async () => {
    const heartbeatInfos: AttemptProgressInfo[] = [];
    const pinBody = "branch: release/v2\n## Agent brief\nDo it.";
    const { deps, input } = harness({ outcome: "done", feedbackOk: true, body: pinBody });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      emitHeartbeat: (info) => heartbeatInfos.push(info),
      runAgent: async (ri) => {
        ri.onHeartbeat?.({ head: "abc123", lastProgressMs: 0, nowMs: 0 });
        return {
          outcome: "done",
          branch: ri.branch,
          commits: [{ sha: "deadbee" }],
          completionSignal: "<promise>DONE</promise>",
          stdout: "",
        };
      },
    };
    await processIssue(customDeps, input);
    expect(heartbeatInfos).toHaveLength(1);
    expect(heartbeatInfos[0]?.base).toBe("release/v2");
  });

  it("passes main as base when no pin and no lock", async () => {
    const heartbeatInfos: AttemptProgressInfo[] = [];
    const { deps, input } = harness({ outcome: "done", feedbackOk: true });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      emitHeartbeat: (info) => heartbeatInfos.push(info),
      runAgent: async (ri) => {
        ri.onHeartbeat?.({ head: "abc123", lastProgressMs: 0, nowMs: 0 });
        return {
          outcome: "done",
          branch: ri.branch,
          commits: [{ sha: "deadbee" }],
          completionSignal: "<promise>DONE</promise>",
          stdout: "",
        };
      },
    };
    await processIssue(customDeps, input);
    expect(heartbeatInfos).toHaveLength(1);
    expect(heartbeatInfos[0]?.base).toBe("main");
  });
});

describe("processIssue — new lifecycle checkpoints (#832)", () => {
  it("on_heartbeat context carries the full worker vitals", async () => {
    const stdins: string[] = [];
    const { deps, input } = harness({ outcome: "done", feedbackOk: true });
    const vitals = {
      tools_called_count: 7,
      text_chunk_count: 3,
      reasoning_events: 2,
      reasoning_tokens: 128,
      waiting_count: 1,
      input_tokens: 900,
      output_tokens: 450,
      cost_usd: 0.12,
      loc_added: 40,
      loc_removed: 5,
    };
    const customDeps: ProcessIssueDeps = {
      ...deps,
      heartbeatVitals: () => vitals,
      hooks: {
        ...deps.hooks,
        config: { "afk.hooks.on_heartbeat": "hb-cmd" },
        exec: async (command, _env, stdin) => {
          if (command === "hb-cmd") stdins.push(stdin);
          return { code: 0, stdout: "" };
        },
      },
      runAgent: async (ri) => {
        ri.onHeartbeat?.({ head: "abc123", lastProgressMs: 0, nowMs: 0 });
        return {
          outcome: "done",
          branch: ri.branch,
          commits: [{ sha: "deadbee" }],
          completionSignal: "<promise>DONE</promise>",
          stdout: "",
        };
      },
    };
    await processIssue(customDeps, input);
    expect(stdins).toHaveLength(1);
    const ctx = JSON.parse(stdins[0]!) as { vitals?: Record<string, number> };
    expect(ctx.vitals).toEqual(vitals);
  });

  it("on_feedback_classify (mutable) overrides SEMANTIC→INFRA and suppresses the tier retry", async () => {
    // A SEMANTIC simple-tier feedback failure normally retries once on the complex
    // tier (a second runAgent). A hook that reclassifies it as INFRA suppresses
    // that retry — a tier bump can't fix infra — so the agent runs exactly once.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: false,
      classifyIssue: async () => "simple",
    });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      hooks: {
        ...deps.hooks,
        config: { "afk.hooks.on_feedback_classify": "cls" },
        exec: async (command) =>
          command === "cls"
            ? { code: 0, stdout: JSON.stringify({ class: "infra" }) }
            : { code: 0, stdout: "" },
      },
    };
    const result = await processIssue(customDeps, input);
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(result.outcome).toBe("feedback-failed-infra");
  });

  it("on_recovery_decision (mutable) overrides retry→escalate", async () => {
    // pre_worktree abort routes through routeRecovery("hook-aborted"), bounded-
    // recoverable → RETRY under a raised cap. A hook returning {"decision":
    // "escalate"} forces the human gate instead of the clean re-queue.
    const { deps, input, trace } = harness({
      abortHook: "pre_worktree",
      attempt: 1,
      recoveryEnv: { RED_AFK_RETRY_POLICY: "2" },
    });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      hooks: {
        ...deps.hooks,
        config: {
          "afk.hooks.pre_worktree": "abort:pre_worktree",
          "afk.hooks.on_recovery_decision": "dec",
        },
        exec: async (command) => {
          if (command === "abort:pre_worktree") return { code: 1, stdout: "" };
          if (command === "dec") return { code: 0, stdout: JSON.stringify({ decision: "escalate" }) };
          return { code: 0, stdout: "" };
        },
      },
    };
    await processIssue(customDeps, input);
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).not.toContain("ready-for-agent");
  });

  it("on_blocked fires when an issue is parked to the human gate", async () => {
    // Default policy cap (1) → attempt 1 escalates, so the issue is parked to a
    // human gate and the on_blocked hook fires with the typed blocked label.
    const commands: string[] = [];
    const { deps, input } = harness({ abortHook: "pre_worktree", attempt: 1 });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      hooks: {
        ...deps.hooks,
        config: {
          "afk.hooks.pre_worktree": "abort:pre_worktree",
          "afk.hooks.on_blocked": "blk",
        },
        exec: async (command, env) => {
          commands.push(command);
          if (command === "blk") {
            // The typed blocked:* label rides the env (RED_AFK_BLOCKED_LABEL).
            expect(env.RED_AFK_BLOCKED_LABEL).toBe("blocked:policy");
            return { code: 0, stdout: "" };
          }
          if (command === "abort:pre_worktree") return { code: 1, stdout: "" };
          return { code: 0, stdout: "" };
        },
      },
    };
    await processIssue(customDeps, input);
    expect(commands).toContain("blk");
  });
});
