import { describe, expect, it } from "vitest";
import {
  mechanicalDisqualifier,
  reconcile,
  type ReconcileDeps,
  type ReconcileInput,
} from "../src/core/reconcile.js";
import { upsertCurrentBlocker } from "../src/core/blocker-state.js";

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
  recordedOutcomes: string[];
  listByLabelCalls: string[];
  firedHooks: string[];
  pnpmCalls: number;
  /** Branches passed to the ADR 0083 §4 terminal exit barrier (#1021). */
  terminalBarrierCalls: string[];
}

interface HarnessOptions {
  labels?: string[];
  body?: string;
  /** Aggregate feedback gate verdict. Defaults to passing (green). */
  feedbackOk?: boolean;
  changedFiles?: string[];
  branchPresent?: boolean;
  locked?: boolean;
  /** When true, the unlocked `gh pr merge` returns non-zero (land fails). */
  landFail?: boolean;
  /** Close-cascade fixture: open dependents returned by gh.listByLabel(req:N). */
  dependentsByLabel?: Record<string, { number: number; labels: string[] }[]>;
  closedIssues?: number[];
  withSidecarPort?: boolean;
  recordAttempt?: boolean;
  /** When set, wire the ADR 0083 §4 `terminalExitBarrier` port (#1021): reconcile
   * uses it (not `pushAttempt`) for the pre-fetch safety push. The fake records
   * the branch and returns a receipt driven by these fields. */
  terminalBarrier?: { salvagedFiles?: number; pushed?: boolean };
}

