import { formatDuration } from "./format.js";
import { resolveLifecyclePosition } from "./lifecycle-phase.js";
import type { RedskilledRenderWorker, RedskilledRenderWorkerDisplay } from "./payload.js";

/**
 * Macro position and momentary verb, with their axes visible in the grammar.
 *
 * The position comes from the published pair when there is one and from the
 * phase word's declared cell otherwise — the SAME resolution the bar beside it
 * uses, so the cell can never state `gate 3/5` beside a bar drawn at a different
 * cursor. A phase no table declares keeps its bare word and gains no ordinal.
 */
export function phaseActivityCell(display: RedskilledRenderWorkerDisplay): string {
  const phase = display.phase;
  const total = display.phase_total;
  const index = display.phase_index;
  const resolved = total != null && total > 0 && index != null && index >= 0
    ? { index: Math.floor(index), total: Math.floor(total) }
    : resolveLifecyclePosition(phase);
  const positioned = phase != null && resolved != null
    ? `${phase} ${Math.min(resolved.index + 1, resolved.total)}/${resolved.total}`
    : phase;
  return [positioned, display.step].filter((part): part is string => Boolean(part)).join(" · ");
}

function elapsedSince(startedAt: string | null | undefined, generatedAt: string): number | null {
  if (startedAt == null || startedAt === "") return null;
  const started = Date.parse(startedAt);
  const now = Date.parse(generatedAt);
  return Number.isFinite(started) && Number.isFinite(now) ? Math.max(0, now - started) : null;
}

/** Three named clocks: process age, macro-phase age, and real-progress idle age. */
export function workerClocksCell(
  worker: RedskilledRenderWorker,
  display: RedskilledRenderWorkerDisplay,
  generatedAt: string,
): string {
  const age = worker.uptime_ms ?? elapsedSince(worker.started_at, generatedAt);
  const phase = elapsedSince(display.phase_started_at, generatedAt);
  const idle = elapsedSince(display.progress_at, generatedAt);
  return [
    age == null ? null : `age=${formatDuration(age)}`,
    phase == null ? null : `phase=${formatDuration(phase)}`,
    idle == null ? null : `idle=${formatDuration(idle)}`,
  ].filter((part): part is string => part != null).join(" ");
}
