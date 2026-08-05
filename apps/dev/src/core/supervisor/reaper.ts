import { encode as encodeToon } from "@reddb-io/toon";
import { renderClaimComment } from "../claim.js";
import { decideReaperSignal, deriveSnapshot } from "../reaper-signal.js";
import { dispose } from "../disposition.js";
import { parkOrHuman, transitionLabels, type StateTransition } from "../state-transition.js";
import { workerIdentity } from "../host-identity.js";
import {
  LABEL_CONTESTED,
  LABEL_HUMAN,
  LABEL_READY,
  LABEL_RUNNER_ERROR,
  LABEL_RUNNING,
} from "../triage-labels.js";
import type { CapHandoff } from "../wall-clock-cap.js";
import {
  planBudgetHandoff,
  type WorkerBudgetBreach,
  type WorkerUsage,
} from "../worker-budget.js";
import {
  workerUsage,
  hasResourceBudget,
  resourceBudgetBreach,
  sampleWorkerPeakRss,
} from "./worker-accounting.js";
import { SUPERVISOR_DEFAULTS, type SupervisorConfig } from "./config.js";
import {
  buildWorkerBudgetEnvelope,
  buildDiscardEnvelope,
  buildReaperEnvelope,
  buildWallClockCapEnvelope,
} from "./envelopes.js";
import type { SlotState, SupervisorState } from "./state.js";
import type { IterDirInfo, SupervisorDeps } from "./types.js";

export async function sweepParkedSlot(
  slot: number,
  state: SlotState,
  deps: SupervisorDeps,
  config: Pick<SupervisorConfig, "runner">,
): Promise<void> {
  if (state.swept) return;
  state.swept = true;

  // state.pid is the last dead worker's PID — the fs layer uses it as a
  // fallback when the slot log has no boot-stamp (native fleet path).
  const work = deps.fs.parkedSlotWork(slot, state.pid);
  const workerIdsCsv = work.workers.map((w) => w.workerId).join(",");
  // Real fast-death count lives in the circuit ring at the time of the trip,
  // not in the FS layer (which has no visibility into the breaker state).
  const fastDeaths = state.deaths.length;


  if (work.workers.length === 0) return;

  const hasAnyClaim = work.workers.some((w) => w.pairs.some((p) => p.issue !== null));
  if (hasAnyClaim) await deps.gh.ensureRunnerErrorLabel();

  for (const worker of work.workers) {
    for (const pair of worker.pairs) {
      if (pair.issue !== null) {
        const body = buildDiscardEnvelope(
          config.runner,
          slot,
          workerIdsCsv,
          fastDeaths,
          work.supervisorLogPath,
        );
        await deps.gh.comment(pair.issue, body);
        await deps.gh.comment(
          pair.issue,
          renderClaimComment(
            { worker: workerIdentity(worker.workerId), runner: config.runner },
            "concede",
            "released",
          ),
        );
        await deps.gh.editLabels(
          pair.issue,
          [LABEL_READY, LABEL_RUNNER_ERROR],
          [LABEL_HUMAN, LABEL_RUNNING],
        );
      }
      await deps.fs.removeDir(pair.dir);
    }
  }
}

/**
 * reap_stalled_slot (supervisor.sh ~868): hard-reap a slot silent past the kill
 * threshold. Idempotent per slot via SlotState.reaped. Order (every step
 * best-effort past the kill):
 *   1. kill_tree the orchestrator when alive.
 *   2. Free the slot bookkeeping so the next tick respawns it.
 *   3. When an issue number was recovered: post a no-sentinel envelope and
 *      rotate labels back (+ready-for-agent -running).
 *   4. Tear down worktree + iter dir.
 * A worker that died pre-claim (issue null) still kills, frees the slot, and
 * tears down the dir, but posts no envelope and rotates no labels.
 */
