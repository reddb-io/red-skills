import type { ProcessIssueDeps } from "../../core/process-issue.js";
import type { Runner } from "../../types/runner.js";
import {
  afkPaths,
  resolveRunSettings,
  type RepoContext,
} from "../../runtime/wire.js";
import type { LaneIdleStallConfig } from "../../core/lane-idle-reaper.js";
import { workerPidFile } from "../../core/worker-paths.js";
import { makeClaimLock } from "./claim-lease.js";
import { Output } from "@reddb-io/red-castle";
import * as gitx from "../../runtime/git.js";
import * as fsx from "../../runtime/fs.js";
import type { GhContext } from "../../runtime/gh.js";
import type { GitContext } from "../../runtime/git.js";
import { execTool, type ExecFn } from "../../runtime/exec.js";
import {
  getConfig,
  loadConfig,
  readPostWorkerFormat,
  readValidationMoments,
  readValidationResourceBudget,
  resolveTaskRoute,
  resolveTier,
  resolveCiTimeoutSeconds,
  resolveMergeQueueTimeoutSeconds,
} from "../../core/config.js";
import type { TaskRouteOverrides } from "../../core/config.js";
import {
  makeExtractAdversarialReview,
  resolveAdversarialReviewConfig,
  type AdversarialReviewFindings,
} from "../../core/adversarial-review.js";
import { defaultSandcastleDeps, DEFAULT_MAX_ITERATIONS } from "../../core/execution.js";
import { resolveSandboxImageName } from "../../core/execution/sandbox-image.js";
import { resolveNotesLoopConfig } from "../../core/notes-loop.js";
import { resolveOutputShapingConfig } from "../../core/output-shaping.js";
import {
  classifyIssue,
  resolveReviewGate,
  type IssueClassificationMetadata,
} from "../../core/issue-classifier.js";
import { toAgentRunner } from "../../core/runner-spec.js";
import { LABEL_READY_FOR_REVIEW } from "../../core/triage-labels.js";
import { createEnginePaths, createFileHealLedgerStore } from "@reddb-io/red-castle/engine";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pluginEnabledInConfig } from "@reddb-io/shared/plugin-gate.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import { configFile } from "@reddb-io/shared/red-paths.js";
import { spawn } from "node:child_process";
import { claudeSpawnArgs, codexSpawnArgs } from "../../core/runner-spawn.js";
import { createLandLock } from "../../runtime/land-lock.js";
import type { FeedbackWorktree } from "../../runtime/feedback-worktree.js";
import { deathCauseForRecoveredWorker } from "../../core/process-safety.js";
import { join } from "node:path";
import { hostFingerprintPrefix } from "../../core/host-identity.js";
import { updateState, workerStatePath } from "../../core/state.js";
import { buildProgressHeartbeat, formatIterationMarker } from "../../core/heartbeat.js";
import { resolveAttemptLoc, locMemoPath } from "../../core/loc-memo.js";
import { createActivityMeter } from "../../core/activity-meter.js";
import { resolveImplementerPluginRoots } from "../../runtime/implementer-environment.js";
import { createCastleWorkerLaneBridge } from "../../core/castle-worker-lane-bridge.js";
import { createWorkerLogLinePublisher } from "../../runtime/redskilled-worker-log.js";
import { createDevGithubMergeRead } from "../../runtime/github-merge-read.js";
import { makeStaleClaimPredicate, resolveClaimStalenessConfig } from "../../core/claim-staleness.js";
import {
  createFileQueueCustodyStore,
  handoffQueueCustody,
} from "../../core/queue-custodian.js";

import type { CurrentAttempt } from "./attempt.js";
import { deriveActivity } from "./activity.js";
import { makeImplementerRunAgent } from "./implementer-run-agent.js";
import { makeAgentConflictResolver, makeMechanicalConflictResolver } from "./reconcile.js";
import { runLinkedSubagent } from "./linked-subagent.js";
import { buildClaimGhPort, buildGhPort, buildReseedTrailPort, buildReviewPorts } from "./ports/gh.js";
import { buildGitPorts } from "./ports/git.js";
import { buildFsPort } from "./ports/fs.js";
import { buildHooks } from "./ports/hooks.js";
import { buildEnvelopePort } from "./ports/envelope.js";
import { buildLookups } from "./ports/lookups.js";
import { makeMechanicalRegenerator } from "./ports/mechanical-regeneration.js";
import { realDirectoryProbe } from "../../core/validation-command.js";
import {
  castleWorktreeUnder,
  decodeLocMemoSnapshot,
  encodeLocMemoSnapshot,
  readCapturedWorktreePath,
} from "./state.js";

const LANDING_GH_PROBE_TIMEOUT_MS = 60_000;
/** Poll spacing for the queued-merge confirmation (#2986). A merge group takes
 * minutes, so a tighter interval would only spend GitHub quota. */
const MERGE_QUEUE_POLL_INTERVAL_MS = 15_000;

