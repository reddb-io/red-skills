import { describe, expect, it, vi } from "vitest";
import {
  attempt,
  DAY,
  makeDeps,
  options,
  runBoot,
  NOW,
  type AttemptDir,
  type BootDeps,
  type BranchRef,
  type IssueMeta,
  type OrphanDir,
  type UnblockCandidate,
} from "./boot.helpers.js";
import { KNOWN_TMP_LANES } from "../src/core/tmp-janitor.js";
import type { WorkerArtifactVerdict } from "../src/core/worker-reclaim.js";

type JanitorSweep = NonNullable<NonNullable<Parameters<typeof options>[0]>["tmpJanitor"]>;

function emptyJanitorPlan(): JanitorSweep["plan"] {
  return {
    logs: { reclaim: [], spare: [] },
    scratch: { reclaim: [], spare: [] },
    diagnostics: { reclaim: [], spare: [] },
    feedbackWorktrees: { reclaim: [], spare: [] },
    legacySlotLogs: { reclaim: [], spare: [] },
    unknownTmpRoots: [],
  };
}

/** One dead Worker's workspace, already condemned by the daemon-keyed planner. */
function workspaceVerdict(workerId: string, path: string): WorkerArtifactVerdict {
  return {
    worker_id: workerId,
    artifact: { worker_id: workerId, kind: "worktree", path },
    class: "workspace",
    liveness: "dead",
    reclaim: true,
    verdict: "workspace-reclaimable",
    reason: "the daemon calls this Worker gone",
  };
}

/** One dead Worker's durable state record, condemned by the record planner. */
function stateRecordVerdict(workerId: string) {
  return {
    worker_id: workerId,
    path: `/p/.red/state/castle/workers/${workerId}`,
    liveness: "dead" as const,
    outcome: "terminal",
    age_ms: 2 * 24 * 60 * 60 * 1000,
    reclaim: true,
    verdict: "settled-reclaimable" as const,
    reason: "the daemon calls this Worker gone and its record is past the retention",
  };
}

// #2978: nothing owned the durable Worker STATE RECORD, so 345 accumulated to
// convey one live Worker. The boot sweep reclaims it on the same authority every
// other reclaim answers to, and fails CLOSED on anything short of `dead`.
describe("runBoot Worker state record reclaim", () => {
  it("removes a record whose Worker the daemon calls gone", async () => {
    const { deps, fsCalls } = makeDeps({ workerStateRecordLivenessVerdict: async () => "dead" });
    const result = await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: emptyJanitorPlan(),
          staleWorkers: { reclaim: [], spare: [] },
          workerStateRecords: {
            reclaim: [stateRecordVerdict("wDEAD")],
            retain: [],
            totals: { considered: 1, reclaim: 1, retain: 0 },
          },
        },
      }),
    );
    expect(fsCalls.removeDir).toEqual(["/p/.red/state/castle/workers/wDEAD"]);
    expect(result.tmpJanitor?.workerStateRecords).toEqual([
      "/p/.red/state/castle/workers/wDEAD",
    ]);
    expect(result.tmpJanitor?.removals).toContainEqual({
      path: "/p/.red/state/castle/workers/wDEAD",
      livenessVerdict: "worker-dead",
    });
  });

  it("keeps the record when the probe answers anything but dead", async () => {
    const { deps, fsCalls } = makeDeps({ workerStateRecordLivenessVerdict: async () => "unknown" });
    const result = await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: emptyJanitorPlan(),
          staleWorkers: { reclaim: [], spare: [] },
          workerStateRecords: {
            reclaim: [stateRecordVerdict("wMAYBE")],
            retain: [],
            totals: { considered: 1, reclaim: 1, retain: 0 },
          },
        },
      }),
    );
    expect(fsCalls.removeDir).toEqual([]);
    expect(result.tmpJanitor?.protectedLiveWorkerStateRecords).toEqual([
      "/p/.red/state/castle/workers/wMAYBE",
    ]);
  });

  it("keeps the record when the probe is not wired at all — fail closed", async () => {
    const { deps, fsCalls } = makeDeps();
    const result = await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: emptyJanitorPlan(),
          staleWorkers: { reclaim: [], spare: [] },
          workerStateRecords: {
            reclaim: [stateRecordVerdict("wUNWIRED")],
            retain: [],
            totals: { considered: 1, reclaim: 1, retain: 0 },
          },
        },
      }),
    );
    expect(fsCalls.removeDir).toEqual([]);
    expect(result.tmpJanitor?.protectedLiveWorkerStateRecords).toEqual([
      "/p/.red/state/castle/workers/wUNWIRED",
    ]);
  });
});

