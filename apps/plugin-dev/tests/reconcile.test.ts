import { describe, expect, it } from "vitest";
import {
  landingRefusalSummary,
  mechanicalDisqualifier,
  reconcile,
  routeLandingFailure,
  type ReconcileDeps,
  type ReconcileInput,
} from "../src/core/reconcile.js";
// The effectful collaborators are now injected (#2665). The harness wires the
// REAL host implementations, so every assertion below still exercises the same
// doLanding / runFeedback / emitEnvelope / push-delete code over the fake execs.
import { HOST_RECONCILE_PORTS } from "../src/core/reconcile-ports.js";
import { DEFAULT_TRIAGE_LABELS } from "../src/core/triage-labels.js";
import { upsertCurrentBlocker } from "../src/core/blocker-state.js";
import { readsPull, restPullBody } from "./support/gh-rest-fixtures.js";
import { githubMergeReadFromExec } from "./support/github-merge-read.js";

// Everything injected is a fake — no real gh / git / pnpm / fs ever runs. The
// harness records the side-effect sequence (label edits, comments, close, sweep,
// pushed/deleted branches, posted envelopes) so each test asserts the reconcile
// decision tree as a trace. The shape mirrors process-issue.test.ts so the two
// read alike.

interface Trace {
  labelEdits: Array<{ issue: number; remove: string[]; add: string[] }>;
  comments: Array<{ issue: number; body: string }>;
  ensuredLabels: string[];
  closed: number[];
  swept: number[];
  deletedRemote: string[][];
  pushedAttempt: string[][];
  postedEnvelopes: Array<{ issue: number; status: string }>;
  deletedLocalBranches: string[];
  sidecarWrites: Array<{ path: string; lines: string[] }>;
  listByLabelCalls: string[];
  firedHooks: string[];
  iterLogs: string[];
  /** Presence stages reconcile advanced through via `markStage` (#1306). */
  stageMarks: string[];
  mergeCalls: string[][];
  pnpmCalls: number;
  pnpmArgs: string[][];
  changedFileCalls: Array<{ branch: string; base: string }>;
}

interface HarnessOptions {
  labels?: string[];
  body?: string;
  /** Aggregate feedback gate verdict. Defaults to passing (green). */
  feedbackOk?: boolean;
  /** Aggregate in-lock post-merge feedback verdict. Defaults to passing. */
  postMergeFeedbackOk?: boolean;
  ciAware?: "merge" | "skipped";
  changedFiles?: string[];
  changedFilesByBase?: Record<string, string[]>;
  packageScopes?: string[];
  branchPresent?: boolean;
  locked?: boolean;
  /** When true, the unlocked `gh pr merge` returns non-zero (land fails). */
  landFail?: boolean;
  /**
   * #2864: the PR is merely BEHIND its base — zero conflicts, zero failing
   * checks, `mergeable=true`. The first `gh pr merge` is rejected; a single
   * `gh pr update-branch` makes it CLEAN and the retry merges.
   */
  behindBase?: boolean;
  /**
   * #2864: the pre-merge rebase hits a GENUINE conflict in these paths (the
   * only state that may reach `blocked:merge-conflict`).
   */
  rebaseConflict?: string[];
  /** Close-cascade fixture: open dependents returned by gh.listByLabel(req:N). */
  dependentsByLabel?: Record<string, { number: number; labels: string[] }[]>;
  closedIssues?: number[];
  withSidecarPort?: boolean;
}

