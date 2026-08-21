// death-sweep — the checkout half of ADR 0155: the daemon classifies, the
// checkout joins and decides (Spec #4129, ticket #4136).
//
// **A Worker that dies HARD leaves a Ticket that nothing releases.** A graceful
// exit routes through the terminal path: the claim is conceded, a history row
// lands, and `recoveryDecision()` bounds the retry. A SIGKILL or a cgroup OOM
// runs none of that — the issue keeps `running` and a live claim until the NEXT
// Worker's boot sweep happens to concede it on a staleness clock, which makes
// queue latency after a hard death a function of when somebody else boots.
//
// The evidence to do better already crosses the boundary. #4133 put the unit
// receipt onto the daemon's worker-death record as FACTS — `sender_class`,
// `confidence`, `exit_code`, `signal`, `memory_peak_bytes` — keyed by
// `worker_id` and nothing else, because ADR 0130/0144 keep the daemon ignorant
// of what an issue, a label or a tracker is. What the daemon cannot do is say
// which Ticket that Worker held. This module does exactly that:
//
//   worker_id → claim marker (`<host>:<worker_id>`) → issue
//
// and then spends the evidence on the decision the checkout already owns.
//
// ## What it decides, in vocabularies that already exist
//
// **No sixth vocabulary.** A hard death becomes the existing `signal-killed`
// {@link WorkerOutcome}, which `recoveryReasonFor` already maps to the `crashed`
// policy key, which `recovery.ts` already caps and `requeueOrdinal()` already
// counts. `dispose()` composes the label sets and the exhaustion comment exactly
// as it does for a graceful failure. The ONLY thing this module adds is the
// REMEDY — the answer to "retry how?" that the receipt makes possible:
//
//   - `oomd`                      → requeue with a memory bump, or, when no
//                                   bump is available, a model-tier escalation
//   - `user-signal` / `teardown` /
//     `parent-death` / `boot-refused` → plain requeue
//   - `unknown`, or any verdict below `medium` confidence
//                                 → DEFER: leave it to the boot sweep's
//                                   staleness clock, unchanged
//
// The deferral is deliberate and is the reason the boot sweep stays. An
// unattributed SIGKILL is reported as `unknown`/`low` precisely because the
// receipt could not name a sender, and releasing a claim on a guess is worse
// than releasing it a staleness window late.
//
// ## Order of operations, and why
//
// The executor concedes FIRST, then appends the history row, then edits the
// labels, then comments — the same order the boot claim sweep uses, so no reader
// ever sees an issue that is unclaimed and still `running`. Each step is
// per-issue best-effort: a failure leaves the issue exactly where the boot sweep
// would have found it anyway.
//
// The sweep is idempotent by construction rather than by a ledger: once the
// claim is conceded and `running` is stripped, the join finds no claimed issue
// for that worker and the next tick plans nothing for it.
//
// PURE planner, thin executor. Every clock, every read and every mutation is
// injected, so a simulated OOM flows through one tick in a unit test.

import { AFK_MODEL_TIERS, type AfkModelTier } from "./config.js";
import { dispose, type Disposition } from "./disposition.js";
import type { HistoryClock, HistoryEvent, HistoryRecord } from "./history.js";
import { requeueOrdinal } from "./history.js";
import type { RecoveryEnv } from "./recovery.js";
import type { ClaimedIssue } from "./claim-staleness.js";
import { classifyIssueClaims } from "./claim-staleness.js";
import { LABEL_RUNNING } from "./triage-labels.js";
import type { WorkerOutcome } from "./worker-outcome.js";
import type {
  AttributionConfidence,
  DeathSenderClass,
} from "@reddb-io/shared/death-attribution.js";

/**
 * The daemon event kinds that carry a death receipt.
 *
 * `worker-budget-kill` rides beside `worker-death` because the daemon ends a
 * Worker over budget the same way the host ends one over memory — the receipt
 * shape is identical and the checkout's join does not care which authority
 * pulled the trigger.
 */
