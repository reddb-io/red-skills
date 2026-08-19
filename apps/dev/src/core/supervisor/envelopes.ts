import { buildEnvelope } from "../envelope.js";
import { renderClaimComment } from "../claim.js";
import { renderLogTailToon } from "../envelope-emit.js";
import { dispose } from "../disposition.js";
import { workerIdentity } from "../host-identity.js";
import { LABEL_READY, LABEL_RUNNING } from "../triage-labels.js";
import { isRefused, parkOrHuman, planTransition, type StateTransition } from "../state-transition.js";
import { recordIssueHeal } from "@reddb-io/worker/engine";
import type { WorkerBudgetBreach, WorkerUsage } from "../worker-budget.js";
import type { IterDirInfo, SupervisorDeps } from "./types.js";

/** Unit each budget is measured in, for the envelope's duration line. */
const WORKER_BUDGET_UNITS: Record<WorkerBudgetBreach["budget"], string> = {
  wall_clock_s: "s",
  peak_rss_mb: "MB",
  cost_usd: "USD",
};

export function buildDiscardEnvelope(
  runner: string,
  slot: number,
  workerIdsCsv: string,
  fastDeaths: number,
  supervisorLogPath: string,
): string {
  const sectionBody = [
    `slot: ${slot}`,
    `worker IDs: ${workerIdsCsv}`,
    `fast deaths: ${fastDeaths}`,
    `supervisor log: ${supervisorLogPath}`,
  ].join("\n");
  return buildEnvelope({
    status: "discarded",
    worker: runner,
    duration: `runner-broken, slot parked after ${fastDeaths} fast deaths`,
    diff: "discarded",
    attempt: 1,
    sections: [{ name: "summary", body: sectionBody }],
  });
}

/** Build the stall-reaper no-sentinel envelope body, composing envelope.ts
 * buildEnvelope. Mirrors the `summary` + notes + log envelope reap_stalled_slot
 * posts: status "no-sentinel", a notes section and a fenced log section. */
export function buildReaperEnvelope(info: IterDirInfo): string {
  return buildEnvelope({
    status: "no-sentinel",
    worker: info.workerId.length > 0 ? info.workerId : "unknown",
    duration: `${info.durationS}s · stall-reaped`,
    diff: "stall-reaped",
    attempt: info.attempt,
    sections: [
      { name: "notes", body: info.notes.length > 0 ? info.notes : "(no agent notes recorded before stall-reap)" },
      { name: "log", body: renderLogTailToon(info.logTail), fenced: true, fenceLang: "toon" },
    ],
  });
}

/**
 * Build the wall-clock-cap envelope body (#2701) — the reaper's OTHER terminal
 * record. It shares the reap envelope's sections but never its status: a capped
 * attempt is reported as `wall-clock-capped`, naming the ceiling it hit, so the
 * issue's history reads "we stopped it at 2700s" instead of "the agent never
 * finished".
 */
export function buildWallClockCapEnvelope(info: IterDirInfo, capSeconds: number): string {
  return buildEnvelope({
    status: "wall-clock-capped",
    worker: info.workerId.length > 0 ? info.workerId : "unknown",
    duration: `${info.durationS}s · wall-clock cap ${capSeconds}s reached`,
    diff: "wall-clock-capped",
    attempt: info.attempt,
    sections: [
      {
        name: "notes",
        body: info.notes.length > 0 ? info.notes : "(no agent notes recorded before the wall-clock cap)",
      },
      { name: "log", body: renderLogTailToon(info.logTail), fenced: true, fenceLang: "toon" },
    ],
  });
}

/**
 * Build the per-attempt BUDGET envelope body (ADR 0128 §8) — the reaper's third
 * terminal record. Like the wall-clock cap it is never a stall: the attempt was
 * cut off by a resource ceiling it reached, and the envelope NAMES that budget
 * so the issue's history reads "we stopped it at 4096MB" rather than "the agent
 * never finished". Its status is `blocked` (the mapping `budget-exceeded`
 * already carries in worker-outcome), because a resource runaway pages a human
 * instead of blind-retrying.
 */
export function buildWorkerBudgetEnvelope(
  info: IterDirInfo,
  breach: WorkerBudgetBreach,
): string {
  const unit = WORKER_BUDGET_UNITS[breach.budget];
  return buildEnvelope({
    status: "blocked",
    worker: info.workerId.length > 0 ? info.workerId : "unknown",
    duration: `${info.durationS}s · ${breach.budget} budget ${breach.limit}${unit} reached (used ${breach.observed}${unit})`,
    diff: "budget-exceeded",
    attempt: info.attempt,
    sections: [
      {
        name: "notes",
        body:
          info.notes.length > 0
            ? info.notes
            : "(no agent notes recorded before the budget termination)",
      },
      { name: "log", body: renderLogTailToon(info.logTail), fenced: true, fenceLang: "toon" },
    ],
  });
}

