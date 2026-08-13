/** Daemon integration for the generic host-resource lease authority. */
import { freemem } from "node:os";
import type { RedskilledPaths } from "../paths.js";
import type { RedskilledRequest, RedskilledResponse } from "../protocol.js";
import { createRedskilledResourceLeaseRuntime, type RedskilledResourceLeaseRuntime } from "../resource-lease.js";
import { createRedskilledResourceLeaseStore, type RedskilledResourceLeaseStore } from "../resource-lease-store.js";

export async function resolveResourceLeaseRuntime(input: {
  readonly paths: RedskilledPaths;
  readonly store?: RedskilledResourceLeaseStore;
  readonly availableMemoryBytes?: () => number | Promise<number>;
  readonly clock: () => string;
}): Promise<{ readonly runtime: RedskilledResourceLeaseRuntime; readonly store: RedskilledResourceLeaseStore }> {
  const store = input.store ?? createRedskilledResourceLeaseStore(input.paths.resourceLeasePath);
  const restored = await store.read().catch(() => []);
  return {
    store,
    runtime: createRedskilledResourceLeaseRuntime({
      nowMs: () => Date.parse(input.clock()),
      availableMemoryBytes: input.availableMemoryBytes ?? freemem,
      restored,
      changed: (leases) => store.replace(leases),
    }),
  };
}

type ResourceLeaseRequest = Extract<RedskilledRequest, { op: "resource-acquire" | "resource-renew" | "resource-release" }>;

export async function handleResourceLeaseRequest(
  request: ResourceLeaseRequest,
  runtime: RedskilledResourceLeaseRuntime,
): Promise<RedskilledResponse> {
  if (request.op === "resource-acquire") return { id: request.id, ok: true, value: await runtime.acquire(request.request) };
  if (request.op === "resource-renew") return { id: request.id, ok: true, value: await runtime.renew(request.lease_id, request.ttl_ms) };
  return {
    id: request.id,
    ok: true,
    value: { version: 1, lease_id: request.lease_id, released: await runtime.release(request.lease_id) },
  };
}

export async function releaseOrphanedResourceLeases(
  runtime: RedskilledResourceLeaseRuntime,
  liveWorkerIds: ReadonlySet<string>,
): Promise<void> {
  await Promise.all(runtime.snapshot()
    .filter((lease) => lease.worker_id != null && !liveWorkerIds.has(lease.worker_id))
    .map((lease) => runtime.release(lease.lease_id).catch(() => false)));
}
