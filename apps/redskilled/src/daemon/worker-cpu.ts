import type { RedskilledWorkerView } from "../host-state.js";
import type { RedskilledCpuReading } from "../memory-sampler.js";

/** Carry measured CPU forward without erasing Workers absent from this tick. */
export function recordWorkerCpuReadings(
  workers: Map<string, RedskilledWorkerView>,
  cpuSeconds: RedskilledCpuReading,
  sampledAt: string,
): void {
  for (const [workerId, seconds] of Object.entries(cpuSeconds)) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) continue;
    const held = workers.get(workerId);
    if (!held) continue;
    workers.set(workerId, { ...held, cpu: { cpu_seconds: seconds, sampled_at: sampledAt } });
  }
}
