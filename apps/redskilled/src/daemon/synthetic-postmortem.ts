/**
 * synthetic-postmortem — a Worker that ends without saying goodbye still leaves
 * a story (ADR 0155, Spec #4164, #4176).
 *
 * **A death nothing explains is a death nobody can act on.** #4133 put the unit
 * receipt onto the worker-death record as facts, and #4136 taught the checkout
 * to spend those facts on a claim. Both halves work only when the receipt NAMES
 * a sender: an unattributed SIGKILL, a Worker the host simply stopped
 * confirming, a unit systemd retained no exit details for — all three reach the
 * lane as `sender_class: unknown`, which the checkout deliberately DEFERS to a
 * staleness clock. That deferral is correct and it is also the moment the
 * failure story evaporates: the row says a Worker died and nothing else, so the
 * only account of what happened lives in whoever was watching.
 *
 * **So the daemon writes the account the Worker never got to write.** A silent
 * death appends a SECOND row, `worker-postmortem`, beside the death it explains:
 * the failure mode as a structured field, and every last thing the daemon held
 * about that Worker rendered into one line — when it was born, what its tree had
 * burned, the ceiling it ran under, the signal or receipt if either spoke, and
 * the path to the narration it left behind. Synthetic because nobody witnessed
 * it: the row is assembled from what the host retained, and it says so.
 *
 * **Facts only; the join is still the checkout's.** ADR 0130/0144 keep the
 * daemon ignorant of what a Ticket, a label or a tracker is. This row is keyed
 * by `worker_id` exactly as the death it accompanies, rides the daemon's own
 * registered event lane, and decides nothing about recovery — the boundary is
 * enforced mechanically by `daemon-death-evidence-guard`.
 */
import type { RecordWorkerEventInput } from "../event-lane.js";
import type { RedskilledWorkerView } from "../host-state.js";

/**
 * What the host can tell about a death nobody explained.
 *
 * Three of the five are spelled exactly as the Worker failure retry classes
 * (#4175) so a checkout routes on the word without a translation table; the
 * other two name what only a host-scoped observer can see and no error text ever
 * carries — a process that vanished between two liveness probes, and a kill
 * whose signal named no sender.
 */
export const SILENT_DEATH_FAILURE_MODES = [
  "oom",
  "cap-hit",
  "unattributed-kill",
  "host-vanished",
  "unknown",
] as const;

export type SilentDeathFailureMode = (typeof SILENT_DEATH_FAILURE_MODES)[number];

/** The death-record fields the postmortem turns on; every one may be absent. */
export type SilentDeathEvidence = Pick<
  RecordWorkerEventInput,
  | "deliberate"
  | "senderClass"
  | "confidence"
  | "exitCode"
  | "signal"
  | "systemdResult"
  | "memoryPeakBytes"
  | "memorySwapPeakBytes"
  | "journalTail"
>;

/**
 * Did this death explain itself? PURE.
 *
 * The complement of the checkout's `deathVerdictIsActionable` on purpose: a
 * death the sweep can act on already carries its own account, and a second row
 * restating it would be noise. What is left is exactly the set the sweep defers
 * — no exit status of its own, and no sender named at a confidence anyone would
 * spend a claim on — which is the set whose story would otherwise be lost. A
 * death the DAEMON decided on is excluded outright: the decider is the account.
 */
export function deathWasSilent(evidence: SilentDeathEvidence): boolean {
  if (evidence.deliberate === true) return false;
  if (evidence.exitCode != null) return false;
  const sender = evidence.senderClass ?? null;
  if (sender === null || sender === "unknown") return true;
  return evidence.confidence !== "high" && evidence.confidence !== "medium";
}

/**
 * Name the failure mode from whatever the host retained. PURE.
 *
 * The order is the order of authority: a memory verdict first, because it is the
 * only one a kernel writes down; then the supervisor's own timeout, which is a
 * cap by another name; then a signal, which names an act and no author; then the
 * absence of every receipt at once, which is its own finding — a Worker the host
 * stopped confirming with nothing retained about how it went.
 */
export function classifySilentDeath(evidence: SilentDeathEvidence): SilentDeathFailureMode {
  const result = evidence.systemdResult ?? null;
  const signal = evidence.signal ?? null;
  if (result === "oom-kill" || evidence.senderClass === "oomd") return "oom";
  if (result === "timeout" || result === "watchdog") return "cap-hit";
  if (signal != null) return "unattributed-kill";
  if (result === null && evidence.exitCode == null) return "host-vanished";
  return "unknown";
}

/**
 * Every last thing the daemon held about this Worker, in one line. PURE.
 *
 * The whole value of a postmortem is that a reader who was not watching can
 * still start somewhere, so the line ends with the pointer rather than the
 * summary: `log=` is the narration the Worker itself wrote, and it is the only
 * field here the daemon did not derive.
 */
export function renderLastEvidence(
  worker: RedskilledWorkerView,
  evidence: SilentDeathEvidence,
): string {
  const parts = [`born=${worker.started_at}`];
  if (worker.cpu != null) {
    parts.push(`cpu=${worker.cpu.cpu_seconds.toFixed(1)}s at ${worker.cpu.sampled_at}`);
  }
  if (evidence.signal != null) parts.push(`signal=${evidence.signal}`);
  if (evidence.systemdResult != null) parts.push(`systemd result=${evidence.systemdResult}`);
  if (evidence.memoryPeakBytes != null) parts.push(`memory peak=${formatGib(evidence.memoryPeakBytes)}`);
  const ceiling = worker.memory_ceiling ?? worker.applied_budget?.memory_max ?? null;
  if (ceiling != null) parts.push(`ceiling=${ceiling}`);
  if (worker.warnings.length > 0) parts.push(`warnings: ${worker.warnings.join(", ")}`);
  const tail = lastLineOf(evidence.journalTail);
  if (tail != null) parts.push(`journal: ${tail}`);
  parts.push(`log=${worker.log_path ?? "unrecorded"}`);
  return parts.join("; ");
}

/**
 * The postmortem row a silent death earns, or `null` when the death spoke.
 *
 * It is built FROM the death record rather than beside it, so every fact the
 * receipt carried rides the postmortem too and a reader never has to join the
 * two rows back together to learn what the host saw.
 */
export function planSyntheticPostmortem(
  death: RecordWorkerEventInput,
): RecordWorkerEventInput | null {
  if (death.kind !== "worker-death") return null;
  if (!deathWasSilent(death)) return null;
  const failureMode = classifySilentDeath(death);
  return {
    ...death,
    kind: "worker-postmortem",
    failureMode,
    detail: `synthetic postmortem: failure-mode=${failureMode}; ${renderLastEvidence(death.worker, death)}`,
  };
}

/**
 * Append the postmortem this death earns, if it earns one.
 *
 * The one entrance the daemon uses, so the question "is this death silent?" is
 * asked in exactly one place and every future path that ends a Worker inherits
 * the answer rather than restating it.
 */
export function appendSyntheticPostmortem(
  append: (postmortem: RecordWorkerEventInput) => void,
  death: RecordWorkerEventInput,
): void {
  const postmortem = planSyntheticPostmortem(death);
  if (postmortem != null) append(postmortem);
}

/** Longest journal fragment a postmortem line carries; the rest is in the unit. */
const JOURNAL_TAIL_BUDGET = 200;

function lastLineOf(text: string | null | undefined): string | null {
  if (text == null) return null;
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  return last.length <= JOURNAL_TAIL_BUDGET ? last : `${last.slice(0, JOURNAL_TAIL_BUDGET)}…`;
}

function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
