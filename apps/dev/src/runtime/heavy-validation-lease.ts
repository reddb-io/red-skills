/** Redskilled adapter for Castle-classified heavy validation commands. */
import {
  acquireRedskilledResourceLease,
  releaseRedskilledResourceLease,
  renewRedskilledResourceLease,
} from "@reddb-io/redskilled/resource-lease-client";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";

export const HEAVY_VALIDATION_WAIT_MS = 60 * 60_000;
const LEASE_TTL_MS = 30_000;

export interface HeavyValidationLeaseNotice {
  readonly state: "waiting" | "acquired" | "timed-out";
  readonly waitedMs: number;
  readonly message: string;
}

export async function acquireHeavyValidationLease(input: {
  readonly minimumAvailableMemoryMb: number;
  readonly workerId?: string;
  readonly notice?: (notice: HeavyValidationLeaseNotice) => void;
}): Promise<(() => Promise<void>) | null> {
  const paths = resolveRedskilledPaths();
  const started = Date.now();
  input.notice?.({ state: "waiting", waitedMs: 0, message: "⏳ /afk gate: waiting for host heavy-validation admission." });
  try {
    const lease = await acquireRedskilledResourceLease(paths, {
      resource: "validation-heavy",
      holder_id: input.workerId ?? `process:${process.pid}`,
      ...(input.workerId == null ? {} : { worker_id: input.workerId }),
      minimum_available_memory_bytes: input.minimumAvailableMemoryMb * 1024 ** 2,
      ttl_ms: LEASE_TTL_MS,
      wait_timeout_ms: HEAVY_VALIDATION_WAIT_MS,
    });
    input.notice?.({ state: "acquired", waitedMs: Date.now() - started, message: "✅ /afk gate: host granted heavy-validation admission." });
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal.then(() => renewRedskilledResourceLease(paths, lease.lease_id, LEASE_TTL_MS).then(() => undefined))
        .catch(() => undefined);
    }, LEASE_TTL_MS / 3);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await renewal;
      await releaseRedskilledResourceLease(paths, lease.lease_id).catch(() => undefined);
    };
  } catch (error) {
    input.notice?.({
      state: "timed-out",
      waitedMs: Date.now() - started,
      message: `⛔ /afk gate: heavy-validation admission failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}
