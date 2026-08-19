import { describe, expect, it } from "vitest";
import {
  attempt,
  DAY,
  makeDeps,
  options,
  runBoot,
  type AttemptDir,
  type BootDeps,
  type BranchRef,
  type IssueMeta,
  type ReconcileBootRunner,
  type ReconcileSweepCandidate,
} from "./boot.helpers.js";

describe("runBoot reconcile sweep", () => {
  const stalled: ReconcileSweepCandidate = {
    number: 50,
    title: "stalled issue",
    body: "",
    labels: ["blocked:stalled"],
  };
  const crashed: ReconcileSweepCandidate = {
    number: 51,
    title: "crashed issue",
    body: "",
    labels: ["blocked:crashed"],
  };
  const noBranch: ReconcileSweepCandidate = {
    number: 52,
    title: "no branch issue",
    body: "",
    labels: ["blocked:stalled"],
  };
  const remoteLiveRefs: BranchRef[] = [
    { branch: "afk/wAAA/50-stalled-work" },
    { branch: "afk/wAAA/51-crashed-work" },
    // 52 intentionally omitted — no owned branch
  ];

  it("returns empty result when no reconcileRunner is wired", async () => {
    const { deps } = makeDeps();
    const r = await runBoot(
      deps,
      options({ reconcileSweepCandidates: [stalled], branches: { remoteLiveRefs, localLiveRefs: [] } }),
    );
    expect(r.reconcileSweep).toEqual({ landed: [], parked: [], skipped: [] });
  });

  it("green → landed when runner returns 'landed'", async () => {
    const reconcileRunner: ReconcileBootRunner = async () => ({ outcome: "landed" });
    const { deps } = makeDeps({ reconcileRunner });
    const r = await runBoot(
      deps,
      options({ reconcileSweepCandidates: [stalled], branches: { remoteLiveRefs, localLiveRefs: [] } }),
    );
    expect(r.reconcileSweep).toEqual({ landed: [50], parked: [], skipped: [] });
  });

  it("red → parked when runner returns 'parked'", async () => {
    const reconcileRunner: ReconcileBootRunner = async () => ({ outcome: "parked" });
    const { deps } = makeDeps({ reconcileRunner });
    const r = await runBoot(
      deps,
      options({ reconcileSweepCandidates: [crashed], branches: { remoteLiveRefs, localLiveRefs: [] } }),
    );
    expect(r.reconcileSweep).toEqual({ landed: [], parked: [51], skipped: [] });
  });

  it("no branch → not passed to runner, absent from all arrays", async () => {
    let runnerCalled = false;
    const reconcileRunner: ReconcileBootRunner = async () => {
      runnerCalled = true;
      return { outcome: "landed" };
    };
    const { deps } = makeDeps({ reconcileRunner });
    const r = await runBoot(
      deps,
      options({ reconcileSweepCandidates: [noBranch], branches: { remoteLiveRefs, localLiveRefs: [] } }),
    );
    expect(runnerCalled).toBe(false);
    expect(r.reconcileSweep).toEqual({ landed: [], parked: [], skipped: [] });
  });

  it("skipped when runner throws", async () => {
    const reconcileRunner: ReconcileBootRunner = async () => {
      throw new Error("gate failed");
    };
    const { deps } = makeDeps({ reconcileRunner });
    const r = await runBoot(
      deps,
      options({ reconcileSweepCandidates: [stalled], branches: { remoteLiveRefs, localLiveRefs: [] } }),
    );
    expect(r.reconcileSweep).toEqual({ landed: [], parked: [], skipped: [50] });
  });

  it("mixed batch: landed + parked + no-branch in one pass", async () => {
    let calls = 0;
    const reconcileRunner: ReconcileBootRunner = async (plan) => {
      calls++;
      return { outcome: plan.number === 50 ? "landed" : "parked" };
    };
    const { deps } = makeDeps({ reconcileRunner });
    const r = await runBoot(
      deps,
      options({
        reconcileSweepCandidates: [stalled, crashed, noBranch],
        branches: { remoteLiveRefs, localLiveRefs: [] },
      }),
    );
    expect(r.reconcileSweep).toEqual({ landed: [50], parked: [51], skipped: [] });
    expect(calls).toBe(2); // noBranch never reaches the runner
  });
});

describe("runBoot straggler check", () => {
  it("warns when any bucket is non-zero", async () => {
    const straggler: BootDeps["lookups"]["straggler"] = {
      unlabeled: async () => 2,
      needsTriage: async () => 0,
      needsInfo: async () => 1,
    };
    const { deps } = makeDeps({ straggler });
    const r = await runBoot(deps, options());
    expect(r.straggler).toEqual({
      counts: { unlabeled: 2, needsTriage: 0, needsInfo: 1 },
      warn: true,
    });
  });

  it("does not warn when every bucket is zero", async () => {
    const { deps } = makeDeps();
    const r = await runBoot(deps, options());
    expect(r.straggler).toEqual({
      counts: { unlabeled: 0, needsTriage: 0, needsInfo: 0 },
      warn: false,
    });
  });
});

describe("runBoot step ORDER", () => {
  it("fires bootstrap → orphan → cap → branch → sweep → straggler in sequence", async () => {
    const orphanState: BootDeps["lookups"]["orphanState"] = async () => ({
      ghOk: true,
      state: "CLOSED",
      label: null,
      envelopePosted: false,
    });
    const closed: IssueMeta = { state: "CLOSED", closedAt: "2000-01-01T00:00:00Z" };
    const branchIssue: BootDeps["lookups"]["branchIssue"] = () => closed;
    const blockerState: BootDeps["lookups"]["blockerState"] = async () => "CLOSED";
    const { deps, calls } = makeDeps({ orphanState, branchIssue, blockerState });

    const byIssue = new Map<number, AttemptDir[]>([[42, [attempt(42, 1, 20 * DAY)]]]);
    const opts = options({
      orphans: [{ path: "/d/orphan", issue: 1, ageS: 0 }],
      attemptCap: { byIssue },
      branches: {
        remoteLiveRefs: [{ branch: "afk/wAAA/9-r" }],
        localLiveRefs: [{ branch: "afk/wAAA/9-l" }],
      },
      unblockCandidates: [
        { number: 100, labels: ["blocked:dependency"], body: "## Blocked by\n\n- [ ] #10\n" },
      ],
    });

    await runBoot(deps, opts);

    // First mutating op of each step, in order.
    const markers = [
      "fs.ensureDir:/p/.red/tmp", // bootstrap
      "fs.removeDir:/d/orphan", // orphan cleanup
      "fs.removeDir:/p/.red/tmp/workers/wAAA/42-a1", // attempt cap
      "git.deleteRemote:afk/wAAA/9-r", // remote live cleanup
      "git.deleteLocal:afk/wAAA/9-l", // local live cleanup
      "gh.editLabels:100", // unblock sweep
    ];
    const seen = markers.map((m) => calls.indexOf(m));
    expect(seen.every((i) => i >= 0)).toBe(true);
    const sorted = [...seen].sort((a, b) => a - b);
    expect(seen).toEqual(sorted);
  });
});