function harness(opts: HarnessOptions = {}): {
  deps: ReconcileDeps;
  input: ReconcileInput;
  trace: Trace;
} {
  let nowEpoch = 0;
  const trace: Trace = {
    labelEdits: [],
    comments: [],
    ensuredLabels: [],
    closed: [],
    swept: [],
    deletedRemote: [],
    pushedAttempt: [],
    postedEnvelopes: [],
    deletedLocalBranches: [],
    sidecarWrites: [],
    listByLabelCalls: [],
    firedHooks: [],
    iterLogs: [],
    stageMarks: [],
    mergeCalls: [],
    pnpmCalls: 0,
    pnpmArgs: [],
    changedFileCalls: [],
  };

  /** #2864: flipped by the landing's `gh pr update-branch` repair. */
  let branchUpdated = false;
    let behindMerged = false;

  const deps: ReconcileDeps = {
    ...HOST_RECONCILE_PORTS,
    gh: {
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
    git: {
      async headShortSha() {
        return "abc1234";
      },
      async deleteLocalBranch(branch) {
        trace.deletedLocalBranches.push(branch);
      },
    },
    fs: {
      async completionSweep(issue) {
        trace.swept.push(issue);
        return [`/tmp/workers/w/${issue}-a1`];
      },
      writeValidationSidecar:
        opts.withSidecarPort === false
          ? undefined
          : async (path, lines) => {
              trace.sidecarWrites.push({ path, lines });
            },
    },
    lookups: {
      async changedFiles(branch, base) {
        trace.changedFileCalls.push({ branch, base });
        return opts.changedFilesByBase?.[base] ?? opts.changedFiles ?? ["packages/x/src/a.ts"];
      },
      async branchPresent() {
        return opts.branchPresent ?? true;
      },
      async isLocked() {
        return opts.locked ?? false;
      },
    },
    mergeExec: async (argv) => {
      trace.mergeCalls.push(argv);
      const j = argv.join(" ");
      // #2864 fixtures: a genuinely conflicting rebase, and a merely-behind PR
      // the landing repairs with `gh pr update-branch`.
      if (opts.rebaseConflict) {
        if (j.includes("merge-base --is-ancestor")) return { code: 1, stdout: "", stderr: "" };
        if (j === "git -C /rwt rebase origin/main") return { code: 1, stdout: "", stderr: "CONFLICT" };
        if (j.includes("--diff-filter=U")) {
          return { code: 0, stdout: `${opts.rebaseConflict.join("\n")}\n`, stderr: "" };
        }
      }
      if (opts.behindBase) {
        if (j.includes("pr update-branch") || /pulls\/\d+\/update-branch/.test(j)) {
          branchUpdated = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if ((j.includes("pr merge") || /pulls\/\d+\/merge(?!-)/.test(j)) && !branchUpdated) {
          return { code: 1, stdout: "", stderr: "Base branch was modified. Review and try the merge again." };
        }
        if ((j.includes("pr merge") || /pulls\/\d+\/merge(?!-)/.test(j)) && branchUpdated) {
          behindMerged = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        // The routed single-object probe (#3726) answers BEHIND until the
        // update repairs it, then CLEAN, then the merged confirmation.
        if (readsPull(argv) && !behindMerged) {
          return {
            code: 0,
            stdout: JSON.stringify(restPullBody({
              state: "OPEN", mergedAt: null,
              mergeStateStatus: branchUpdated ? "CLEAN" : "BEHIND",
              mergeable: "MERGEABLE",
            })),
            stderr: "",
          };
        }
        // The READINESS probe only: since #3030 the merge confirmation also asks
        // for `mergeStateStatus`, and answering it with a payload carrying no
        // `state` would read the completed merge as an unmerged PR.
        if (j.includes("pr view") && j.includes("statusCheckRollup")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              mergeStateStatus: branchUpdated ? "CLEAN" : "BEHIND",
              mergeable: "MERGEABLE",
              baseRefOid: "0r1g1nsha",
              statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
            }),
            stderr: "",
          };
        }
      }
      if (j === "git -C /repo fetch origin afk/wAAAA/9-fix-the-thing --quiet") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (j === "git -C /repo rev-parse --verify --quiet origin/afk/wAAAA/9-fix-the-thing") {
        return { code: 0, stdout: "feedfacecafebeef\n", stderr: "" };
      }
      if (j === "git -C /repo rev-parse origin/main") {
        return { code: 0, stdout: "0r1g1nsha\n", stderr: "" };
      }
      if (j.includes("api repos/o/r/branches/main/protection/required_status_checks/contexts")) {
        return { code: 0, stdout: JSON.stringify(["ci"]), stderr: "" };
      }
      // landPr reuses an open PR via the routed REST pulls probe (#3726) or
      // the legacy `gh pr list`; reply with a number either way.
      if (
        (argv.includes("pr") && argv.includes("list")) ||
        (argv.includes("api") && argv.some((a) => /repos\/.+\/pulls$/.test(a)) && argv.includes("state=open"))
      ) {
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      // #2986 merge confirmation: this forge merges on the spot, so the probe
      // that follows the merge command reports a MERGED pull request. The probe
      // is a single-object read, so it arrives over REST (#3094).
      if (readsPull(argv)) {
        return {
          code: 0,
          stdout: JSON.stringify(
            restPullBody({
              state: "MERGED",
              mergedAt: "2026-08-01T00:00:00Z",
              mergeCommitOid: "abc1234",
              autoMerge: false,
              mergeStateStatus: "CLEAN",
              mergeable: "MERGEABLE",
            }),
          ),
          stderr: "",
        };
      }
      if (j.includes("pr view") && j.includes("mergeStateStatus")) {
        const map = {
          merge: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", baseRefOid: "0r1g1nsha", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }] },
          skipped: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", baseRefOid: "0r1g1nsha", statusCheckRollup: [{ name: "ci", conclusion: "SKIPPED" }] },
        } as const;
        return { code: 0, stdout: JSON.stringify(map[opts.ciAware ?? "merge"]), stderr: "" };
      }
      // Inject a land failure on the admin merge.
      if (opts.landFail && (j.includes("pr merge") || /pulls\/\d+\/merge/.test(j))) {
        return { code: 1, stdout: "", stderr: "merge rejected" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    remoteGit: async (argv) => {
      if (argv.includes("--delete")) trace.deletedRemote.push(argv);
      else trace.pushedAttempt.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
    pnpm: async (args) => {
      trace.pnpmCalls += 1;
      trace.pnpmArgs.push([...args]);
      // AFK runner improvement: reconcile now passes the base as
      // `baselineWorktree` to `runFeedback`. The baseline probe always
      // returns success in this harness (it isn't modelling pre-existing
      // main failures) so a worker-failure test still sees
      // feedback-failed and isn't accidentally downgraded.
      const cIdx = Array.isArray(args) ? args.indexOf("-C") : -1;
      const dir = cIdx >= 0 ? (args[cIdx + 1] ?? "") : "";
      if (dir === "main" || dir.startsWith("main/")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (dir === "/rwt") {
        return { code: opts.postMergeFeedbackOk === false ? 1 : 0, stdout: "", stderr: "merged boom\n" };
      }
      return { code: opts.feedbackOk === false ? 1 : 0, stdout: "", stderr: "boom\n" };
    },
    layout: {
      hasPackage: (scope) => (opts.packageScopes ? opts.packageScopes.includes(scope) : scope === "."),
      hasScript: () => true,
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
    fireHook: async (name) => {
      trace.firedHooks.push(name);
      return true;
    },
    makeRebaseWorktree: async () => "/rwt",
    removeRebaseWorktree: async () => {},
    nowEpoch: () => (nowEpoch += 1000),
    appendIterLog: (line) => {
      trace.iterLogs.push(line);
    },
    markStage: async (stage) => {
      trace.stageMarks.push(stage);
    },
  };

  const input: ReconcileInput = {
    issue: 9,
    title: "Fix the thing",
    body: opts.body ?? "## Agent brief\nDo it.",
    labels: opts.labels ?? ["running", "type:feature"],
    branch: "afk/wAAAA/9-fix-the-thing",
    base: "main",
    trunk: "main",
    repo: "o/r",
    repoDir: "/repo",
    remote: "origin",
    workerId: "wAAAA",
    attempt: 1,
    attemptDir: "/tmp/afk/workers/wAAAA/9-a1",
    runner: "claude",
  };

  if (opts.ciAware) {
    deps.ciAwait = { github: githubMergeReadFromExec(deps.mergeExec), sleep: async () => {}, maxPolls: 2 };
  }
  return { deps, input, trace };
}

describe("reconcile — green → land", () => {
  it("validates the branch green and lands it, closing the issue without re-running the agent", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, ciAware: "merge" });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
    if (result.outcome === "landed") {
      expect(result.mergeSha).toBe("abc1234");
      expect(result.locked).toBe(false);
      expect(result.posted).toBe(true);
    }
    // The feedback gate ran before landing; fresh PR CI satisfied the post-merge validation lane.
    expect(trace.pnpmCalls).toBe(4);
    expect(trace.sidecarWrites.at(-1)?.lines.some((line) => line.includes("post-merge:satisfied-by-ci"))).toBe(true);
    // Landed → issue closed, remote + local branch removed, attempt dir swept.
    expect(trace.closed).toEqual([9]);
    expect(trace.deletedRemote.length).toBe(1);
    expect(trace.deletedLocalBranches).toEqual(["afk/wAAAA/9-fix-the-thing"]);
    expect(trace.swept).toEqual([9]);
    // Done envelope posted.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    // Routing labels shed (running dropped); the domain label is left untouched.
    const close = trace.labelEdits.at(-1)!;
    expect(close.remove).toEqual(["running"]);
    expect(close.add).toEqual([]);
    // The landing fired the merge hooks via the injected fireHook.
    expect(trace.firedHooks).toEqual(["pre_merge", "post_merge"]);
    expect(trace.iterLogs.some((line) => line.includes("validating fetched `origin/afk/wAAAA/9-fix-the-thing` tip `feedfacecafe`"))).toBe(true);
    expect(trace.iterLogs.some((line) => line.includes("tip `feedfacecafe` validated green and landed"))).toBe(true);
  });

  it("passes issue labels into the no-agent landing so the merge subject is releasable", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, labels: ["running", "type:bug"] });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
    // The write-plan realizes the default merge on REST (#3663).
    expect(trace.mergeCalls.map((c) => c.join(" "))).toContain(
      "gh api -X PUT repos/o/r/pulls/42/merge -f merge_method=merge -f commit_title=fix: #9 Fix the thing",
    );
  });

  it("resolves feedback scopes from origin/<base>, not a stale local base", async () => {
    const { deps, input, trace } = harness({
      feedbackOk: true,
      packageScopes: ["packages/stale", "packages/fresh"],
      changedFilesByBase: {
        main: ["packages/stale/src/old.ts"],
        "origin/main": ["packages/fresh/src/new.ts"],
      },
    });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
    expect(trace.changedFileCalls).toEqual([
      { branch: "afk/wAAAA/9-fix-the-thing", base: "origin/main" },
    ]);
    const pnpmDirs = trace.pnpmArgs
      .map((args) => {
        const idx = args.indexOf("-C");
        return idx >= 0 ? args[idx + 1] : undefined;
      })
      .filter(Boolean);
    expect(pnpmDirs).toContain("afk/wAAAA/9-fix-the-thing/packages/fresh");
    expect(pnpmDirs).not.toContain("afk/wAAAA/9-fix-the-thing/packages/stale");
  });

  it("trusts prior green (#1095) before landing, then revalidates the integrated tree in the land-lock", async () => {
    const { deps, input, trace } = harness({
      // feedbackOk left unset — the gate must NOT run at all on this path.
      labels: ["ready-for-human", "blocked:merge-conflict", "priority:high"],
    });
    const result = await reconcile(deps, { ...input, trustPriorValidation: true });

    expect(result.outcome).toBe("landed");
    // The pre-land scoped feedback gate was skipped, but the integrated tree was revalidated.
    expect(trace.pnpmCalls).toBe(4);
    // Still lands + closes + sheds the merge-conflict blocked label.
    expect(trace.closed).toEqual([9]);
    const close = trace.labelEdits.at(-1)!;
    expect(close.remove).toEqual(["ready-for-human", "blocked:merge-conflict"]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
  });

  it("falls back to local post-merge validation when CI evidence is skipped", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, ciAware: "skipped" });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
    expect(trace.pnpmCalls).toBe(8);
    expect(trace.sidecarWrites.at(-1)?.lines.some((line) => line.includes("post-merge:local-rerun"))).toBe(true);
  });

  it("parks a trusted reland as VALIDATION when the in-lock integrated-tree gate fails (#2864)", async () => {
    const { deps, input, trace } = harness({
      labels: ["ready-for-human", "blocked:merge-conflict", "priority:high"],
      postMergeFeedbackOk: false,
    });
    const result = await reconcile(deps, { ...input, trustPriorValidation: true });

    // The rebase that precedes the gate SUCCEEDED — nothing conflicted, so the
    // park names the gate that failed instead of re-asserting a conflict.
    expect(result).toEqual({ outcome: "parked", reason: "feedback-failed", posted: true });
    expect(trace.pnpmCalls).toBe(8);
    expect(trace.closed).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.ensuredLabels).toContain("blocked:validation");
    expect(trace.labelEdits.at(-1)!.add).toContain("blocked:validation");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
  });

  it("lands a PARKED issue, shedding ready-for-human + the mechanical blocked label", async () => {
    const { deps, input, trace } = harness({
      feedbackOk: true,
      labels: ["ready-for-human", "blocked:stalled", "priority:high"],
    });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
    const close = trace.labelEdits.at(-1)!;
    // Both routing/blocked labels shed; the domain label survives.
    expect(close.remove).toEqual(["ready-for-human", "blocked:stalled"]);
    expect(close.add).toEqual([]);
    expect(trace.closed).toEqual([9]);
  });

  it("runs the close cascade, unblocking a dependent whose reqs are now all closed", async () => {
    const { deps, input, trace } = harness({
      feedbackOk: true,
      dependentsByLabel: { "req:9": [{ number: 12, labels: ["blocked:dependency", "req:9"] }] },
    });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
    expect(trace.listByLabelCalls).toContain("req:9");
    // The dependent (#12) is promoted: blocked:dependency → ready-for-agent.
    const promote = trace.labelEdits.find((e) => e.issue === 12);
    expect(promote).toEqual({ issue: 12, remove: ["blocked:dependency", "req:9"], add: ["ready-for-agent"] });
  });
});