/** Build the crash-reconcile no-sentinel envelope body (#815), composing
 * envelope.ts buildEnvelope. The running-supervisor analogue of
 * buildReaperEnvelope: status "no-sentinel", a notes section and a fenced
 * afk.log tail, but worded for an orchestrator that DIED mid-attempt (SIGKILL
 * class — its EXIT trap never ran, so it posted no terminal envelope) rather
 * than a stall-reap. */
export function buildCrashEnvelope(info: IterDirInfo): string {
  return buildEnvelope({
    status: "no-sentinel",
    worker: info.workerId.length > 0 ? info.workerId : "unknown",
    duration: `${info.durationS}s · orchestrator died mid-attempt`,
    diff: "crashed",
    attempt: info.attempt,
    sections: [
      { name: "notes", body: info.notes.length > 0 ? info.notes : "(no agent notes recorded before the orchestrator died)" },
      { name: "log", body: renderLogTailToon(info.logTail), fenced: true, fenceLang: "toon" },
    ],
  });
}

/** Pure gate for the running-supervisor crash reconcile (#815): a dead worker's
 * claim is reconcilable only when it named a real issue, the gh lookup
 * succeeded, and the issue is still stranded in `running`. A null issue (worker
 * died pre-claim), a failed gh lookup (left for the boot sweep), or an issue no
 * longer `running` (the worker completed normally, or another surface already
 * reclaimed it) all resolve to false → no envelope, no label edit. */
export function decideCrashReconcile(input: {
  issue: number | null;
  ghOk: boolean;
  stillRunning: boolean;
}): boolean {
  return input.issue !== null && input.ghOk && input.stillRunning;
}

/**
 * reconcileDeadWorkerClaim (#815, ADR 0071 Pattern 5): recover a single issue a
 * just-dead worker stranded in `running`. The running supervisor's analogue of
 * the boot-time orphan sweep's restore-and-remove branch — it closes the gap
 * where a worker dies mid-attempt (after the agent finished, before posting a
 * terminal envelope), the slot is respawned onto a NEW issue, and the old claim
 * sits `running` forever because no fleet reboot ever runs the boot sweep.
 *
 * `info` is the dead worker's iter-dir snapshot, captured by the caller BEFORE
 * handleDeadSlot respawns the slot (a respawn rebinds resolveIterDir to the new
 * worker's dir). Steps, all best-effort and gated on a real still-`running`
 * claim:
 *   1. Post a no-sentinel envelope carrying the attempt's afk.log tail (skipped
 *      when one was already posted, so a double-fire never double-comments).
 *   2. Route through bounded `blocked:crashed` recovery (recovery.ts), exactly
 *      as reapStalledSlot does for `stalled`: under the cap → rotate
 *      `running` → `ready-for-agent` CLEAN; at the cap → escalate to
 *      ready-for-human carrying `blocked:crashed` + a self-explanatory comment.
 * Returns the reconciled issue number, or null when nothing was reconciled.
 *
 * `usage` is what the resident measured while the attempt ran (ADR 0128 §8). It
 * closes the attempt record here — this is the boundary where a COMPLETED
 * attempt is observed, so wall clock and peak RSS land on a clean finish exactly
 * as they do on a termination.
 */
