/** Durable per-Worker resource peaks folded across samples and daemon handover. */
import type { RecordWorkerEventInput, RedskilledHostEvent } from "../event-lane.js";
import type { RedskilledResourceSample } from "../resource-incidents.js";

export interface WorkerHighWater {
  readonly memory: number;
  readonly swap: number;
  readonly pids: number;
}

export type WorkerHighWaterMap = Map<string, WorkerHighWater>;

const EMPTY: WorkerHighWater = { memory: 0, swap: 0, pids: 0 };

export function replayWorkerHighWater(events: readonly RedskilledHostEvent[]): WorkerHighWaterMap {
  const highWater: WorkerHighWaterMap = new Map();
  for (const event of events) {
    if (event.worker_id === "" || event.worker_id.startsWith("daemon:")) continue;
    const previous = highWater.get(event.worker_id);
    if (previous == null && event.memory_peak_bytes == null && event.memory_swap_peak_bytes == null && event.pids_peak == null) continue;
    highWater.set(event.worker_id, merge(previous ?? EMPTY, {
      memory: event.memory_peak_bytes ?? 0,
      swap: event.memory_swap_peak_bytes ?? 0,
      pids: event.pids_peak ?? 0,
    }));
  }
  return highWater;
}

export function foldWorkerHighWater(
  highWater: WorkerHighWaterMap,
  workerId: string,
  sample: RedskilledResourceSample,
): WorkerHighWater | null {
  const previous = highWater.get(workerId) ?? EMPTY;
  const next = merge(previous, {
    memory: sample.memory.peak_bytes,
    swap: sample.memory.swap_peak_bytes ?? 0,
    pids: sample.pids.peak,
  });
  if (next.memory === previous.memory && next.swap === previous.swap && next.pids === previous.pids) return null;
  highWater.set(workerId, next);
  return next;
}

export function terminalHighWaterFacts(
  highWater: WorkerHighWaterMap,
  workerId: string,
  facts: Omit<RecordWorkerEventInput, "kind" | "worker" | "ts" | "detail">,
): Pick<RecordWorkerEventInput, "memoryPeakBytes" | "memorySwapPeakBytes" | "pidsPeak"> | undefined {
  const high = highWater.get(workerId);
  return high == null ? undefined : {
    memoryPeakBytes: Math.max(facts.memoryPeakBytes ?? 0, high.memory),
    memorySwapPeakBytes: Math.max(facts.memorySwapPeakBytes ?? 0, high.swap),
    pidsPeak: Math.max(facts.pidsPeak ?? 0, high.pids),
  };
}

function merge(left: WorkerHighWater, right: WorkerHighWater): WorkerHighWater {
  return {
    memory: Math.max(left.memory, right.memory),
    swap: Math.max(left.swap, right.swap),
    pids: Math.max(left.pids, right.pids),
  };
}