describe("reconcile — red → park", () => {
  it("parks to ready-for-human with the real failing checks, never landing", async () => {
    const { deps, input, trace } = harness({ feedbackOk: false });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("parked");
    if (result.outcome === "parked") expect(result.reason).toBe("feedback-failed");
    // NOT landed: no close, no remote delete.
    expect(trace.closed).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
    // Parked to ready-for-human + blocked:validation (the now-known reason).
    expect(trace.ensuredLabels).toContain("blocked:validation");
    const park = trace.labelEdits.at(-1)!;
    expect(park.add).toContain("ready-for-human");
    expect(park.add).toContain("blocked:validation");
    // A comment carries the failing checks for the human page.
    expect(trace.comments.some((c) => c.body.includes("validation FAILED"))).toBe(true);
    // The failure envelope rides the generic `blocked` status bucket.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
  });

  it("parks as a merge-conflict when the rebase GENUINELY conflicts, naming the paths (#2864)", async () => {
    const { deps, input, trace } = harness({
      feedbackOk: true,
      rebaseConflict: ["src/a.ts", "src/b.ts"],
    });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("parked");
    if (result.outcome === "parked") expect(result.reason).toBe("merge-conflict");
    expect(trace.closed).toEqual([]);
    expect(trace.ensuredLabels).toContain("blocked:merge-conflict");
    const park = trace.labelEdits.at(-1)!;
    expect(park.add).toContain("ready-for-human");
    expect(park.add).toContain("blocked:merge-conflict");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "merge-conflict" }]);
    // The summary names WHAT conflicts, so no human hunts for a phantom.
    expect(trace.iterLogs.some((line) => line.includes("in 2 file(s): src/a.ts, src/b.ts"))).toBe(true);
  });

  // #2864 — the defect: a rejected merge on a PR with zero conflicts and zero
  // failing checks was parked `blocked:merge-conflict`, sending a human to
  // resolve something that did not exist.
  it("parks a REJECTED merge on a mergeable PR as blocked:ci, never merge-conflict (#2864)", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, landFail: true });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("parked");
    if (result.outcome === "parked") expect(result.reason).toBe("ci-failed");
    expect(trace.closed).toEqual([]);
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    expect(trace.ensuredLabels).toContain("blocked:ci");
    const park = trace.labelEdits.at(-1)!;
    expect(park.add).toContain("ready-for-human");
    expect(park.add).toContain("blocked:ci");
    expect(park.add).not.toContain("blocked:merge-conflict");
    // Never a `merge-conflict` envelope on a PR that never conflicted.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
  });

  it("updates a merely-BEHIND branch and lands it instead of parking (#2864)", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, behindBase: true });
    const result = await reconcile(deps, input);

    // One `gh pr update-branch` — exactly what a human does — then it merges.
    expect(result.outcome).toBe("landed");
    expect(trace.mergeCalls.some((c) => /pr update-branch|pulls\/\d+\/update-branch/.test(c.join(" ")))).toBe(true);
    expect(trace.closed).toEqual([9]);
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
  });
});