export const DEATH_SWEEP_EVENT_KINDS: readonly string[] = ["worker-death", "worker-budget-kill"];

/** The daemon event kind that un-does a death: the same worker id born again. */
const BIRTH_EVENT_KIND = "worker-birth";

/**
 * One classified death, as the checkout reads it off the daemon's event lane.
 *
 * Declared structurally rather than imported from the daemon package so the
 * planner stays a value function: a test poses a death by writing one down, and
 * the transport (`drainEvents`, `events_since`, a lane read) is the caller's.
 * Every field but `worker_id` may be absent — a receipt the host could not
 * retain is a fact about the host, never a reason to throw.
 */
export interface WorkerDeathEvidence {
  readonly worker_id: string;
  /** The daemon's event discriminator; either spelling of the field is read. */
  readonly kind?: string | null;
  readonly event?: string | null;
  readonly ts?: string | null;
  readonly sender_class?: DeathSenderClass | null;
  readonly confidence?: AttributionConfidence | null;
  readonly exit_code?: number | null;
  readonly signal?: string | null;
  readonly memory_peak_bytes?: number | null;
  /** The unit's memory ceiling at the time it died, when the daemon stamped one. */
  readonly memory_max?: number | string | null;
  readonly detail?: string | null;
}

/**
 * The latest death per worker id, with re-births cancelling earlier deaths.
 *
 * A lane is a history, not an inbox: the same worker id can appear dead, then
 * born again after a `worker_recycle`, and sweeping the stale death would rob a
 * living Worker of its claim. Reading the lane in order and letting a birth
 * DELETE the pending death is the whole rule.
 */
export function deathEvidenceIn(
  events: readonly WorkerDeathEvidence[],
): WorkerDeathEvidence[] {
  const pending = new Map<string, WorkerDeathEvidence>();
  for (const event of events) {
    const kind = event.kind ?? event.event ?? "";
    if (event.worker_id === "") continue;
    if (kind === BIRTH_EVENT_KIND) {
      pending.delete(event.worker_id);
      continue;
    }
    if (!DEATH_SWEEP_EVENT_KINDS.includes(kind)) continue;
    pending.set(event.worker_id, event);
  }
  return [...pending.values()];
}

/** Why the sweep declined to act on one death. */
export type DeathDeferralReason =
  | "no-named-sender"
  | "low-confidence"
  | "no-claim";

/**
 * Does this receipt name a sender well enough to spend a claim on it? PURE.
 *
 * `high` and `medium` are the confidences a source earns by NAMING the process
 * or its scope (`death-attribution.ts`). `low` and `none` are a chain of
 * inference and an honest ignorance respectively, and ADR 0155 routes both to
 * the boot sweep's staleness clock rather than to a decision.
 */
export function deathVerdictIsActionable(
  evidence: WorkerDeathEvidence,
): DeathDeferralReason | null {
  const sender = evidence.sender_class ?? null;
  if (sender === null || sender === "unknown") return "no-named-sender";
  const confidence = evidence.confidence ?? null;
  if (confidence !== "high" && confidence !== "medium") return "low-confidence";
  return null;
}

/**
 * The terminal outcome a hard death IS, in the outcome vocabulary that already
 * exists. PURE.
 *
 * Every named sender resolves to `signal-killed` — the outcome whose own comment
 * already says "an OOM or watchdog kill may be transient, so a bounded fresh
 * worker run is warranted". Inventing a per-sender outcome would fork the retry
 * policy at the exact place ADR 0155 says not to.
 */
export function hardDeathOutcome(_senderClass: DeathSenderClass): WorkerOutcome {
  return "signal-killed";
}

/** How a requeue after a hard death differs from repeating the run that died. */
export type HardDeathRemedy = "memory-bump" | "tier-escalation" | "plain";

/** Multiple of the observed peak the next placement asks for. */
export const MEMORY_BUMP_FACTOR = 1.5;

