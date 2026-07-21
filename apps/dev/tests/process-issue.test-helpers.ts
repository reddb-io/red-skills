export { describe, expect, it } from "vitest";
import {
  processIssue,
  type ProcessIssueDeps,
  type ProcessIssueInput,
} from "../src/core/process-issue.js";
import { SCOUT_EXIT_PROTOCOL } from "../src/core/handoff.js";
import type { HookName } from "../src/core/hook-config.js";
import type { ConfigValues } from "../src/core/config.js";
import type { AgentEffort, RunAgentInput, RunAgentResult, SandboxMode } from "../src/core/execution.js";
import type { AttemptRecordPayload } from "../src/core/attempt-record.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import type { IssueClassificationMetadata } from "../src/core/issue-classifier.js";
import type { TrustProvenance } from "../src/core/trust-gate.js";
import { parseCurrentBlocker, upsertCurrentBlocker } from "../src/core/blocker-state.js";
import type { AttemptProgressInfo } from "../src/core/execution.js";
import { installProcessSafety, noopSafetyLogger } from "../src/core/process-safety.js";
import type { AdversarialReviewFindings } from "../src/core/adversarial-review.js";

export {
  SCOUT_EXIT_PROTOCOL,
  installProcessSafety,
  noopSafetyLogger,
  parseCurrentBlocker,
  processIssue,
  upsertCurrentBlocker,
};
export type { AttemptProgressInfo, ConfigValues, ProcessIssueDeps, ProcessIssueInput };
// Everything injected is a fake — no real gh / git / sandcastle / pnpm / fs ever
// runs. The harness records the side-effect sequence (label edits, comments,
// close, sweep, hook order) so each test asserts the lifecycle as a trace rather
// than reaching into the modules being composed. Execution itself is the
// injected `runAgent` port (ADR 0033): a fake returning a scripted
// RunAgentResult, replacing the old fake runner-spawn + worktree-create deps.

export const DEFAULT_BRANCH_TIP = "feedfacecafebeef";

export interface Trace {
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
  /** Non-blocking backpressure evidence reviews posted via the #1279 seam. */
  backpressureReviews: Array<{ pr: number; body: string }>;
  /** Advisory adversarial reviews posted after the machine gate and before merge. */
  adversarialReviews: Array<{ pr: number; issue: number; body: string; findings: AdversarialReviewFindings }>;
  adversarialReviewContexts: Array<{
    issueNumber: number;
    issueTitle: string;
    issueBody: string;
    prNumber: number;
    diff: string;
    runner: string;
    model: string;
    effort?: AgentEffort;
    maxIterations: number;
  }>;
  /** Memory reasoning-attempt records fired after a terminal envelope. */
  recordedAttempts: AttemptRecordPayload[];
  /** Brain outcome events fired after terminal attempt completion. */
  outcomeEvents: OutcomeEvent[];
  /** Worker branches passed to the commit-leftovers salvage port. */
  salvageCalls: string[];
  /** Worker branches passed to the ADR 0083 §4 terminal exit barrier (#1021). */
  terminalBarrierCalls: string[];
  /** Metadata handed to the per-issue classifier before runAgent. */
  classifierCalls: IssueClassificationMetadata[];
  /** Lines appended to the iteration log (deps.appendIterLog). */
  iterLogs: string[];
  /** Main-red repair issue create attempts from the baseline probe sync path. */
  mainRedRepairCreates: Array<{ title: string; body: string; labels: readonly string[] }>;
  /** Compact state patches written to afk.state.toon. */
  statePatches: Array<Record<string, unknown>>;
  /** Branches for which cascadeRebase.rebaseAndPush was called (#1007). */
  cascadeRebaseAttempts: string[];
  /** Arguments passed into feedback scope changed-file resolution. */
  changedFileCalls: Array<{ branch: string; base: string }>;
  /** Raw pnpm argv vectors emitted by the feedback/backpressure fakes. */
  pnpmArgs: string[][];
  /** Handoff bodies written before the sandcastle run. */
  handoffs: Array<{ path: string; content: string }>;
  /** Fresh-branch preparation calls before sandcastle can reuse a worktree. */
  freshWorkerBranchCalls: Array<{ branch: string; baseRef: string; force: boolean }>;
}

