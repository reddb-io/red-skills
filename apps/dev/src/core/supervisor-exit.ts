import type { CastleLaneRecord } from "@reddb-io/red-castle/engine";

export type SupervisorExitReason =
  | "signal"
  | "exception"
  | "explicit-stop"
  | "completed"
  /** The tick loop stopped so a successor on a newer published bundle can take
   * over (#2925) — a restart, not a stop: the live Workers are handed across. */
  | "self-replace"
  | "process-exit";

type SupervisorExitRecord = Omit<CastleLaneRecord, "at">;

export interface SupervisorExitRecorderOptions {
  supervisorId: string;
  append(record: SupervisorExitRecord): Promise<void>;
  appendSync(record: SupervisorExitRecord): void;
}

export interface SupervisorExitRecorder {
  record(reason: SupervisorExitReason, detail?: Record<string, unknown>): Promise<void>;
  recordSync(reason: SupervisorExitReason, detail?: Record<string, unknown>): void;
}

export function createSupervisorExitRecorder(
  options: SupervisorExitRecorderOptions,
): SupervisorExitRecorder {
  let recorded = false;
  const terminalRecord = (
    reason: SupervisorExitReason,
    detail: Record<string, unknown> = {},
  ): SupervisorExitRecord => ({
    kind: "supervisor.exit",
    supervisor_id: options.supervisorId,
    payload: { reason, ...detail },
  });

  return {
    async record(reason, detail): Promise<void> {
      if (recorded) return;
      recorded = true;
      const record = terminalRecord(reason, detail);
      try {
        await options.append(record);
      } catch {
        options.appendSync(record);
      }
    },
    recordSync(reason, detail): void {
      if (recorded) return;
      recorded = true;
      options.appendSync(terminalRecord(reason, detail));
    },
  };
}