export interface ReapOptions {
  /**
   * True when the kill was ordered by the per-issue WALL-CLOCK CEILING rather
   * than by silence (#2701). The reap then records `wall-clock-capped` instead
   * of `no-sentinel`, hands the attempt's branch/PR forward to the next worker,
   * and skips the retry contest (the cut-off was deliberate — there is nothing
   * to contest).
   */
  wallClockCapped?: boolean;
  /** The ceiling that fired, in seconds — named in the envelope and comment. */
  capSeconds?: number;
  /**
   * Set when a per-attempt RESOURCE budget terminated the attempt (ADR 0128 §8).
   * The reap then NAMES that budget in its envelope, its comment and its attempt
   * record, hands the branch/PR forward exactly like a wall-clock cap, and pages
   * a human — a resource runaway is not a transient flake to blind-retry.
   */
  budget?: WorkerBudgetBreach;
  /** What the attempt consumed, as sampled by the resident. Recorded on the
   * attempt record for a terminated attempt exactly as for a completed one. */
  usage?: WorkerUsage;
}

export async function reapStalledSlot(
  slot: number,
  state: SlotState,
  deps: SupervisorDeps,
  config: Pick<SupervisorConfig, "reapContestWindowS"> = SUPERVISOR_DEFAULTS,
  opts: ReapOptions = {},
): Promise<void> {
  if (state.reaped) return;
  state.reaped = true;

  const orchPid = state.pid;
  const info = deps.fs.resolveIterDir(slot);

  // 1. kill_tree the orchestrator — SIGTERM, grace, SIGKILL, confirm exit.
  // `confirmedDead` gates the destructive teardown in step 4: a worker already
  // gone (no pid / not alive) is trivially dead; otherwise we trust killTree's
  // confirmation. Only a definitive `false` (survived SIGKILL) blocks teardown.
  let confirmedDead = true;
  if (orchPid !== null && deps.proc.isAlive(orchPid)) {
    const killed = await deps.proc.killTree(orchPid);
    confirmedDead = killed !== false;
  }

  // 2. Free the slot — next tick respawns it even if cleanup below fails.
  state.pid = null;
  state.stalled = false;
  state.stallSinceEpoch = 0;

  // 3. Envelope + BOUNDED re-claim routing (only with a recovered issue number).
  // The stall-reaper is now capped (#402): it asks recovery.ts whether this
  // attempt may retry. While under the `stalled` cap it rotates back to
  // ready-for-agent CLEAN — no `blocked:*` label rides along, so a re-queued issue
  // never trips the adoption-doctor's "ready-for-agent + blocked:*" hygiene check.
  // Once the cap is exhausted it escalates to ready-for-human carrying
  // `blocked:stalled` (created on the fly) plus a self-explanatory page comment,
  // exactly like the per-issue routeRecovery escalation.
  if (info && info.issue !== null) {
    const capped = opts.wallClockCapped === true;
    const capSeconds = opts.capSeconds ?? 0;
    // The three terminal records this reap can write, and they are NOT
    // interchangeable: a stall is silence, a cap is the wall-clock policy
    // deadline, a budget termination is a resource ceiling that NAMES itself
    // (ADR 0128 §8). Only the first is ever reported as a stall.
    const budgetBreach: WorkerBudgetBreach | undefined =
      opts.budget ??
      (capped
        ? { budget: "wall_clock_s", limit: capSeconds, observed: info.durationS }
        : undefined);
    const resourceBudget = opts.budget !== undefined;
    await deps.gh.comment(
      info.issue,
      resourceBudget
        ? buildWorkerBudgetEnvelope(info, opts.budget!)
        : capped
          ? buildWallClockCapEnvelope(info, capSeconds)
          : buildReaperEnvelope(info),
    );
    await deps.gh.comment(
      info.issue,
      renderClaimComment({ worker: workerIdentity(info.workerId) }, "concede", "released"),
    );
    // A budgeted worker's work is LIVE, not lost: publish its branch and name
    // its PR before the labels rotate, so the retry adopts the ref instead of
    // branching fresh from main (#2701 for the cap, the same contract for every
    // other budget).
    if (budgetBreach !== undefined) await handOffBudgetedWork(info, deps, budgetBreach);
    // The composer owns the bounded re-claim DECISION + the budget-exhausted
    // page comment (core/disposition, total map → `stalled` is recoverable,
    // #402); since #2663 the LABEL DELTA belongs to the transition planner, so
    // the reaper no longer applies dispose's raw sets. gh.editLabels here is the
    // (issue, add, remove) shape, so the plan's (remove, add) pair is swapped
    // at the port.
    const disp = dispose(
      resourceBudget ? "budget-exceeded" : capped ? "wall-clock-capped" : "stalled",
      info.attempt,
      deps.recoveryEnv ?? {},
    );
    if (disp.decision === "retry") {
      // No contest on a cap: the kill was a deliberate policy cut-off and the
      // branch is already handed forward, so a `contested` hold would only delay
      // the adoption it exists to protect.
      const opened = budgetBreach !== undefined
        ? false
        : await openReapContest(slot, state, info, deps, config.reapContestWindowS);
      if (!opened) {
        // CLEAN re-queue: no blocked:* tag rides a re-queued issue.
        await applyReaperTransition(deps, info.issue, disp.removeLabels, { kind: "queue" });
      }
    } else {
      if (disp.typedLabel !== null) await deps.gh.ensureLabel(disp.typedLabel);
      // Escalation also sheds any stale ready-for-agent — the reaped slot was
      // `running`, never re-queue it. (Context-specific to the reaper; the
      // per-issue routeRecovery only removes `running`.)
      await applyReaperTransition(
        deps,
        info.issue,
        [...disp.removeLabels, LABEL_READY],
        parkOrHuman(disp.typedLabel),
      );
      if (disp.escalationComment !== null) {
        await deps.gh.comment(info.issue, disp.escalationComment);
      }
    }
  }

  // 4. Teardown — only once the worker is confirmed dead, so the `rm -rf` of the
  // worktree never races a still-live worker still writing into it (#580). A
  // worker that survived SIGKILL leaks its worktree (cleaned up on the next boot
  // sweep), which is strictly safer than corrupting a live checkout.
  if (info && confirmedDead) await deps.fs.teardownIterDir(info);
}