export async function reconcileDeadWorkerClaim(
  info: IterDirInfo | null,
  deps: SupervisorDeps,
  usage: WorkerUsage = {},
): Promise<number | null> {
  if (info === null || info.issue === null) return null;
  if (!deps.gh.crashedClaimState) return null;

  let claim: { ghOk: boolean; stillRunning: boolean; envelopePosted: boolean; labels?: string[] };
  try {
    claim = await deps.gh.crashedClaimState(info.issue);
  } catch {
    // gh failed → leave the issue for the next boot sweep (conservative), and
    // record nothing: an unreadable claim is not evidence of an outcome.
    return null;
  }
  if (!decideCrashReconcile({ issue: info.issue, ghOk: claim.ghOk, stillRunning: claim.stillRunning })) {
    // The claim is no longer `running`, so the worker closed its own ticket
    // before it exited — a clean finish, and nothing for the sweep to reconcile.
    return null;
  }

  // 1. No-sentinel envelope (skip when one already rode the issue).
  if (!claim.envelopePosted) {
    await deps.gh.comment(info.issue, buildCrashEnvelope(info));
  }
  await deps.gh.comment(
    info.issue,
    renderClaimComment({ worker: workerIdentity(info.workerId) }, "concede", "released"),
  );

  // 1b. ADR 0122 heal ledger (#2526): a death-sweep IS a heal of this issue.
  // The 3rd heal inside the window stops re-queueing and quarantines instead —
  // an issue that keeps killing workers is a signal, not a retry candidate.
  // Best-effort: a ledger failure falls through to the normal disposition.
  if (deps.healLedger) {
    try {
      const decision = await recordIssueHeal(deps.healLedger, info.issue);
      if (decision.action === "quarantine") {
        await deps.gh.ensureLabel("quarantine");
        const applied = await applyDeathTransition(deps, info.issue, claim.labels, {
          kind: "quarantine",
          diagnosis: "",
        });
        if (applied) {
          await deps.gh.comment(
            info.issue,
            `🤖 /afk death-sweep quarantined this issue: ${decision.history.length} worker-death heals inside the ledger window — it keeps killing workers and needs human judgment before another attempt (ADR 0122 heal budget).`,
          );
          return info.issue;
        }
      }
    } catch {
      // best-effort: fall through to the bounded recovery below.
    }
  }

  // 2. Bounded blocked:crashed recovery via the disposition composer (#402,
  // #822), mirroring the stall-reaper path below. The death-without-envelope
  // outcome is "no-sentinel" → recovery reason `crashed` + label `blocked:runner`;
  // dispose() owns the retry/escalate decision, label sets, and the budget-
  // exhausted page comment. (Completes #822: this crash path still called the
  // un-imported recoveryDecision/blockedLabelFor/recoveryCap after the stall path
  // was converted, breaking the apps/dev typecheck.)
  const disp = dispose("no-sentinel", info.attempt, deps.recoveryEnv ?? {});
  if (disp.decision === "retry") {
    // CLEAN re-queue through the transition API. When the claim reported the
    // issue's labels the plan strips every park remnant in one edit; when it
    // did not, the planner is fed dispose's shed set instead of applying it raw
    // (#2663), so the legacy fallback is now a PLANNED delta too.
    await applyDeathTransition(deps, info.issue, claim.labels, { kind: "queue" }, disp.removeLabels);
  } else {
    if (disp.typedLabel !== null) await deps.gh.ensureLabel(disp.typedLabel);
    // Escalation also sheds any stale ready-for-agent — the crashed slot was
    // `running`, never re-queue it (matches the reaper path). That extra shed
    // is exactly what the labels-unknown fallback set encodes.
    await applyDeathTransition(
      deps,
      info.issue,
      claim.labels,
      parkOrHuman(disp.typedLabel),
      [...disp.removeLabels, LABEL_READY],
    );
    if (disp.escalationComment !== null) {
      await deps.gh.comment(info.issue, disp.escalationComment);
    }
  }
  return info.issue;
}

/**
 * Apply one ADR 0122 state transition for the death-sweep as a single label
 * edit. Returns false when labels are unknown or the planner refuses (the
 * caller then falls back to the legacy dispose label sets), so the sweep is
 * never weaker than the pre-#2526 behavior.
 */
/**
 * Apply one death-sweep state transition. `labels` is the claim's reported
 * label set; `fallbackCurrent` is what the call site KNOWS the dead slot
 * carried, used when the claim reported nothing. Since #2663 that fallback goes
 * through the planner too — there is no raw disp-set write left on this path.
 * Returns false (performing no edit) when neither set is available or the plan
 * is refused, so a caller that gates a follow-up comment on success still can.
 */
async function applyDeathTransition(
  deps: SupervisorDeps,
  issue: number,
  labels: string[] | undefined,
  transition: StateTransition,
  fallbackCurrent?: readonly string[],
): Promise<boolean> {
  const current = labels ?? fallbackCurrent;
  if (!current) return false;
  const plan = planTransition(current, transition);
  if (isRefused(plan)) {
    deps.log?.(`death-sweep: transition "${transition.kind}" for #${issue} refused by the state planner (${plan.reason})`);
    return false;
  }
  await deps.gh.editLabels(issue, [...plan.add], [...plan.remove]);
  return true;
}

// ---------- actions (compose deciders, apply via injected IO) ----------
