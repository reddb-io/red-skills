// #2811 — a successful branch push recorded as a failed push, labelled
// merge-conflict, with a next-action naming a conflict that does not exist, and
// 624 committed lines left invisible on the tracker.
//
// Four defects compound in that record, and each has its own contract here:
//   1. a push that reached origin must never be recorded as a failed push;
//   2. a push that did NOT reach origin must be classified as a push failure,
//      never as a merge conflict;
//   3. a blocker's kind and its summary must not be able to contradict;
//   4. the recorded next-action must apply to the recorded cause.
// The fifth — committed work that reaches the remote is visible on the tracker
// — is asserted against the park path that stranded it.

import { describe, expect, it } from "vitest";
import {
  pushAttempt,
  verifyPushed,
  type GitExec,
  type GitExecResult,
} from "../src/core/remote-branch.js";
import {
  blockerIsSelfConsistent,
  makeBlocker,
  reconcileBlockerKind,
} from "../src/core/blocker-state.js";
import { blockerForFailure, ensureRemoteWorkVisible, type StageCommon } from "../src/core/process-issue/terminal.js";
import { doLanding } from "../src/core/landing.js";
import { harness } from "./landing.test-support.js";

const BRANCH = "afk/2779-a-module";
const TIP = "30373add9fe1c0de0000000000000000deadbeef";