/**
 * Hand a budget-terminated attempt's work forward (#2701 for the wall-clock cap,
 * ADR 0128 §8 for every other budget). The worker was cut off mid-flight, so
 * whatever it committed is the NEXT worker's starting point, not garbage:
 * resolve the branch head, publish the ref so branch discovery can see it, look
 * up any PR it already opened, and post the plan as a comment naming both the
 * budget and the pending artifact. Every step is best-effort — a failure
 * degrades the hand-forward to a plain re-queue, exactly the pre-#2701
 * behaviour, and never blocks the reap.
 */
async function handOffBudgetedWork(
  info: IterDirInfo,
  deps: SupervisorDeps,
  breach: WorkerBudgetBreach,
): Promise<CapHandoff | null> {
  if (info.issue === null) return null;

  const branchHead = info.branch ? await branchHeadForContest(deps, info.branch) : undefined;
  let branchPublished: boolean | undefined;
  if (info.branch && branchHead !== undefined && deps.publishAttemptBranch) {
    try {
      branchPublished = await deps.publishAttemptBranch(info.branch);
    } catch {
      branchPublished = false;
    }
  }

  let pullRequest: number | undefined;
  if (deps.gh.findAttemptPullRequest) {
    try {
      pullRequest = (await deps.gh.findAttemptPullRequest(info.issue)) ?? undefined;
    } catch {
      // best-effort: an unresolvable PR lookup just omits the pending artifact.
    }
  }

  const handoff = planBudgetHandoff({
    issue: info.issue,
    breach,
    ...(info.branch !== undefined ? { branch: info.branch } : {}),
    ...(branchHead !== undefined ? { branchHead } : {}),
    ...(branchPublished !== undefined ? { branchPublished } : {}),
    ...(pullRequest !== undefined ? { pullRequest } : {}),
  });
  await deps.gh.comment(info.issue, handoff.comment);
  return handoff;
}

/**
 * Apply one reaper state transition through the ADR 0122 transition API
 * (#2663). The planner is fed the labels the reaper KNOWS the reaped slot
 * carried — dispose's shed set, plus the stale `ready-for-agent` the escalation
 * path also drops — so the emitted delta is exactly the historical one, with
 * the one-state-role invariant proven before the tracker call. The supervisor
 * gh port takes (issue, ADD, REMOVE), so the plan's pair is swapped here.
 */