/** Bumps round up to this, so a ceiling reads as a number a human chose. */
export const MEMORY_BUMP_GRANULARITY_BYTES = 256 * 1024 * 1024;

export interface MemoryBumpInput {
  /** Peak charged to the unit before it died, from the receipt. */
  readonly peakBytes?: number | null;
  /** The ceiling the dead placement ran under, when one was stamped. */
  readonly ceilingBytes?: number | null;
  /** The most this host will ever hand one Worker. Absent → no host ceiling. */
  readonly hostCeilingBytes?: number | null;
}

/**
 * The memory ceiling an OOM retry should ask for, or `null` when no bump is
 * available. PURE.
 *
 * Anchored on the higher of the PEAK and the old ceiling, because the peak is
 * what the kernel measured and the ceiling is only what somebody guessed —
 * taking the maximum means the answer always clears the placement that died. A
 * bump a host ceiling refuses, or one with nothing to anchor on, is `null`, and
 * a `null` is what sends the remedy to a tier escalation instead of repeating
 * the same placement with a rounder number.
 */
export function planMemoryBump(input: MemoryBumpInput): number | null {
  const peak = positiveOrZero(input.peakBytes);
  const ceiling = positiveOrZero(input.ceilingBytes);
  const anchor = Math.max(peak, ceiling);
  if (anchor <= 0) return null;
  const wanted =
    Math.ceil((anchor * MEMORY_BUMP_FACTOR) / MEMORY_BUMP_GRANULARITY_BYTES) *
    MEMORY_BUMP_GRANULARITY_BYTES;
  const hostCeiling = positiveOrZero(input.hostCeilingBytes);
  if (hostCeiling > 0 && wanted > hostCeiling) return null;
  return wanted;
}

/**
 * One step UP the model-tier ladder, or `null` at the top. PURE.
 *
 * The sibling of `downgradeAfkModelTier`, and deliberately not in `config.ts`
 * beside it: a tier that cannot rise any further must answer `null` rather than
 * silently returning itself, because "escalated" and "already at the ceiling"
 * are different facts and the remedy turns on which one it is.
 */
export function escalateAfkModelTier(tier: AfkModelTier): AfkModelTier | null {
  const index = AFK_MODEL_TIERS.indexOf(tier);
  if (index < 0 || index >= AFK_MODEL_TIERS.length - 1) return null;
  return AFK_MODEL_TIERS[index + 1]!;
}

/** What a requeue should change about the placement that died. */
export interface HardDeathRemedyPlan {
  readonly remedy: HardDeathRemedy;
  /** The ceiling the next placement should ask for, when the remedy is a bump. */
  readonly memoryBumpBytes: number | null;
  /** The tier the next run should use, when the remedy is an escalation. */
  readonly escalatedTier: AfkModelTier | null;
  /** One clause naming the remedy, for the audit comment. */
  readonly note: string;
}

export interface HardDeathRemedyInput extends MemoryBumpInput {
  readonly senderClass: DeathSenderClass;
  /** The tier the dead run used, when the caller knows it. */
  readonly tier?: AfkModelTier | null;
}

/**
 * Decide how the retry should differ from the run that died. PURE.
 *
 * Only a memory kill earns a different placement — a requested stop and a host
 * teardown say nothing about the resources the work needs, and bumping on them
 * would inflate every ceiling on the machine for a reason nobody observed.
 */
export function planHardDeathRemedy(input: HardDeathRemedyInput): HardDeathRemedyPlan {
  if (input.senderClass !== "oomd") {
    return {
      remedy: "plain",
      memoryBumpBytes: null,
      escalatedTier: null,
      note: "requeued unchanged: the receipt names who stopped the Worker, not what it needed",
    };
  }
  const bump = planMemoryBump(input);
  if (bump !== null) {
    return {
      remedy: "memory-bump",
      memoryBumpBytes: bump,
      escalatedTier: null,
      note: `requeued with the memory ceiling raised to ${formatGib(bump)}`,
    };
  }
  const escalated = input.tier == null ? null : escalateAfkModelTier(input.tier);
  if (escalated !== null) {
    return {
      remedy: "tier-escalation",
      memoryBumpBytes: null,
      escalatedTier: escalated,
      note: `requeued at the \`${escalated}\` tier: no memory headroom is left to give it`,
    };
  }
  return {
    remedy: "plain",
    memoryBumpBytes: null,
    escalatedTier: null,
    note: "requeued unchanged: neither a memory bump nor a tier escalation is available",
  };
}

