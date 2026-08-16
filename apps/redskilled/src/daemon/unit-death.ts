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
>;

export interface ResolvedUnitDeath {
  readonly detail: string;
  readonly facts: UnitDeathFacts;
}

/** Prefer a dead transient unit's own receipt over its launch client's exit. */
export async function resolveUnitDeath(
  worker: RedskilledWorkerView,
  probe: RedskilledUnitExitFactsProbe,
  fallback: ResolvedUnitDeath,
): Promise<ResolvedUnitDeath> {
  if (worker.unit == null || worker.unit === "" || parseContainerPlacementHandle(worker.unit) != null) return fallback;
  const receipt = await Promise.resolve(probe(worker.unit)).catch(() => null);
  if (receipt == null) return fallback;
  return {
    detail: describeUnitExitReceipt(receipt),
    facts: {
      exitCode: receipt.exit_code,
      signal: receipt.signal,
      systemdResult: receipt.systemd_result,
      memoryPeakBytes: receipt.memory_peak_bytes,
      memorySwapPeakBytes: receipt.memory_swap_peak_bytes,
      journalTail: receipt.journal_tail,
    },
  };
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
