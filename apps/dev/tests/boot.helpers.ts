import {
  precheck,
  runBoot,
  type BootDeps,
  type BootOptions,
  BootHaltError,
  type OrphanDir,
  type PrecheckFacts,
  type ReconcileBootRunner,
} from "../src/core/boot.js";
import type { AttemptDir } from "../src/core/reclaim.js";
import type { BranchRef, IssueMeta } from "../src/core/branch-cleanup.js";
import type { UnblockCandidate, ReconcileSweepCandidate } from "../src/core/boot-sweep.js";

export { precheck, runBoot, BootHaltError };
export type {
  BootDeps,
  BootOptions,
  OrphanDir,
  PrecheckFacts,
  ReconcileBootRunner,
  AttemptDir,
  BranchRef,
  IssueMeta,
  UnblockCandidate,
  ReconcileSweepCandidate,
};

export const DAY = 86400;
export const NOW = 1700000000;

export function facts(over: Partial<PrecheckFacts> = {}): PrecheckFacts {
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

/** A recording fake for every injected op, with a global call-order log so the
 * step ORDER can be asserted. */
export function makeDeps(over: Partial<{
  orphanState: BootDeps["lookups"]["orphanState"];
  branchIssue: BootDeps["lookups"]["branchIssue"];
  blockerState: BootDeps["lookups"]["blockerState"];
  straggler: BootDeps["lookups"]["straggler"];
  claimHolderAlive: BootDeps["lookups"]["claimHolderAlive"];
  claimedIssues: BootDeps["lookups"]["claimedIssues"];
  workerLivenessVerdict: BootDeps["fs"]["workerLivenessVerdict"];
  workerWorkspaceLivenessVerdict: BootDeps["fs"]["workerWorkspaceLivenessVerdict"];
  workerStateRecordLivenessVerdict: BootDeps["fs"]["workerStateRecordLivenessVerdict"];
  trimHistory: BootDeps["trimHistory"];
  viewLabels: (issue: number) => Promise<string[]>;
  env: Record<string, string | undefined>;
  config: Record<string, string | undefined>;
  reconcileRunner: ReconcileBootRunner;
  docsSweepLander: BootDeps["docsSweepLander"];
  fastForwardLocalBase: BootDeps["fastForwardLocalBase"];
  log: BootDeps["log"];
}> = {}) {
  const calls: string[] = [];
  const fsCalls = {
    ensureDir: [] as string[],
    workerPid: [] as Array<{ path: string; pid: number }>,
    removeDir: [] as string[],
  };
  const ghCalls = {
    editLabels: [] as Array<{ issue: number; remove: string[]; add: string[] }>,
    comment: [] as Array<{ issue: number; body: string }>,
    viewLabels: [] as Array<{ issue: number }>,
    attachSubIssue: [] as Array<{ parent: number; child: number }>,
  };
  const gitCalls = {
    deleteRemote: [] as string[],
    deleteLocal: [] as string[],
    worktreePrune: 0,
  };

  const deps: BootDeps = {
    fs: {
      async ensureDir(p) {
        calls.push(`fs.ensureDir:${p}`);
        fsCalls.ensureDir.push(p);
      },
      async writeWorkerPid(path, pid) {
        calls.push(`fs.workerPid:${path}`);
        fsCalls.workerPid.push({ path, pid });
      },
      async removeDir(p) {
        calls.push(`fs.removeDir:${p}`);
        fsCalls.removeDir.push(p);
      },
      ...(over.workerLivenessVerdict
        ? {
            async workerLivenessVerdict(workerDir: string) {
              calls.push(`fs.workerLivenessVerdict:${workerDir}`);
              return over.workerLivenessVerdict!(workerDir);
            },
          }
        : {}),
      ...(over.workerWorkspaceLivenessVerdict
        ? {
            async workerWorkspaceLivenessVerdict(path: string) {
              calls.push(`fs.workerWorkspaceLivenessVerdict:${path}`);
              return over.workerWorkspaceLivenessVerdict!(path);
            },
          }
        : {}),
      ...(over.workerStateRecordLivenessVerdict
        ? {
            async workerStateRecordLivenessVerdict(workerId: string) {
              calls.push(`fs.workerStateRecordLivenessVerdict:${workerId}`);
              return over.workerStateRecordLivenessVerdict!(workerId);
            },
          }
        : {}),
    },
    trimHistory: over.trimHistory ?? (async () => null),
    gh: {
      async editLabels(issue, remove, add) {
        calls.push(`gh.editLabels:${issue}`);
        ghCalls.editLabels.push({ issue, remove, add });
      },
      async comment(issue, body) {
        calls.push(`gh.comment:${issue}`);
        ghCalls.comment.push({ issue, body });
      },
      async viewLabels(issue) {
        calls.push(`gh.viewLabels:${issue}`);
        ghCalls.viewLabels.push({ issue });
        return over.viewLabels ? over.viewLabels(issue) : ["running"];
      },
      async attachSubIssue(parent, child) {
        calls.push(`gh.attachSubIssue:${parent}:${child}`);
        ghCalls.attachSubIssue.push({ parent, child });
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
      async worktreePrune() {
        calls.push("git.worktreePrune");
        gitCalls.worktreePrune += 1;
      },
    },
    ...(over.log ? { log: over.log } : {}),
    ...(over.fastForwardLocalBase ? { fastForwardLocalBase: over.fastForwardLocalBase } : {}),
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
      ...(over.claimedIssues ? { claimedIssues: over.claimedIssues } : {}),
    },
    nowS: NOW,
    env: over.env ?? {},
    config: over.config ?? {},
    ...(over.reconcileRunner ? { reconcileRunner: over.reconcileRunner } : {}),
    ...(over.docsSweepLander ? { docsSweepLander: over.docsSweepLander } : {}),
  };

  return { deps, calls, fsCalls, ghCalls, gitCalls };
}

export function options(over: Partial<BootOptions> = {}): BootOptions {
  return {
    precheck: facts(),
    bootstrap: {
      tmpDir: "/p/.red/tmp",
      stateDir: "/p/.red/state",
      workerDir: "/p/.red/tmp/workers/wAAA",
      workerPidFile: "/p/.red/tmp/workers/wAAA/worker.pid",
      workerPid: 4242,
    },
    orphans: [],
    attemptCap: { byIssue: new Map() },
    branches: { remoteLiveRefs: [], localLiveRefs: [] },
    unblockCandidates: [],
    ...over,
  };
}

export function attempt(issue: number, num: number, ageS: number, live = false): AttemptDir {
  return { path: `/p/.red/tmp/workers/wAAA/${issue}-a${num}`, mtimeS: NOW - ageS, live };
}