async function applyReaperTransition(
  deps: SupervisorDeps,
  issue: number,
  current: readonly string[],
  transition: StateTransition,
): Promise<void> {
  const result = await transitionLabels(
    (remove, add) => deps.gh.editLabels(issue, add, remove),
    current,
    transition,
  );
  if (!result.applied) {
    deps.log?.(`reaper: transition "${transition.kind}" for #${issue} refused by the state planner (${result.reason})`);
  }
}

async function branchHeadForContest(deps: SupervisorDeps, branch: string): Promise<string | undefined> {
  try {
    return await deps.attemptBranchHead?.(branch);
  } catch {
    return undefined;
  }
}

function logReapContest(
  deps: SupervisorDeps,
  event: "opened" | "reclaimed" | "expired",
  details: Record<string, string | number | undefined>,
): void {
  deps.log?.(
    encodeToon({
      schema_version: "red.afk.reap_contest.v1",
      event,
      ...details,
    }),
  );
}

async function openReapContest(
  slot: number,
  state: SlotState,
  info: IterDirInfo,
  deps: SupervisorDeps,
  windowS: number,
): Promise<boolean> {
  if (info.issue === null || !info.branch || windowS <= 0) return false;
  const openedEpoch = deps.now();
  const deadlineEpoch = openedEpoch + windowS;
  const headAtReap = await branchHeadForContest(deps, info.branch);

  await deps.gh.editLabels(info.issue, [LABEL_CONTESTED], []);
  state.contest = {
    issue: info.issue,
    branch: info.branch,
    headAtReap,
    openedEpoch,
    deadlineEpoch,
  };
  logReapContest(deps, "opened", {
    slot,
    issue: info.issue,
    branch: info.branch,
    head_at_reap: headAtReap,
    deadline_epoch: deadlineEpoch,
  });
  return true;
}

export type ReapContestResolution = "pending" | "reclaimed" | "expired" | null;

export async function resolveReapContest(
  slot: number,
  state: SlotState,
  deps: SupervisorDeps,
  _config: Pick<SupervisorConfig, "reapContestWindowS"> = SUPERVISOR_DEFAULTS,
): Promise<ReapContestResolution> {
  const contest = state.contest;
  if (contest === null) return null;

  const now = deps.now();
  const currentHead = await branchHeadForContest(deps, contest.branch);
  if (
    now <= contest.deadlineEpoch &&
    contest.headAtReap !== undefined &&
    currentHead !== undefined &&
    currentHead !== contest.headAtReap
  ) {
    await deps.gh.editLabels(contest.issue, [], [LABEL_CONTESTED]);
    state.contest = null;
    logReapContest(deps, "reclaimed", {
      slot,
      issue: contest.issue,
      branch: contest.branch,
      head_at_reap: contest.headAtReap,
      head_at_resolution: currentHead,
    });
    return "reclaimed";
  }

  if (now < contest.deadlineEpoch) return "pending";

  await deps.gh.editLabels(contest.issue, [LABEL_READY], [LABEL_RUNNING, LABEL_CONTESTED]);
  state.contest = null;
  logReapContest(deps, "expired", {
    slot,
    issue: contest.issue,
    branch: contest.branch,
    head_at_reap: contest.headAtReap,
    head_at_resolution: currentHead,
  });
  return "expired";
}

/**
 * pollStallDetector (supervisor.sh ~611): sample every non-parked slot. Flag /
 * clear the stall bit from the agent-lane mtime vs the stall threshold, then —
 * for a slot silent past the kill threshold and not yet reaped — gate the
 * irreversible kill behind the reaper-signal predicate. The kill fires only
 * when decideReaperSignal returns "kill" (idle past threshold AND no active
 * build/test descendant AND flat cpu); a busy worker is left alone. Composes
 * deriveSnapshot + decideReaperSignal — never re-implements them.
 */
