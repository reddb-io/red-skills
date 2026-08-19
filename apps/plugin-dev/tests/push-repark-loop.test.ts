// #3377 — the push/re-park chain that turned an orphaned origin tip into an
// eternal park loop (observed 2026-08-05 on #3335/#3336/#3343).
//
// Four seams compound into that loop, and each has its own contract here:
//   1. a claim-owned attempt branch reconciles a diverged remote tip instead of
//      failing, and a LOST lease still fails;
//   2. a rejected push and an unreachable remote park with DIFFERENT cures;
//   3. fresh requeue guidance is never evaporated by the no-agent fast path;
//   4. a second identical park inside the window escalates as a loop.

import { describe, expect, it } from "vitest";
import {
  classifyPushFailure,
  pushAttempt,
  pushAttemptForceWithLeaseArgs,
  type GitExec,
  type GitExecResult,
} from "../src/core/remote-branch.js";
import {
  applyCurrentBlockerEdit,
  makeBlocker,
  parseCurrentBlocker,
  type CurrentBlocker,
} from "../src/core/blocker-state.js";
import { blockerForFailure } from "../src/core/process-issue/terminal.js";
import { detectParkLoop, parkSignature, PARK_LOOP_WINDOW_S } from "../src/core/park-loop.js";
import { hasUnconsumedGuidance } from "../src/core/branch-resume.js";
import { doLanding } from "../src/core/landing.js";
import { harness } from "./landing.test-support.js";

const BRANCH = "afk/3335-a-module";
const LOCAL_TIP = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORPHAN_TIP = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NON_FF_STDERR = "! [rejected] main -> main (non-fast-forward)\nhint: Updates were rejected because the tip ...";
const ACCESS_STDERR = "remote: Permission to o/r.git denied to worker.\nfatal: unable to access 'https://…': 403";

/**
 * A GitExec whose plain push is rejected with `stderr`, whose remote answers
 * `remoteTip`, and whose leased re-push exits `leaseCode` (converging the remote
 * onto the local tip when it succeeds).
 */
function gitWithDivergedRemote(opts: {
  stderr: string;
  remoteTip: string;
  leaseCode?: number;
}): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  let remoteTip = opts.remoteTip;
  const git: GitExec = async (args): Promise<GitExecResult> => {
    calls.push(args);
    const j = args.join(" ");
    if (j.includes("ls-remote")) return { code: 0, stdout: `${remoteTip}\trefs/heads/${BRANCH}\n`, stderr: "" };
    if (j.includes("rev-parse")) return { code: 0, stdout: `${LOCAL_TIP}\n`, stderr: "" };
    if (j.includes("--force-with-lease")) {
      const code = opts.leaseCode ?? 0;
      if (code === 0) remoteTip = LOCAL_TIP;
      return { code, stdout: "", stderr: code === 0 ? "" : "! [rejected] (stale info)" };
    }
    return { code: 1, stdout: "", stderr: opts.stderr };
  };
  return { git, calls };
}

