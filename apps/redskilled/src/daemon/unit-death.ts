/**
 * unit-death — the systemd unit receipt, read as FACTS rather than rendered as
 * prose (ADR 0155 §1, issue #4133).
 *
 * **A receipt the daemon only narrates is evidence nobody can act on.** The unit
 * receipt already carried `exit_code`, `signal`, `systemd_result` and
 * `memory_peak_bytes` onto the worker-death record; what it did NOT carry was
 * the one judgement a reader wants — WHO ended the Worker. That judgement was
 * being made, once, far downstream, to paint a statusline, and a recovery policy
 * that wanted it had to re-derive it from a sentence.
 *
 * **So the classification happens here, where the receipt is read, and rides the
 * record.** `sender_class` and `confidence` are the existing attribution
 * vocabulary (`death-attribution.ts`) — no new members, because a sixth class
 * would be a decision about death, not a field on a record.
 *
 * **Facts only; the join is the checkout's.** ADR 0130/0144 keep the daemon
 * ignorant of what an issue, a label or a tracker is: this record is keyed by
 * `worker_id` and says what the host observed. Which Ticket that Worker held,
 * and what to do about it, is decided by the checkout-side sweep that joins
 * `worker_id → claim → issue`. The boundary is enforced mechanically by
 * `apps/plugin-dev/tests/daemon-death-evidence-guard.test.ts`.
 */
import type {
  AttributionConfidence,
  DeathSenderClass,
} from "@reddb-io/shared/death-attribution.js";

import type { RecordWorkerEventInput } from "../event-lane.js";
import type { RedskilledWorkerView } from "../host-state.js";
import type {
  RedskilledUnitExitFacts,
  RedskilledUnitExitFactsProbe,
} from "../reattach.js";
import { parseContainerPlacementHandle } from "../reattach.js";

type UnitDeathFacts = Pick<
  RecordWorkerEventInput,
  | "exitCode"
  | "signal"
  | "systemdResult"
  | "memoryPeakBytes"
  | "memorySwapPeakBytes"
  | "journalTail"
  | "senderClass"
  | "confidence"
>;

export interface ResolvedUnitDeath {
  readonly detail: string;
  readonly facts: UnitDeathFacts;
}

/** Who ended a Worker, and how far the receipt goes toward proving it. PURE result. */
export interface UnitDeathVerdict {
  readonly senderClass: DeathSenderClass;
  readonly confidence: AttributionConfidence;
}

/** The receipt fields the classification turns on; every one may be absent. */
export interface UnitDeathEvidence {
  readonly systemdResult?: string | null;
  readonly signal?: string | null;
  readonly exitCode?: number | null;
}

/**
 * systemd's own verdicts that name the manager as the one that ended the unit.
 *
 * A stop timeout and a watchdog timeout are the supervisor killing what it
 * supervises — the same act the daemon performs when it kills a Worker over
 * budget, which this codebase has always called `teardown`. Reading them as a
 * user signal would blame a person for a machine's decision.
 */
const MANAGER_ENDED_RESULTS = new Set(["timeout", "watchdog", "start-limit-hit"]);

/**
 * The signals a person or a tool sends to ask a process to stop.
 *
 * SIGKILL is deliberately ABSENT: it is the one signal that names no sender.
 * systemd reports it as `signal` whether an operator sent it, a supervisor sent
 * it, or the kernel's OOM killer sent it on a host with no oomd integration —
 * and that last case is exactly the death this receipt exists to explain. An
 * unattributed SIGKILL is therefore `unknown` at `low` confidence rather than a
 * guess wearing a person's name.
 */
const REQUESTED_STOP_SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]);

/**
 * Classify one unit receipt into the shared attribution vocabulary. PURE.
 *
 * The order is the order of authority: the manager's own verdict first, because
 * it is the only source that can NAME a killer; then the signal, which names an
 * act but not always its author; then the exit status, which names no sender at
 * all — a process that reached a code left under its own power, and `unknown`
 * with `none` is the honest reading of "nothing ended it".
 */
export function classifyUnitDeath(evidence: UnitDeathEvidence): UnitDeathVerdict {
  const result = evidence.systemdResult ?? null;
  const signal = evidence.signal ?? null;
  if (result === "oom-kill") return { senderClass: "oomd", confidence: "high" };
  if (result != null && MANAGER_ENDED_RESULTS.has(result)) {
    return { senderClass: "teardown", confidence: "high" };
  }
  if (signal === "SIGKILL") return { senderClass: "unknown", confidence: "low" };
  if (signal != null && REQUESTED_STOP_SIGNALS.has(signal)) {
    return { senderClass: "user-signal", confidence: "high" };
  }
  // A signal outside both families was named by a source that watched this
  // process under the boot it lived in, but the family says nothing about who
  // sent it; `medium` is the confidence for a source that names the act.
  if (signal != null) return { senderClass: "user-signal", confidence: "medium" };
  return { senderClass: "unknown", confidence: "none" };
}

/**
 * Prefer a dead transient unit's own receipt over its launch client's exit, and
 * classify whichever of the two spoke.
 *
 * The fallback path — an unisolated Worker, a container placement, a probe that
 * would not answer — observed a real process exit and gets the same reading, so
 * a caller never has to ask which path produced the record it is holding. A path
 * that gathered NOTHING classifies to `unknown`/`none`, which is the truthful
 * answer and never a silent absence.
 */
export async function resolveUnitDeath(
  worker: RedskilledWorkerView,
  probe: RedskilledUnitExitFactsProbe,
  fallback: ResolvedUnitDeath,
): Promise<ResolvedUnitDeath> {
  const receipt = worker.unit == null || worker.unit === "" ||
      parseContainerPlacementHandle(worker.unit) != null
    ? null
    : await Promise.resolve(probe(worker.unit)).catch(() => null);
  if (receipt == null) {
    return { ...fallback, facts: { ...fallback.facts, ...classifyUnitDeath(fallback.facts) } };
  }
  const facts: UnitDeathFacts = {
    exitCode: receipt.exit_code,
    signal: receipt.signal,
    systemdResult: receipt.systemd_result,
    memoryPeakBytes: receipt.memory_peak_bytes,
    memorySwapPeakBytes: receipt.memory_swap_peak_bytes,
    journalTail: receipt.journal_tail,
  };
  return { detail: describeUnitExitReceipt(receipt), facts: { ...facts, ...classifyUnitDeath(facts) } };
}

/** Render the structured unit receipt once for evidence-bearing human surfaces. */
export function describeUnitExitReceipt(receipt: RedskilledUnitExitFacts): string {
  const parts: string[] = [];
  if (receipt.systemd_result != null) parts.push(`systemd result=${receipt.systemd_result}`);
  if (receipt.signal != null) parts.push(`main process signal=${receipt.signal}`);
  else if (receipt.exit_code != null) parts.push(`main process exit code=${receipt.exit_code}`);
  if (receipt.memory_peak_bytes != null) {
    const swap = receipt.memory_swap_peak_bytes == null
      ? ""
      : ` + ${formatGib(receipt.memory_swap_peak_bytes)} swap`;
    parts.push(`memory peak=${formatGib(receipt.memory_peak_bytes)}${swap}`);
  } else if (receipt.memory_swap_peak_bytes != null) {
    parts.push(`swap peak=${formatGib(receipt.memory_swap_peak_bytes)}`);
  }
  return parts.length === 0 ? "systemd retained the unit without exit details" : parts.join("; ");
}

function formatGib(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`;
}