/** systemd's size suffixes, in the spelling `systemd.resource-control` accepts. */
const BYTE_SUFFIXES: ReadonlyMap<string, number> = new Map([
  ["", 1],
  ["b", 1],
  ["k", 1024],
  ["kb", 1024],
  ["ki", 1024],
  ["m", 1024 ** 2],
  ["mb", 1024 ** 2],
  ["mi", 1024 ** 2],
  ["g", 1024 ** 3],
  ["gb", 1024 ** 3],
  ["gi", 1024 ** 3],
  ["t", 1024 ** 4],
  ["tb", 1024 ** 4],
  ["ti", 1024 ** 4],
]);

/**
 * Read a memory ceiling the daemon stamped as systemd writes it. PURE.
 *
 * The receipt's `memory_max` is a STRING — `8G`, `70%`, `infinity` — because
 * that is what the unit carried, and `Number("8G")` is `NaN`. Silently reading
 * NaN as "no ceiling" is the bug this closes: a 4 GiB peak under a 16 GiB
 * ceiling would then plan a 6 GiB "bump", which is a REDUCTION dressed as a
 * remedy. A percentage and an `infinity` answer `null` honestly — neither names
 * a number of bytes this module can compare against.
 */
export function parseByteQuantity(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)\s*$/.exec(value);
  if (match === null) return null;
  const unit = BYTE_SUFFIXES.get(match[2]!.toLowerCase());
  if (unit === undefined) return null;
  const bytes = Number(match[1]) * unit;
  return Number.isFinite(bytes) ? bytes : null;
}

/**
 * Render the receipt as one line a human can read on the issue. PURE.
 *
 * Every escalation quotes this, because the whole value of a hard-death page is
 * the evidence: "we do not know" and "the kernel reclaimed 4.00 GiB" send a
 * maintainer to two different places.
 */
export function renderDeathEvidence(evidence: WorkerDeathEvidence): string {
  const parts: string[] = [
    `sender=${evidence.sender_class ?? "unknown"}/${evidence.confidence ?? "none"}`,
  ];
  if (evidence.signal != null) parts.push(`signal=${evidence.signal}`);
  else if (evidence.exit_code != null) parts.push(`exit code=${evidence.exit_code}`);
  if (evidence.memory_peak_bytes != null) {
    parts.push(`memory peak=${formatGib(evidence.memory_peak_bytes)}`);
  }
  if (evidence.detail != null && evidence.detail !== "") parts.push(evidence.detail);
  return parts.join("; ");
}

/** One issue the sweep will act on, with everything the executor needs. */
export interface DeathSweepStep {
  readonly issue: number;
  /** The claim marker identity, `<host>:<worker_id>` — what the concede names. */
  readonly claimOwner: string;
  /** The daemon's key for the dead Worker. */
  readonly workerId: string;
  readonly evidence: WorkerDeathEvidence;
  readonly senderClass: DeathSenderClass;
  readonly outcome: WorkerOutcome;
  /** The 1-based requeue ordinal the caps count (ADR 0103). */
  readonly ordinal: number;
  readonly disposition: Disposition;
  readonly remedy: HardDeathRemedyPlan;
  /** The ledger event this death appends. Non-`done`, so the ordinal advances. */
  readonly historyEvent: HistoryEvent;
  /** The `reason` field carried on the history row. */
  readonly historyReason: string;
  /** The audit comment, evidence quoted. */
  readonly comment: string;
  /** The ISO timestamp of the dead worker's last claim marker, when known. */
  readonly lastHeartbeatAt?: string;
}

