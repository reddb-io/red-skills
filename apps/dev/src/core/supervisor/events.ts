import type { SupervisorDeps, SupervisorEventRecord } from "./types.js";

export async function emitSupervisorEvent(
  deps: SupervisorDeps,
  record: SupervisorEventRecord,
): Promise<void> {
  try {
    await deps.emitSupervisorEvent?.(record);
  } catch {
    // best-effort: telemetry IO must not affect supervisor scheduling.
  }
}