function harness(opts: HarnessOptions = {}): {
  deps: ReconcileDeps;
  input: ReconcileInput;
  trace: Trace;
} {
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
    recordedOutcomes: [],
    listByLabelCalls: [],
    firedHooks: [],
    pnpmCalls: 0,
    terminalBarrierCalls: [],
  };

  const deps: ReconcileDeps = {
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
      async changedFiles() {
        return opts.changedFiles ?? ["packages/x/src/a.ts"];
      },
      async branchPresent() {
        return opts.branchPresent ?? true;
      },
      async isLocked() {
        return opts.locked ?? false;
      },
    },
    mergeExec: async (argv) => {
      const j = argv.join(" ");
      // landPr reuses an open PR via `gh pr list`; reply with a number.
      if (argv.includes("pr") && argv.includes("list")) {
        return { code: 0, stdout: "42\n", stderr: "" };
      }
      // Inject a land failure on the admin merge.
      if (opts.landFail && j.includes("pr merge")) {
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
      return { code: opts.feedbackOk === false ? 1 : 0, stdout: "", stderr: "boom\n" };
    },
    layout: {
      hasPackage: (scope) => scope === ".",
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
    nowEpoch: () => 1000,
    appendIterLog: () => {},
    recordAttempt: opts.recordAttempt
      ? async (payload) => {
          trace.recordedOutcomes.push(payload.status);
        }
      : undefined,
    terminalExitBarrier:
      opts.terminalBarrier === undefined
        ? undefined
        : async (branch) => {
            trace.terminalBarrierCalls.push(branch);
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

  return { deps, input, trace };
}

describe("reconcile — green → land", () => {
  it("validates the branch green and lands it, closing the issue without re-running the agent", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("landed");
    if (result.outcome === "landed") {
      expect(result.mergeSha).toBe("abc1234");
      expect(result.locked).toBe(false);
      expect(result.posted).toBe(true);
    }
    // The feedback gate ran (four scripts on the root scope).
    expect(trace.pnpmCalls).toBe(4);
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
  });

  it("trusts prior green (#1095): lands WITHOUT re-running the feedback gate", async () => {
    const { deps, input, trace } = harness({
      // feedbackOk left unset — the gate must NOT run at all on this path.
      labels: ["ready-for-human", "blocked:merge-conflict", "priority:high"],
    });
    const result = await reconcile(deps, { ...input, trustPriorValidation: true });

    expect(result.outcome).toBe("landed");
    // The scoped feedback gate was SKIPPED — zero pnpm invocations.
    expect(trace.pnpmCalls).toBe(0);
    // Still lands + closes + sheds the merge-conflict blocked label.
    expect(trace.closed).toEqual([9]);
    const close = trace.labelEdits.at(-1)!;
    expect(close.remove).toEqual(["ready-for-human", "blocked:merge-conflict"]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
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

  it("parks as a merge-conflict when the land path rejects the green branch", async () => {
    const { deps, input, trace } = harness({ feedbackOk: true, landFail: true });
    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("parked");
    if (result.outcome === "parked") expect(result.reason).toBe("merge-conflict");
    expect(trace.closed).toEqual([]);
    expect(trace.ensuredLabels).toContain("blocked:merge-conflict");
    const park = trace.labelEdits.at(-1)!;
    expect(park.add).toContain("ready-for-human");
    expect(park.add).toContain("blocked:merge-conflict");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "merge-conflict" }]);
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
    expect(mechanicalDisqualifier(["running"], "## body")).toBeNull();
    expect(mechanicalDisqualifier(["ready-for-human", "blocked:stalled"], "## body")).toBeNull();
    expect(mechanicalDisqualifier(["ready-for-human", "blocked:crashed"], "## body")).toBeNull();
  });

  it("flags human-decision blocked labels", () => {
    expect(mechanicalDisqualifier(["blocked:spec"], "x")).toBe("not-mechanical");
    expect(mechanicalDisqualifier(["blocked:validation"], "x")).toBe("not-mechanical");
    expect(mechanicalDisqualifier(["blocked:dependency"], "x")).toBe("not-mechanical");
    expect(mechanicalDisqualifier(["blocked:policy"], "x")).toBe("not-mechanical");
    expect(mechanicalDisqualifier(["blocked:infra"], "x")).toBe("not-mechanical");
  });

  it("flags an active non-mechanical Current blocker", () => {
    const body = upsertCurrentBlocker("body", {
      status: "blocked",
      kind: "validation",
      summary: "Tests fail and need a call.",
      next: "Human decides scope.",
    });
    expect(mechanicalDisqualifier(["blocked:stalled"], body)).toBe("active-blocker");
  });
});

// ADR 0083 §4 (#1021): the no-agent reconcile lane is a terminal path too — its
// branch-preservation write goes through the SAME exit barrier every other
// terminal path uses, replacing the inline `pushAttempt` pre-fetch safety push.
describe("reconcile — exit barrier crossing (#1021)", () => {
  it("crosses the barrier for the pre-fetch safety push and does NOT use the inline pushAttempt", async () => {
    // A parked (red) reconcile isolates the pre-fetch safety push — no landing push
    // muddies the trace. With the barrier wired, the safety push runs THROUGH the
    // barrier (branch recorded, salvage surfaced), and the inline `pushAttempt` is
    // never called — the barrier is reconcile's only branch-preservation writer.
    const { deps, input, trace } = harness({ feedbackOk: false, terminalBarrier: { salvagedFiles: 1, pushed: true } });

    const result = await reconcile(deps, input);

    expect(result.outcome).toBe("parked");
    // (1) barrier ran on the worker branch; (2) receipt confirms the push.
    expect(trace.terminalBarrierCalls).toEqual(["afk/wAAAA/9-fix-the-thing"]);
    // (3) no inline pushAttempt ran — no bare `push` reached remoteGit.
    const barePushes = trace.pushedAttempt.filter((argv) => !argv.includes("--delete"));
    expect(barePushes).toEqual([]);
  });

  it("falls back to the inline pushAttempt when no barrier is wired (legacy caller)", async () => {
    // Back-compat: a caller that has not wired the barrier keeps the original
    // `pushAttempt` pre-fetch safety push, so older wiring never regresses.
    const { deps, input, trace } = harness({ feedbackOk: false });

    await reconcile(deps, input);

    expect(trace.terminalBarrierCalls).toEqual([]);
    const barePushes = trace.pushedAttempt.filter((argv) => !argv.includes("--delete"));
    expect(barePushes.length).toBeGreaterThanOrEqual(1);
  });
});