describe("runBoot tmp janitor", () => {
  it("reaps orphan test-runner groups and records an audit row", async () => {
    const { deps } = makeDeps();
    const reapProcessGroup = vi.fn(async () => true);
    (deps.fs as BootDeps["fs"] & { reapProcessGroup: typeof reapProcessGroup }).reapProcessGroup = reapProcessGroup;
    const result = await runBoot(deps, options({
      tmpJanitor: {
        plan: {
          logs: { reclaim: [], spare: [] }, scratch: { reclaim: [], spare: [] },
          diagnostics: { reclaim: [], spare: [] }, feedbackWorktrees: { reclaim: [], spare: [] },
          legacySlotLogs: { reclaim: [], spare: [] }, unknownTmpRoots: [],
        },
        staleWorkers: { reclaim: [], spare: [] },
        orphanTestRunners: [{
          pid: 200, ppid: 10, pgid: 190, sid: 10, ageS: 600,
          cwd: "/p/.red/tmp/workers/wTEST/2432/worktree", command: "node (vitest 2)",
        }],
      } as NonNullable<NonNullable<Parameters<typeof options>[0]>["tmpJanitor"]>,
    }));

    expect(reapProcessGroup).toHaveBeenCalledWith(190);
    expect(result.tmpJanitor?.orphanTestRunners).toEqual([{ pid: 200, pgid: 190 }]);
  });

  it("reclaims expired named lanes, closed-issue dead workers, and audited unknown tmp roots", async () => {
    const { deps, fsCalls } = makeDeps({ workerLivenessVerdict: async () => "dead" });
    const result = await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: {
            logs: { reclaim: [{ path: "/p/.red/tmp/logs/old", mtimeS: NOW - 99 }], spare: [] },
            scratch: { reclaim: [{ path: "/p/.red/tmp/scratch/old", mtimeS: NOW - 99 }], spare: [] },
            diagnostics: { reclaim: [], spare: [] },
            feedbackWorktrees: { reclaim: [], spare: [] },
            legacySlotLogs: { reclaim: [], spare: [] },
            unknownTmpRoots: ["work-old"],
          },
          staleWorkers: {
            reclaim: [
              {
                path: "/p/.red/tmp/workers/wOLD",
                liveness: "dead",
                issues: [{ issue: 9, state: "CLOSED" }],
              },
            ],
            spare: [],
          },
        },
      }),
    );

    expect(fsCalls.removeDir).toEqual([
      "/p/.red/tmp/logs/old",
      "/p/.red/tmp/scratch/old",
      "/p/.red/tmp/workers/wOLD",
      "/p/.red/tmp/work-old",
    ]);
    expect(result.tmpJanitor).toEqual({
      expiredLanes: ["/p/.red/tmp/logs/old", "/p/.red/tmp/scratch/old"],
      staleWorkers: ["/p/.red/tmp/workers/wOLD"],
      unknownTmpRoots: ["/p/.red/tmp/work-old"],
      protectedLiveWorkers: [],
      protectedLiveFeedback: [],
      orphanTestRunners: [],
      workerWorkspaces: [],
      protectedLiveWorkspaces: [],
      workerStateRecords: [],
      protectedLiveWorkerStateRecords: [],
      refusedOutsideTmp: [],
      removals: [
        { path: "/p/.red/tmp/logs/old", livenessVerdict: "not-worker-workspace" },
        { path: "/p/.red/tmp/scratch/old", livenessVerdict: "not-worker-workspace" },
        { path: "/p/.red/tmp/workers/wOLD", livenessVerdict: "worker-dead" },
        { path: "/p/.red/tmp/work-old", livenessVerdict: "not-worker-workspace" },
      ],
    });
  });

  // #2866: removing a worktree's bytes leaves git still registering the path,
  // which is what blocked a gate worktree from being created there.
  it("prunes git's worktree registry after reclaiming a dead Worker's workspace", async () => {
    const { deps, gitCalls } = makeDeps({ workerWorkspaceLivenessVerdict: async () => "dead" });
    await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: emptyJanitorPlan(),
          staleWorkers: { reclaim: [], spare: [] },
          workerReclaim: {
            workers: [],
            reclaim: [
              workspaceVerdict("wDEAD", "/p/.red/tmp/workers/wDEAD/2866/worktree"),
            ],
            retain: [],
            dropped: [],
            truncated: false,
            totals: { considered: 1, reclaim: 1, retain: 0, dropped: 0 },
          },
        },
      }),
    );
    expect(gitCalls.worktreePrune).toBe(1);
  });

  it("does not prune when only logs and scratch expired", async () => {
    const { deps, gitCalls } = makeDeps();
    await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: {
            ...emptyJanitorPlan(),
            logs: { reclaim: [{ path: "/p/.red/tmp/logs/old", mtimeS: NOW - 99 }], spare: [] },
          },
          staleWorkers: { reclaim: [], spare: [] },
        },
      }),
    );
    expect(gitCalls.worktreePrune).toBe(0);
  });

  it("refuses to remove a registered lane named as an unknown tmp root (#2679)", async () => {
    const { deps, fsCalls } = makeDeps();
    const result = await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: {
            logs: { reclaim: [], spare: [] },
            scratch: { reclaim: [], spare: [] },
            diagnostics: { reclaim: [], spare: [] },
            feedbackWorktrees: { reclaim: [], spare: [] },
            legacySlotLogs: { reclaim: [], spare: [] },
            // A plan from an older bundle (pre-lane-registry) misclassified the
            // live supervisors lane; the apply path must still spare it.
            unknownTmpRoots: [...KNOWN_TMP_LANES, "work-old"],
          },
          staleWorkers: { reclaim: [], spare: [] },
        },
      }),
    );

    expect(fsCalls.removeDir).toEqual(["/p/.red/tmp/work-old"]);
    expect(result.tmpJanitor?.unknownTmpRoots).toEqual(["/p/.red/tmp/work-old"]);
    expect(result.tmpJanitor?.removals.map((r) => r.path)).not.toContain("/p/.red/tmp/supervisors");
  });

  it("re-asks the daemon before removing a stale worker dir and protects a live Worker", async () => {
    const { deps, fsCalls } = makeDeps({ workerLivenessVerdict: async () => "alive" });
    const result = await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: {
            logs: { reclaim: [], spare: [] },
            scratch: { reclaim: [], spare: [] },
            diagnostics: { reclaim: [], spare: [] },
            feedbackWorktrees: { reclaim: [], spare: [] },
            legacySlotLogs: { reclaim: [], spare: [] },
            unknownTmpRoots: [],
          },
          staleWorkers: {
            reclaim: [
              {
                path: "/p/.red/tmp/workers/wLIVE",
                liveness: "dead",
                issues: [{ issue: 9, state: "CLOSED" }],
              },
            ],
            spare: [],
          },
        },
      }),
    );

    expect(fsCalls.removeDir).toEqual([]);
    expect(result.tmpJanitor?.protectedLiveWorkers).toEqual(["/p/.red/tmp/workers/wLIVE"]);
  });

  it("rechecks feedback ownership before removal and records the liveness verdict", async () => {
    const { deps, fsCalls } = makeDeps();
    deps.fs.feedbackWorktreeLiveness = async () => "owner-live";
    const feedback = "/p/.red/tmp/worktrees/feedback/afk-wLIVE-2450-live-gate";
    const result = await runBoot(
      deps,
      options({
        tmpJanitor: {
          plan: {
            logs: { reclaim: [], spare: [] },
            scratch: { reclaim: [], spare: [] },
            diagnostics: { reclaim: [], spare: [] },
            feedbackWorktrees: { reclaim: [{ path: feedback, mtimeS: 1 }], spare: [] },
            legacySlotLogs: { reclaim: [], spare: [] },
            unknownTmpRoots: [],
          },
          staleWorkers: { reclaim: [], spare: [] },
        },
      }),
    );

    expect(fsCalls.removeDir).toEqual([]);
    expect(result.tmpJanitor?.protectedLiveFeedback).toEqual([feedback]);
    expect(result.tmpJanitor?.removals).toEqual([]);
  });
});

