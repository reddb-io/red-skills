import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBuildInfo } from "@reddb-io/build-info";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { createEnginePaths, createFileHealLedgerStore } from "@reddb-io/worker/engine";
import { hostFingerprintPrefix } from "../../core/host-identity.js";
import { auditConfigLoad, loadConfig, getConfig } from "../../core/config.js";
import { readWarmBundleCacheState } from "../../core/bundle-version.js";
import { readPublishedBundleVersion, refreshPublishedBundleVersion } from "../../core/published-version.js";
import { resolveBaseWithSource } from "../../core/base-resolver.js";
import { DEFAULT_BRANCH } from "../../core/pin-reader.js";
import type { PrecheckFacts, BootOptions, BootDeps, BootstrapInput, OrphanDir } from "../../core/boot.js";
import type { AttemptDir } from "../../core/reclaim.js";
import { LABEL_HUMAN, LABEL_READY, LABEL_RUNNING } from "../../core/triage-labels.js";
import { allWorkersRoots, parseReapableWorkerPath } from "../../core/worker-paths.js";
import { parseClaimRecords } from "../../core/claim.js";
import { workerStatePath } from "../../core/state.js";
import {
  collectFleetTruthProbeInput,
  collectLaneCensusProbeInput,
  collectProcessCensusProbeInput,
  HOST_PREREQUISITE_COMMANDS,
  type ClaimHygieneCommentInput,
  type ClaimHygieneIssueInput,
  type HostPrerequisiteProbeInput,
} from "../../core/operational-probes.js";
import { historyTrim } from "../../core/history.js";
import { evaluateFastForwardLocalTarget, fastForwardLocalTarget } from "../../core/merge.js";
import { liveIssueFromBranch, type IssueMeta } from "../../core/branch-cleanup.js";
import { readWorkerState } from "../../core/worker-state-reader.js";
import { isLivePid, killTreeAndWait } from "../kill-tree.js";
import { execTool, type ExecFn } from "../exec.js";
import { readWorkerLiveness } from "../liveness-anchor.js";
import { issueMeta, type GhContext, type IssueStateRow } from "../gh.js";
import * as ghx from "../gh.js";
import * as gitx from "../git.js";
import * as fsx from "../fs.js";
import { afkPaths, type RepoContext } from "./paths.js";
import { collectDocsSweepInput, landDocsSweep } from "./docs.js";

/** Heartbeat staleness ceiling for the fleet-truth probe, in seconds. */
const HEARTBEAT_STALE_S = 300;

export async function collectBootOptions(
  ctx: RepoContext,
  facts: PrecheckFacts,
  bootstrap: BootstrapInput,
  nowS: number,
): Promise<BootOptions> {
  const paths = afkPaths(ctx.root);
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

  // Orphan dirs + the same dirs grouped by issue for the cap pass.
  const orphans = (await Promise.all(allWorkersRoots(paths.tmpDir).map((root) => fsx.listOrphanDirs(root, nowS)))).flat();
  const byIssue = new Map<number, AttemptDir[]>();
  for (const o of orphans) {
    // Hygiene parser: legacy -a{n} dirs must stay REAPABLE (ADR 0103 #2170).
    const parsed = parseReapableWorkerPath(o.path);
    if (!parsed) continue;
    // Cap-pass liveness keeps the pid-identity verdict (a live attempt is
    // excluded from the cap even when briefly quiet), read through the single
    // owner so the schema + legacy-key shim apply here too.
    const live = readWorkerState(workerStatePath(o.path))?.live ?? false;
    const mtimeS = nowS - o.ageS;
    const list = byIssue.get(parsed.issue) ?? [];
    list.push({ path: o.path, mtimeS, live });
    byIssue.set(parsed.issue, list);
  }

  // Branch namespaces for the live reapers, the unblock-candidate listing, and
  // the stale claim-lock / pre-cutover work-* sweeps are mutually independent
  // reads — run them concurrently. (Stale-claim + legacy-work both probe pid
  // liveness at discovery so boot's orphan step stays a pure removal, #252.)
  const [
    remoteLiveRefs,
    localAll,
    checkedOut,
    landedLocalBranches,
    unblockCandidateRead,
    staleClaimDirs,
    legacyWorkDirs,
    reconcileSweepCandidates,
    specSubIssueCandidates,
  ] =
    await Promise.all([
      gitx.listRemoteBranches(gitCtx, "afk/"),
      gitx.listLocalBranches(gitCtx, "afk/*"),
      gitx.checkedOutBranches(gitCtx),
      // Read against the trunk's REMOTE ref: a stale local trunk under-reports
      // what has landed, and under-reporting only ever spares (#2866).
      gitx.listMergedLocalBranches(gitCtx, "afk/*", `origin/${facts.configuredTrunk ?? DEFAULT_BRANCH}`),
      ghx.listUnblockCandidates(ghCtx),
      fsx.listStaleClaimDirs(paths.tmpDir),
      fsx.listLegacyWorkDirs(paths.tmpDir),
      ghx.listParkedMechanicalCandidates(ghCtx),
      ghx.listSpecSubIssueCandidates(ghCtx, nowS),
      ghx.listIssueStates(ghCtx),
    ]);
  const localLiveRefs = localAll.filter((b) => !checkedOut.has(b)).map((b) => ({ branch: b }));

  return {
    precheck: facts,
    bootstrap,
    orphans: orphans as readonly OrphanDir[],
    attemptCap: { byIssue },
    branches: {
      remoteLiveRefs,
      localLiveRefs,
      landedLocalBranches,
      trunk: facts.configuredTrunk ?? DEFAULT_BRANCH,
    },
    unblockCandidates:
      unblockCandidateRead.outcome === "rows" ? unblockCandidateRead.rows : [],
    staleClaimDirs,
    legacyWorkDirs,
    reconcileSweepCandidates,
    docsSweep: await collectDocsSweepInput(ctx, facts.configuredTrunk ?? "main"),
    specSubIssueCandidates,
  };
}