/** GitExec whose push exits non-zero while the remote answers `remoteTip`. */
function gitWithRejectedPush(remoteTip: string, localTip: string = TIP): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitExec = async (args): Promise<GitExecResult> => {
    calls.push(args);
    const j = args.join(" ");
    if (j.includes("ls-remote")) {
      return { code: remoteTip ? 0 : 2, stdout: remoteTip ? `${remoteTip}\trefs/heads/${BRANCH}\n` : "", stderr: "" };
    }
    if (j.includes("rev-parse")) {
      return { code: localTip ? 0 : 1, stdout: localTip ? `${localTip}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "! [rejected] (stale info)\n" };
  };
  return { git, calls };
}

describe("#2811 — a successful push is never recorded as a failed push", () => {
  it("verifies the remote ref before believing a non-zero push, and reports `pushed`", async () => {
    // The exact #2779 shape: the branch is on origin at the pushed sha the whole
    // time, and the push exec still exits non-zero (a concurrent post-commit
    // hook push had already put it there).
    const { git, calls } = gitWithRejectedPush(TIP);
    const result = await pushAttempt(git, "/repo", BRANCH, BRANCH);

    expect(result.status).toBe("pushed");
    expect(result.ok).toBe(true);
    expect(result.warn).toContain("the push succeeded");
    // The verification is a ref read, not a guess.
    expect(calls.some((c) => c.join(" ").includes("ls-remote origin refs/heads/" + BRANCH))).toBe(true);
  });

  it("distinguishes did-not-run from ran-and-failed from ran-and-succeeded", async () => {
    const ok: GitExec = async () => ({ code: 0, stdout: "", stderr: "" });
    expect((await pushAttempt(ok, "/repo", BRANCH, BRANCH)).status).toBe("pushed");
    expect((await pushAttempt(ok, "/repo", "", BRANCH)).status).toBe("skipped");
    expect((await pushAttempt(ok, "/repo", "not-a-live-ref", BRANCH)).status).toBe("skipped");
    // ran and genuinely failed: the remote carries a DIFFERENT sha.
    const { git } = gitWithRejectedPush("0000000000000000000000000000000000000000");
    expect((await pushAttempt(git, "/repo", BRANCH, BRANCH)).status).toBe("failed");
  });

  it("only ever upgrades a failure to a success on positive evidence", async () => {
    // Remote ref missing entirely, and local ref unresolvable — neither may be
    // read as proof that the work is safely on origin.
    const missingRemote = gitWithRejectedPush("");
    expect((await pushAttempt(missingRemote.git, "/repo", BRANCH, BRANCH)).ok).toBe(false);
    const noLocal = gitWithRejectedPush(TIP, "");
    expect((await pushAttempt(noLocal.git, "/repo", BRANCH, BRANCH)).ok).toBe(false);
    const throwing: GitExec = async () => {
      throw new Error("git unavailable");
    };
    expect((await verifyPushed(throwing, "/repo", BRANCH, BRANCH)).pushed).toBe(false);
  });
});

describe("#2811 — a genuine push failure is classified as a push failure, not a merge conflict", () => {
  it("routes a push that never reached origin to `infra`, and never to the merge-conflict terminal", async () => {
    const h = harness({
      openPr: true,
      pushAttemptCode: 1,
      remoteTipSha: "0000000000000000000000000000000000000000",
      localTipSha: TIP,
    });
    const result = await doLanding(h.deps, h.input, h.hooks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `land-failed` funnels into the merge-conflict terminal — the exact path
    // that produced `kind: merge-conflict` for a push failure.
    expect(result.reason).not.toBe("land-failed");
    expect(result.reason).toBe("infra");
    expect(result.infraReason).toContain("push failed");
    expect(result.infraReason).not.toMatch(/merge conflict/i);
  });

  it("narrates a push that never ran as not-run, not as a failure", async () => {
    const h = harness({ openPr: true });
    // A malformed branch skips the git call entirely.
    const result = await doLanding(h.deps, { ...h.input, branch: "not-a-live-ref" }, h.hooks);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("infra");
    expect(result.infraReason).toContain("did not run");
  });

  it("lands normally when the non-zero push is proven to have reached origin", async () => {
    const h = harness({ openPr: true, pushAttemptCode: 1, remoteTipSha: TIP, localTipSha: TIP });
    const result = await doLanding(h.deps, h.input, h.hooks);
    // The #2779 recovery — a PR from the existing branch, no code change — is
    // exactly what the landing now does on its own instead of parking.
    expect(result.ok).toBe(true);
  });
});

describe("#2811 — a blocker's kind and summary cannot contradict", () => {
  const PUSH_SUMMARY =
    "land-failed — worker branch push failed: failed to push attempt branch to origin/afk/2779-x — " +
    "nothing was merged; the true cause is the push, not a merge conflict";

  it("refuses to record merge-conflict under a summary that names the push as the cause", () => {
    const blocker = makeBlocker({
      kind: "merge-conflict",
      summary: PUSH_SUMMARY,
      next: "Resolve the merge conflict or add guidance for the next agent attempt.",
    });
    expect(blocker.kind).toBe("push-failed");
    expect(blockerIsSelfConsistent(blocker)).toBe(true);
  });

  it("drops a kind its summary refutes even when no replacement cause is named", () => {
    expect(reconcileBlockerKind("merge-conflict", "the branch merges cleanly; nothing to resolve")).toBe(
      "unclassified",
    );
    expect(reconcileBlockerKind("merge-conflict", "Worker branch could not be merged cleanly.")).toBe(
      "merge-conflict",
    );
  });

  it("flags the historical #2811 record as self-inconsistent", () => {
    expect(
      blockerIsSelfConsistent({
        status: "blocked",
        kind: "merge-conflict",
        summary: PUSH_SUMMARY,
        next: "Resolve the merge conflict or add guidance for the next agent attempt.",
      }),
    ).toBe(false);
  });

  it("keeps every blockerForFailure outcome self-consistent", () => {
    const outcomes = [
      "blocked",
      "feedback-failed",
      "feedback-failed-infra",
      "no-sentinel",
      "host-config",
      "stalled",
      "budget-exceeded",
      "merge-conflict",
      "ci-failed",
      "ci-pending",
      "trunk-diverged",
      "base-stale",
      "infra",
    ] as const;
    for (const outcome of outcomes) {
      const blocker = blockerForFailure(outcome, { log: PUSH_SUMMARY, notes: PUSH_SUMMARY, validation: PUSH_SUMMARY });
      expect(blocker, outcome).not.toBeNull();
      expect(blockerIsSelfConsistent(blocker!), `${outcome}: ${JSON.stringify(blocker)}`).toBe(true);
    }
  });
});

describe("#2811 — the next-action applies to the recorded cause", () => {
  it("never prescribes resolving a merge conflict on a non-conflict kind", () => {
    const blocker = blockerForFailure("merge-conflict", {
      log: "worker branch push failed — the true cause is the push, not a merge conflict",
    });
    expect(blocker?.kind).toBe("push-failed");
    expect(blocker?.next).not.toMatch(/resolve the merge conflict/i);
    expect(blocker?.next).toMatch(/push/i);
  });

  it("derives the next-action from the reconciled kind, not from the call site", () => {
    const withWrongNext = makeBlocker({
      kind: "push-failed",
      summary: "worker branch push failed",
      next: "Resolve the merge conflict or add guidance for the next agent attempt.",
    });
    expect(withWrongNext.next).not.toMatch(/resolve the merge conflict/i);
    expect(blockerIsSelfConsistent(withWrongNext)).toBe(true);
  });

  it("keeps a real merge conflict pointing at conflict resolution", () => {
    const blocker = blockerForFailure("merge-conflict", { log: "Worker branch could not be merged cleanly." });
    expect(blocker?.kind).toBe("merge-conflict");
    expect(blocker?.next).toMatch(/resolve the merge conflict/i);
  });
});

describe("#2811 — work that reaches the remote is visible on the tracker", () => {
  function stage(opts: { ahead: string; prExists?: boolean }): {
    c: StageCommon;
    calls: string[][];
  } {
    const calls: string[][] = [];
    let created = opts.prExists ?? false;
    const c = {
      deps: {
        mergeExec: async (argv: string[]) => {
          calls.push([...argv]);
          const j = argv.join(" ");
          if (j.includes("rev-list") && j.includes("--count")) {
            return { code: 0, stdout: `${opts.ahead}\n`, stderr: "" };
          }
          if ((argv.includes("pr") && argv.includes("create")) || (argv.includes("POST") && argv.some((a) => /repos\/.+\/pulls$/.test(a)))) {
            created = true;
            return { code: 0, stdout: "", stderr: "" };
          }
          if (
            (argv.includes("pr") && argv.includes("list"))
            || (argv.includes("api") && argv.some((a) => /repos\/.+\/pulls$/.test(a)) && argv.includes("state=open"))
          ) {
            return { code: 0, stdout: created ? "77\n" : "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      input: { repo: "o/r", repoDir: "/repo", issue: 2779, title: "A module" },
      branch: BRANCH,
      base: "main",
    } as unknown as StageCommon;
    return { c, calls };
  }

  it("opens a PR for a parked branch that carries commits on origin", async () => {
    const { c, calls } = stage({ ahead: "1" });
    await expect(ensureRemoteWorkVisible(c)).resolves.toBe(77);
    expect(calls.some((a) => (a.includes("pr") && a.includes("create")) || (a.includes("POST") && a.some((x) => /repos\/.+\/pulls$/.test(x))))).toBe(true);
  });

  it("reuses the existing PR rather than minting a duplicate", async () => {
    const { c, calls } = stage({ ahead: "1", prExists: true });
    await expect(ensureRemoteWorkVisible(c)).resolves.toBe(77);
    expect(calls.some((a) => (a.includes("pr") && a.includes("create")) || (a.includes("POST") && a.some((x) => /repos\/.+\/pulls$/.test(x))))).toBe(false);
  });

  it("opens nothing when the remote branch carries no commits", async () => {
    const { c, calls } = stage({ ahead: "0" });
    await expect(ensureRemoteWorkVisible(c)).resolves.toBeUndefined();
    expect(calls.some((a) => (a.includes("pr") && a.includes("create")) || (a.includes("POST") && a.some((x) => /repos\/.+\/pulls$/.test(x))))).toBe(false);
  });
});