/** One death the sweep declined, and why — a deferral is a finding, not silence. */
export interface DeferredDeath {
  readonly workerId: string;
  readonly reason: DeathDeferralReason;
  readonly evidence: WorkerDeathEvidence;
}

export interface DeathSweepPlan {
  readonly steps: readonly DeathSweepStep[];
  readonly deferred: readonly DeferredDeath[];
}

export interface DeathSweepFacts {
  /** Death receipts off the daemon's event lane, oldest first. */
  readonly deaths: readonly WorkerDeathEvidence[];
  /** Every currently-claimed issue with its parsed claim markers. */
  readonly claimed: readonly ClaimedIssue[];
  /** The castle history ledger, for the requeue ordinal. */
  readonly history: readonly HistoryRecord[];
  /** `<host>:` — the prefix this checkout's claim markers carry. */
  readonly hostPrefix: string;
  /** Env for the recovery caps. */
  readonly env: RecoveryEnv;
  /** The tier the drain runs at, when the caller knows it. */
  readonly tier?: AfkModelTier | null;
  /** The most memory this host will hand one Worker, when a ceiling is set. */
  readonly hostCeilingBytes?: number | null;
}

/**
 * Plan one sweep tick. PURE — no clock, no IO, no tracker.
 *
 * The join is the point: a claim marker's `worker` is `<host>:<worker_id>`, and
 * only the checkout holds both halves. A marker whose latest record CONCEDED is
 * skipped — the Worker withdrew before it died, so the claim is already free and
 * a second release would post a second audit comment for nothing.
 */
export function planDeathSweep(facts: DeathSweepFacts): DeathSweepPlan {
  const steps: DeathSweepStep[] = [];
  const deferred: DeferredDeath[] = [];

  for (const evidence of deathEvidenceIn(facts.deaths)) {
    const deferral = deathVerdictIsActionable(evidence);
    if (deferral !== null) {
      deferred.push({ workerId: evidence.worker_id, reason: deferral, evidence });
      continue;
    }
    const held = findHeldClaim(evidence.worker_id, facts.claimed, facts.hostPrefix);
    if (held === null) {
      deferred.push({ workerId: evidence.worker_id, reason: "no-claim", evidence });
      continue;
    }

    const senderClass = evidence.sender_class as DeathSenderClass;
    const outcome = hardDeathOutcome(senderClass);
    const ordinal = requeueOrdinal(facts.history, held.issue);
    const disposition = dispose(outcome, ordinal, facts.env, { stalledRecoverable: false });
    const remedy = planHardDeathRemedy({
      senderClass,
      peakBytes: evidence.memory_peak_bytes ?? null,
      ceilingBytes: parseByteQuantity(evidence.memory_max),
      hostCeilingBytes: facts.hostCeilingBytes ?? null,
      tier: facts.tier ?? null,
    });

    steps.push({
      issue: held.issue,
      claimOwner: held.owner,
      workerId: evidence.worker_id,
      evidence,
      senderClass,
      outcome,
      ordinal,
      disposition,
      remedy,
      historyEvent: "blocked",
      historyReason: `hard-death:${senderClass}`,
      comment: renderDeathSweepAudit({ evidence, disposition, remedy, ordinal, owner: held.owner }),
      ...(held.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: held.lastHeartbeatAt }),
    });
  }

  return { steps, deferred };
}

export interface DeathSweepAuditInput {
  readonly evidence: WorkerDeathEvidence;
  readonly disposition: Disposition;
  readonly remedy: HardDeathRemedyPlan;
  readonly ordinal: number;
  readonly owner: string;
}

/**
 * The one comment the sweep posts per issue. PURE.
 *
 * A retry says what it changed; a park says what ran out AND quotes the receipt,
 * because after the caps a human is the next reader and the evidence is the
 * entire reason they were called.
 */
