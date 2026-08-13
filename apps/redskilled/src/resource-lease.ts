/** Generic, host-scoped resource admission. Domain-specific classification stays in callers. */
import { randomUUID } from "node:crypto";

export const DEFAULT_REDSKILLED_RESOURCE_LEASE_TTL_MS = 30_000;
export const DEFAULT_REDSKILLED_RESOURCE_SAFETY_POLL_MS = 5_000;

export interface RedskilledResourceLeaseRequest {
  readonly resource: string;
  readonly holder_id: string;
  readonly worker_id?: string;
  readonly minimum_available_memory_bytes: number;
  readonly ttl_ms: number;
  readonly wait_timeout_ms: number;
}

export interface RedskilledResourceLease {
  readonly version: 1;
  readonly lease_id: string;
  readonly resource: string;
  readonly holder_id: string;
  readonly worker_id?: string;
  readonly minimum_available_memory_bytes: number;
  readonly acquired_at: string;
  readonly renewed_at: string;
  readonly expires_at: string;
}

export class RedskilledResourceAdmissionTimeoutError extends Error {
  constructor(readonly resource: string, readonly waitTimeoutMs: number) {
    super(`host resource admission timed out after ${waitTimeoutMs}ms while waiting for ${JSON.stringify(resource)}`);
    this.name = "RedskilledResourceAdmissionTimeoutError";
  }
}

export interface RedskilledResourceLeaseRuntime {
  acquire(request: RedskilledResourceLeaseRequest): Promise<RedskilledResourceLease>;
  renew(leaseId: string, ttlMs?: number): Promise<RedskilledResourceLease | null>;
  release(leaseId: string): Promise<boolean>;
  releaseHolder(holderId: string): Promise<number>;
  snapshot(): readonly RedskilledResourceLease[];
}

export function isRedskilledResourceLease(value: unknown): value is RedskilledResourceLease {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return lease.version === 1 &&
    typeof lease.lease_id === "string" && lease.lease_id !== "" &&
    typeof lease.resource === "string" && lease.resource !== "" &&
    typeof lease.holder_id === "string" && lease.holder_id !== "" &&
    (lease.worker_id === undefined || (typeof lease.worker_id === "string" && lease.worker_id !== "")) &&
    typeof lease.minimum_available_memory_bytes === "number" &&
    typeof lease.acquired_at === "string" &&
    typeof lease.renewed_at === "string" &&
    typeof lease.expires_at === "string";
}

export function createRedskilledResourceLeaseRuntime(options: {
  readonly nowMs?: () => number;
  readonly availableMemoryBytes: () => number | Promise<number>;
  readonly restored?: readonly RedskilledResourceLease[];
  readonly safetyPollMs?: number;
  readonly changed?: (leases: readonly RedskilledResourceLease[]) => Promise<void> | void;
}): RedskilledResourceLeaseRuntime {
  const nowMs = options.nowMs ?? (() => Date.now());
  const safetyPollMs = Math.max(1, options.safetyPollMs ?? DEFAULT_REDSKILLED_RESOURCE_SAFETY_POLL_MS);
  const leases = new Map(
    (options.restored ?? []).filter(isRedskilledResourceLease).map((lease) => [lease.lease_id, lease]),
  );
  const waiters = new Set<() => void>();

  const snapshot = (): readonly RedskilledResourceLease[] => [...leases.values()];
  const persist = async (): Promise<void> => { await options.changed?.(snapshot()); };
  const wake = (): void => {
    const current = [...waiters];
    waiters.clear();
    for (const resolve of current) resolve();
  };
  const pruneExpired = async (): Promise<void> => {
    const now = nowMs();
    let changed = false;
    for (const [id, lease] of leases) {
      if (Date.parse(lease.expires_at) <= now) {
        leases.delete(id);
        changed = true;
      }
    }
    if (changed) {
      await persist();
      wake();
    }
  };
  const waitForChange = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      waiters.add(finish);
    });
  };

  return {
    async acquire(request) {
      if (request.resource.trim() === "" || request.holder_id.trim() === "") {
        throw new Error("host resource admission requires non-empty resource and holder_id");
      }
      if (!Number.isFinite(request.minimum_available_memory_bytes) || request.minimum_available_memory_bytes < 0 ||
        !Number.isFinite(request.ttl_ms) || request.ttl_ms <= 0 ||
        !Number.isFinite(request.wait_timeout_ms) || request.wait_timeout_ms < 0) {
        throw new Error("host resource admission received invalid memory, TTL, or wait bounds");
      }
      const started = nowMs();
      const deadline = started + Math.max(0, request.wait_timeout_ms);
      for (;;) {
        await pruneExpired();
        const conflict = [...leases.values()].some((lease) => lease.resource === request.resource);
        const available = await options.availableMemoryBytes();
        // Re-check after the host sample: another async acquire may have spent
        // the resource while this one was awaiting memory.
        const stillFree = ![...leases.values()].some((lease) => lease.resource === request.resource);
        if (!conflict && stillFree && Number.isFinite(available) && available >= request.minimum_available_memory_bytes) {
          const now = nowMs();
          const instant = new Date(now).toISOString();
          const lease: RedskilledResourceLease = {
            version: 1,
            lease_id: randomUUID(),
            resource: request.resource,
            holder_id: request.holder_id,
            ...(request.worker_id == null ? {} : { worker_id: request.worker_id }),
            minimum_available_memory_bytes: request.minimum_available_memory_bytes,
            acquired_at: instant,
            renewed_at: instant,
            expires_at: new Date(now + Math.max(1, request.ttl_ms)).toISOString(),
          };
          leases.set(lease.lease_id, lease);
          await persist();
          return lease;
        }
        const remaining = deadline - nowMs();
        if (remaining <= 0) {
          throw new RedskilledResourceAdmissionTimeoutError(request.resource, request.wait_timeout_ms);
        }
        const nextExpiry = Math.min(
          ...[...leases.values()]
            .filter((lease) => lease.resource === request.resource)
            .map((lease) => Math.max(1, Date.parse(lease.expires_at) - nowMs())),
          safetyPollMs,
          remaining,
        );
        await waitForChange(nextExpiry);
      }
    },
    async renew(leaseId, ttlMs = DEFAULT_REDSKILLED_RESOURCE_LEASE_TTL_MS) {
      await pruneExpired();
      const held = leases.get(leaseId);
      if (held == null) return null;
      const now = nowMs();
      const renewed = {
        ...held,
        renewed_at: new Date(now).toISOString(),
        expires_at: new Date(now + Math.max(1, ttlMs)).toISOString(),
      };
      leases.set(leaseId, renewed);
      await persist();
      return renewed;
    },
    async release(leaseId) {
      if (!leases.delete(leaseId)) return false;
      await persist();
      wake();
      return true;
    },
    async releaseHolder(holderId) {
      let released = 0;
      for (const [id, lease] of leases) {
        if (lease.holder_id !== holderId && lease.worker_id !== holderId) continue;
        leases.delete(id);
        released += 1;
      }
      if (released > 0) {
        await persist();
        wake();
      }
      return released;
    },
    snapshot,
  };
}
