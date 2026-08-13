/** Client boundary for daemon-owned generic host-resource admission. */
import { requestRedskilled, type RedskilledClientConfig } from "./client.js";
import type { RedskilledPaths } from "./paths.js";
import { isRedskilledResourceLeaseReleased, type RedskilledResourceLeaseReleased } from "./protocol.js";
import {
  isRedskilledResourceLease,
  type RedskilledResourceLease,
  type RedskilledResourceLeaseRequest,
} from "./resource-lease.js";

export async function acquireRedskilledResourceLease(
  paths: RedskilledPaths,
  request: RedskilledResourceLeaseRequest,
  config: RedskilledClientConfig = {},
): Promise<RedskilledResourceLease> {
  const value = await requestRedskilled(paths, { op: "resource-acquire", request }, {
    ...config,
    requestTimeoutMs: Math.max(config.requestTimeoutMs ?? 0, request.wait_timeout_ms + 1_000),
  });
  if (!isRedskilledResourceLease(value)) throw new Error("redskilled daemon returned a malformed resource lease");
  return value;
}

export async function renewRedskilledResourceLease(
  paths: RedskilledPaths,
  leaseId: string,
  ttlMs: number,
  config: RedskilledClientConfig = {},
): Promise<RedskilledResourceLease | null> {
  const value = await requestRedskilled(paths, { op: "resource-renew", lease_id: leaseId, ttl_ms: ttlMs }, config);
  if (value === null) return null;
  if (!isRedskilledResourceLease(value)) throw new Error("redskilled daemon returned a malformed renewed resource lease");
  return value;
}

export async function releaseRedskilledResourceLease(
  paths: RedskilledPaths,
  leaseId: string,
  config: RedskilledClientConfig = {},
): Promise<RedskilledResourceLeaseReleased> {
  const value = await requestRedskilled(paths, { op: "resource-release", lease_id: leaseId }, config);
  if (!isRedskilledResourceLeaseReleased(value)) throw new Error("redskilled daemon returned a malformed resource release");
  return value;
}