describe("reconcile — presence stage progression (#1306)", () => {
  it("advances the caller's stage validate → land on a green landed reconcile", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
    expect(trace.stageMarks).toEqual(["validating", "landing"]);
  });

  it("stops at validating when the gate fails (never reaches landing)", async () => {
    const { deps, input, trace } = harness({ feedbackOk: false });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("parked");
    expect(trace.stageMarks).toEqual(["validating"]);
  });

  it("marks no stage for a skipped (non-mechanical) reconcile — the gate never runs", async () => {
    const { deps, input, trace } = harness({ labels: ["running", "blocked:spec"] });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("skipped");
    expect(trace.stageMarks).toEqual([]);
  });
});

describe("reconcile — pre-fetch safety push", () => {
  it("attempts a push before the fetch gate so local-only commits reach the remote", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true });
    await reconcile(deps, input);
    // The pre-fetch push uses pushAttempt (not --delete), so trace.pushedAttempt
    // must have at least one entry before the fetch gate runs.
    const pushes = trace.pushedAttempt.filter((a) => !a.includes("--delete"));
    expect(pushes.length).toBeGreaterThanOrEqual(1);
  });

  it("continues to the fetch gate even when the pre-fetch push fails", async () => {
    const { deps, input, trace } = harness({ branchPresent: false });
    // Override remoteGit to fail on the push attempt
    let callCount = 0;
    deps.remoteGit = async (argv) => {
      callCount++;
      if (!argv.includes("--delete")) trace.pushedAttempt.push(argv);
      return { code: 1, stdout: "", stderr: "auth failed" };
    };
    const result = await reconcile(deps, input);
    // Push was attempted (the pre-fetch safety step ran)
    expect(callCount).toBeGreaterThan(0);
    // Reconcile falls through to branch-absent (remote is still empty after failed push)
    expect(result).toEqual({ outcome: "skipped", reason: "branch-absent" });
  });
});

