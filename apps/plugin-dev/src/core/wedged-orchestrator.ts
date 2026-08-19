// core/wedged-orchestrator.ts — name the hang the liveness lane cannot see.
//
// Every stall signal this engine has watches the INNER AGENT: the liveness lane
// advances on agent stream events, the reaper keys off its mtime, the vitals
// call a worker with a live descendant healthy. None of them describes the
// window AFTER the agent emits DONE, when the orchestrator itself owns the turn
// — and an orchestrator that blocks there spawns no child, opens no socket and
// writes nothing, so every surface reads `live=true` while nothing happens
// (#2985: 30+ minutes parked in `ep_poll` behind a host-wide gate lock).
//
// This module is the classifier for that shape and nothing else. It is pure: it
// takes what `worker_vitals` already knows and answers with an alert or null.

/**
 * The phases in which the ORCHESTRATOR — not the inner agent — owns the turn.
 * Silence here means the engine itself is stuck; silence during `coding` means
 * the agent is thinking, which is a different question with its own detector.
 */
export const ORCHESTRATOR_OWNED_PHASES: readonly string[] = ["validating", "merging"];

/**
 * How long an orchestrator-owned phase may be silent before it is a page.
 *
 * The gate's own steps are loud — every stage writes a validation record and
 * spawns children — so ten minutes of nothing is not a slow test run, it is a
 * wait nobody declared. Below this a genuinely long `pnpm install` between
 * writes would page; far above it the hang outlives the fleet's patience.
 */
export const WEDGED_ORCHESTRATOR_SILENCE_MS = 10 * 60_000;

export interface WedgedOrchestratorInput {
  /** Is the worker process itself alive? A dead one is somebody else's alert. */
  readonly live: boolean;
  /** `current.phase` — which side of the DONE boundary the worker is on. */
  readonly phase: string;
  /** Age of the newest liveness-lane record, from the evaluator's verdict. */
  readonly laneAgeMs?: number;
  /** Does the worker have a live descendant process? */
  readonly liveDescendants?: boolean;
  /** `current.blocked_on` — a wait that NAMED itself (e.g. `lock:validation-gate`). */
  readonly blockedOn?: string;
  /** `current.blocked_detail` — that wait's own one-line account. */
  readonly blockedDetail?: string;
  /** Override for {@link WEDGED_ORCHESTRATOR_SILENCE_MS}. */
  readonly silenceThresholdMs?: number;
}

export interface WedgedOrchestratorAlert {
  /** `orchestrator-blocked` — waiting, and it said so. `orchestrator-wedged` —
   * waiting, and nothing anywhere says on what. The second is the bug class. */
  readonly type: "orchestrator-blocked" | "orchestrator-wedged";
  readonly message: string;
}

function humanizeMs(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}

/**
 * Classify the post-DONE stuck shape: alive, orchestrator-owned phase, no child
 * process, and no lane record for {@link WEDGED_ORCHESTRATOR_SILENCE_MS}.
 *
 * A wait that NAMED itself still pages once it ages past the threshold — a
 * declared hour-long block is a smaller lie than an undeclared one, not a
 * healthy state — but it pages under its own name, carrying what it waits for.
 * Returns `null` for every shape that is somebody else's problem.
 */
export function detectWedgedOrchestrator(
  input: WedgedOrchestratorInput,
): WedgedOrchestratorAlert | null {
  if (!input.live) return null;
  if (!ORCHESTRATOR_OWNED_PHASES.includes(input.phase)) return null;
  // A live descendant IS the work; only the childless silence is the hang.
  if (input.liveDescendants === true) return null;
  const threshold = input.silenceThresholdMs ?? WEDGED_ORCHESTRATOR_SILENCE_MS;
  const age = input.laneAgeMs;
  if (age === undefined || age < threshold) return null;
  const silent = humanizeMs(age);
  const blockedOn = (input.blockedOn ?? "").trim();
  if (blockedOn !== "") {
    const detail = (input.blockedDetail ?? "").trim();
    return {
      type: "orchestrator-blocked",
      message:
        `Orchestrator has been blocked on \`${blockedOn}\` for ${silent} in phase \`${input.phase}\`` +
        ` with no child process.${detail === "" ? "" : ` ${detail}`}`,
    };
  }
  return {
    type: "orchestrator-wedged",
    message:
      `Orchestrator has written nothing for ${silent} in phase \`${input.phase}\` with no child process` +
      ` and nothing naming a wait — the inner agent is done and the engine is not progressing.` +
      ` \`live=true\` here is liveness of the process, not of the work.`,
  };
}