export function parseSlot(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Everything `buildProcessDeps` needs, named. Replaces the 13 positional
 * params the assembly used to take — a call site could silently swap two
 * same-typed neighbours (model/workerId, inlineVerifyCommand/…) and typecheck. */
export interface BuildProcessDepsOptions {
  ctx: RepoContext;
  model: string;
  sandbox: ReturnType<typeof resolveRunSettings>["sandbox"];
  feedback: FeedbackWorktree;
  current: CurrentAttempt;
  fallbackRunner: boolean;
  runner: Runner;
  routeOverrides?: TaskRouteOverrides;
  exec?: ExecFn;
  maxIterations?: number;
  laneIdle?: LaneIdleStallConfig;
  inlineVerifyCommand?: string;
  goVerifyRetries?: number;
  workerId?: string;
}

export function buildProcessDeps({
  ctx,
  model,
  sandbox,
  feedback,
  current,
  fallbackRunner,
  runner,
  routeOverrides,
  exec,
  maxIterations,
  laneIdle,
  inlineVerifyCommand,
  goVerifyRetries,
  workerId = "unknown",
}: BuildProcessDepsOptions): ProcessIssueDeps {
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo, exec };
  const gitCtx: GitContext = { cwd: ctx.root, exec, ghProbeTimeoutMs: LANDING_GH_PROBE_TIMEOUT_MS };
  const paths = afkPaths(ctx.root);
  const queueCustodyStore = createFileQueueCustodyStore(
    join(ctx.root, ".red", "state", "afk", "queue-custody.toon"),
  );
  // The same beat reaches the host here too (#3079); null when this Worker was
  // not born by the daemon, so a direct `run` publishes nothing.
  const publishHostLogLine = createWorkerLogLinePublisher({ root: ctx.root });
  const castleBridge = createCastleWorkerLaneBridge({
    redRoot: join(ctx.root, ".red"),
    workerId,
    attemptDir: () => current.attemptDir,
    ...(publishHostLogLine == null ? {} : { publishHostLogLine }),
  });
  // Per-agentic-iteration boundary tracking (observability): when sandcastle's
  // re-invocation count (event.iteration) ticks, emit "iteration N ended/started"
  // markers. Reset per attempt — a new attempt's run restarts at iteration 1
  // (detected by the attempt dir changing or the count going backwards).
  const iterMax = maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let lastIter = 0;
  let lastIterDir = "";
  // Per-attempt stream-activity meter (slice 1 liveness metrics): counts
  // toolCall/text events and derives waiting windows. Re-created when the
  // attempt dir changes so counts never bleed across the attempt boundary.
  let activityMeter = createActivityMeter();
  let activityMeterDir = "";
  // Last diff volume observed by the heartbeat sink, so the on_heartbeat vitals
  // provider (#832) can report loc_added/loc_removed alongside the meter's
  // activity counters without re-shelling `git diff`.
  let lastHeartbeatDiff = { added: 0, removed: 0 };
  // Per-attempt peak diff: the largest diff seen by the heartbeat for this attempt.
  // Reset at attempt boundaries (same guard as activityMeter). Written to the state
  // file so the statusline can show a sticky last-known value when the live diff
  // transiently drops to 0 (e.g. during the feedback gate).
  let peakLocAdded = 0;
  let peakLocRemoved = 0;
  let peakLocDir = "";

  // ---- lifecycle hooks: load config + resolve built-in defaults + real exec ----
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  let configText = "";
  try {
    configText = readFileSync(paths.configPath, "utf8");
  } catch {
    // The strict activation gate stays closed when config is absent/unreadable.
  }
  const implementerPluginRoots = resolveImplementerPluginRoots({
    repoRoot: ctx.root,
    env: process.env,
  });
  // Repo-level container image for the isolation path (#2340) — resolved off the
  // repo root, never off the per-attempt worktree, so the tag is prebuildable.
  const sandboxImage = resolveSandboxImageName({
    repoRoot: ctx.root,
    configured: getConfig(config, "afk.sandbox_image"),
    envOverride: process.env.RED_AFK_SANDBOX_IMAGE,
  });
  let githubMergeRead: ReturnType<typeof createDevGithubMergeRead> | undefined;
  const routedGithub = () => githubMergeRead ??= createDevGithubMergeRead(ctx.root, `worker:${workerId}`);

  // Merge-gate policy (ADR 0048). Default off → the unlocked admin-merge ignores
  // advisory review checks (drift-guard + in-process backpressure stay the
  // binding gates). When `afk.merge.wait_for_review` is true, the unlocked
  // landing holds until the configured review check (`afk.merge.review_check`)
  // concludes, then merges regardless of the verdict.
  const waitForReview =
    getConfig(config, "afk.merge.wait_for_review") === "true"
      ? {
          check: getConfig(config, "afk.merge.review_check") || "CodeRabbit",
          github: routedGithub(),
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          probeTimeoutMs: LANDING_GH_PROBE_TIMEOUT_MS,
        }
      : undefined;

  const configuredLandingWait = getConfig(config, "afk.landing.wait");
  const landingWait: NonNullable<ProcessIssueDeps["landingWait"]> =
    configuredLandingWait === "ci" || configuredLandingWait === "none"
      ? configuredLandingWait
      : "merge";

  // CI-aware merge (#812). Default off → the unlocked admin-merge fires
  // immediately (fine on a base with NO required status checks). When
  // `afk.merge.ci_aware` is true, the unlocked landing first polls the PR's merge
  // state and admin-merges ONLY once it settles — because an admin-merge cannot
  // bypass required checks on an `enforce_admins` base, so merging a just-opened
  // PR with checks pending is rejected and was mislabelled `merge-conflict`. The
  // poll budget comes from `RED_AFK_MERGE_CI_TIMEOUT_S` (default 1800s) at a fixed
  // 10s cadence; on timeout the open, MERGEABLE PR is handed off (no agent re-run).
  const ciAwait =
    getConfig(config, "afk.merge.ci_aware") === "true" || landingWait !== "merge"
      ? {
          github: routedGithub(),
          sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          intervalMs: 10_000,
          maxPolls: Math.max(1, Math.ceil(resolveCiTimeoutSeconds(process.env) / 10)),
          probeTimeoutMs: LANDING_GH_PROBE_TIMEOUT_MS,
        }
      : undefined;

  // PR review gate (ADR 0064 §10, #749). Default off → AFK keeps fast-merging
  // every tier. When enabled, a NON-mechanical attempt (classified tier at/above
  // `afk.review_gate.threshold`) gets `ready-for-review` on its PR and holds the
  // merge for a fresh-agent review; mechanical/trivial work fast-merges as today.
  const reviewGate = resolveReviewGate(config);
  const adversarialReview = resolveAdversarialReviewConfig((key) => getConfig(config, key));
  const extractAdversarialReview =
    adversarialReview.enabled
      ? async (input: {
          context: Parameters<ReturnType<typeof makeExtractAdversarialReview>>[0]["context"];
          runner: Runner;
          model: string;
          effort?: ProcessIssueDeps["effort"];
          maxIterations: number;
        }): Promise<AdversarialReviewFindings> => {
          const sandcastle = await defaultSandcastleDeps();
          const extract = makeExtractAdversarialReview({
            run: sandcastle.run as Parameters<typeof makeExtractAdversarialReview>[0]["run"],
            agentFor: sandcastle.agentFor,
            sandboxFor: (mode) => sandcastle.sandboxFor(mode),
            output: ({ tag, schema, maxRetries }) => Output.object({ tag, schema, maxRetries }),
            cwd: ctx.root,
          });
          return extract({ ...input, runner: toAgentRunner(input.runner) });
        }
      : undefined;

  // Landing-mode flag (ADR 0030 amended, #842), decoupled from the lock. Default
  // true → the attempt lands via an admin-merged PR into the resolved base; false
  // → a direct merge into that base (offline, no PR). The lock only resolves the
  // base (ADR 0031). Honours the namespaced + legacy fallback via loadConfig.
  const worktreeLaunchesPr = getConfig(config, "afk.worktree_launches_pull_request") !== "false";

  // Serialized landing (#1337, Spec #1333 root cause 2). Two workers finishing in
  // the same window used to both integrate-and-push into the base: the second push
  // was rejected non-fast-forward, and re-integrating an overlapping diff conflicted.
  //
  //   afk.merge.native_queue: true → `<base>` has the forge's merge queue; the PR is
  //     ENQUEUED and no local lock is taken (the queue rebases + revalidates each
  //     entry onto the current tip itself).
  //   otherwise → a global land-lock at `.red/tmp/afk-land.lock`, scoping mutual
  //     exclusion to every AFK worker landing into this repo on this host. Default
  //     ON; `afk.merge.land_lock: false` opts out into the pre-#1337 unserialized land.
  const nativeMergeQueue = getConfig(config, "afk.merge.native_queue") === "true";
  const landLock =
    nativeMergeQueue || getConfig(config, "afk.merge.land_lock") === "false"
      ? undefined
      : createLandLock(paths.tmpDir, `pid-${process.pid}`);

  // Intra-attempt notes-loop (Track C, #924). Default OFF → exactly one agent
  // call. When enabled, processIssue wraps the inner invocation in a bounded
  // outer loop carrying an accumulated `notes.md` between iterations.
  const notesLoop = resolveNotesLoopConfig(config);
  const outputShaping = resolveOutputShapingConfig(config);

  const validationMoments = readValidationMoments(config);
  if (inlineVerifyCommand && inlineVerifyCommand.trim() !== "") {
    validationMoments.post_done = [
      ...(validationMoments.post_done ?? []),
      inlineVerifyCommand.trim(),
    ];
  }

  return {
    gh: buildGhPort(ghCtx),
    claimGh: buildClaimGhPort(ghCtx),
    // The Re-seed trail's Issue half (#2731): one comment, edited in place.
    reseedTrailGh: buildReseedTrailPort(ghCtx),
    // Cross-host stale-claim recovery (#627, ADR 0066): a claim whose owner
    // stopped refreshing past `cadence × (tolerance + 1)` is presumed dead and
    // released by this sweep. The clock is sampled once per issue at deps build;
    // the policy comes from RED_AFK_CLAIM_REFRESH_S / RED_AFK_CLAIM_STALE_TOLERANCE.
    claimStale: makeStaleClaimPredicate(
      Math.floor(Date.now() / 1000),
      resolveClaimStalenessConfig(process.env),
    ),
    // AFK runner improvement (Pattern 5 — make the diagnostic actionable): when
    // a stale-claim recovery releases a SAME-HOST predecessor, read its
    // process-safety diagnostic log and surface the death cause in the recovery
    // audit comment. The self identity only needs the host for the same-host
    // gate (a cross-host predecessor's log isn't on this filesystem).
    recoveredWorkerDeathCause: (recoveredWorker) =>
      deathCauseForRecoveredWorker(paths.tmpDir, recoveredWorker, hostFingerprintPrefix()),
    claimLock: makeClaimLock(paths.tmpDir, workerId),
    fs: buildFsPort(paths),
    ...buildGitPorts(gitCtx, ctx.remote),
    // ADR 0103: no exit-time salvage and no exit receipt. Work reaches origin as
    // the agent commits (the continuous-push hook, issue #191); a worktree still
    // dirty when the worker exits is disposable, and the terminal Envelope plus
    // those pushed commits are the forensic record.
    // Validation runs against a checkout of the worker branch — the feedback
    // worktree manager materialises pnpm/layout onto that fixed branch tip.
    pnpm: feedback.pnpm,
    baseMergeReversionGeometry: feedback.baseMergeReversionGeometry,
    requireBranchReversionSafety: true,
    validationResourceBudget: readValidationResourceBudget(config),
    validationMoments,
    mechanicalRegenerate: makeMechanicalRegenerator(() => current.attemptDir, exec),
    // The gate's proof that a declared validation worktree is really there
    // (#3041): a landing worktree that vanished refuses as an infrastructure
    // error instead of composing commands against a path that resolves nowhere.
    dirExists: realDirectoryProbe,
    layout: feedback.layout,
    // Declared-command executor (ADR 0135): the shell port that runs the
    // operator's Validation-moment commands against the worker-branch checkout.
    backpressure: feedback.backpressure,
    outputShaping,
    ...buildReviewPorts(ghCtx),
    adversarialReview,
    extractAdversarialReview,
    goVerifyRetries,
    reseedGateBudget: (() => {
      const raw = getConfig(config, "dev.reseed.afk.gate_budget");
      const parsed = raw === undefined ? NaN : Number(raw);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
    })(),
    // Post-attempt-format step (#1015): operator-declared `afk.post_attempt_format`
    // commands run BEFORE the feedback gate and auto-commit any formatting delta.
    postWorkerFormat: feedback.postWorkerFormat,
    postWorkerFormatCommands: readPostWorkerFormat(config),
    runAgent: makeImplementerRunAgent({
      root: ctx.root, workerId, current, config, configText,
      pluginRoots: implementerPluginRoots, castleBridge, sandbox,
      maxIterations, laneIdle, sandboxImage,
    }),
    sandboxMode: sandbox,
    sandboxAvailable: async (mode) => {
      const run = exec ?? execTool;
      return (await run("sh", ["-c", `command -v ${mode}`], { cwd: ctx.root })).code === 0;
    },
    sandboxImage,
    // Preflight image probe (#2340): `<mode> image inspect` is cheap and local,
    // so the forced-isolation policy can park with a build command instead of
    // letting the provider crash the attempt on a missing image.
    sandboxImageAvailable: async (mode, image) => {
      const run = exec ?? execTool;
      return (await run(mode, ["image", "inspect", image], { cwd: ctx.root })).code === 0;
    },
    model,
    classifyIssue: makeIssueClassifier(config, runner, ctx.root, exec),
    resolveRoute: (taskClass = "think") => resolveTaskRoute(config, taskClass, routeOverrides),
    resolveTier: (activeRunner, taskClass = "think") => resolveTier(config, activeRunner, taskClass, process.env),
    fallbackRunner,
    waitForReview,
    ciAwait,
    landingWait,
    queueCustody: (identity, armNativeIntent) => handoffQueueCustody(
      {
        store: queueCustodyStore,
        now: () => new Date().toISOString(),
        armNativeIntent,
      },
      identity,
    ),
    landingTailObserver:
      landingWait === "merge"
        ? undefined
        : async (task) => {
            if (!exec) {
              // Fleet slots are `run --once` processes. Keeping the wait as an
              // in-process promise would keep that OS process alive and would
              // not release the supervisor slot at all. The production path
              // therefore hands the tail to one detached, ephemeral observer.
              // `rsp wait pr` itself consumes the resident webhook singleton
              // when present and falls back to its per-wait forwarder when not.
              const timeoutS = resolveCiTimeoutSeconds(process.env);
              const script = [
                'if [ "$1" = "wait" ]; then',
                '  rsp wait pr "$2" --timeout "$3" --reason "finish AFK landing for issue $5" || exit $?',
                "fi",
                'gh -R "$4" pr merge "$2" --merge --delete-branch || exit $?',
                'gh -R "$4" issue close "$5" --reason completed >/dev/null 2>&1 || true',
                'gh -R "$4" issue edit "$5" --remove-label running >/dev/null 2>&1 || true',
              ].join("\n");
              const child = spawn(
                "sh",
                [
                  "-c",
                  script,
                  "landing-tail",
                  task.waitForCi ? "wait" : "ready",
                  String(task.prNumber),
                  `${timeoutS}s`,
                  ctx.repo,
                  String(task.issue),
                ],
                {
                  cwd: ctx.root,
                  env: process.env,
                  detached: true,
                  stdio: "ignore",
                },
              );
              child.unref();
              // The detached observer owns completion. A permanently pending
              // promise carries that fact to processIssue without keeping the
              // event loop alive; an orphaned observer is intentionally left as
              // the deadend-audit class described by the Spec.
              return await new Promise<never>(() => undefined);
            }
            if (task.waitForCi) {
              // `rsp wait pr` is the shared wait/webhook observer: it consumes
              // the resident singleton's event lane when a holder exists and
              // transparently starts the established per-wait forwarder when
              // it does not. A non-success verdict falls back to the landing
              // primitive's one-shot classifier so conflict/failed/pending keep
              // their existing terminal routes.
              const timeoutS = resolveCiTimeoutSeconds(process.env);
              const waited = await exec(
                "rsp",
                [
                  "wait",
                  "pr",
                  String(task.prNumber),
                  "--timeout",
                  `${timeoutS}s`,
                  "--reason",
                  `finish AFK landing for issue ${task.issue}`,
                ],
                { cwd: ctx.root },
              );
              if (waited.code === 0) return task.run(true);
            }
            return task.run();
          },
    worktreeLaunchesPr,
    landLock,
    nativeMergeQueue,
    // #2986: `gh pr merge --auto` exits 0 on ENQUEUE. This is the budget the
    // landing holds for while the forge builds the merge group and runs its CI —
    // nothing closes the issue or deletes the branch until the PR says merged.
    mergeQueueWait: {
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      intervalMs: MERGE_QUEUE_POLL_INTERVAL_MS,
      maxPolls: Math.max(
        1,
        Math.ceil(resolveMergeQueueTimeoutSeconds(process.env) / (MERGE_QUEUE_POLL_INTERVAL_MS / 1000)),
      ),
      probeTimeoutMs: LANDING_GH_PROBE_TIMEOUT_MS,
    },
    reviewGate,
    reviewGateLabel: LABEL_READY_FOR_REVIEW,
    // One-shot merge-conflict resolver (merge_resolve_conflict): re-enter the
    // configured runner in the LANDING WORKTREE (`cwd`, the isolated checkout the
    // locked merge happens in, #572) with the resolver prompt. The merge primitive
    // verifies git state afterwards, so a non-zero / thrown runner here is
    // swallowed. Mirrors run_claude / run_codex on the conflicted checkout.
    conflictResolver: async (prompt: string, cwd: string) => {
      const conflictTier = resolveTier(config, runner, "think", process.env);
      const invocation =
        runner === "codex"
          ? codexSpawnArgs({
              prompt,
              worktree: cwd,
              lastMessagePath: paths.mergeResolveScratchPath,
              model: conflictTier.model,
              effort: conflictTier.effort,
            })
          : claudeSpawnArgs({ prompt, worktree: cwd });
      await runLinkedSubagent({ runner, phase: "merge-resolver", invocation, cwd, bridge: castleBridge, exec: exec ?? execTool });
    },
    resolveMechanicalConflict: makeMechanicalConflictResolver(gitCtx),
    resolveAgentConflict: makeAgentConflictResolver({ config, runner, paths, bridge: castleBridge, exec: exec ?? execTool }),
    maxAgentConflictResolveAttempts: 2,
    // Isolated landing worktree for the LOCKED path (#572): a detached worktree at
    // <base> so the locked merge/push/rollback never `git -C`'s the primary
    // checkout. The primary branch is sacred — a rejected push's `reset --hard`
    // only rewinds this throwaway worktree, never the primary's WIP. A stale dir
    // from a prior crash is removed first so `worktree add` does not collide.
    makeLandingWorktree: async (base: string) => {
      const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
      const slug = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "base";
      const dest = join(paths.landingWorktreesDir, `${slug}-${slot}`);
      await gitx.worktreeRemove(gitCtx, dest);
      const added = await gitx.worktreeAdd(gitCtx, dest, base);
      if (!added.ok) gitx.warnWorktreeAdd(dest, base, added.stderr);
      return added.ok ? dest : null;
    },
    removeLandingWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
    // Isolated worker-branch worktree for the PR path's pre-merge rebase (#1006):
    // fetch base + rebase the branch + force-push run here, never the primary.
    makeRebaseWorktree: async (branch: string) => {
      const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
      const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
      const dest = join(paths.rebaseWorktreesDir, `${slug}-${slot}`);
      await gitx.worktreeRemove(gitCtx, dest);
      const added = await gitx.worktreeAdd(gitCtx, dest, branch);
      if (!added.ok) gitx.warnWorktreeAdd(dest, branch, added.stderr);
      return added.ok ? dest : null;
    },
    removeRebaseWorktree: (dir: string) => gitx.worktreeRemove(gitCtx, dir),
    hooks: buildHooks({
      config,
      root: ctx.root,
      repo: ctx.repo,
      runner,
      slot: parseSlot(process.env.RED_AFK_SLOT),
    }),
    lookups: buildLookups({ ghCtx, gitCtx, paths, config, exec }),
    envelope: buildEnvelopePort(ghCtx, gitCtx, current),
    nowEpoch: () => Math.floor(Date.now() / 1000),
    nowIso: () => new Date().toISOString(),
    // Orchestrator narration shares the Worker's canonical structured log.
    appendIterLog: (line) => {
      void castleBridge.log(line).catch(() => {});
    },
    workerLogPath: join(paths.workersRoot, workerId, "worker.log.toonl"),
    // Native-path liveness (#284 observability gap): sandcastle captures the
    // inner agent's stream itself. Forward each event into Worker activity and
    // liveness state while the file display writes its readable structured row.
    // Best-effort: lane-write failures are swallowed so observability can never
    // break a run (sandcastle also swallows any throw from this callback).
    recordAgentEvent: (event) => {
      const ts = new Date().toISOString();
      // Raw stdout lines (sandcastle 0.11.0 verbose stream `{type:"raw"}`) are
      // noisy per-line output, not assistant turns. Keep it in the canonical log
      // for diagnostics, but do not count it as an activity unit.
      if (event.type === "raw") {
        void castleBridge.log(event.line).catch(() => {});
        return;
      }
      if (event.type === "sessionId") {
        void castleBridge.log(`session ${event.sessionId}`).catch(() => {});
        return;
      }
      // Agentic-iteration boundary markers. Emit "iteration N ended" + "iteration N+1 started" when
      // sandcastle's re-invocation count advances, so a run burning through
      // iterations (re-validating instead of emitting DONE) is visible.
      const dir0 = current.attemptDir;
      if (dir0 !== lastIterDir) {
        lastIterDir = dir0;
        lastIter = 0; // new attempt → fresh iteration count
      }
      // New attempt → fresh activity meter (counts must not bleed across attempts).
      if (dir0 !== activityMeterDir) {
        activityMeterDir = dir0;
        activityMeter = createActivityMeter();
      }
      // New attempt → reset peak diff (peaks are per-attempt, not per-worker).
      if (dir0 !== peakLocDir) {
        peakLocDir = dir0;
        peakLocAdded = 0;
        peakLocRemoved = 0;
      }
      if (
        event.type === "text" ||
        event.type === "toolCall" ||
        event.type === "reasoning" ||
        event.type === "usage"
      ) {
        activityMeter.record(event);
      }
      if (event.iteration !== lastIter) {
        const emit = (line: string): void => {
          void castleBridge.log(line).catch(() => {});
        };
        if (lastIter > 0) emit(formatIterationMarker(lastIter, "ended", iterMax));
        lastIter = event.iteration;
        emit(formatIterationMarker(lastIter, "started", iterMax));
        void updateState(workerStatePath(dir0), { "current.iteration": String(lastIter) }).catch(() => {});
      }
      const msg =
        event.type === "text"
          ? event.message
          : event.type === "reasoning"
            ? `🧠 reasoning${
                event.tokens ? ` (${event.tokens} tok)` : event.message ? `: ${event.message.slice(0, 80)}` : ""
              }`
            : event.type === "usage"
              ? `💰 usage (in:${event.inputTokens} out:${event.outputTokens}${
                  event.reasoningTokens ? ` reason:${event.reasoningTokens}` : ""
                })`
              : event.type === "result"
                ? `result: ${event.result}`
                : `→ ${event.name} ${event.formattedArgs}`;
      void castleBridge.record("worker.heartbeat", {
        event: event.type,
        iteration: String(event.iteration),
      }).catch(() => {});
      // The file display already renders agent text + tool calls into the Worker
      // log, so re-appending the formatted callback message would double turns.
      // Advance the monitor's state view on recognised tool-call transitions
      // (bounded write rate vs every text chunk — the lane mtime above is the
      // stall-detector's liveness signal; this is the dashboard's activity/last).
      // `last_event_at` (the honest liveness clock, ADR 0065) is stamped on every
      // DISCRETE event — tool/reasoning/usage/result, not per-text-chunk — so it advances
      // every few seconds for an active worker even between commits.
      const activity = deriveActivity(event);
      const discrete =
        event.type === "toolCall" ||
        event.type === "reasoning" ||
        event.type === "usage" ||
        event.type === "result";
      // A `usage` event is the only carrier of the cost group, and for claude it
      // arrives exactly ONCE — on the terminal result line, AFTER the last
      // heartbeat poll and just before the agent exits. The ~60s heartbeat is
      // what normally folds the meter's cost into state, but it never fires again
      // once the agent completes, so a single-iteration claude run persisted
      // cost_usd=0 despite real token spend. Flush the cumulative cost from the
      // meter the instant a usage event lands (ADR 0065). Idempotent: codex emits
      // many usage events and each just re-stamps the running total.
      const costPatch =
        event.type === "usage"
          ? {
              "current.input_tokens": activityMeter.peek().inputTokens,
              "current.output_tokens": activityMeter.peek().outputTokens,
              "current.cost_usd": activityMeter.peek().costUsd,
              // The context LEVEL rides the same flush (#3097): it is read off the
              // very event that carries the cost group, and a dashboard cell that
              // only refreshed on the ~60s heartbeat would show a window occupancy
              // from two turns ago.
              "current.context_tokens": activityMeter.peek().contextTokens,
            }
          : {};
      if (activity || discrete) {
        void updateState(workerStatePath(current.attemptDir), {
          ...(activity ? { "current.activity": activity, "current.last_stream_line": msg.slice(0, 200) } : {}),
          // Any inner-agent stream activity means we are in the macro `coding`
          // phase (collapses explore/impl/tests/commit — the fine activity lives in
          // the description, so the title never flickers, issue #811). Idempotent:
          // re-stamping `coding` each event is a no-op write.
          "current.phase": "coding",
          "current.last_event_at": ts,
          ...costPatch,
        }).catch(() => {});
      }
    },
    // Worker-vitals heartbeat sink (ADR 0065/0103): the independent vitals
    // sampler fires this every ~20s (and the codex stream pulse opportunistically
    // in between) with the live progress signal. Append the readable heartbeat
    // to the Worker log and mirror
    // `current.{last_progress_at,diff_added,diff_removed}` into the state file, so
    // each tick shows how the attempt is evolving and the monitor's +A -R stays
    // fresh between its sparse 10-min ticks (#448). Best-effort — swallowed.
    emitHeartbeat: (info) => {
      const ts = new Date().toISOString();
      const secs = Math.max(0, Math.floor((info.nowMs - info.lastProgressMs) / 1000));
      const lastProgressAt = new Date(info.lastProgressMs).toISOString();
      const head = info.head ?? "";
      void (async () => {
        // The castle creates the agent's worktree at the conventional direct
        // `{workerWorkspace}/worktree` child. Source of truth = the path it records from its
        // `onWorktreeReady` hook (its `pwd` in the real worktree); reconstructing
        // it from the primary's worktree registry is unreliable for mirror-owned
        // worktrees, so every codex tick once read a permanent `+0 -0`.
        // The probe/legacy fallbacks stay only for the window before the hook
        // runs. Persist the resolved path into `current.worktree` so the monitor
        // (which reads that field for its own diffstat) gets the live path too.
        const worktree =
          readCapturedWorktreePath(current.attemptDir) ??
          (await gitx.worktreePathUnder(gitCtx, current.attemptDir).catch(() => undefined)) ??
          castleWorktreeUnder(current.attemptDir) ??
          join(current.attemptDir, "worktree");
        // Fall back to the configured Trunk (ADR 0083), not a literal "main".
        const baseRef = info.base
          ? `origin/${info.base}`
          : `origin/${getConfig(config, "dev.trunk") || "main"}`;
        // Writer-side LOC ownership (#1210 Part B): the render paths no longer
        // shell out to `git diff --shortstat`, so this heartbeat is the runner-
        // agnostic owner that stamps loc_added/loc_removed for ALL runners (codex
        // included). The COMMITTED delta is EXPENSIVE but stable between commits,
        // so memoize it against the current HEAD sha in the attempt dir — computed
        // at most once per commit; while HEAD is unchanged the memoized volume is
        // served without spawning git. The UNCOMMITTED working-tree delta is
        // recomputed every tick and added on top (#1224 Part A): a codex worker
        // never commits, so its HEAD sha is frozen and ONLY the working-tree diff
        // reflects its work — memoizing the combined volume on HEAD sha would
        // freeze the first tick's `+0 -0` for the whole attempt. The claude
        // incremental path is unaffected: a new commit moves the delta into the
        // sha-keyed committed memo. Render stays git-free either way.
        const memoPath = locMemoPath(current.attemptDir, "/");
        const { added, removed } = await resolveAttemptLoc({
          headSha: head,
          compute: () =>
            gitx.diffstatCommitted({ cwd: worktree }, baseRef).catch(() => ({ added: 0, removed: 0 })),
          computeUncommitted: () =>
            gitx.diffstatUncommitted({ cwd: worktree }).catch(() => ({ added: 0, removed: 0 })),
          readMemo: () => {
            // The memo file is ABSENT on the first heartbeat of every attempt,
            // and a codex worker (no incremental commits) never creates one at
            // all — so `readFileSync` throws ENOENT here on EVERY tick. The
            // `resolveAttemptLoc` contract is that `readMemo` returns null when
            // "absent/unreadable"; an uncaught throw instead propagated out of
            // the heartbeat's async body BEFORE it stamped loc or wrote its
            // record, leaving codex vitals a permanent `+0 -0` (0 heartbeat
            // records). Fail closed to null so a missing/corrupt memo just forces
            // a recompute (the committed delta), never a lost stamp.
            try {
              return decodeLocMemoSnapshot(readFileSync(memoPath, "utf8"));
            } catch {
              return null;
            }
          },
          writeMemo: (m) => {
            try {
              writeFileSync(memoPath, encodeLocMemoSnapshot(m), "utf8");
            } catch {
              // best-effort, like the surrounding heartbeat writes
            }
          },
        });
        // Remember the volume for the on_heartbeat vitals provider (#832).
        lastHeartbeatDiff = { added, removed };
        // Update the per-attempt peak diff (only grows; never decreases).
        if (added > peakLocAdded) peakLocAdded = added;
        if (removed > peakLocRemoved) peakLocRemoved = removed;
        // Close this heartbeat window on the meter — derives the waiting count
        // (a window with no new stream events) and snapshots the cumulative
        // tool/text counts to fold into the record + state.
        const activity = activityMeter.snapshotWindow();
        const hb = buildProgressHeartbeat({
          secsSinceProgress: secs,
          lastProgressAt,
          head,
          added,
          removed,
          activity,
        });
        await updateState(workerStatePath(current.attemptDir), {
          ...hb.statePatch,
          "current.loc_peak_added": peakLocAdded,
          "current.loc_peak_removed": peakLocRemoved,
          "current.worktree": worktree,
          ...(info.base ? { "current.base": info.base } : {}),
        }).catch(() => {});
        await castleBridge.record("worker.heartbeat", {
          signal: "vitals-sampler",
          seconds_since_progress: secs,
          head,
        }, `[heartbeat] ${hb.msg}`).catch(() => {});
      })();
    },
    // Worker-vitals provider for the on_heartbeat hook context (ADR 0065/#832):
    // the live cumulative activity counters from the attempt's meter plus the
    // last-observed diff volume, under their canonical WorkerVitals names. Read
    // each vitals sample right before the on_heartbeat hook fires.
    heartbeatVitals: () => {
      const a = activityMeter.peek();
      return {
        tools_called_count: a.toolsCalled,
        text_chunk_count: a.textChunks,
        reasoning_events: a.reasoningCount,
        reasoning_tokens: a.reasoningTokens,
        waiting_count: a.waiting,
        input_tokens: a.inputTokens,
        output_tokens: a.outputTokens,
        cost_usd: a.costUsd,
        context_tokens: a.contextTokens,
        loc_added: lastHeartbeatDiff.added,
        loc_removed: lastHeartbeatDiff.removed,
      };
    },
    // Intra-attempt notes-loop (Track C, #924). `notesLoop` is the resolved
    // `afk.notes_loop.*` config (default OFF). `writeNotes` persists the loop's
    // carried `notes.md` at the attempt dir — outside the worker branch's
    // worktree, so it is never committed. Best-effort: a write failure must never
    // fail the attempt.
    notesLoop,
    writeNotes: (path, content) => {
      try {
        writeFileSync(path, content, "utf8");
      } catch {
        /* best-effort: notes are also carried in-process */
      }
    },
    // Macro-lifecycle phase stamp (issue #811): processIssue calls this at the
    // orchestrator-owned points the agent stream can't see — `validating` at the
    // feedback gate, `merging` at landing. Best-effort, swallowed; the calm title
    // signal must never fail the run.
    markPhase: (phase) => {
      void (async () => {
        await updateState(workerStatePath(current.attemptDir), {
          "current.phase": phase,
        }).catch(() => {});
        await castleBridge.snapshot().catch(() => {});
      })();
    },
    markState: (patch) => {
      void (async () => {
        await updateState(workerStatePath(current.attemptDir), patch).catch(() => {});
        await castleBridge.snapshot().catch(() => {});
      })();
    },
    recordWorkerEvent: (kind, payload) => {
      void castleBridge.record(kind, payload).catch(() => {});
    },
    historyPath: paths.historyPath,
    historyClock: { ts: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000) },
    // BOUNDED auto-recovery reads its RED_AFK_RETRY_* caps from the process env.
    recoveryEnv: process.env,
    // ADR 0122 heal ledger (#2576): merge-retry accounting shared with the
    // death-sweep and boot healer — one per-issue budget across all belts.
    healLedger: createFileHealLedgerStore(createEnginePaths(join(ctx.root, ".red"))),
    // ADR 0017: best-effort AFK→Memory "reasoning attempt" recording. Serialise
    // the payload to a temp JSON file under the attempt dir, then exec the memory
    // CLI DIRECTLY (`<memoryCli> attempt record --root <root>` with the payload on
    // stdin). The resolver gates on memory availability (ADR 0009) — a silent
    // no-op when memory is absent / not opted-in — replacing the old shell-bridge
    // hop. ALL errors are swallowed (one warn line), so a memory failure can
    // NEVER fail the close.
    recordOutcomeEvent: makeRecordOutcomeEvent(ctx.root, current, exec),
    // Spec cascade rebase (issue #1007): after a successful DONE landing, rebase
    // every open sibling branch (same spec:N, not held by a live worker) onto the
    // pinned landing commit. Best-effort — failures log a warning, never fail the close.
    // Gated by `afk.landing.cascade_rebase` (default "true", checked in core).
    cascadeRebase: {
      async listAFKBranches() {
        const refs = await gitx.listRemoteBranches(gitCtx, "afk/");
        return refs.map((r) => r.branch);
      },
      isWorkerLive(workerId: string): boolean {
        try {
          const pidPath = workerPidFile(paths.tmpDir, workerId);
          const content = readFileSync(pidPath, "utf8").trim();
          if (!/^[1-9][0-9]*$/.test(content)) return false;
          process.kill(Number(content), 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "EPERM";
        }
      },
      async rebaseAndPush(repoDir: string, branch: string, trunkTip: string) {
        const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        const slot = parseSlot(process.env.RED_AFK_SLOT) ?? 0;
        const dest = join(paths.cascadeWorktreesDir, `${slug}-${slot}`);
        try {
          await gitx.worktreeRemove(gitCtx, dest);
          const added = await gitx.worktreeAdd(gitCtx, dest, branch);
          if (!added.ok) {
            return {
              ok: false,
              warn: `failed to create worktree for ${branch}: ${added.stderr || "no git detail"}`,
            };
          }
          const run = exec ?? (await import("../../runtime/exec.js")).execTool;
          const rebaseR = await run("git", ["rebase", trunkTip], { cwd: dest });
          if (rebaseR.code !== 0) {
            await run("git", ["rebase", "--abort"], { cwd: dest }).catch(() => {});
            return {
              ok: false,
              warn: `rebase of ${branch} onto ${trunkTip} conflicted: ${rebaseR.stderr.slice(0, 200)}`,
            };
          }
          const pushR = await run(
            "git",
            ["push", "origin", `HEAD:refs/heads/${branch}`, "--force-with-lease"],
            { cwd: dest },
          );
          if (pushR.code !== 0) {
            return {
              ok: false,
              warn: `--force-with-lease push rejected for ${branch}: ${pushR.stderr.slice(0, 200)}`,
            };
          }
          return { ok: true };
        } finally {
          await gitx.worktreeRemove(gitCtx, dest).catch(() => {});
        }
      },
    },
  };
}

