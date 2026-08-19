// park-loop — the re-park loop detector (#3377).
//
// A park is a handoff to a human. A park REPEATED with the same blocker, minutes
// after the last one, is not a handoff — it is the engine telling itself the
// same thing forever. That is what #3335/#3336/#3343 did on 2026-08-05: an
// orphaned origin tip parked with one diagnosis, the issue was requeued, the
// next Worker reproduced the identical park, and the cycle had no floor because
// nothing in the pipeline ever compared a park to the one before it.
//
// This module is PURE: it maps (previous blocker, next blocker, now) to a
// verdict. The blocker's `parked_at` stamp is what makes "within a short window"
// answerable at all — see blocker-state.ts.

import type { CurrentBlocker } from "./blocker-state.js";

/**
 * How recently the previous park must have happened for a repeat to count as a
 * loop. Three hours is deliberately SHORT: the signal being caught is
 * worker-by-worker rebirth, which turns around in minutes. An identical park a
 * day later is a stale issue nobody got to, and escalating that as a loop would
 * teach humans to ignore the note.
 */
export const PARK_LOOP_WINDOW_S = 3 * 60 * 60;

/** The comparable identity of a park: its kind and its summary, nothing else.
 * The `next:` is derived from the kind, and the `ref:` moves between Workers
 * without the blocker changing at all — including either would let a loop hide
 * behind a field that carries no diagnosis. */
export function parkSignature(blocker: Pick<CurrentBlocker, "kind" | "summary">): string {
  const norm = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
  return `${norm(blocker.kind)}|${norm(blocker.summary)}`;
}

/** The verdict. `loop:true` means this park must ESCALATE rather than retry. */
export interface ParkLoopVerdict {
  loop: boolean;
  /** The note the escalating park carries, or null when there is no loop. */
  note: string | null;
  /** Seconds between the two parks, when both stamps were readable. */
  elapsedS?: number;
}

const NO_LOOP: ParkLoopVerdict = { loop: false, note: null };

/**
 * Detect a re-park loop: the SAME issue, the SAME blocker signature, inside the
 * window. Three things deliberately return "no loop" rather than a guess:
 *
 *   - no previous park (the first park of a blocker is just a park);
 *   - a previous park with no readable `parked_at` stamp (a record written
 *     before this detector existed must not escalate on its first re-park);
 *   - a differing signature (a NEW blocker is progress, even when it parks).
 */
export function detectParkLoop(input: {
  previous: CurrentBlocker | null;
  next: Pick<CurrentBlocker, "kind" | "summary">;
  nowEpoch: number;
  windowS?: number;
}): ParkLoopVerdict {
  const { previous, next, nowEpoch } = input;
  const windowS = input.windowS ?? PARK_LOOP_WINDOW_S;
  if (!previous) return NO_LOOP;
  if (previous.parkedAtEpoch === undefined) return NO_LOOP;
  if (parkSignature(previous) !== parkSignature(next)) return NO_LOOP;
  const elapsedS = nowEpoch - previous.parkedAtEpoch;
  // A stamp from the future is an unusable clock, not a zero-second loop.
  if (elapsedS < 0 || elapsedS > windowS) return NO_LOOP;
  return { loop: true, note: formatLoopNote(next.kind, elapsedS, windowS), elapsedS };
}

/** The note a loop-detected park carries. It names the repetition, the interval
 * and the fact that the automatic route is now closed, because the cure for a
 * loop is never another lap. */
export function formatLoopNote(kind: string, elapsedS: number, windowS: number = PARK_LOOP_WINDOW_S): string {
  return (
    `re-park loop detected — this issue parked with the identical blocker (kind: ${kind}) ` +
    `${describeInterval(elapsedS)} ago, inside the ${describeInterval(windowS)} loop window. ` +
    `Automatic re-queue is withheld: each Worker is reproducing the same park, so the next lap changes nothing. ` +
    `A human must change the blocker's cause or the guidance before this issue is queued again.`
  );
}

function describeInterval(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