export interface CollectPrecheckFactsOptions {
  readonly includeNpmBundleCoherence?: boolean;
  /** Detection-only doctor surface; AFK boot deliberately leaves it disabled. */
  readonly includeLaneCensus?: boolean;
  /** Detection-only doctor surface; AFK boot deliberately leaves it disabled. */
  readonly includeProcessCensus?: boolean;
  readonly laneCensusHostRoot?: string;
  readonly hostPrerequisiteExec?: ExecFn;
}

export interface CollectBootPrecheckFactsOptions extends CollectPrecheckFactsOptions {
  readonly log?: (line: string) => void;
}

export interface ClaimHygieneIssueScanDeps {
  readonly listCandidates: (label: string) => Promise<readonly { readonly number: number }[]>;
  readonly listClaimComments: (issue: number) => Promise<readonly ClaimHygieneCommentInput[]>;
}

/** Claim hygiene spans both executable and active lifecycle states. A fleet
 * relaunch must see claims stranded on `running` issues before workers spawn,
 * even when a later label reconcile would return those issues to the queue. */
export async function collectClaimHygieneIssues(
  deps: ClaimHygieneIssueScanDeps,
): Promise<readonly ClaimHygieneIssueInput[]> {
  const pools = await Promise.all([
    deps.listCandidates(LABEL_READY),
    deps.listCandidates(LABEL_RUNNING),
  ]);
  const issueNumbers = [...new Set(pools.flat().map((candidate) => candidate.number))];
  return Promise.all(
    issueNumbers.map(async (number) => ({
      number,
      comments: await deps.listClaimComments(number),
    })),
  );
}

/**
 * Boot-only precheck collector. The worktree quarantine must run before any
 * fetch-backed operational probe: a single initializing worktree with a
 * dangling HEAD can otherwise make the probe itself fail on every boot.
 * Read-only callers such as red-doctor continue to use collectPrecheckFacts.
 */
export async function collectBootPrecheckFacts(
  ctx: RepoContext,
  options: CollectBootPrecheckFactsOptions = {},
): Promise<PrecheckFacts> {
  const quarantined = await gitx.quarantineBrokenWorktrees({ cwd: ctx.root });
  for (const worktree of quarantined) {
    if (worktree.removed) {
      options.log?.(`boot janitor quarantined worktree path=${worktree.path} reason=${worktree.reason}`);
    } else {
      options.log?.(
        `boot janitor failed to quarantine worktree path=${worktree.path} reason=${worktree.reason}: ${worktree.error ?? "unknown git error"}`,
      );
    }
  }
  return collectPrecheckFacts(ctx, options);
}

export interface CollectHostPrerequisiteOptions {
  /** The environment whose PATH the lookup searches. Defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** The node the engine runs on. An input only so a test can pose a host. */
  readonly execPath?: string;
  /** Does this absolute path exist? Injected for the same reason. */
  readonly exists?: (path: string) => boolean;
}