describe("reconcile — guards (mechanical class only)", () => {
  it("skips blocked:spec (a human-decision class) without touching the issue", async () => {
    const { deps, input, trace } = harness({
      feedbackOk: true,
      labels: ["ready-for-human", "blocked:spec"],
    });
    const result = await reconcile(deps, input);

    expect(result).toEqual({ outcome: "skipped", reason: "not-mechanical" });
    // No side effects at all — the caller owns the routing.
    expect(trace.labelEdits).toEqual([]);
    expect(trace.closed).toEqual([]);
    expect(trace.pnpmCalls).toBe(0);
  });

  it("skips blocked:validation (already a human-decision failure)", async () => {
    const { deps, input } = harness({ feedbackOk: true, labels: ["ready-for-human", "blocked:validation"] });
    const result = await reconcile(deps, input);
    expect(result).toEqual({ outcome: "skipped", reason: "not-mechanical" });
  });

  it("skips an active non-mechanical Current blocker (spec kind), even under a mechanical label", async () => {
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "spec",
      summary: "Need a product decision.",
      next: "Human must choose the API shape.",
    });
    const { deps, input, trace } = harness({ feedbackOk: true, labels: ["blocked:stalled"], body });
    const result = await reconcile(deps, input);

    expect(result).toEqual({ outcome: "skipped", reason: "active-blocker" });
    expect(trace.pnpmCalls).toBe(0);
  });

  it("ALLOWS a mechanical (stalled-kind) active Current blocker — the parked state it exists to clear", async () => {
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "stalled",
      summary: "No progress within the wall-clock guard.",
      next: "Review the pushed branch and decide.",
    });
    const { deps, input } = harness({ feedbackOk: true, labels: ["ready-for-human", "blocked:stalled"], body });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
  });

  it("skips when the branch carries no commits (nothing to land)", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, changedFiles: [] });
    const result = await reconcile(deps, input);

    expect(result).toEqual({ outcome: "skipped", reason: "no-commits" });
    expect(trace.pnpmCalls).toBe(0);
  });

  it("skips when the worker branch is absent on the host (cannot validate)", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, branchPresent: false });
    const result = await reconcile(deps, input);

    expect(result).toEqual({ outcome: "skipped", reason: "branch-absent" });
    expect(trace.pnpmCalls).toBe(0);
  });

  it("skips when the issue was closed since selection — does not land or close (#568)", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, closedIssues: [9] });
    const result = await reconcile(deps, input);

    expect(result).toEqual({ outcome: "skipped", reason: "already-closed" });
    // The re-check fires AFTER the green feedback gate but BEFORE landing, so the
    // already-closed thread is never landed, closed, or relabelled.
    expect(trace.closed).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.labelEdits).toEqual([]);
  });

  it("fetches an origin-only branch before the commits gate so it is not skipped as no-commits", async () => {
    // Simulate: branch exists on origin but not yet locally. Before branchPresent
    // (which fetches), changedFiles would return []. After the fetch it returns work.
    let fetched = false;
    const { deps, input } = harness({ feedbackOk: true });
    deps.lookups.changedFiles = async () => (fetched ? ["packages/x/src/a.ts"] : []);
    deps.lookups.branchPresent = async () => {
      fetched = true;
      return true;
    };

    const result = await reconcile(deps, input);

    // branchPresent ran first (fetching the branch), so changedFiles found work
    // and the issue was salvaged rather than skipped as no-commits.
    expect(result.outcome).toBe("landed");
  });
});