export function renderDeathSweepAudit(input: DeathSweepAuditInput): string {
  const evidence = renderDeathEvidence(input.evidence);
  const head =
    `🤖 AFK death sweep: the Worker \`${input.owner}\` died without saying goodbye — ` +
    `${evidence}. Its claim was released eagerly rather than left for the next boot sweep.`;
  if (input.disposition.decision === "retry") {
    return `${head}\n\nThis is requeue ${input.ordinal}${capSuffix(input.disposition)}; ${input.remedy.note}.`;
  }
  return (
    `${head}\n\n${input.disposition.escalationComment ??
      `Parked for a human: \`${input.disposition.typedLabel ?? "blocked"}\` carries no automatic requeue budget.`}` +
    `\n\nDeath evidence: ${evidence}.`
  );
}

/** The mutations one sweep tick performs. Narrow on purpose. */
export interface DeathSweepIO {
  /** Post the concede marker that withdraws the dead Worker's claim. */
  concede(issue: number, owner: string, lastHeartbeatAt?: string): Promise<void>;
  /** Append the terminal ledger row the requeue ordinal counts. */
  appendHistory(step: DeathSweepStep, clock: HistoryClock): Promise<void>;
  editLabels(issue: number, remove: readonly string[], add: readonly string[]): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  /** Current labels, re-read so a parallel edit is never clobbered. */
  viewLabels?(issue: number): Promise<readonly string[]>;
}

/** What one issue's sweep did. */
export interface DeathSweepOutcome {
  readonly issue: number;
  readonly workerId: string;
  readonly decision: "retry" | "escalate" | "skipped" | "failed";
  readonly remedy: HardDeathRemedy;
}

export interface DeathSweepResult {
  readonly released: readonly number[];
  readonly requeued: readonly number[];
  readonly parked: readonly number[];
  readonly deferred: readonly DeferredDeath[];
  readonly outcomes: readonly DeathSweepOutcome[];
}

/**
 * Apply one planned tick. THIN — every decision was already made.
 *
 * Concede first, ledger second, labels third, comment last: the withdrawal
 * marker must land before the label projection changes so no reader ever sees an
 * unclaimed-but-still-`running` issue, and the ledger row must land before the
 * labels so a crash between them leaves the ordinal counted rather than lost.
 * Each issue is independent — a failure is recorded and the tick continues.
 */
export async function executeDeathSweep(
  plan: DeathSweepPlan,
  io: DeathSweepIO,
  clock: HistoryClock,
  log?: (line: string) => void,
): Promise<DeathSweepResult> {
  const released: number[] = [];
  const requeued: number[] = [];
  const parked: number[] = [];
  const outcomes: DeathSweepOutcome[] = [];

  for (const step of plan.steps) {
    try {
      if (io.viewLabels) {
        const labels = await io.viewLabels(step.issue);
        if (!labels.includes(LABEL_RUNNING)) {
          outcomes.push({
            issue: step.issue,
            workerId: step.workerId,
            decision: "skipped",
            remedy: step.remedy.remedy,
          });
          continue;
        }
      }
      await io.concede(step.issue, step.claimOwner, step.lastHeartbeatAt);
      await io.appendHistory(step, clock);
      await io.editLabels(step.issue, step.disposition.removeLabels, step.disposition.addLabels);
      await io.comment(step.issue, step.comment);
      released.push(step.issue);
      (step.disposition.decision === "retry" ? requeued : parked).push(step.issue);
      outcomes.push({
        issue: step.issue,
        workerId: step.workerId,
        decision: step.disposition.decision,
        remedy: step.remedy.remedy,
      });
      log?.(
        `death sweep #${step.issue}: ${step.senderClass} → ${step.disposition.decision}` +
          ` (requeue ${step.ordinal}, remedy ${step.remedy.remedy})`,
      );
    } catch {
      // Best effort by contract: an issue this tick could not release is exactly
      // the issue the boot sweep's staleness clock still covers.
      outcomes.push({
        issue: step.issue,
        workerId: step.workerId,
        decision: "failed",
        remedy: step.remedy.remedy,
      });
    }
  }

  return { released, requeued, parked, deferred: plan.deferred, outcomes };
}