describe("runBoot orphan cleanup applies each fate", () => {
  it("removes a CLOSED-issue orphan dir", async () => {
    const orphanState: BootDeps["lookups"]["orphanState"] = async () => ({
      ghOk: true,
      state: "CLOSED",
      label: null,
      envelopePosted: false,
    });
    const { deps, fsCalls } = makeDeps({ orphanState });
    const orphans: OrphanDir[] = [{ path: "/d/closed", issue: 1, ageS: 0 }];
    const r = await runBoot(deps, options({ orphans }));
    expect(fsCalls.removeDir).toEqual(["/d/closed"]);
    expect(r.orphanCleanup).toEqual({ removed: ["/d/closed"], restored: [], kept: [], legacyWiped: [], claimsReleased: [] });
  });

  it("restores ready-for-agent then removes a crashed `running` orphan", async () => {
    const orphanState: BootDeps["lookups"]["orphanState"] = async () => ({
      ghOk: true,
      state: "OPEN",
      label: "running",
      envelopePosted: false,
    });
    const { deps, calls, ghCalls, fsCalls } = makeDeps({ orphanState });
    const orphans: OrphanDir[] = [{ path: "/d/running", issue: 7, ageS: 0 }];
    const r = await runBoot(deps, options({ orphans }));
    expect(ghCalls.editLabels).toEqual([
      { issue: 7, remove: ["running"], add: ["ready-for-agent"] },
    ]);
    expect(ghCalls.comment).toEqual([
      { issue: 7, body: "🤖 /afk orchestrator died mid-issue; restoring ready-for-agent." },
    ]);
    expect(fsCalls.removeDir).toEqual(["/d/running"]);
    expect(r.orphanCleanup).toEqual({ removed: ["/d/running"], restored: [7], kept: [], legacyWiped: [], claimsReleased: [] });
    // edit + comment fire before the rm.
    expect(calls.filter((c) => c.startsWith("gh.") || c === "fs.removeDir:/d/running")).toEqual([
      "gh.viewLabels:7",
      "gh.editLabels:7",
      "gh.comment:7",
      "fs.removeDir:/d/running",
    ]);
  });

  it("downgrades restore-and-remove to plain remove when a live worker holds the claim (#644)", async () => {
    // A claim-race loser's debris dir names an issue the WINNER is actively
    // working: restoring ready-for-agent here would clobber the live worker's
    // `running` label and put the issue back at the head of every queue.
    const orphanState: BootDeps["lookups"]["orphanState"] = async () => ({
      ghOk: true,
      state: "OPEN",
      label: "running",
      envelopePosted: false,
    });
    const { deps, ghCalls, fsCalls } = makeDeps({ orphanState, claimHolderAlive: async () => true });
    const orphans: OrphanDir[] = [{ path: "/d/debris", issue: 9, ageS: 0 }];
    const r = await runBoot(deps, options({ orphans }));
    expect(ghCalls.editLabels).toEqual([]); // no label restore
    expect(ghCalls.comment).toEqual([]); // no recovery comment
    expect(fsCalls.removeDir).toEqual(["/d/debris"]);
    expect(r.orphanCleanup).toEqual({ removed: ["/d/debris"], restored: [], kept: [], legacyWiped: [], claimsReleased: [] });
  });

  it("still restores when the claim lookup reports no live holder (#644)", async () => {
    const orphanState: BootDeps["lookups"]["orphanState"] = async () => ({
      ghOk: true,
      state: "OPEN",
      label: "running",
      envelopePosted: false,
    });
    const { deps, ghCalls } = makeDeps({ orphanState, claimHolderAlive: async () => false });
    const orphans: OrphanDir[] = [{ path: "/d/crashed", issue: 11, ageS: 0 }];
    const r = await runBoot(deps, options({ orphans }));
    expect(ghCalls.editLabels).toEqual([{ issue: 11, remove: ["running"], add: ["ready-for-agent"] }]);
    expect(r.orphanCleanup?.restored).toEqual([11]);
  });

  it("treats a throwing claim lookup as no-live-holder and restores (#644 fail-open)", async () => {
    const orphanState: BootDeps["lookups"]["orphanState"] = async () => ({
      ghOk: true,
      state: "OPEN",
      label: "running",
      envelopePosted: false,
    });
    const { deps, ghCalls } = makeDeps({
      orphanState,
      claimHolderAlive: async () => {
        throw new Error("fs unavailable");
      },
    });
    const orphans: OrphanDir[] = [{ path: "/d/crashed2", issue: 13, ageS: 0 }];
    await runBoot(deps, options({ orphans }));
    expect(ghCalls.editLabels).toEqual([{ issue: 13, remove: ["running"], add: ["ready-for-agent"] }]);
  });

  it("keep-until removes only once the dir has aged past the TTL", async () => {
    // ready-for-human, envelope posted=false → 7-day TTL.
    const orphanState: BootDeps["lookups"]["orphanState"] = async () => ({
      ghOk: true,
      state: "OPEN",
      label: "ready-for-human",
      envelopePosted: false,
    });
    const { deps, fsCalls } = makeDeps({ orphanState });
    const orphans: OrphanDir[] = [
      { path: "/d/young", issue: 1, ageS: 1 * DAY }, // within 7d → kept
      { path: "/d/old", issue: 2, ageS: 8 * DAY }, // past 7d → removed
    ];
    const r = await runBoot(deps, options({ orphans }));
    expect(fsCalls.removeDir).toEqual(["/d/old"]);
    expect(r.orphanCleanup).toEqual({ removed: ["/d/old"], restored: [], kept: ["/d/young"], legacyWiped: [], claimsReleased: [] });
  });

  it("a dir with no state file never queries gh and is kept under the 1-day TTL", async () => {
    let queried = false;
    const orphanState: BootDeps["lookups"]["orphanState"] = async () => {
      queried = true;
      return { ghOk: true, state: "OPEN", label: null, envelopePosted: false };
    };
    const { deps, fsCalls } = makeDeps({ orphanState });
    const orphans: OrphanDir[] = [{ path: "/d/nostate", issue: null, ageS: 1000 }];
    await runBoot(deps, options({ orphans }));
    expect(queried).toBe(false);
    expect(fsCalls.removeDir).toEqual([]);
  });
});