export interface HarnessOptions {
  labels?: string[];
  acquire?: boolean;
  /** Inject the ADR 0066 GitHub-native claim arbiter. When set, the claim path
   * is the authority and `running` is a projection. The `winner` field decides
   * the verdict for the test (self worker is "h:w"). */
  claim?: { winner: "self" | "other" };
  outcome?: RunAgentResult["outcome"];
  timeoutReason?: RunAgentResult["timeoutReason"];
  /** Scripted per-call outcomes (overrides `outcome`); one entry per runAgent call. */
  outcomes?: RunAgentResult["outcome"][];
  /** Test hook invoked inside the fake runner while the issue claim is active. */
  onRunAgent?: () => void | Promise<void>;
  feedbackOk?: boolean;
  /** When true, the feedback baseline probe fails the same check as the worker. */
  baselineFails?: boolean;
  /** Existing main-red repair issue returned by the finder. false/null means missing. */
  mainRedRepairIssue?: boolean;
  /** When set, creating the main-red repair issue throws this message. */
  mainRedRepairCreateError?: string;
  /** Scripted per-feedback-gate outcomes. Each feedback run executes the four
   * standard scripts; this controls the aggregate pass/fail for each run. */
  feedbackResults?: boolean[];
  /** Operator-declared backpressure commands (afk.backpressure, #430). When set,
   * the backpressure gate runs after feedback against the worker branch. */
  backpressureCommands?: string[];
  outputShaping?: { terseSteering: boolean };
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
  trust?: TrustProvenance;
  /** Operator-configured sandbox mode threaded into processIssue. */
  sandboxMode?: SandboxMode;
  /** Container backends considered present by the fail-closed sandbox policy. */
  availableSandboxes?: SandboxMode[];
  /** Repo-level sandbox image (#2340) threaded into processIssue. */
  sandboxImage?: string;
  /** Backends whose sandbox image already exists. When set, the image-readiness
   * probe is registered and a missing image parks instead of crashing. */
  sandboxesWithImage?: SandboxMode[];
  /** Repository visibility (#1101) returned by gh.repoVisibility. When set, the
   * port is registered and the no-allowlist default becomes visibility-aware. */
  visibility?: "public" | "private" | "internal";
  /** Logins that gh.actorTrustSignals reports as write-access maintainers (#1101);
   * everyone else resolves to determinable-negative signals. When set, the
   * actorTrustSignals port is registered (enabling the fail-closed path). */
  maintainers?: string[];
  abortHook?: HookName;
  /** FIX J: when set, a pre_worktree hook command emits this env as the mutated
   * context's `{env:{…}}` slice — proving it threads onto the runAgent input. */
  preWorktreeEnv?: Record<string, string>;
  changedFiles?: string[];
  /** Per-call changed-file results. Useful when a bounded retry changes whether
   * the worker branch actually differs from base. */
  changedFilesSequence?: string[][];
  changedFilesByBase?: Record<string, string[]>;
  packageScopes?: string[];
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
  /** Restart-informed context block returned by the attempt ledger lookup. */
  priorAttemptContext?: string;
  /** The configured Trunk (`plugins.dev.trunk`, ADR 0083) injected into base resolution. */
  configTrunk?: string;
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
  /** Close-cascade fixture: metadata for human-facing dependency references. */
  issueRefs?: Record<number, { title: string; url: string }>;
  /** Attempt number (1-based) the issue runs under — drives the BOUNDED
   * auto-recovery cap (recovery.ts). Defaults to 1. */
  attempt?: number;
  /** Env view the recovery policy reads RED_AFK_RETRY_* caps from. Defaults to {}. */
  recoveryEnv?: Record<string, string>;
  /** /go post-DONE machine-gate retry cap injected by run.ts. */
  goVerifyRetries?: number;
  /** When set, register the ADR 0017 `recordAttempt` port. "throw" makes it
   * reject (proving a memory failure never fails the close); "ok" records the
   * payload; undefined omits the port entirely (older-caller safety). */
  recordAttempt?: "ok" | "throw";
  /** When set, register the Brain outcome-event sink. "throw"/"hang" model Brain down/slow. */
  recordOutcomeEvent?: "ok" | "throw" | "hang";
  /** When false, omit the optional fs.writeValidationSidecar port (older-caller
   * safety). Defaults to true (port present + recorded). */
  withSidecarPort?: boolean;
  /** Commits sandcastle reports runAgent landed on the worker branch. Defaults
   * to one commit on a real outcome / none on exhaustion. Set `[]` to model the
   * codex DONE-without-commit case the salvage port rescues. */
  commits?: { sha: string }[];
  /** Text chunks emitted through the agent stream callback before runAgent returns. */
  agentTextEvents?: string[];
  /** Override the fake runAgent completion signal. */
  completionSignal?: string;
  /** When set, register the commit-leftovers `salvageUncommitted` port and have
   * it return this count (files committed). undefined omits the port (legacy
   * caller — no salvage). */
  salvage?: number;
  /** When set, register the ADR 0083 §4 `terminalExitBarrier` port (#1021). The
   * fake records the branch and returns a {@link TerminalReceipt} whose
   * `salvagedFiles` / `pushed` are driven by these fields (defaults: 0 files,
   * pushed:true). `fault:true` makes the port reject, proving the terminal still
   * reports (with a not-pushed receipt) when the barrier itself faults. undefined
   * omits the port (legacy caller — no barrier crossing). */
  terminalBarrier?: { salvagedFiles?: number; pushed?: boolean; fault?: boolean };
  /** Issue body threaded into processIssue. */
  body?: string;
  /** Execution mode forwarded to ProcessIssueInput (e.g. `"scout"`). */
  runMode?: string;
  /** The candidate-listing lane label forwarded to ProcessIssueInput (`--lane`).
   * Undefined models the `/afk` default (`ready-for-agent`); `"lane:go"` models a
   * `/go` dispatch. Drives the lane-aware claim preflight (#1045). */
  laneLabel?: string;
  /** Optional ADR 0049 tier resolver injected by the production wiring. */
  resolveTier?: ProcessIssueDeps["resolveTier"];
  /** Optional ADR 0049 issue classifier injected by the production wiring. */
  classifyIssue?: ProcessIssueDeps["classifyIssue"];
  /** PR review gate (ADR 0064 §10, #749). When set, processIssue may hand the
   * unlocked landing off for a fresh-agent review instead of fast-merging. */
  reviewGate?: ProcessIssueDeps["reviewGate"];
  /** Advisory adversarial review tracer (#2207). */
  adversarialReview?: ProcessIssueDeps["adversarialReview"];
  adversarialFindings?: AdversarialReviewFindings;
  adversarialFindingsSequence?: AdversarialReviewFindings[];
  /** CI-aware merge (#812). When set, register the `ciAwait` port and drive the
   * `gh pr view` verdict the unlocked landing polls before admin-merging. */
  ciAware?: "merge" | "ci-failed" | "ci-pending" | "conflict";
  /** Exit code for the final `gh pr merge` command. Defaults to 0. */
  prMergeCode?: number;
  /** Spec cascade rebase (#1007): remote afk/* branches returned by
   * cascadeRebase.listAFKBranches. When set, injects the cascadeRebase port. */
  siblingBranches?: string[];
  /** Worker IDs considered live (skipped by cascade rebase). */
  liveWorkers?: string[];
  /** When true, cascadeRebase.rebaseAndPush returns ok=false for every branch. */
  cascadeRebaseFail?: boolean;
}