export async function pollStallDetector(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: Pick<
    SupervisorConfig,
    | "stallThresholdS"
    | "stallKillThresholdS"
    | "runner"
    | "reapContestWindowS"
    | "issueWallClockMaxS"
    | "workerBudgets"
  >,
): Promise<number[]> {
  const now = deps.now();
  const reaped: number[] = [];
  // ONE process-table read per tick charges memory to every live attempt (ADR
  // 0128 §8), independent of fleet width.
  sampleWorkerPeakRss(state, deps);
  const budgets = config.workerBudgets ?? {};
  const watchResources = hasResourceBudget(budgets);

  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    if (slot.parked || slot.idleParked) continue;

    // Per-attempt RESOURCE budgets, checked before the silence ladder: an
    // attempt over its memory or cost ceiling is terminated by POLICY, so it
    // never waits out a stall countdown it would never accumulate, and it is
    // never recorded as a stall. All-unlimited budgets (the default) skip the
    // state read entirely.
    if (watchResources && !slot.reaped && slot.pid !== null) {
      const info = deps.fs.resolveIterDir(i);
      const usage = workerUsage(slot, info);
      const breach = resourceBudgetBreach(usage, budgets);
      if (breach !== null) {
        await reapStalledSlot(i, slot, deps, config, { budget: breach, usage });
        reaped.push(i);
        continue;
      }
    }

    // Skip freshly-spawned slots (startup window: same guard as old computeStalled).
    if (!(slot.spawnEpoch > 0) || !(now - slot.spawnEpoch >= config.stallThresholdS)) continue;

    // Evaluator verdict: stale lane + no live descendants → stalled. Live
    // descendants → alive even when the lane is silent (wedged substrate guard).
    const verdict = deps.fs.workerLivenessVerdict(
      i,
      config.stallThresholdS * 1000,
      config.stallKillThresholdS * 1000,
      config.issueWallClockMaxS * 1000,
    );
    // Two verdicts, one escalation path, DIFFERENT terminal records (#2701):
    // `stalled` means silence, `capped` means the per-issue wall-clock ceiling
    // fired on an attempt that was still working. Both free the slot; only the
    // stall is reported as a stall.
    const flagged = verdict !== null && (verdict.status === "stalled" || verdict.status === "capped");
    const capped = verdict !== null && verdict.status === "capped";

    if (flagged) {
      if (!slot.stalled) {
        slot.stalled = true;
        // Anchor the stall window to the last observed lane activity. When the
        // lane record age is known, compute the epoch; otherwise anchor to now.
        // The wall-clock ceiling (#2286) is its own deadline — the attempt has
        // ALREADY exceeded its budget — so it anchors the window to the kill
        // threshold and escalates on this same tick instead of waiting out a
        // second, silence-shaped countdown it would never accumulate.
        const stallSince = verdict.wallClockExceeded
          ? now - config.stallKillThresholdS
          : verdict.laneAgeMs !== undefined
            ? now - Math.round(verdict.laneAgeMs / 1000)
            : now;
        slot.stallSinceEpoch = stallSince;
      }
      // Hard-reap escalation: candidacy alone is not death — gate the kill.
      const since = slot.stallSinceEpoch;
      if (since > 0 && now - since >= config.stallKillThresholdS && !slot.reaped) {
        const orchPid = slot.pid;
        const snapshot =
          orchPid !== null
            ? deriveSnapshot(deps.proc.inspectTree(orchPid))
            : { activeDescendant: false, cpuPct: 0 };
        const decision = decideReaperSignal({
          idleSeconds: now - since,
          idleThresholdSeconds: config.stallKillThresholdS,
          activeDescendant: snapshot.activeDescendant,
          cpuPct: snapshot.cpuPct,
        });
        if (decision === "kill") {
          const info = deps.fs.resolveIterDir(i);
          const usage = workerUsage(slot, info);
          await reapStalledSlot(
            i,
            slot,
            deps,
            config,
            capped
              ? { wallClockCapped: true, capSeconds: config.issueWallClockMaxS, usage }
              : { usage },
          );
          reaped.push(i);
        }
      }
    } else if (slot.stalled) {
      slot.stalled = false;
      slot.stallSinceEpoch = 0;
    }
  }

  return reaped;
}