describe("mechanicalDisqualifier", () => {
  it("returns null for a clean mechanical state", () => {
    expect(mechanicalDisqualifier(["running"], "## body", DEFAULT_TRIAGE_LABELS)).toBeNull();
    expect(mechanicalDisqualifier(["ready-for-human", "blocked:stalled"], "## body", DEFAULT_TRIAGE_LABELS)).toBeNull();
    expect(mechanicalDisqualifier(["ready-for-human", "blocked:crashed"], "## body", DEFAULT_TRIAGE_LABELS)).toBeNull();
  });

  it("flags human-decision blocked labels", () => {
    expect(mechanicalDisqualifier(["blocked:spec"], "x", DEFAULT_TRIAGE_LABELS)).toBe("not-mechanical");
    expect(mechanicalDisqualifier(["blocked:validation"], "x", DEFAULT_TRIAGE_LABELS)).toBe("not-mechanical");
    expect(mechanicalDisqualifier(["blocked:dependency"], "x", DEFAULT_TRIAGE_LABELS)).toBe("not-mechanical");
    expect(mechanicalDisqualifier(["blocked:policy"], "x", DEFAULT_TRIAGE_LABELS)).toBe("not-mechanical");
    expect(mechanicalDisqualifier(["blocked:infra"], "x", DEFAULT_TRIAGE_LABELS)).toBe("not-mechanical");
  });

  it("flags an active non-mechanical Current blocker", () => {
    const body = upsertCurrentBlocker("body", {
      status: "blocked",
      kind: "validation",
      summary: "Tests fail and need a call.",
      next: "Human decides scope.",
    });
    expect(mechanicalDisqualifier(["blocked:stalled"], body, DEFAULT_TRIAGE_LABELS)).toBe("active-blocker");
  });
});