describe("runBoot legacy work-* drain-wipe (#252)", () => {
  it("unconditionally removes every dead legacy work dir, before the orphan sweep", async () => {
    const { deps, calls, fsCalls } = makeDeps();
    const r = await runBoot(
      deps,
      options({
        legacyWorkDirs: ["/p/.red/tmp/work-001", "/p/.red/tmp/work-002"],
        orphans: [{ path: "/d/orphan", issue: null, ageS: 10 * DAY }],
      }),
    );
    expect(fsCalls.removeDir).toEqual([
      "/p/.red/tmp/work-001",
      "/p/.red/tmp/work-002",
      "/d/orphan",
    ]);
    expect(r.orphanCleanup?.legacyWiped).toEqual([
      "/p/.red/tmp/work-001",
      "/p/.red/tmp/work-002",
    ]);
    // the legacy wipe fires before any orphan-dir removal.
    const removes = calls.filter((c) => c.startsWith("fs.removeDir:"));
    expect(removes[0]).toBe("fs.removeDir:/p/.red/tmp/work-001");
  });

  it("is a no-op when there are no legacy dirs", async () => {
    const { deps, fsCalls } = makeDeps();
    const r = await runBoot(deps, options());
    expect(fsCalls.removeDir).toEqual([]);
    expect(r.orphanCleanup?.legacyWiped).toEqual([]);
  });
});