function makeIssueClassifier(
  config: import("../../core/config.js").ConfigValues,
  runner: Runner,
  cwd: string,
  exec?: ExecFn,
): (metadata: IssueClassificationMetadata) => Promise<import("../../core/config.js").AfkModelTier> {
  return async (metadata) => {
    const validateTier = resolveTier(config, runner, "validate", process.env);
    return classifyIssue(metadata, async ({ prompt }) => {
      const run = exec ?? (await import("../../runtime/exec.js")).execTool;
      const common = { cwd, timeoutMs: 45_000, maxBuffer: 1024 * 1024 };
      const result =
        runner === "codex"
          ? await run(
              "codex",
              [
                "exec",
                "--model",
                validateTier.model,
                "-c",
                `model_reasoning_effort=${validateTier.effort}`,
                "-C",
                cwd,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                prompt,
              ],
              common,
            )
          : await run(
              "claude",
              [
                "--model",
                validateTier.model,
                "--effort",
                validateTier.effort,
                "--permission-mode",
                "bypassPermissions",
                "--print",
                prompt,
              ],
              common,
            );
      return result.code === 0 ? result.stdout.trim() : undefined;
    });
  };
}

function makeRecordOutcomeEvent(
  gitRoot: string,
  current: CurrentAttempt,
  exec?: ExecFn,
): (event: OutcomeEvent) => Promise<void> {
  return async (event: OutcomeEvent): Promise<void> => {
    try {
      const configPath = configFile(gitRoot);
      const configText = readFileSync(configPath, "utf8");
      if (!pluginEnabledInConfig(configText, "brain")) return;
      const env = { ...process.env, BRAIN_REPO_ROOT: process.env.BRAIN_REPO_ROOT ?? gitRoot };
      const brainCli = resolveBrainCli(gitRoot, env);
      if (!brainCli) return;
      const dir = current.attemptDir || gitRoot;
      await fsx.ensureDir(dir);
      const json = JSON.stringify(event);
      await writeFile(join(dir, `brain-outcome-event-${event.context?.issueNumber ?? "unknown"}.json`), json, "utf8");
      const run = exec ?? (await import("../../runtime/exec.js")).execTool;
      const [cmd, ...head] = brainCli;
      await run(cmd, [...head, "outcome-event", "record", "--root", gitRoot], {
        cwd: gitRoot,
        env,
        input: json,
      });
    } catch (err) {
      process.stderr.write(`[afk] brain outcome-event skipped (best-effort): ${String(err)}\n`);
    }
  };
}

function resolveBrainCli(gitRoot: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const override = env.RED_BRAIN_CLI;
  if (override) return existsSync(override) ? ["node", override] : undefined;
  const pathHit = findOnPath("brain", env.PATH);
  if (pathHit) return ["brain"];
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? env.CODEX_PLUGIN_ROOT;
  if (pluginRoot) {
    const sibling = join(pluginRoot, "..", "brain", "dist", "cli.js");
    if (existsSync(sibling)) return ["node", sibling];
  }
  const inRepo = join(gitRoot, "plugins", "brain", "dist", "cli.js");
  if (existsSync(inRepo)) return ["node", inRepo];
  return undefined;
}

function findOnPath(bin: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export type { CurrentAttempt } from "./attempt.js";