export function harness(opts: HarnessOptions = {}): {
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
    terminalBarrierCalls: [],
    listByLabelCalls: [],
    ensuredLabels: [],
    sidecarWrites: [],
    backpressureReviews: [],
    adversarialReviews: [],
    adversarialReviewContexts: [],
    recordedAttempts: [],
    outcomeEvents: [],
    salvageCalls: [],
    classifierCalls: [],
    iterLogs: [],
    mainRedRepairCreates: [],
    statePatches: [],
    cascadeRebaseAttempts: [],
    changedFileCalls: [],
    pnpmArgs: [],
    handoffs: [],
    freshWorkerBranchCalls: [],
  };

  const outcome = opts.outcome ?? "done";
  const config: ConfigValues = opts.config ?? {};
  // Flipped true once the conflict resolver dispatch runs; the mergeExec
  // verification reads above key off it to model "the agent resolved the merge".
  let mergeResolved = false;
  let pnpmCalls = 0;
  let changedFilesCalls = 0;
  let currentMainRedRepairIssue: { number: number; title?: string; body?: string; labels?: readonly string[] } | null =
    opts.mainRedRepairIssue ? { number: 123 } : null;

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
      async issueReference(n) {
        const ref = opts.issueRefs?.[n];
        return ref ? { number: n, ...ref } : undefined;
      },
      // Trust-gate provenance port (#621): registered only when the test opts in,
      // so legacy-shaped tests omit it and the gate never fires (permissive).
      issueTrust: opts.trust ? async () => opts.trust! : undefined,
      // Visibility-aware default ports (#1101): registered only when the test opts
      // in, so legacy-shaped tests omit them and the default stays permissive.
      repoVisibility: opts.visibility ? async () => opts.visibility! : undefined,
      actorTrustSignals: opts.maintainers
        ? async (actor: string) => ({
            hasWriteAccess: opts.maintainers!.includes(actor),
            inCodeowners: false,
          })
        : undefined,
      listMainRedRepairIssues:
        opts.baselineFails || opts.mainRedRepairIssue !== undefined || opts.mainRedRepairCreateError
          ? async () => currentMainRedRepairIssue ? [currentMainRedRepairIssue] : []
          : undefined,
      findMainRedRepairIssue:
        opts.baselineFails || opts.mainRedRepairIssue !== undefined || opts.mainRedRepairCreateError
          ? async () => currentMainRedRepairIssue
          : undefined,
      createMainRedRepairIssue:
        opts.baselineFails || opts.mainRedRepairIssue !== undefined || opts.mainRedRepairCreateError
          ? async (spec) => {
              trace.mainRedRepairCreates.push(spec);
              if (opts.mainRedRepairCreateError) throw new Error(opts.mainRedRepairCreateError);
              currentMainRedRepairIssue = { number: 124 };
              return 124;
            }
          : undefined,
      updateMainRedRepairIssue:
        opts.baselineFails || opts.mainRedRepairIssue !== undefined || opts.mainRedRepairCreateError
          ? async (issue, spec) => {
              currentMainRedRepairIssue = { number: issue, ...spec };
            }
          : undefined,
      closeMainRedRepairIssue:
        opts.baselineFails || opts.mainRedRepairIssue !== undefined || opts.mainRedRepairCreateError
          ? async () => {
              currentMainRedRepairIssue = null;
            }
          : undefined,
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
      async writeHandoff(path, content) {
        trace.handoffs.push({ path, content });
      },
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
      async resolveFreshBase({ base, remote }) {
        if (opts.fetchedBases) opts.fetchedBases.push(base);
        return {
          ok: true,
          base,
          baseRef: "red-trunk",
          sha: `${remote}/${base}-tip`,
          source: "mirror",
          remoteReachable: true,
        };
      },
      async fetchBase(base) {
        if (opts.fetchedBases) opts.fetchedBases.push(base);
      },
      async prepareFreshWorkerBranch(input) {
        trace.freshWorkerBranchCalls.push(input);
        return true;
      },
    },
    mergeExec: async (argv) => {
      const j = argv.join(" ");
      if (j === "git -C /repo fetch origin afk/wAAAA/9-fix-the-thing --quiet") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (j === "git -C /repo rev-parse --verify --quiet origin/afk/wAAAA/9-fix-the-thing") {
        return { code: 0, stdout: `${DEFAULT_BRANCH_TIP}\n`, stderr: "" };
      }
      if (j === "git -C /wt rev-parse --verify --quiet origin/afk/wAAAA/9-fix-the-thing") {
        return { code: 0, stdout: `${DEFAULT_BRANCH_TIP}\n`, stderr: "" };
      }
      if (j.includes("merge-base --is-ancestor origin/")) {
        return { code: 1, stdout: "", stderr: "" };
      }
      // landPr reuses an open PR via `gh pr list`; reply with a number so it
      // resolves without a create round-trip.
      if (argv.includes("pr") && argv.includes("list")) {
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      if (argv.includes("pr") && argv.includes("diff")) {
        return {
          code: 0,
          stdout: "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts\n+++ b/packages/x/src/a.ts\n@@ -0,0 +1 @@\n+export const ok = true;\n",
          stderr: "",
        };
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
      if (j.includes("pr view") && j.includes("--json mergeCommit")) {
        return { code: 0, stdout: "forge-merge-sha\n", stderr: "" };
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
      trace.pnpmArgs.push([...args]);
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
        return { code: opts.baselineFails ? 1 : 0, stdout: "", stderr: "" };
      }
      const feedbackRun = Math.floor(pnpmCalls / 4);
      pnpmCalls += 1;
      const ok = opts.feedbackResults
        ? (opts.feedbackResults[feedbackRun] ?? opts.feedbackResults.at(-1) ?? true)
        : opts.feedbackOk !== false;
      return { code: ok ? 0 : 1, stdout: "", stderr: "" };
    },
    layout: {
      hasPackage: (scope) => (opts.packageScopes ? opts.packageScopes.includes(scope) : scope === "."),
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
    outputShaping: opts.outputShaping,
    // Non-blocking backpressure evidence review seam (#1279): record every
    // aggregated COMMENT review the engine posts once the PR number is known.
    postBackpressureReview: async (pr, body) => {
      trace.backpressureReviews.push({ pr, body });
    },
    adversarialReview: opts.adversarialReview,
    extractAdversarialReview: opts.adversarialReview
      ? async ({ context, runner, model, effort, maxIterations }) => {
          trace.adversarialReviewContexts.push({ ...context, runner, model, effort, maxIterations });
          return opts.adversarialFindingsSequence?.[trace.adversarialReviewContexts.length - 1] ?? opts.adversarialFindings ?? {
            summary: "Stubbed adversarial review summary.",
            findings: [
              {
                path: "packages/x/src/a.ts",
                line: 1,
                body: "Acceptance criteria conformance finding.",
                blocking: true,
              },
            ],
          };
        }
      : undefined,
    postAdversarialReview: opts.adversarialReview
      ? async (review) => {
          trace.adversarialReviews.push(review);
          trace.comments.push({ issue: review.pr, body: review.body });
          trace.comments.push({ issue: review.issue, body: review.body });
        }
      : undefined,
    goVerifyRetries: opts.goVerifyRetries,
    sandboxMode: opts.sandboxMode ?? "none",
    sandboxAvailable: async (mode) => (opts.availableSandboxes ?? ["docker", "podman"]).includes(mode),
    sandboxImage: opts.sandboxImage,
    sandboxImageAvailable: opts.sandboxesWithImage
      ? async (mode) => opts.sandboxesWithImage!.includes(mode)
      : undefined,
    // The sandcastle execution port: a fake returning a scripted outcome on the
    // worker branch sandcastle "committed" to. When `outcomes` is set, each call
    // pops the next scripted outcome (for fallback-swap sequences).
    async runAgent(input) {
      const callIdx = trace.runAgentCalls.length;
      trace.runAgentCalls.push(input);
      await opts.onRunAgent?.();
      const thisOutcome = opts.outcomes ? (opts.outcomes[callIdx] ?? outcome) : outcome;
      for (const message of opts.agentTextEvents ?? []) {
        input.onAgentEvent?.({ type: "text", message, iteration: 1, timestamp: new Date(0) });
      }
      return {
        outcome: thisOutcome,
        branch: input.branch,
        commits:
          opts.commits ??
          (thisOutcome === "exhausted" || thisOutcome === "runner-transient" ? [] : [{ sha: "deadbee" }]),
        completionSignal:
          opts.completionSignal ??
          (thisOutcome === "done"
            ? "<promise>DONE</promise>"
            : thisOutcome === "blocked"
              ? "<promise>BLOCKED</promise>"
              : undefined),
        timeoutReason: thisOutcome === "timeout" ? opts.timeoutReason : undefined,
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
    makeRebaseWorktree: async () => "/rwt",
    removeRebaseWorktree: async () => {},
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
        configTrunk: opts.configTrunk,
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
        return opts.priorAttemptContext;
      },
      async changedFiles(branch, base) {
        trace.changedFileCalls.push({ branch, base });
        const seq = opts.changedFilesSequence;
        if (seq) {
          const idx = changedFilesCalls++;
          return seq[idx] ?? seq.at(-1) ?? [];
        }
        return opts.changedFilesByBase?.[base] ?? opts.changedFiles ?? ["packages/x/src/a.ts"];
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
    markState: (patch) => {
      trace.statePatches.push(patch);
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
    recordOutcomeEvent: opts.recordOutcomeEvent
      ? async (event) => {
          if (opts.recordOutcomeEvent === "throw") throw new Error("brain exploded");
          if (opts.recordOutcomeEvent === "hang") return await new Promise<never>(() => {});
          trace.outcomeEvents.push(event);
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
    // ADR 0083 §4 terminal exit barrier port (#1021). Records the branch and
    // returns a scripted TerminalReceipt; `fault` rejects to prove the terminal
    // still reports when the barrier itself faults.
    terminalExitBarrier:
      opts.terminalBarrier === undefined
        ? undefined
        : async (branch) => {
            trace.terminalBarrierCalls.push(branch);
            if (opts.terminalBarrier!.fault) throw new Error("terminal barrier boom");
            const salvagedFiles = opts.terminalBarrier!.salvagedFiles ?? 0;
            const pushed = opts.terminalBarrier!.pushed ?? true;
            return {
              branch,
              head: pushed ? "beefcafe" : "",
              pushedAt: "2026-07-03T12:00:00Z",
              salvaged: salvagedFiles > 0,
              salvagedFiles,
              pushed,
            };
          },
    // Spec cascade rebase port (#1007): injected when siblingBranches is set.
    cascadeRebase:
      opts.siblingBranches !== undefined
        ? {
            async listAFKBranches() {
              return opts.siblingBranches!;
            },
            isWorkerLive(workerId) {
              return (opts.liveWorkers ?? []).includes(workerId);
            },
            async rebaseAndPush(_repoDir, branch, _newBase) {
              trace.cascadeRebaseAttempts.push(branch);
              if (opts.cascadeRebaseFail) {
                return { ok: false, warn: `rebase failed for ${branch}` };
              }
              return { ok: true };
            },
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
    specRef: undefined,
    runMode: opts.runMode,
    laneLabel: opts.laneLabel,
  };

  return { deps, input, trace };
}

export const labelTrace = (t: Trace): string[] =>
  t.labelEdits.map((e) => `-${e.remove.join("+")}|+${e.add.join("+")}`);
