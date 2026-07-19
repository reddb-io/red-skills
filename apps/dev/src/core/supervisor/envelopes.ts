import { buildEnvelope } from "../envelope.js";
import { renderLogTailToon } from "../envelope-emit.js";
import { dispose } from "../disposition.js";
import { LABEL_READY, LABEL_RUNNING } from "../triage-labels.js";
import type { IterDirInfo, SupervisorDeps } from "./types.js";

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
 */
export async function reconcileDeadWorkerClaim(
  info: IterDirInfo | null,
  deps: SupervisorDeps,
): Promise<number | null> {
  if (info === null || info.issue === null) return null;
  if (!deps.gh.crashedClaimState) return null;

  let claim: { ghOk: boolean; stillRunning: boolean; envelopePosted: boolean };
  try {
    claim = await deps.gh.crashedClaimState(info.issue);
  } catch {
    // gh failed → leave the issue for the next boot sweep (conservative).
    return null;
  }
  if (!decideCrashReconcile({ issue: info.issue, ghOk: claim.ghOk, stillRunning: claim.stillRunning })) {
    return null;
  }

  // 1. No-sentinel envelope (skip when one already rode the issue).
  if (!claim.envelopePosted) {
    await deps.gh.comment(info.issue, buildCrashEnvelope(info));
  }

  // 2. Bounded blocked:crashed recovery via the disposition composer (#402,
  // #822), mirroring the stall-reaper path below. The death-without-envelope
  // outcome is "no-sentinel" → recovery reason `crashed` + label `blocked:crashed`;
  // dispose() owns the retry/escalate decision, label sets, and the budget-
  // exhausted page comment. (Completes #822: this crash path still called the
  // un-imported recoveryDecision/blockedLabelFor/recoveryCap after the stall path
  // was converted, breaking the apps/dev typecheck.)
  const disp = dispose("no-sentinel", info.attempt, deps.recoveryEnv ?? {});
  if (disp.decision === "retry") {
    // CLEAN re-queue: no blocked:* tag rides a re-queued issue.
    await deps.gh.editLabels(info.issue, disp.addLabels, disp.removeLabels);
  } else {
    if (disp.typedLabel !== null) await deps.gh.ensureLabel(disp.typedLabel);
    // Escalation also sheds any stale ready-for-agent — the crashed slot was
    // `running`, never re-queue it (matches the reaper path).
    await deps.gh.editLabels(info.issue, disp.addLabels, [...disp.removeLabels, LABEL_READY]);
    if (disp.escalationComment !== null) {
      await deps.gh.comment(info.issue, disp.escalationComment);
    }
  }
  return info.issue;
}

// ---------- actions (compose deciders, apply via injected IO) ----------