describe("runBoot stale claim-lock sweep", () => {
  it("reclaims every stale claim dir, after the orphan sweep", async () => {
    const { deps, calls, fsCalls } = makeDeps();
    const r = await runBoot(
      deps,
      options({
        orphans: [{ path: "/d/orphan", issue: null, ageS: 10 * DAY }],
        staleClaimDirs: [{ path: "/p/.red/tmp/claims/7" }, { path: "/p/.red/tmp/claims/9" }],
      }),
    );
    expect(r.orphanCleanup?.claimsReleased).toEqual([
      "/p/.red/tmp/claims/7",
      "/p/.red/tmp/claims/9",
    ]);
    // claim sweep runs LAST — after the orphan-dir removal.
    const removes = calls.filter((c) => c.startsWith("fs.removeDir:"));
    expect(removes).toEqual([
      "fs.removeDir:/d/orphan",
      "fs.removeDir:/p/.red/tmp/claims/7",
      "fs.removeDir:/p/.red/tmp/claims/9",
    ]);
    expect(fsCalls.removeDir).toContain("/p/.red/tmp/claims/7");
  });

  it("is a no-op when no claim is stale", async () => {
    const { deps, fsCalls } = makeDeps();
    const r = await runBoot(deps, options());
    expect(fsCalls.removeDir).toEqual([]);
    expect(r.orphanCleanup?.claimsReleased).toEqual([]);
  });
});

describe("runBoot attempt cap reclaims the right dirs", () => {
  it("reaps age- and count-capped dirs with fixed legacy cleanup defaults", async () => {
    const { deps, fsCalls } = makeDeps({ env: { RED_AFK_ATTEMPT_KEEP: "2", RED_AFK_ATTEMPT_TTL_S: "999999" } });
    const byIssue = new Map<number, AttemptDir[]>([
      [
        42,
        [
          attempt(42, 1, 20 * DAY), // age-capped (default ttl 14d)
          attempt(42, 2, 1 * DAY),
          attempt(42, 3, 1 * DAY),
          attempt(42, 4, 1 * DAY),
          attempt(42, 5, 1 * DAY),
          attempt(42, 6, 1 * DAY),
          attempt(42, 7, 1 * DAY),
          attempt(42, 8, 1 * DAY, true), // live -> spared, not counted
        ],
      ],
    ]);
    const r = await runBoot(deps, options({ attemptCap: { byIssue } }));
    // Deleted RED_AFK_ATTEMPT_* env is ignored: fixed defaults are ttl=14d, keep=5.
    // a1 age-capped; survivors a2..a7 with keep=5 -> drop a2 (oldest by number).
    expect(fsCalls.removeDir).toEqual([
      "/p/.red/tmp/workers/wAAA/42-a1",
      "/p/.red/tmp/workers/wAAA/42-a2",
    ]);
    expect(r.attemptCap).toEqual({
      reclaimed: [
        "/p/.red/tmp/workers/wAAA/42-a1",
        "/p/.red/tmp/workers/wAAA/42-a2",
      ],
    });
  });
});