describe("#3377 — a claim-owned attempt branch reconciles a diverged remote tip", () => {
  it("re-pushes with --force-with-lease on the OBSERVED tip and reports pushed", async () => {
    const { git, calls } = gitWithDivergedRemote({ stderr: NON_FF_STDERR, remoteTip: ORPHAN_TIP });
    const result = await pushAttempt(git, "/repo", BRANCH, BRANCH, { claimHeld: true });

    expect(result.status).toBe("pushed");
    expect(result.ok).toBe(true);
    expect(result.warn).toContain("dead attempt");
    // The lease is pinned to the tip that was READ, not to a bare --force.
    const leased = calls.find((c) => c.join(" ").includes("--force-with-lease"));
    expect(leased).toEqual(pushAttemptForceWithLeaseArgs("/repo", BRANCH, BRANCH, ORPHAN_TIP));
    expect(calls.some((c) => c.includes("--force"))).toBe(false);
  });

  it("keeps a LOST lease a failure — a real race is never clobbered", async () => {
    const { git, calls } = gitWithDivergedRemote({ stderr: NON_FF_STDERR, remoteTip: ORPHAN_TIP, leaseCode: 1 });
    const result = await pushAttempt(git, "/repo", BRANCH, BRANCH, { claimHeld: true });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.warn).toContain("another writer holds this branch");
    expect(calls.filter((c) => c.join(" ").includes("--force-with-lease"))).toHaveLength(1);
  });

  it("never forces without the claim", async () => {
    const { git, calls } = gitWithDivergedRemote({ stderr: NON_FF_STDERR, remoteTip: ORPHAN_TIP });
    const result = await pushAttempt(git, "/repo", BRANCH, BRANCH);

    expect(result.ok).toBe(false);
    expect(result.warn).toContain("does not hold the issue claim");
    expect(calls.some((c) => c.join(" ").includes("force"))).toBe(false);
  });

  it("never forces outside the afk/* attempt namespace, claim or no claim", async () => {
    const { git, calls } = gitWithDivergedRemote({ stderr: NON_FF_STDERR, remoteTip: ORPHAN_TIP });
    const result = await pushAttempt(git, "/repo", "main", "main", { claimHeld: true });

    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("never forces an ACCESS failure — reconciliation is not the cure there", async () => {
    const { git, calls } = gitWithDivergedRemote({ stderr: ACCESS_STDERR, remoteTip: ORPHAN_TIP });
    const result = await pushAttempt(git, "/repo", BRANCH, BRANCH, { claimHeld: true });

    expect(result.ok).toBe(false);
    expect(result.warn).toContain("push access to the remote failed");
    expect(calls.some((c) => c.join(" ").includes("force"))).toBe(false);
  });

  it("classifies the two failure families, and refuses to guess a third", () => {
    expect(classifyPushFailure(NON_FF_STDERR)).toBe("non-fast-forward");
    expect(classifyPushFailure(ACCESS_STDERR)).toBe("access");
    // An access failure that also uses the word "rejected" is still access: the
    // cure a human is told to apply must match what actually broke.
    expect(classifyPushFailure("remote: Permission denied\n! [rejected] non-fast-forward")).toBe("access");
    expect(classifyPushFailure("")).toBe("unknown");
    expect(classifyPushFailure("fatal: something entirely new")).toBe("unknown");
  });

  it("converges the landing's gate push when the Worker holds the claim", async () => {
    const h = harness({
      openPr: true,
      pushAttemptCode: 1,
      pushAttemptStderr: NON_FF_STDERR,
      claimHeld: true,
      remoteTipSha: ORPHAN_TIP,
      remoteTipShaAfterLease: LOCAL_TIP,
      localTipSha: LOCAL_TIP,
    });
    const result = await doLanding(h.deps, h.input, h.hooks);

    expect(result.ok).toBe(true);
    expect(h.pushedAttempt.some((c) => c.join(" ").includes("--force-with-lease"))).toBe(true);
  });

  it("parks the same landing when the Worker does NOT hold the claim", async () => {
    const h = harness({
      openPr: true,
      pushAttemptCode: 1,
      pushAttemptStderr: NON_FF_STDERR,
      remoteTipSha: ORPHAN_TIP,
      localTipSha: LOCAL_TIP,
    });
    const result = await doLanding(h.deps, h.input, h.hooks);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("infra");
    expect(h.pushedAttempt.some((c) => c.join(" ").includes("force"))).toBe(false);
  });
});

describe("#3377 — a push park names the cause that actually broke", () => {
  /** The landing's own infraReason text for a push that reached nothing. */
  const landingSummary = (warn: string): string =>
    `worker branch push failed: ${warn} — the branch is not on origin at its local tip, so nothing was merged`;

  it("prescribes MECHANICAL reconciliation for a non-fast-forward rejection", () => {
    const blocker = blockerForFailure("infra", {
      log: landingSummary(
        `failed to push attempt branch to origin/${BRANCH} — the remote tip diverged (non-fast-forward) and the ` +
          "leased reconciliation did not converge; another writer holds this branch, so nothing was force-pushed",
      ),
    });
    expect(blocker?.kind).toBe("push-rejected");
    expect(blocker?.next).toMatch(/reconcile the diverged remote tip/i);
    // The exact sentence that misdiagnosed the 2026-08-05 incident.
    expect(blocker?.next).not.toMatch(/restore push access/i);
  });

  it("still prescribes restoring ACCESS when access is what failed", () => {
    const blocker = blockerForFailure("infra", {
      log: landingSummary(
        `failed to push attempt branch to origin/${BRANCH} — push access to the remote failed (auth/network), ` +
          "so nothing reached origin",
      ),
    });
    expect(blocker?.kind).toBe("push-failed");
    expect(blocker?.next).toMatch(/restore push access/i);
    expect(blocker?.next).not.toMatch(/reconcile the diverged remote tip/i);
  });

  it("derives the cure from the cause even when a call site proposes the wrong one", () => {
    const blocker = makeBlocker({
      kind: "push-failed",
      summary: "the push was rejected non-fast-forward; origin carries a tip this Worker never wrote",
      next: "Restore push access to the worker branch's remote, then requeue.",
    });
    expect(blocker.kind).toBe("push-rejected");
    expect(blocker.next).toMatch(/reconcile the diverged remote tip/i);
  });
});

describe("#3377 — requeue guidance survives the adopt fast-path", () => {
  const envelope = (n: number): string => `<details data-attempt-status="blocked">\n<summary>Attempt ${n}</summary>\n</details>`;
  const guidance = (text: string): string =>
    `<details data-kind="directive">\n<summary>Requeue</summary>\n\nHuman guidance:\n${text}\n</details>`;

  it("reports guidance posted after the last envelope as unconsumed", () => {
    expect(
      hasUnconsumedGuidance([
        { body: envelope(1), sourceTrust: "trusted" },
        { body: guidance("force-push the branch"), sourceTrust: "trusted" },
      ]),
    ).toBe(true);
  });

  it("reports guidance a Worker already reported against as consumed", () => {
    expect(
      hasUnconsumedGuidance([
        { body: guidance("force-push the branch"), sourceTrust: "trusted" },
        { body: envelope(1), sourceTrust: "trusted" },
      ]),
    ).toBe(false);
  });

  it("never promotes an UNTRUSTED directive into a fast-path refusal", () => {
    expect(
      hasUnconsumedGuidance([
        { body: envelope(1), sourceTrust: "trusted" },
        { body: guidance("do a thing"), sourceTrust: "automation" },
      ]),
    ).toBe(false);
  });

  it("is silent on a thread with no guidance at all", () => {
    expect(hasUnconsumedGuidance([{ body: envelope(1) }, { body: "just talking" }])).toBe(false);
    expect(hasUnconsumedGuidance([])).toBe(false);
  });
});

describe("#3377 — an identical park inside the window is a loop, not a retry", () => {
  const parked = (fields: Partial<CurrentBlocker> = {}): CurrentBlocker => ({
    status: "blocked",
    kind: "push-rejected",
    summary: "worker branch push failed — the remote tip diverged (non-fast-forward)",
    next: "Reconcile the diverged remote tip.",
    parkedAtEpoch: 1_000_000,
    ...fields,
  });

  it("escalates the second identical park", () => {
    const verdict = detectParkLoop({
      previous: parked(),
      next: parked(),
      nowEpoch: 1_000_000 + 600,
    });
    expect(verdict.loop).toBe(true);
    expect(verdict.elapsedS).toBe(600);
    expect(verdict.note).toMatch(/re-park loop detected/i);
    expect(verdict.note).toMatch(/automatic re-queue is withheld/i);
  });

  it("lets a DIFFERENT blocker through — a new park is progress", () => {
    expect(
      detectParkLoop({
        previous: parked(),
        next: parked({ kind: "validation", summary: "the gate failed" }),
        nowEpoch: 1_000_000 + 60,
      }).loop,
    ).toBe(false);
  });

  it("lets an identical park OUTSIDE the window through — that is a stale issue, not a loop", () => {
    expect(
      detectParkLoop({
        previous: parked(),
        next: parked(),
        nowEpoch: 1_000_000 + PARK_LOOP_WINDOW_S + 1,
      }).loop,
    ).toBe(false);
  });

  it("never fires on a first park, an unstamped record, or a clock that runs backwards", () => {
    expect(detectParkLoop({ previous: null, next: parked(), nowEpoch: 1_000_000 }).loop).toBe(false);
    expect(
      detectParkLoop({
        previous: parked({ parkedAtEpoch: undefined }),
        next: parked(),
        nowEpoch: 1_000_000,
      }).loop,
    ).toBe(false);
    expect(detectParkLoop({ previous: parked(), next: parked(), nowEpoch: 999_000 }).loop).toBe(false);
  });

  it("compares kind and summary only — a moved ref must not hide a loop", () => {
    expect(parkSignature(parked())).toBe(parkSignature(parked({ ref: "afk/3335-other", next: "something else" })));
  });

  it("round-trips the park stamp and the loop note through the issue body", () => {
    const blocker = parked({ loopNote: "re-park loop detected — identical blocker 10m ago." });
    const { body, valid } = applyCurrentBlockerEdit("## Current blocker\n\nNone\n", blocker);
    expect(valid).toBe(true);
    const reparsed = parseCurrentBlocker(body);
    expect(reparsed?.parkedAtEpoch).toBe(1_000_000);
    expect(reparsed?.loopNote).toMatch(/re-park loop detected/);
  });

  it("treats a malformed stamp as NO stamp rather than as epoch zero", () => {
    const reparsed = parseCurrentBlocker(
      "<!-- red:blocker-state v1 -->\nstatus: blocked\nkind: infra\nsummary: s\nnext: n\nparked_at: nonsense\n<!-- /red:blocker-state -->",
    );
    expect(reparsed?.parkedAtEpoch).toBeUndefined();
  });
});
