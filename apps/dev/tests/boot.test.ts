import { describe, expect, it } from "vitest";
import {
  precheck,
  runBoot,
  type BootDeps,
  type BootOptions,
  type OrphanDir,
  type PrecheckFacts,
  type ReconcileBootRunner,
} from "../src/core/boot.js";
import type { AttemptDir } from "../src/core/reclaim.js";
import type { BranchRef, IssueMeta } from "../src/core/branch-cleanup.js";
import type { UnblockCandidate, ReconcileSweepCandidate } from "../src/core/boot-sweep.js";

const DAY = 86400;
const NOW = 1700000000;

// ---------- precheck ----------

function facts(over: Partial<PrecheckFacts> = {}): PrecheckFacts {
  return {
    ghInstalled: true,
    ghAuthenticated: true,
    isGitRepo: true,
    remoteUrls: ["git@github.com:reddb-io/red-skills.git"],
    hasMainBranch: true,
    currentBranch: "main",
    pnpmInstalled: true,
    ...over,
  };
}

describe("precheck", () => {
  it("passes with no warnings when every precondition holds", () => {
    expect(precheck(facts())).toEqual({ ok: true, warnings: [] });
  });

  it("fails gh-missing first", () => {
    expect(precheck(facts({ ghInstalled: false, ghAuthenticated: false }))).toEqual({
      ok: false,
      failed: "gh-missing",
    });
  });

  it("fails gh-unauthenticated", () => {
    expect(precheck(facts({ ghAuthenticated: false }))).toEqual({
      ok: false,
      failed: "gh-unauthenticated",
    });
  });

  it("fails not-a-git-repo", () => {
    expect(precheck(facts({ isGitRepo: false }))).toEqual({
      ok: false,
      failed: "not-a-git-repo",
    });
  });

  it("rejects an https remote, naming the offending url", () => {
    expect(
      precheck(facts({ remoteUrls: ["https://github.com/reddb-io/red-skills.git"] })),
    ).toEqual({
      ok: false,
      failed: "https-remote-forbidden",
      detail: "https://github.com/reddb-io/red-skills.git",
    });
  });

  it("allows an https remote in a CI lane (allowHttpsRemote) — GHA checkout is token-https", () => {
    // The Actions lane checks out an https remote authed by GITHUB_TOKEN; the
    // SSH-only rule must not fire there or every cloud attempt dies at precheck.
    expect(
      precheck(
        facts({
          remoteUrls: ["https://github.com/reddb-io/red-skills.git"],
          allowHttpsRemote: true,
        }),
      ),
    ).toEqual({ ok: true, warnings: [] });
  });

  it("fails no-main-branch", () => {
    expect(precheck(facts({ hasMainBranch: false }))).toEqual({
      ok: false,
      failed: "no-main-branch",
    });
  });

  it("fails not-on-main, naming the current branch", () => {
    expect(precheck(facts({ currentBranch: "feature/x" }))).toEqual({
      ok: false,
      failed: "not-on-main",
      detail: "feature/x",
    });
  });

  it("locked: passes when currentBranch matches the lock value", () => {
    expect(precheck(facts({ currentBranch: "feature-locked", lockedBranch: "feature-locked" }))).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("locked: fails not-on-main when currentBranch is main instead of the lock value", () => {
    expect(precheck(facts({ currentBranch: "main", lockedBranch: "feature-locked" }))).toEqual({
      ok: false,
      failed: "not-on-main",
      detail: "main",
    });
  });

  it("locked: fails not-on-main when currentBranch is a different branch than the lock value", () => {
    expect(precheck(facts({ currentBranch: "other-branch", lockedBranch: "feature-locked" }))).toEqual({
      ok: false,
      failed: "not-on-main",
      detail: "other-branch",
    });
  });

  it("treats a missing pnpm as a warning, not a failure", () => {
    const r = precheck(facts({ pnpmInstalled: false }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual(["pnpm not on PATH; feedback loops will be skipped"]);
  });
});

// ---------- runBoot harness ----------

/** A recording fake for every injected op, with a global call-order log so the
 * step ORDER can be asserted. */
function makeDeps(over: Partial<{
  orphanState: BootDeps["lookups"]["orphanState"];
  branchIssue: BootDeps["lookups"]["branchIssue"];
  blockerState: BootDeps["lookups"]["blockerState"];
  straggler: BootDeps["lookups"]["straggler"];
  claimHolderAlive: BootDeps["lookups"]["claimHolderAlive"];
  env: Record<string, string | undefined>;
  reconcileRunner: ReconcileBootRunner;
}> = {}) {
  const calls: string[] = [];
  const fsCalls = {
    ensureDir: [] as string[],
    gitignore: [] as string[],
    workerPid: [] as Array<{ path: string; pid: number }>,
    removeDir: [] as string[],
  };
  const ghCalls = {
    editLabels: [] as Array<{ issue: number; remove: string[]; add: string[] }>,
    comment: [] as Array<{ issue: number; body: string }>,
  };
  const gitCalls = {
    deleteRemote: [] as string[],
    deleteLocal: [] as string[],
  };

  const deps: BootDeps = {
    fs: {
      async ensureDir(p) {
        calls.push(`fs.ensureDir:${p}`);
        fsCalls.ensureDir.push(p);
      },
      async ensureGitignoreLine(_gi, line) {
        calls.push(`fs.gitignore:${line}`);
        fsCalls.gitignore.push(line);
      },
      async writeWorkerPid(path, pid) {
        calls.push(`fs.workerPid:${path}`);
        fsCalls.workerPid.push({ path, pid });
      },
      async removeDir(p) {
        calls.push(`fs.removeDir:${p}`);
        fsCalls.removeDir.push(p);
      },
    },
    gh: {
      async editLabels(issue, remove, add) {
        calls.push(`gh.editLabels:${issue}`);
        ghCalls.editLabels.push({ issue, remove, add });
      },
      async comment(issue, body) {
        calls.push(`gh.comment:${issue}`);
        ghCalls.comment.push({ issue, body });
      },
    },
    git: {
      async deleteRemoteBranch(branch) {
        calls.push(`git.deleteRemote:${branch}`);
        gitCalls.deleteRemote.push(branch);
      },
      async deleteLocalBranch(branch) {
        calls.push(`git.deleteLocal:${branch}`);
        gitCalls.deleteLocal.push(branch);
      },
    },
    lookups: {
      orphanState:
        over.orphanState ??
        (async () => ({ ghOk: true, state: "OPEN", label: null, envelopePosted: false })),
      branchIssue: over.branchIssue ?? (() => ({ state: "OPEN" }) as IssueMeta),
      blockerState: over.blockerState ?? (async () => "OPEN"),
      straggler:
        over.straggler ?? {
          unlabeled: async () => 0,
          needsTriage: async () => 0,
          needsInfo: async () => 0,
        },
      ...(over.claimHolderAlive ? { claimHolderAlive: over.claimHolderAlive } : {}),
    },
    nowS: NOW,
    env: over.env ?? {},
    ...(over.reconcileRunner ? { reconcileRunner: over.reconcileRunner } : {}),
  };

  return { deps, calls, fsCalls, ghCalls, gitCalls };
}

function options(over: Partial<BootOptions> = {}): BootOptions {
  return {
    precheck: facts(),
    bootstrap: {
      tmpDir: "/p/.red/tmp",
      stateDir: "/p/.red/state",
      gitignorePath: "/p/.gitignore",
      workerDir: "/p/.red/tmp/workers/wAAA",
      workerPidFile: "/p/.red/tmp/workers/wAAA/worker.pid",
      workerPid: 4242,
    },
    orphans: [],
    attemptCap: { byIssue: new Map() },
    branches: { snapshotRefs: [], remoteLiveRefs: [], localLiveRefs: [] },
    unblockCandidates: [],
    ...over,
  };
}

function attempt(issue: number, num: number, ageS: number, live = false): AttemptDir {
  return { path: `/p/.red/tmp/workers/wAAA/${issue}-a${num}`, mtimeS: NOW - ageS, live };
}

describe("runBoot precheck short-circuit", () => {
  it("aborts before bootstrap on a precheck failure", async () => {
    const { deps, calls } = makeDeps();
    const result = await runBoot(deps, options({ precheck: facts({ ghInstalled: false }) }));
    expect(result.precheck).toEqual({ ok: false, failed: "gh-missing" });
    expect(result.bootstrap).toBeUndefined();
    expect(result.orphanCleanup).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("runBoot bootstrap", () => {
  it("ensures dirs, gitignore lines, and writes worker.pid", async () => {
    const { deps, fsCalls } = makeDeps();
    await runBoot(deps, options());
    expect(fsCalls.ensureDir).toEqual([
      "/p/.red/tmp",
      "/p/.red/state",
      "/p/.red/tmp/workers/wAAA",
    ]);
    expect(fsCalls.gitignore).toEqual([".red/tmp/", ".red/state/"]);
    expect(fsCalls.workerPid).toEqual([
      { path: "/p/.red/tmp/workers/wAAA/worker.pid", pid: 4242 },
    ]);
  });
});

describe("runBoot skipSweeps — supervisor-owned boot (#623)", () => {
  it("runs precheck + bootstrap then returns before every sweep", async () => {
    const { deps, calls, fsCalls } = makeDeps();
    // Provide sweep INPUTS that would normally trigger work, to prove they are
    // ignored once skipSweeps is set: an orphan dir, an attempt-cap group, a
    // reapable branch, and an unblock candidate.
    const result = await runBoot(
      deps,
      options({
        skipSweeps: true,
        orphans: [{ path: "/d/orphan", issue: 7, ageS: 999_999 }],
        attemptCap: { byIssue: new Map([[7, [attempt(7, 1, 999_999)]]]) },
        branches: { snapshotRefs: [{ branch: "afk-attempts/7-x" }], remoteLiveRefs: [], localLiveRefs: [] },
        unblockCandidates: [{ number: 9, body: "", labels: ["blocked:dependency", "req:1"] }],
      }),
    );

    // Bootstrap still ran (dirs + gitignore + worker.pid).
    expect(fsCalls.ensureDir).toEqual([
      "/p/.red/tmp",
      "/p/.red/state",
      "/p/.red/tmp/workers/wAAA",
    ]);
    expect(fsCalls.workerPid).toHaveLength(1);
    // …but NOTHING else: no removeDir, no gh, no git — every sweep was skipped.
    expect(fsCalls.removeDir).toEqual([]);
    expect(calls.filter((c) => c.startsWith("gh.") || c.startsWith("git."))).toEqual([]);

    // The result carries only precheck + bootstrap; every sweep field is absent.
    expect(result.precheck.ok).toBe(true);
    expect(result.bootstrap).toEqual({ ok: true });
    expect(result.orphanCleanup).toBeUndefined();
    expect(result.attemptCap).toBeUndefined();
    expect(result.branchCleanup).toBeUndefined();
    expect(result.unblockSweep).toBeUndefined();
    expect(result.reconcileSweep).toBeUndefined();
    expect(result.straggler).toBeUndefined();
  });

  it("still aborts on a precheck failure before bootstrap", async () => {
    const { deps, calls } = makeDeps();
    const result = await runBoot(
      deps,
      options({ skipSweeps: true, precheck: facts({ ghInstalled: false }) }),
    );
    expect(result.precheck).toEqual({ ok: false, failed: "gh-missing" });
    expect(result.bootstrap).toBeUndefined();
    expect(calls).toEqual([]);
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
  it("reaps age- and count-capped dirs, keeps live and newest", async () => {
    const { deps, fsCalls } = makeDeps({ env: { RED_AFK_ATTEMPT_KEEP: "2" } });
    const byIssue = new Map<number, AttemptDir[]>([
      [
        42,
        [
          attempt(42, 1, 20 * DAY), // age-capped (default ttl 14d)
          attempt(42, 2, 1 * DAY),
          attempt(42, 3, 1 * DAY),
          attempt(42, 4, 1 * DAY),
          attempt(42, 5, 1 * DAY, true), // live → spared, not counted
        ],
      ],
    ]);
    const r = await runBoot(deps, options({ attemptCap: { byIssue } }));
    // a1 age-capped; survivors a2,a3,a4 with keep=2 → drop a2 (oldest by number).
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
  it("reaps closed snapshot/remote-live remotely and local-live locally", async () => {
    const closed: IssueMeta = { state: "CLOSED", closedAt: "2000-01-01T00:00:00Z" };
    const branchIssue: BootDeps["lookups"]["branchIssue"] = (issue) =>
      issue === 9 ? closed : ({ state: "OPEN" } as IssueMeta);
    const { deps, gitCalls } = makeDeps({ branchIssue });
    const snapshotRefs: BranchRef[] = [
      { branch: "afk-attempts/wAAA/9-slug", commitS: NOW - 30 * DAY },
      { branch: "afk-attempts/wAAA/3-open" }, // open → kept
    ];
    const remoteLiveRefs: BranchRef[] = [
      { branch: "afk/wAAA/9-slug" },
      { branch: "afk/wAAA/3-open" }, // open → kept
    ];
    const localLiveRefs: BranchRef[] = [{ branch: "afk/wAAA/9-local" }];
    const r = await runBoot(
      deps,
      options({ branches: { snapshotRefs, remoteLiveRefs, localLiveRefs } }),
    );
    expect(gitCalls.deleteRemote).toEqual(["afk-attempts/wAAA/9-slug", "afk/wAAA/9-slug"]);
    expect(gitCalls.deleteLocal).toEqual(["afk/wAAA/9-local"]);
    expect(r.branchCleanup).toEqual({
      snapshotReaped: ["afk-attempts/wAAA/9-slug"],
      remoteLiveReaped: ["afk/wAAA/9-slug"],
      localLiveReaped: ["afk/wAAA/9-local"],
    });
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
      { issue: 100, remove: ["blocked:dependency"], add: ["ready-for-agent"] },
    ]);
    expect(ghCalls.comment).toEqual([
      { issue: 100, body: "🤖 /afk unblocked: all dependencies closed (#10, #11)." },
    ]);
    expect(r.unblockSweep).toEqual({ promoted: [100] });
  });
});

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
      options({ reconcileSweepCandidates: [stalled], branches: { snapshotRefs: [], remoteLiveRefs, localLiveRefs: [] } }),
    );
    expect(r.reconcileSweep).toEqual({ landed: [], parked: [], skipped: [] });
  });

  it("green → landed when runner returns 'landed'", async () => {
    const reconcileRunner: ReconcileBootRunner = async () => ({ outcome: "landed" });
    const { deps } = makeDeps({ reconcileRunner });
    const r = await runBoot(
      deps,
      options({ reconcileSweepCandidates: [stalled], branches: { snapshotRefs: [], remoteLiveRefs, localLiveRefs: [] } }),
    );
    expect(r.reconcileSweep).toEqual({ landed: [50], parked: [], skipped: [] });
  });

  it("red → parked when runner returns 'parked'", async () => {
    const reconcileRunner: ReconcileBootRunner = async () => ({ outcome: "parked" });
    const { deps } = makeDeps({ reconcileRunner });
    const r = await runBoot(
      deps,
      options({ reconcileSweepCandidates: [crashed], branches: { snapshotRefs: [], remoteLiveRefs, localLiveRefs: [] } }),
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
      options({ reconcileSweepCandidates: [noBranch], branches: { snapshotRefs: [], remoteLiveRefs, localLiveRefs: [] } }),
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
      options({ reconcileSweepCandidates: [stalled], branches: { snapshotRefs: [], remoteLiveRefs, localLiveRefs: [] } }),
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
        branches: { snapshotRefs: [], remoteLiveRefs, localLiveRefs: [] },
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
        snapshotRefs: [{ branch: "afk-attempts/wAAA/9-s", commitS: NOW - 30 * DAY }],
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
      "git.deleteRemote:afk-attempts/wAAA/9-s", // snapshot cleanup
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