describe("runBoot branch cleanup deletes the planned refs", () => {
  it("reaps closed remote-live remotely and local-live locally", async () => {
    const closed: IssueMeta = { state: "CLOSED", closedAt: "2000-01-01T00:00:00Z" };
    const branchIssue: BootDeps["lookups"]["branchIssue"] = (issue) =>
      issue === 9 ? closed : ({ state: "OPEN" } as IssueMeta);
    const { deps, gitCalls } = makeDeps({ branchIssue });
    const remoteLiveRefs: BranchRef[] = [
      { branch: "afk/wAAA/9-slug" },
      { branch: "afk/wAAA/3-open" }, // open → kept
    ];
    const localLiveRefs: BranchRef[] = [{ branch: "afk/wAAA/9-local" }];
    const r = await runBoot(
      deps,
      options({ branches: { remoteLiveRefs, localLiveRefs } }),
    );
    expect(gitCalls.deleteRemote).toEqual(["afk/wAAA/9-slug"]);
    expect(gitCalls.deleteLocal).toEqual(["afk/wAAA/9-local"]);
    expect(r.branchCleanup?.remoteLiveReaped).toEqual(["afk/wAAA/9-slug"]);
    expect(r.branchCleanup?.localLiveReaped).toEqual(["afk/wAAA/9-local"]);
    expect(r.branchCleanup?.localSpared).toEqual([]);
  });

  // #2866: a branch whose PR merged while its issue stayed open is exactly the
  // branch that accumulated 75-deep. Landing is the merge-base fact, so the
  // reclaim must not wait for the tracker to catch up.
  it("reaps a landed local branch even while its issue is still open", async () => {
    const { deps, gitCalls } = makeDeps({ branchIssue: () => ({ state: "OPEN" } as IssueMeta) });
    const localLiveRefs: BranchRef[] = [
      { branch: "afk/wAAA/9-landed" },
      { branch: "afk/wAAA/3-in-flight" },
    ];
    const r = await runBoot(
      deps,
      options({
        branches: {
          remoteLiveRefs: [],
          localLiveRefs,
          landedLocalBranches: ["afk/wAAA/9-landed"],
          trunk: "main",
        },
      }),
    );
    expect(gitCalls.deleteLocal).toEqual(["afk/wAAA/9-landed"]);
    expect(r.branchCleanup?.localSpared?.map((s) => [s.branch, s.verdict])).toEqual([
      ["afk/wAAA/3-in-flight", "unlanded"],
    ]);
  });

  it("never deletes red-trunk or the trunk, however landed they look", async () => {
    const { deps, gitCalls } = makeDeps({ branchIssue: () => ({ state: "CLOSED", closedAt: "2000-01-01T00:00:00Z" } as IssueMeta) });
    const localLiveRefs: BranchRef[] = [
      { branch: "red-trunk" },
      { branch: "main" },
      { branch: "afk/wAAA/9-landed" },
    ];
    const r = await runBoot(
      deps,
      options({
        branches: {
          remoteLiveRefs: [],
          localLiveRefs,
          landedLocalBranches: ["red-trunk", "main", "afk/wAAA/9-landed"],
          trunk: "main",
        },
      }),
    );
    expect(gitCalls.deleteLocal).toEqual(["afk/wAAA/9-landed"]);
    expect(r.branchCleanup?.localSpared?.map((s) => [s.branch, s.verdict])).toEqual([
      ["red-trunk", "infrastructure"],
      ["main", "trunk"],
    ]);
  });
});

describe("runBoot unblock sweep promotes + comments", () => {
  it("promotes a legacy blocked:dependency issue and posts the audit comment", async () => {
    const blockerState: BootDeps["lookups"]["blockerState"] = async (issue) =>
      issue === 10 || issue === 11 ? "CLOSED" : "OPEN";
    const { deps, ghCalls } = makeDeps({ blockerState });
    const unblockCandidates: UnblockCandidate[] = [
      {
        number: 100,
        labels: ["blocked:dependency"],
        body: "## Blocked by\n\n- [ ] #10\n- [ ] #11\n",
      },
      {
        number: 200,
        labels: ["blocked:dependency"],
        body: "## Blocked by\n\n- [ ] #10\n- [ ] #99\n",
      }, // #99 open → stays
    ];
    const r = await runBoot(deps, options({ unblockCandidates }));
    expect(ghCalls.editLabels).toEqual([
      { issue: 100, remove: ["blocked:dependency"], add: ["ready-for-agent"] },
    ]);
    expect(ghCalls.comment).toEqual([
      {
        issue: 100,
        body: "🤖 /afk promoted to ready-for-agent: all blockers closed (#10, #11).",
      },
    ]);
    expect(r.unblockSweep).toEqual({ promoted: [100] });
  });

  it("promotes a blocked:dependency issue via its req:* labels, shedding blocked:dependency", async () => {
    const blockerState: BootDeps["lookups"]["blockerState"] = async (issue) =>
      issue === 10 || issue === 11 ? "CLOSED" : "OPEN";
    const { deps, ghCalls } = makeDeps({ blockerState });
    const unblockCandidates: UnblockCandidate[] = [
      // req:* labels are preferred over the (here, contradictory) body parse.
      {
        number: 100,
        labels: ["blocked:dependency", "req:10", "req:11"],
        body: "## Blocked by\n\n- [ ] #999\n",
      },
      // still-open dep #99 → stays blocked.
      { number: 200, labels: ["blocked:dependency", "req:10", "req:99"], body: "" },
    ];
    const r = await runBoot(deps, options({ unblockCandidates }));
    expect(ghCalls.editLabels).toEqual([
      { issue: 100, remove: ["blocked:dependency", "req:10", "req:11"], add: ["ready-for-agent"] },
    ]);
    expect(ghCalls.comment).toEqual([
      { issue: 100, body: "🤖 /afk unblocked: all dependencies closed (#10, #11)." },
    ]);
    expect(r.unblockSweep).toEqual({ promoted: [100] });
  });
});