export async function collectHostPrerequisiteProbeInput(
  exec: ExecFn = execTool,
  options: CollectHostPrerequisiteOptions = {},
): Promise<HostPrerequisiteProbeInput> {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const availability = await Promise.all(
    HOST_PREREQUISITE_COMMANDS.map(async (command) => {
      const result = await exec("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "host-prereq", command]);
      return [command, result.code === 0] as const;
    }),
  );
  const commands = Object.fromEntries(availability) as Record<
    (typeof HOST_PREREQUISITE_COMMANDS)[number],
    boolean
  >;
  // node is resolved from the engine's own interpreter when PATH does not carry
  // it (#3064). Probing a sanitized PATH for node while holding the absolute
  // path of the node this very process runs on is self-inflicted breakage, and
  // it reds out the whole version-manager class of hosts (mise, nvm, asdf,
  // volta) — i.e. most developer machines.
  if (!commands.node && execPath.trim() !== "" && exists(execPath)) commands.node = true;
  const searchedPath = env.PATH ?? "";
  const facts = { searchedPath, engineNodePath: execPath } as const;
  if (!commands.bash) return { commands, ...facts };

  try {
    const result = await exec("bash", ["--version"]);
    if (result.code === 0) return { commands, ...facts, bashVersion: result.stdout };
    return {
      commands,
      ...facts,
      bashVersion: result.stdout,
      bashVersionExitCode: result.code,
      bashVersionError: result.stderr.trim() || undefined,
    };
  } catch (error) {
    return {
      commands,
      ...facts,
      bashVersionError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function collectPrecheckFacts(
  ctx: RepoContext,
  options: CollectPrecheckFactsOptions = {},
): Promise<PrecheckFacts> {
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const { branchLockPath, readLockedBranch } = await import("../lock.js");
  const lockPath = branchLockPath(ctx.root);
  const paths = afkPaths(ctx.root);
  const configPath = paths.configPath;
  const configText = await fsx.readText(configPath);
  const configAudit = auditConfigLoad(configPath);
  const config = configAudit.values;
  const configLockedBranch = getConfig(config, "dev.lock.branch") || undefined;
  const configTrunk = getConfig(config, "dev.trunk") || undefined;
  const configuredTrunkSource = configLockedBranch?.trim() ? "pin" : "trunk";
  const [
    ghInstalled,
    ghAuthenticated,
    isRepo,
    remoteUrls,
    hasMain,
    currentBranch,
    pnpmProbe,
    lockedBranch,
    lockRaw,
    hostPrerequisites,
  ] =
    await Promise.all([
      ghx.ghInstalled(ghCtx),
      ghx.ghAuthenticated(ghCtx),
      gitx.isGitRepo(gitCtx),
      gitx.remoteUrlFacts(gitCtx),
      gitx.hasMainBranch(gitCtx),
      gitx.currentBranch(gitCtx),
      import("../exec.js").then((m) => m.pnpm(["--version"], { cwd: ctx.root })),
      readLockedBranch(lockPath),
      fsx.readText(lockPath),
      collectHostPrerequisiteProbeInput(options.hostPrerequisiteExec),
    ]);
  const resolvedFocalBranch = await resolveBaseWithSource(
    { issueBody: "" },
    {
      readLockedBranch: async () => lockedBranch,
      configLockedBranch,
      configTrunk,
      fetchIssueBody: async () => undefined,
    },
  );
  const configuredTrunk = resolvedFocalBranch.branch;
  const baseFreshnessDivergence = await gitx.localRemoteDivergence(gitCtx, {
    remote: ctx.remote,
    branch: configuredTrunk,
  });
  const baseFreshnessGuard = await evaluateFastForwardLocalTarget(gitx.mergeExec(gitCtx), {
    gitRepo: ctx.root,
    remote: ctx.remote,
    target: configuredTrunk,
  });
  const lockTargetExists = lockedBranch ? await gitx.branchExists(gitCtx, lockedBranch) : undefined;
  const pnpmInstalled = pnpmProbe.code !== 127;
  const installedBundleVersion = readBuildInfo("dev").version;
  const bundleCache = readWarmBundleCacheState(installedBundleVersion);
  // One definition of "published", shared with the fleet launch, so the skew the
  // probe reports is the skew a relaunch actually clears (#2808). That owner is
  // now `published-version.ts` (#2809), which additionally RECORDS the answer and
  // leaves it undefined when unresolved instead of substituting the running
  // bundle — the substitution is what let a stale local value read as `skew: 0`
  // while every Worker died of the skew it was hiding.
  let npmNewestVersion: string | undefined;
  let npmError: string | undefined;
  let published = readPublishedBundleVersion();
  if (options.includeNpmBundleCoherence) {
    try {
      // The one path that pays for the registry call records the answer, so the
      // status surfaces replay THIS resolution instead of deriving their own.
      published = await refreshPublishedBundleVersion(installedBundleVersion);
      npmNewestVersion = published.source === "registry" ? published.version ?? undefined : undefined;
    } catch (error) {
      npmError = error instanceof Error ? error.message : String(error);
    }
  }
  // The probe that halts a boot and the dashboard an operator reads resolve the
  // published version from the same owner (#2809). An unresolved answer stays
  // undefined here, so the probe records `version-unknown` rather than matching
  // the running bundle against a substituted local value.
  const latestBundleVersion = published.version ?? undefined;
  // How long a heartbeat may go unwritten before the fleet-truth probe calls the
  // lane stale. It was `resolveSupervisorConfig().supervisorStaleS`, one field of
  // the project-side supervisor config ADR 0148 deleted; the number is the same
  // 300 s the `RED_AFK_SUPERVISOR_STALE_S` default always spelled, kept as a
  // constant because the probe reads a lane the daemon writes now and there is no
  // longer a local loop whose cadence it has to agree with.
  const fleetTruth = await collectFleetTruthProbeInput(
    {
      supervisorPidPath: paths.supervisorPidPath,
      fleetStatePath: paths.fleetStatePath,
    },
    {
      heartbeatStaleMs: HEARTBEAT_STALE_S * 1000,
      latestBundleVersion,
    },
  );
  const workerPidState = (worker: string) => {
    const hostPrefix = hostFingerprintPrefix();
    if (!worker.startsWith(hostPrefix)) return "foreign" as const;
    const workerId = worker.slice(hostPrefix.length);
    if (!workerId) return "unknown" as const;
    const pidPath = join(paths.workersRoot, workerId, "worker.pid");
    if (!existsSync(pidPath)) return "dead" as const;
    try {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) return "dead" as const;
      return isLivePid(pid) ? "live" as const : "dead" as const;
    } catch {
      return "unknown" as const;
    }
  };
  return {
    ghInstalled,
    ghAuthenticated,
    isGitRepo: isRepo,
    remoteUrls,
    hasMainBranch: hasMain,
    currentBranch,
    lockedBranch,
    configuredTrunk,
    configuredTrunkSource,
    pnpmInstalled,
    hostPrerequisites,
    laneCensus: options.includeLaneCensus
      ? await collectLaneCensusProbeInput({
          projectRoot: ctx.root,
          hostRoot: options.laneCensusHostRoot ?? redskilledHomeDir(homedir()),
        })
      : undefined,
    processCensus: options.includeProcessCensus
      ? await collectProcessCensusProbeInput({ projectRoot: ctx.root })
      : undefined,
    // CI lanes (the GHA Actions lane) check out an https remote token-authed by
    // GITHUB_TOKEN — the intended setup — so the SSH-only rule must not fire there.
    allowHttpsRemote:
      process.env.RED_AFK_LANE === "actions" || process.env.GITHUB_ACTIONS === "true",
    queueVisibility: ctx.repo ? ghx.queueVisibilityProbeInput(ghCtx) : undefined,
    claimHygiene: ctx.repo
      ? {
          ownWorkerPrefix: hostFingerprintPrefix(),
          listOpenQueueIssues: () =>
            collectClaimHygieneIssues({
              listCandidates: (label) => ghx.listCandidates(ghCtx, label),
              listClaimComments: (issue) => ghx.listClaimComments(ghCtx, issue),
            }),
          workerPidState,
          // Enables the ADR 0066 TTL classification of unknown-pid markers
          // (#2525): an own-namespace claim whose owner stopped refreshing past
          // the stale window is concedable without proving the pid.
          nowS: Math.floor(Date.now() / 1000),
        }
      : undefined,
    labelBodyCoherence: ctx.repo
      ? {
          listOpenReadyIssues: async () => ghx.listCandidates(ghCtx, LABEL_READY),
        }
      : undefined,
    focalBranch: {
      resolved: resolvedFocalBranch,
      configuredTrunk: normalizeConfiguredTrunk(configTrunk),
      lock: lockRaw === null
        ? undefined
        : {
            raw: lockRaw,
            branch: lockedBranch,
            targetExists: lockTargetExists,
            heldByLiveSession: lockedBranch ? currentBranch === lockedBranch : false,
          },
    },
    baseFreshness: {
      trunk: configuredTrunk,
      remote: ctx.remote,
      ...baseFreshnessDivergence,
      guard: baseFreshnessGuard,
    },
    configCoherence: {
      path: configPath,
      displayPath: ".red/config.yaml",
      fileLoaded: configAudit.fileLoaded,
      discarded: configAudit.discarded,
      parseFailure: configAudit.parseFailure,
      rootAccessorCollisions: configAudit.rootAccessorCollisions,
      resolved: {
        trunk: normalizeConfiguredTrunk(configTrunk),
        gate: getConfig(config, "dev.lock.primary-branch"),
        lock: getConfig(config, "dev.lock.branch"),
      },
      sourceText: configText ?? undefined,
    },
    fleetTruth,
    bundleCoherence: {
      installedVersion: installedBundleVersion,
      pointerVersion: bundleCache.pointerVersion,
      laneNewestVersion: bundleCache.laneNewestVersion,
      npmNewestVersion,
      npmError,
      lastStatus: bundleCache.lastStatus,
      lastCheckAgeMs: bundleCache.lastCheckAgeMs,
      lastFailureAgeMs: bundleCache.lastFailureAgeMs,
      lastError: bundleCache.lastError,
    },
  };
}

function normalizeConfiguredTrunk(value: string | undefined): string {
  const trunk = value?.trim();
  return trunk && trunk.length > 0 ? trunk : DEFAULT_BRANCH;
}

async function resolveBranchIssueCache(
  ghCtx: GhContext,
  options: BootOptions,
  states: Map<number, IssueStateRow>,
): Promise<Map<number, IssueMeta | null | undefined>> {
  const issues = new Set<number>();
  for (const r of [...options.branches.remoteLiveRefs, ...options.branches.localLiveRefs]) {
    const n = liveIssueFromBranch(r.branch);
    if (n !== null) issues.add(n);
  }
  const cache = new Map<number, IssueMeta | null | undefined>();
  for (const n of issues) {
    const row = states.get(n);
    if (row) cache.set(n, { state: row.state, closedAt: row.closedAt });
    else cache.set(n, await issueMeta(ghCtx, n));
  }
  return cache;
}

/**
 * Build the real {@link BootDeps} for a full boot run — the fs/gh/git side
 * effects + per-issue lookups every sweep composes. ONE batched
 * `listIssueStates` fetch backs every per-issue boot lookup (orphan state,
 * branch state, blocker state); a map miss falls back to a live read so the
 * classification stays exact. Used by a solo `run` (sweeps run) and by the fleet
 * supervisor's pre-spawn boot (#623).
 */
export async function buildBootDeps(
  ctx: RepoContext,
  options: BootOptions,
  nowS: number,
  log?: (line: string) => void,
): Promise<BootDeps> {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const paths = afkPaths(ctx.root);
  const cfg = loadConfig(paths.configPath);
  // ONE batched issue-state fetch backs every per-issue boot lookup below.
  const issueStates = await ghx.listIssueStates(ghCtx);
  const branchCache = await resolveBranchIssueCache(ghCtx, options, issueStates);
  const trunk = options.branches.trunk ?? options.precheck.configuredTrunk ?? DEFAULT_BRANCH;
  const liveBranchCommitByIssue = new Map<number, number>();
  const liveBranchesByIssue = new Map<number, string[]>();
  for (const ref of options.branches.remoteLiveRefs) {
    const issue = liveIssueFromBranch(ref.branch);
    if (issue === null) continue;
    liveBranchesByIssue.set(issue, [...(liveBranchesByIssue.get(issue) ?? []), ref.branch]);
    if (!Number.isFinite(ref.commitS)) continue;
    const previous = liveBranchCommitByIssue.get(issue);
    if (previous === undefined || ref.commitS! > previous) liveBranchCommitByIssue.set(issue, ref.commitS!);
  }
  return {
    fs: {
      ensureDir: fsx.ensureDir,
      writeWorkerPid: fsx.writeWorkerPid,
      removeDir: fsx.removeDir,
      // The state record carries no workspace path, so its Worker is named
      // directly — the same daemon, asked the same question (#2978).
      workerStateRecordLivenessVerdict: async (workerId) =>
        (await readWorkerLiveness(workerId)).verdict,
      reapDeadEmptyWorkerShells: fsx.reapDeadEmptyWorkerShells,
      reapProcessGroup: (pgid) => killTreeAndWait(pgid),
    },
    trimHistory: () => historyTrim(paths.historyPath),
    gh: {
      ensureLabel: (name) => ghx.ensureLabel(ghCtx, name),
      editLabels: async (issue, remove, add) => {
        // Just the edit. It used to also nudge the statusline's local count cache
        // so a relabel showed up before the next TTL; that cache is gone and the
        // counts are the daemon's poll (ADR 0141 decision 2), which sees the same
        // relabel on its own cycle.
        if (!(await ghx.editLabels(ghCtx, issue, remove, add))) {
          throw new Error(`failed to edit labels for issue #${issue}`);
        }
      },
      comment: (issue, body) => ghx.comment(ghCtx, issue, body),
      editBody: async (issue, body) => {
        if (!(await ghx.editBody(ghCtx, issue, body))) {
          throw new Error(`failed to update quarantine diagnosis for issue #${issue}`);
        }
      },
      viewBody: (issue) => ghx.issueBody(ghCtx, issue),
      viewLabels: (issue) => ghx.viewLabels(ghCtx, issue),
      attachSubIssue: (parent, child) => ghx.attachSubIssue(ghCtx, parent, child),
      issueReference: (issue) => ghx.issueReference(ghCtx, issue),
    },
    git: {
      deleteRemoteBranch: (branch) => gitx.deleteRemoteBranch(gitCtx, branch),
      deleteLocalBranch: async (branch) => {
        await gitx.deleteLocalBranch(gitCtx, branch);
      },
      worktreePrune: () => gitx.worktreePrune(gitCtx),
    },
    log,
    fastForwardLocalBase: ({ remote, target }) =>
      fastForwardLocalTarget(gitx.mergeExec(gitCtx), { gitRepo: ctx.root, remote, target }),
    concedeClaim: ctx.repo
      ? async (issue, body) => {
          await ghx.postClaimComment(ghCtx, issue, body);
        }
      : undefined,
    claimEvictor: `${hostFingerprintPrefix()}supervisor`,
    healLedger: createFileHealLedgerStore(createEnginePaths(join(ctx.root, ".red"))),
    lookups: {
      // Live-claim ownership for the orphan sweep (#644): a dead attempt dir
      // naming an issue whose claims/{N}/pid is a LIVE process is claim-race
      // debris, not a mid-issue crash — the sweep removes it without touching
      // the winner's `running` label.
      claimHolderAlive: (issue) => fsx.claimPathHeldByLivePid(join(afkPaths(ctx.root).claimsDir, String(issue))),
      // Orphan state pairs gh issue state/label with the attempt dir's
      // envelope.posted flag (read from the state file, not gh). Derived from
      // the batched map, preserving ghx.orphanState's exact label/state →
      // verdict mapping (ready-for-human > running > null). On a map MISS the
      // issue isn't in the list window — fall back to the live read so a
      // truncated/just-created/transient issue still classifies correctly.
      orphanState: async (issue) => {
        const row = issueStates.get(issue);
        if (!row) return ghx.orphanState(ghCtx, issue);
        const label = row.labels.includes(LABEL_HUMAN)
          ? LABEL_HUMAN
          : row.labels.includes(LABEL_RUNNING)
            ? LABEL_RUNNING
            : null;
        return { ghOk: true, state: row.state, label, envelopePosted: false };
      },
      branchIssue: (issue) => branchCache.get(issue),
      // Blocker state from the batched map: row.state ("OPEN"/"CLOSED") or
      // undefined on a miss. undefined-on-miss exactly matches the prior
      // 404→undefined→not-closed semantics — a missing blocker stays
      // "open-or-unknown" and the dependent issue is NOT promoted.
      blockerState: async (issue) => issueStates.get(issue)?.state,
      straggler: {
        unlabeled: () => ghx.countUnlabeled(ghCtx),
        needsTriage: () => ghx.countNeedsTriage(ghCtx),
        needsInfo: () => ghx.countNeedsInfo(ghCtx),
      },
      // Cross-host stale-claim sweep input (#627): every OPEN issue projected as
      // `running` (a held claim) with its parsed claim marker records. Derived
      // from the batched issue-state map; the claim comments are read per-issue.
      // A per-issue read failure drops that issue from the sweep (best-effort).
      claimedIssues: async () => {
        const claimed = [];
        const hostPrefix = hostFingerprintPrefix();
        for (const [issue, row] of issueStates) {
          if (row.state !== "OPEN") continue;
          if (!row.labels.includes(LABEL_RUNNING)) continue;
          try {
            const comments = await ghx.listClaimComments(ghCtx, issue);
            const records = parseClaimRecords(comments);
            // Local holders are split by PROCESS evidence, not heartbeat age: a
            // live pid pins the claim (liveOwners), a missing/dead pid frees it
            // immediately (deadOwners). Remote holders appear in neither set and
            // fall through to the heartbeat TTL inside the planner.
            const localOwners = records
              .map((r) => r.worker)
              .filter((worker, idx, workers) => workers.indexOf(worker) === idx)
              .filter((worker) => worker.startsWith(hostPrefix));
            const liveOwners: string[] = [];
            const deadOwners: string[] = [];
            for (const worker of localOwners) {
              const workerId = worker.slice(hostPrefix.length);
              if (!workerId) continue;
              const pidPath = join(paths.workersRoot, workerId, "worker.pid");
              const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) : Number.NaN;
              (Number.isInteger(pid) && isLivePid(pid) ? liveOwners : deadOwners).push(worker);
            }
            const attemptBranches = deadOwners.length === 0
              ? undefined
              : await Promise.all((liveBranchesByIssue.get(issue) ?? []).map(async (branch) => {
                  const commitsAhead = await gitx.branchCommitsAhead(
                    gitCtx,
                    branch,
                    trunk,
                  );
                  return {
                    branch,
                    ...(commitsAhead === undefined ? {} : { commitsAhead }),
                  };
                }));
            claimed.push({
              issue,
              records,
              deadOwners,
              liveOwners,
              attemptBranchCommitS: liveBranchCommitByIssue.get(issue),
              ...(attemptBranches === undefined ? {} : { attemptBranches }),
            });
          } catch {
            // best-effort: skip an issue whose claim comments cannot be read.
          }
        }
        return claimed;
      },
    },
    nowS,
    config: cfg,
    docsSweepLander: (plan) => landDocsSweep(ctx, plan),
  };
}

/**
 * Build a MINIMAL {@link BootDeps} for a supervised worker whose boot skips
 * every shared sweep (#623, `RED_AFK_SWEEPS_DONE`). `runBoot` with
 * `skipSweeps:true` touches only `deps.fs` (the bootstrap mkdir / gitignore /
 * worker.pid writes) and `deps.nowS` before returning, so the gh/git/lookup
 * closures are never reached — they are present only to satisfy the type and
 * throw if ever called, which would surface a regression that let a skip-boot
 * fall through into a sweep. This deliberately AVOIDS the batched
 * `listIssueStates` + branch-cache resolution {@link buildBootDeps} pays, which
 * is the whole point: a respawned worker's boot must be cheap.
 */
export function buildMinimalBootDeps(ctx: RepoContext, nowS: number): BootDeps {
  const unreachable = (): never => {
    throw new Error("buildMinimalBootDeps: sweep IO invoked on a skip-sweeps boot (#623)");
  };
  return {
    fs: {
      ensureDir: fsx.ensureDir,
      writeWorkerPid: fsx.writeWorkerPid,
      removeDir: fsx.removeDir,
    },
    trimHistory: async () => unreachable(),
    gh: {
      editLabels: async () => unreachable(),
      comment: async () => unreachable(),
      viewLabels: async () => unreachable(),
      attachSubIssue: async () => unreachable(),
    },
    git: {
      deleteRemoteBranch: async () => unreachable(),
      deleteLocalBranch: async () => unreachable(),
    },
    lookups: {
      orphanState: async () => unreachable(),
      branchIssue: () => unreachable(),
      blockerState: async () => unreachable(),
      straggler: {
        unlabeled: async () => unreachable(),
        needsTriage: async () => unreachable(),
        needsInfo: async () => unreachable(),
      },
    },
    nowS,
    docsSweepLander: async () => unreachable(),
  };
}