// ADR 0103: reconcile keeps ONE pre-fetch safety push — the inline `pushAttempt`
// that lifts LOCAL-ONLY COMMITS to origin. There is no exit barrier and no
// salvage: a dirty worktree is never commit-rescued on the way through.
describe("reconcile — pre-fetch safety push (ADR 0103)", () => {
  it("pushes local-only commits inline and never salvages a dirty worktree", async () => {
    // A parked (red) reconcile isolates the pre-fetch safety push — no landing push
    // muddies the trace.
    const { deps, input, trace } = harness({ feedbackOk: false });

    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("parked");
    const barePushes = trace.pushedAttempt.filter((argv) => !argv.includes("--delete"));
    expect(barePushes.length).toBeGreaterThanOrEqual(1);
    expect(trace.iterLogs.some((l) => l.includes("exit barrier"))).toBe(false);
    expect(trace.iterLogs.some((l) => l.includes("uncommitted file(s)"))).toBe(false);
  });
});

// #2864: `blocked:merge-conflict` is reserved for a branch that GENUINELY
// conflicts. This table is the whole contract — exactly one landing refusal
// reaches that label, and every other refusal names itself.
describe("routeLandingFailure — one landing refusal, one terminal (#2864)", () => {
  it("routes each refusal to the terminal that names it", () => {
    expect(routeLandingFailure("pr-conflict")).toBe("merge-conflict");
    expect(routeLandingFailure("ci-failed")).toBe("ci-failed");
    expect(routeLandingFailure("pr-merge-failed")).toBe("ci-failed");
    expect(routeLandingFailure("ci-pending")).toBe("ci-pending");
    expect(routeLandingFailure("post-merge-gate")).toBe("feedback-failed");
    expect(routeLandingFailure("pre_merge-abort")).toBe("hook-aborted");
    expect(routeLandingFailure("trunk-diverged")).toBe("trunk-diverged");
    expect(routeLandingFailure("land-failed")).toBe("infra");
    expect(routeLandingFailure("pr-resolved-abort")).toBe("infra");
    expect(routeLandingFailure("infra")).toBe("infra");
  });

  it("reaches merge-conflict from `pr-conflict` and from nothing else", () => {
    const reasons = [
      "pre_merge-abort",
      "integrate-failed",
      "land-failed",
      "ci-failed",
      "ci-pending",
      "pr-conflict",
      "pr-merge-failed",
      "infra",
      "pr-resolved-abort",
      "trunk-diverged",
      "post-merge-gate",
      "land-lock-timeout",
    ] as const;
    const conflictRoutes = reasons.filter((r) => routeLandingFailure(r) === "merge-conflict");
    expect(conflictRoutes).toEqual(["pr-conflict"]);
  });

  it("a land-lock timeout is a BACKOFF, so it parks nothing", () => {
    expect(routeLandingFailure("land-lock-timeout")).toBeNull();
  });

  it("every summary states what was observed, and never invents a conflict", () => {
    expect(landingRefusalSummary("merge-conflict", "conflicts with origin/main in 1 file(s): a.ts"))
      .toBe("conflicts with origin/main in 1 file(s): a.ts");
    expect(landingRefusalSummary("ci-failed")).toContain("rejected the merge");
    expect(landingRefusalSummary("ci-failed")).not.toContain("conflict");
    expect(landingRefusalSummary("ci-pending")).not.toContain("conflict");
    expect(landingRefusalSummary("feedback-failed", "ignored")).toContain("post-merge integration gate");
    expect(landingRefusalSummary("infra")).not.toContain("conflict");
  });
});