describe("runBoot mixed-blocked normalizer (#1481)", () => {
  it("heals a pre-existing mixed-blocked issue by shedding its stale blocked:*", async () => {
    const { deps, ghCalls } = makeDeps();
    const r = await runBoot(
      deps,
      options({
        mixedBlockedCandidates: [
          { number: 42, labels: ["ready-for-agent", "blocked:spec"] },
          { number: 43, labels: ["ready-for-agent"] }, // clean → untouched
        ],
      }),
    );
    expect(ghCalls.editLabels).toEqual([{ issue: 42, remove: ["blocked:spec"], add: [] }]);
    expect(r.mixedBlockedNormalize).toEqual({ healed: [42] });
  });

  it("is a no-op when no mixed-blocked candidates are provided", async () => {
    const { deps, ghCalls } = makeDeps();
    const r = await runBoot(deps, options());
    expect(ghCalls.editLabels).toEqual([]);
    expect(r.mixedBlockedNormalize).toEqual({ healed: [] });
  });
});

describe("runBoot Spec sub-issue reconciler (#1739)", () => {
  it("attaches label-only children and strips stale needs-slicing", async () => {
    const { deps, ghCalls } = makeDeps();
    const r = await runBoot(
      deps,
      options({
        specSubIssueCandidates: [
          {
            number: 42,
            labels: ["type:spec", "needs-slicing"],
            labelChildren: [7, 8],
            nativeSubIssues: [7],
          },
        ],
      }),
    );

    expect(ghCalls.attachSubIssue).toEqual([{ parent: 42, child: 8 }]);
    expect(ghCalls.editLabels).toEqual([{ issue: 42, remove: ["needs-slicing"], add: [] }]);
    expect(r.specSubIssueReconcile).toEqual({
      attached: [{ spec: 42, child: 8 }],
      needsSlicingRemoved: [42],
    });
  });

  it("is a no-op when no Spec candidates are provided", async () => {
    const { deps, ghCalls } = makeDeps();
    const r = await runBoot(deps, options());
    expect(ghCalls.attachSubIssue).toEqual([]);
    expect(r.specSubIssueReconcile).toEqual({ attached: [], needsSlicingRemoved: [] });
  });
});

