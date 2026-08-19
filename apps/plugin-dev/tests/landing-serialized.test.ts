import { describe, expect, it } from "vitest";
import { WT, createFileLandLock, doLanding, harness, joined, type Harness, type LandLock, type LandLockDeps, type LandLockFs } from "./landing.test-support.js";
import { readsPull } from "./support/gh-rest-fixtures.js";

// ---------------------------------------------------------------------------
// Serialized landing (#1337). Two near-simultaneous workers used to race on the
// land: A pushes, B's push is rejected as a non-fast-forward, B re-integrates,
// and overlapping diffs conflict. The land is now a critical section — entered
// under the forge's native merge queue when `<base>` has one, else under the
// global land-lock. These tests drive the REAL createFileLandLock over an
// in-memory lock file, so what is asserted is the integration, not a mock.
// ---------------------------------------------------------------------------

/** In-memory `LandLockFs` with O_EXCL semantics, shared by both concurrent lands. */
function memLockFs(): LandLockFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async createExclusive(path, contents) {
      if (files.has(path)) return false;
      files.set(path, contents);
      return true;
    },
    async read(path) {
      return files.get(path) ?? null;
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

/** A land-lock that always times out — models an incumbent holding it past the wait. */
const timedOutLock: LandLock = { acquire: async () => null };

/** A land-lock that records every enter/exit into a shared trace. */
function tracingLock(trace: string[], name: string, inner: LandLock): LandLock {
  return {
    async acquire() {
      const release = await inner.acquire();
      if (!release) return null;
      trace.push(`enter:${name}`);
      return async () => {
        trace.push(`exit:${name}`);
        await release();
      };
    },
  };
}

/** Wrap a harness's mergeExec so every push to the remote base lands in `trace`. */
function traceBasePushes(h: Harness, trace: string[], name: string): void {
  const inner = h.deps.mergeExec;
  h.deps.mergeExec = async (args: string[]) => {
    if (args.join(" ").includes("push origin HEAD:refs/heads/main")) trace.push(`push:${name}`);
    return inner(args);
  };
}

describe("doLanding — serialized landing (#1337)", () => {
  it("two concurrent direct lands serialize: the second never pushes before the first releases", async () => {
    const fs = memLockFs();
    const clock = { t: 0 };
    const deps: LandLockDeps = {
      fs,
      clock: {
        now: () => clock.t,
        // Advance the fake clock, but yield the microtask queue so the OTHER land
        // actually makes progress while this one polls — real concurrency, not a stub.
        sleep: async (ms) => {
          clock.t += ms;
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      },
      isHolderAlive: () => true,
    };
    const trace: string[] = [];
    const lockFor = (name: string, pid: number) =>
      tracingLock(trace, name, createFileLandLock(deps, { path: "/afk-land.lock", holder: name, pid, pollMs: 5 }));

    const a = harness({ locked: true, openPr: false, landLock: lockFor("A", 100) });
    const b = harness({ locked: true, openPr: false, landLock: lockFor("B", 200) });
    traceBasePushes(a, trace, "A");
    traceBasePushes(b, trace, "B");

    const [ra, rb] = await Promise.all([doLanding(a.deps, a.input, a.hooks), doLanding(b.deps, b.input, b.hooks)]);

    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    // The whole point: no `push:B` between `enter:A` and `exit:A`.
    expect(trace).toEqual(["enter:A", "push:A", "exit:A", "enter:B", "push:B", "exit:B"]);
    // …and B got that order by WAITING on a contended lock, not by luck of
    // scheduling: an uncontended acquire never polls, so the clock never advances.
    expect(clock.t).toBeGreaterThan(0);
    // The lock file is left clean for the next worker.
    expect(fs.files.size).toBe(0);
  });

  it("land-lock wait timeout → land-lock-timeout result, nothing pushed to the remote base", async () => {
    const h = harness({ locked: true, openPr: false, landLock: timedOutLock });

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({ ok: false, reason: "land-lock-timeout", locked: true });
    // Refusing to serialize means refusing to land — never an unserialized push.
    expect(joined(h.mergeCalls).some((c) => c.includes("push origin HEAD:refs/heads/main"))).toBe(false);
    // No landing worktree was even provisioned.
    expect(h.removedWorktrees).toEqual([]);
  });

  it("releases the land-lock when the landing fails inside the critical section", async () => {
    const fs = memLockFs();
    const deps: LandLockDeps = {
      fs,
      clock: { now: () => 0, sleep: async () => {} },
      isHolderAlive: () => true,
    };
    const lock = createFileLandLock(deps, { path: "/afk-land.lock", holder: "A", pid: 100 });
    const h = harness({ locked: true, openPr: false, landLock: lock, integrateCode: 1 });

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({ ok: false, reason: "integrate-failed", locked: true });
    // A failed land must not leave the lock held — the next worker would deadlock.
    expect(fs.files.size).toBe(0);
  });

  it("native merge queue → no land-lock is taken and the enqueue keeps its GraphQL-only form", async () => {
    let acquires = 0;
    const countingLock: LandLock = {
      acquire: async () => {
        acquires += 1;
        return async () => {};
      },
    };
    const h = harness({ locked: false, openPr: true, nativeMergeQueue: true, landLock: countingLock, postMergeGate: true });

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({
      ok: true,
      locked: false,
      // #2986: the merge commit the QUEUE produced, read back once the PR itself
      // reported `merged: true` — not assumed from `--auto` exiting 0.
      mergeSha: "abc1234",
      postMergeValidation: {
        path: "local-rerun",
        reason: "PR #42 CI evidence was absent or unusable; local post-merge validation fallback ran.",
        prNumber: 42,
      },
    });
    // The forge serializes; double-serializing would only add latency.
    expect(acquires).toBe(0);
    // The write-plan keeps `--auto` on the CLI: the merge-queue enqueue is a
    // GraphQL-only mutation with no REST equivalent (#3663).
    expect(joined(h.mergeCalls).some((c) => c.includes("pr merge 42 --merge --auto"))).toBe(true);
    expect(joined(h.mergeCalls).some((c) => c.includes("pulls/42/merge"))).toBe(false);
  });

  it("native merge queue on the DIRECT path still takes the land-lock (no PR to enqueue)", async () => {
    let acquires = 0;
    const countingLock: LandLock = {
      acquire: async () => {
        acquires += 1;
        return async () => {};
      },
    };
    const h = harness({ locked: true, openPr: false, nativeMergeQueue: true, landLock: countingLock });

    expect((await doLanding(h.deps, h.input, h.hooks)).ok).toBe(true);
    expect(acquires).toBe(1);
  });

  it("no land-lock wired → lands unserialized, exactly as before #1337", async () => {
    const h = harness({ locked: true, openPr: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r).toEqual({ ok: true, locked: true, mergeSha: "abc1234" });
    expect(joined(h.mergeCalls).some((c) => c.includes("push origin HEAD:refs/heads/main"))).toBe(true);
  });

  it("PR path without a native queue is serialized by the land-lock", async () => {
    let acquires = 0;
    const countingLock: LandLock = {
      acquire: async () => {
        acquires += 1;
        return async () => {};
      },
    };
    const h = harness({ locked: false, openPr: true, landLock: countingLock });

    expect((await doLanding(h.deps, h.input, h.hooks)).ok).toBe(true);
    expect(acquires).toBe(1);
    // Plain admin-merge, never enqueued.
    expect(joined(h.mergeCalls).some((c) => c.includes("--auto"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A merge request is not proof of the merge (#2986). The REST merge request can
// return before the forge reports the PR merged; the merge group's CI may then
// run for minutes and hand the PR back. Landing used to read that exit 0 as
// "landed" and let its
// caller close the issue, strip its labels and delete the remote branch — so a
// rejected merge group left a closed issue whose code never reached the base.
// Every result below is what gates those steps: only `ok: true` unlocks them.
// ---------------------------------------------------------------------------
describe("doLanding — a queued merge is not a completed one (#2986)", () => {
  it("holds the landing (never ok) while the queued PR still reports merged=false", async () => {
    const h = harness({ locked: false, openPr: true, nativeMergeQueue: true, queueOutcome: "pending" });

    const r = await doLanding(h.deps, h.input, h.hooks);

    // ci-pending → the caller parks blocked:ci and keeps the issue and branch.
    expect(r).toEqual({ ok: false, reason: "ci-pending", locked: false, prNumber: 42 });
    // The post_merge hook is part of the close/cleanup tail — it must not fire.
    expect(h.firedHooks).not.toContain("post_merge");
    // It really did poll the PR rather than trusting the merge command's exit.
    expect(h.mergeCalls.filter((argv) => readsPull(argv)).length).toBeGreaterThan(1);
  });

  it("parks a merge-queue rejection with the observed reason, issue and branch intact", async () => {
    const h = harness({ locked: false, openPr: true, nativeMergeQueue: true, queueOutcome: "rejected" });

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r.ok).toBe(false);
    // pr-merge-failed → prLandingBlocked(ci-failed): blocked:ci, issue open.
    expect(r.ok === false && r.reason).toBe("pr-merge-failed");
    expect(r.ok === false && r.message).toContain("dequeued PR #42");
    expect(h.firedHooks).not.toContain("post_merge");
    // The branch stays on origin — nothing here deletes it.
    expect(joined(h.mergeCalls).some((c) => c.includes("push origin --delete"))).toBe(false);
  });

  it("completes only once the PR itself reports merged=true", async () => {
    const h = harness({ locked: false, openPr: true, nativeMergeQueue: true, queueOutcome: "merged" });

    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r).toEqual({ ok: true, locked: false, mergeSha: "abc1234" });
    expect(h.firedHooks).toContain("post_merge");
  });
});

// #3160 — a confirmation that cannot SEE the PR spent its whole budget saying
// "not yet", and every heartbeat rendered the blind slot as healthy waiting. The
// blind read is its own outcome, and it says so on the beat.
describe("doLanding — a merge confirmation that cannot read the PR (#3160)", () => {
  it("parks as infra after a few blind probes instead of burning the whole budget", async () => {
    const h = harness({ locked: false, openPr: true, nativeMergeQueue: true, queueOutcome: "probe-failing" });

    const r = await doLanding(h.deps, h.input, h.hooks);

    // Not `ci-pending`: nothing here says anything about CI, and an operator sent
    // to the PR's checks would be looking at the wrong machine.
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("infra");
    expect(r.ok === false && r.infraReason).toContain("could not read PR #42");
    expect(h.firedHooks).not.toContain("post_merge");
    // Four blind probes, not the declared 30.
    expect(h.mergeCalls.filter((argv) => readsPull(argv))).toHaveLength(4);
  });

  it("publishes the blind probe on the heartbeat, so no surface reads it as healthy waiting", async () => {
    const h = harness({ locked: false, openPr: true, nativeMergeQueue: true, queueOutcome: "probe-failing" });

    await doLanding(h.deps, h.input, h.hooks);

    const failed = h.landingEvents.filter((event) => event.detail.status === "probe-failed");
    expect(failed).toHaveLength(4);
    expect(failed[0]).toEqual(
      expect.objectContaining({
        phase: "wait",
        detail: expect.objectContaining({
          step: "merge-poll",
          status: "probe-failed",
          pr_number: 42,
          attempt: 1,
          unobserved_probes: 1,
          probe_exit_code: 1,
          probe_stderr: "gh: could not resolve host api.github.com",
        }),
      }),
    );
    expect(failed[3]?.detail).toEqual(expect.objectContaining({ unobserved_probes: 4 }));
  });
});
