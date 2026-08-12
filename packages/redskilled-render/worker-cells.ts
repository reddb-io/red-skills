import { formatDuration } from "./format.js";
import type { RedskilledRenderWorker, RedskilledRenderWorkerDisplay } from "./payload.js";

/** Macro position and momentary verb, with their axes visible in the grammar. */
export function phaseActivityCell(display: RedskilledRenderWorkerDisplay): string {
  const phase = display.phase;
  const total = display.phase_total;
  const index = display.phase_index;
  const positioned = phase != null && total != null && total > 0 && index != null && index >= 0
    ? `${phase} ${Math.min(Math.floor(index) + 1, Math.floor(total))}/${Math.floor(total)}`
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