describe("runBoot cross-host stale-claim sweep (#627)", () => {
  // A claim record from `worker` whose latest refresh was `ageS` ago.
  const claim = (commentId: number, worker: string, ageS: number) => ({
    commentId,
    worker,
    kind: "claim" as const,
    createdAt: new Date((NOW - ageS) * 1000).toISOString(),
  });

  it("is a no-op when claimedIssues is not wired", async () => {
    const { deps, ghCalls } = makeDeps();
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [] });
    expect(ghCalls.editLabels).toEqual([]);
  });

  it("releases a cross-host stale claim back to ready-for-agent with one audit comment", async () => {
    const claimedIssues = async () => [{ issue: 42, records: [claim(10, "host1:wXY", 99999)] }];
    const { deps, ghCalls } = makeDeps({ claimedIssues });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [42] });
    expect(ghCalls.editLabels).toEqual([
      { issue: 42, remove: ["running"], add: ["ready-for-agent"] },
    ]);
    expect(ghCalls.comment).toHaveLength(1);
    expect(ghCalls.comment[0].issue).toBe(42);
    expect(ghCalls.comment[0].body).toContain("host1:wXY");
    expect(ghCalls.comment[0].body).toContain("cross-host stale-claim sweep");
  });

  it("repairs an open running issue whose latest claim marker is a concede", async () => {
    const claimedIssues = async () => [
      {
        issue: 43,
        records: [
          claim(10, "host1:wGone", 120),
          { commentId: 20, worker: "host1:wGone", kind: "concede" as const },
        ],
      },
    ];
    const { deps, ghCalls } = makeDeps({ claimedIssues });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [43], repairedConceded: [43] });
    expect(ghCalls.editLabels).toEqual([
      { issue: 43, remove: ["running"], add: ["ready-for-agent"] },
    ]);
    expect(ghCalls.comment).toHaveLength(1);
    expect(ghCalls.comment[0].body).toContain("claim-label sweep");
    expect(ghCalls.comment[0].body).toContain("ended in concede");
  });

  it("never releases an issue still held by a live worker", async () => {
    const claimedIssues = async () => [{ issue: 42, records: [claim(10, "host1:wXY", 120)] }];
    const { deps, ghCalls } = makeDeps({ claimedIssues });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [] });
    expect(ghCalls.editLabels).toEqual([]);
    expect(ghCalls.comment).toEqual([]);
  });

  it("releases a fresh same-host ghost claim when worker.pid is dead", async () => {
    const claimedIssues = async () => [
      { issue: 42, records: [claim(10, "host1:wXY", 120)], deadOwners: ["host1:wXY"] },
    ];
    const { deps, ghCalls } = makeDeps({ claimedIssues });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [42] });
    expect(ghCalls.editLabels).toEqual([
      { issue: 42, remove: ["running"], add: ["ready-for-agent"] },
    ]);
    expect(ghCalls.comment[0].body).toContain("same-host ghost-claim sweep");
    expect(ghCalls.comment[0].body).toContain("worker.pid");
  });

  it("honours RED_AFK_CLAIM_REFRESH_S / tolerance from env", async () => {
    // 700s old: stale under the default 1200s window? no. Tighten the window to
    // 60×(1+0)=60s via env → 700s is now stale.
    const claimedIssues = async () => [{ issue: 7, records: [claim(10, "h:w", 700)] }];
    const { deps } = makeDeps({
      claimedIssues,
      env: { RED_AFK_CLAIM_REFRESH_S: "60", RED_AFK_CLAIM_STALE_TOLERANCE: "0" },
    });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [7] });
  });

  it("honours plugins.dev.afk claim-reaper grace config before releasing", async () => {
    const claimedIssues = async () => [{ issue: 7, records: [claim(10, "h:w", 120)] }];
    const { deps, ghCalls } = makeDeps({
      env: { RED_AFK_CLAIM_REFRESH_S: "60", RED_AFK_CLAIM_STALE_TOLERANCE: "0" },
      config: { "afk.claim_reaper.grace_s": "300" },
      claimedIssues,
    });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [] });
    expect(ghCalls.editLabels).toEqual([]);
  });

  it("protects a stale claim when the attempt branch has a recent commit", async () => {
    const claimedIssues = async () => [
      {
        issue: 7,
        records: [claim(10, "h:w", 9999)],
        attemptBranchCommitS: NOW - 30,
      },
    ];
    const { deps, ghCalls } = makeDeps({ claimedIssues });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [] });
    expect(ghCalls.editLabels).toEqual([]);
  });

  it("still releases a stale claim when branch commits are older than the protection window", async () => {
    const claimedIssues = async () => [
      {
        issue: 7,
        records: [claim(10, "h:w", 9999)],
        attemptBranchCommitS: NOW - 31,
      },
    ];
    const { deps } = makeDeps({
      env: { RED_AFK_CLAIM_REAPER_RECENT_COMMIT_S: "30" },
      claimedIssues,
    });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [7] });
  });

  it("tolerates a claimedIssues listing failure (best-effort no-op)", async () => {
    const claimedIssues = async () => {
      throw new Error("gh down");
    };
    const { deps } = makeDeps({ claimedIssues });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [] });
  });

  it("removes running but does NOT add ready-for-agent when issue already has ready-for-human (#968)", async () => {
    // Scenario: crash recovery wrote ready-for-human but left the running projection.
    // The sweep must strip running without routing back to ready-for-agent, otherwise
    // the next worker's preflight-blocker concede leaves running again → infinite spin.
    const claimedIssues = async () => [{ issue: 55, records: [claim(10, "host1:wZZ", 99999)] }];
    const viewLabels = async (_issue: number) => ["running", "ready-for-human", "blocked:crashed"];
    const { deps, ghCalls } = makeDeps({ claimedIssues, viewLabels });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [55] });
    expect(ghCalls.editLabels).toEqual([
      { issue: 55, remove: ["running"], add: [] },
    ]);
    expect(ghCalls.comment).toHaveLength(1);
    expect(ghCalls.comment[0].issue).toBe(55);
  });

  it("sheds running but refuses the queue when dangling req:* edges remain (#2528)", async () => {
    // Poison shape: the issue still carries req:* edges without blocked:dependency.
    // The transition API refuses the queue — re-admitting it would hand a worker
    // an issue whose dependencies were never proven closed. Only `running` goes.
    const claimedIssues = async () => [{ issue: 66, records: [claim(10, "host1:wYY", 99999)] }];
    const viewLabels = async (_issue: number) => ["running", "req:2526"];
    const { deps, ghCalls } = makeDeps({ claimedIssues, viewLabels });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [66] });
    expect(ghCalls.editLabels).toEqual([
      { issue: 66, remove: ["running"], add: [] },
    ]);
  });

  it("skips (no-op) when running is already gone at viewLabels time (race)", async () => {
    // Batch fetch returned issue as running, but by the time viewLabels fires
    // another sweep or recovery already removed running — skip to avoid a
    // spurious ready-for-agent add.
    const claimedIssues = async () => [{ issue: 77, records: [claim(10, "host1:wAA", 99999)] }];
    const viewLabels = async (_issue: number) => ["ready-for-human", "blocked:crashed"];
    const { deps, ghCalls } = makeDeps({ claimedIssues, viewLabels });
    const r = await runBoot(deps, options());
    expect(r.staleClaimSweep).toEqual({ released: [77] });
    expect(ghCalls.editLabels).toEqual([]);
    expect(ghCalls.comment).toEqual([]);
  });
});