/** The claim this dead worker still holds, or `null`. */
interface HeldClaim {
  readonly issue: number;
  readonly owner: string;
  readonly lastHeartbeatAt?: string;
}

function findHeldClaim(
  workerId: string,
  claimed: readonly ClaimedIssue[],
  hostPrefix: string,
): HeldClaim | null {
  const exact = `${hostPrefix}${workerId}`;
  for (const issue of claimed) {
    const owner = issue.records
      .map((record) => record.worker)
      .find((worker) => worker === exact || worker === workerId);
    if (owner === undefined) continue;
    // A worker that CONCEDED before it died already freed the claim; releasing it
    // again would post a second audit comment for a claim nobody holds.
    const state = classifyIssueClaims(issue.records, () => false);
    if (state.concededOwners.includes(owner)) continue;
    const latest = issue.records
      .filter((record) => record.worker === owner)
      .sort((a, b) => b.commentId - a.commentId)[0];
    return {
      issue: issue.issue,
      owner,
      ...(latest?.createdAt === undefined ? {} : { lastHeartbeatAt: latest.createdAt }),
    };
  }
  return null;
}

function capSuffix(disposition: Disposition): string {
  return disposition.cap === null ? "" : ` of ${disposition.cap}`;
}

function positiveOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}



function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Everything one tick reads and everything it writes, in one port.
 *
 * A port rather than four loose callbacks because the tick has exactly one
 * caller shape — read the lane, read the claims, read the ledger, then mutate —
 * and a caller that wires three of the four has a sweep that silently does
 * nothing.
 */
export interface DeathSweepPort extends DeathSweepIO {
  /** Death receipts from the daemon's event lane, oldest first. */
  deaths(): Promise<readonly WorkerDeathEvidence[]>;
  /** Every issue currently projected `running`, with its claim markers. */
  claimedIssues(): Promise<readonly ClaimedIssue[]>;
  /** The castle history ledger, for the requeue ordinal. */
  history(): Promise<readonly HistoryRecord[]>;
  /** `<host>:` — the prefix this checkout's claim markers carry. */
  readonly hostPrefix: string;
}

export interface DeathSweepTickContext {
  readonly env: RecoveryEnv;
  readonly clock: HistoryClock;
  readonly tier?: AfkModelTier | null;
  readonly hostCeilingBytes?: number | null;
  readonly log?: (line: string) => void;
}

/**
 * Read, plan and apply ONE sweep tick.
 *
 * This is the verb a manager tick and a reap call, and the verb the boot
 * sequence calls before its staleness sweep — one entrance, so a new caller
 * inherits the ordering rules rather than restating them. A read that fails
 * yields an empty tick rather than an exception: a sweep that cannot see the
 * lane is exactly the case the staleness clock still covers.
 */
export async function runDeathSweep(
  port: DeathSweepPort,
  context: DeathSweepTickContext,
): Promise<DeathSweepResult> {
  let deaths: readonly WorkerDeathEvidence[];
  let claimed: readonly ClaimedIssue[];
  let history: readonly HistoryRecord[];
  try {
    deaths = await port.deaths();
    if (deaths.length === 0) return EMPTY_DEATH_SWEEP;
    claimed = await port.claimedIssues();
    history = await port.history();
  } catch {
    return EMPTY_DEATH_SWEEP;
  }

  const plan = planDeathSweep({
    deaths,
    claimed,
    history,
    hostPrefix: port.hostPrefix,
    env: context.env,
    tier: context.tier ?? null,
    hostCeilingBytes: context.hostCeilingBytes ?? null,
  });
  return await executeDeathSweep(plan, port, context.clock, context.log);
}

const EMPTY_DEATH_SWEEP: DeathSweepResult = {
  released: [],
  requeued: [],
  parked: [],
  deferred: [],
  outcomes: [],
};
