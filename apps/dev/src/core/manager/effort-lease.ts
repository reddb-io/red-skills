// core/manager/effort-lease.ts — per-effort writer lease (Spec #2290, slice #2292).
//
// One lease, one file: `<manager root>/.red/manager/leases/<effort-id>.toonl`.
// The lease records which host+session currently holds the write cursor for an
// effort. Acquire on manage (start or resume), release on end. No daemon — the
// only crash recovery is TTL expiry: a stale lease is reclaimed by the next
// session with a generation bump, so a resurrected old writer fails closed on
// its next saveEffort call (its generation no longer matches the stored one).
//
// Generation semantics:
//   The lease records the effort's generation at acquisition time. On a stale
//   reclaim the reclaimer saves the effort first (bumping generation N → N+1),
//   then writes the lease at N+1. The old writer still holds generation N and
//   receives ManagerGenerationError on its next saveEffort — this is the
//   "fails closed" guarantee.
//
// Lifecycle transitions:
//   manageEffort — inbox | paused → active (+ acquire/reclaim lease)
//   endEffort    — active → completed (+ release lease)

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { managerLeaseFile } from "@reddb-io/shared/red-paths.js";
import { encodeRecords, parseRecords } from "@reddb-io/toon";

type ToonlRecord = Record<string, string | number | boolean | null>;
import {
  ManagerSchemaError,
  ManagerStoreError,
  saveEffort,
  type EffortRecord,
  type EffortLifecycle,
} from "./effort-store.js";

export const MANAGER_LEASE_SCHEMA = "red.manager.lease";
export const MANAGER_LEASE_SCHEMA_VERSION = 1;

/** Default lease TTL: 1 hour. With no daemon, recovery is purely TTL-based. */
export const LEASE_DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface EffortLease {
  effort_id: string;
  /** The hostname that holds the write cursor. */
  host: string;
  /** Matches the effort's generation at acquisition time. */
  generation: number;
  acquired_at: string;
  /** Lease expires at this instant; after which any session may reclaim it. */
  expires_at: string;
}

/** Raised when a live lease is held by a different host. */
export class ManagerLeaseConflictError extends ManagerStoreError {}

/** Raised when a lifecycle transition is not valid from the current state. */
export class ManagerLifecycleError extends ManagerStoreError {}

/** True when the lease's TTL has lapsed. */
export function isLeaseExpired(lease: EffortLease, now = new Date()): boolean {
  return new Date(lease.expires_at) <= now;
}

// ── Lease document encoding ────────────────────────────────────────────────

export function encodeLeaseDocument(lease: EffortLease): string {
  const header: ToonlRecord = {
    kind: "manager.lease.schema",
    schema: MANAGER_LEASE_SCHEMA,
    version: MANAGER_LEASE_SCHEMA_VERSION,
  };
  const body: ToonlRecord = { kind: "manager.lease", ...lease };
  return encodeRecords([header, body]);
}

function requireString(row: ToonlRecord, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value === "") {
    throw new ManagerSchemaError(`manager lease document is missing "${field}"`);
  }
  return value;
}

export function decodeLeaseDocument(text: string): EffortLease {
  let rows: ToonlRecord[];
  try {
    rows = parseRecords(text);
  } catch (error) {
    throw new ManagerSchemaError(
      `manager lease document is not readable TOONL: ${(error as Error).message}`,
    );
  }
  const header = rows.find((row) => row.kind === "manager.lease.schema");
  if (!header) throw new ManagerSchemaError("manager lease document has no schema header");
  if (header.schema !== MANAGER_LEASE_SCHEMA) {
    throw new ManagerSchemaError(`manager lease document has foreign schema "${header.schema}"`);
  }
  if (header.version !== MANAGER_LEASE_SCHEMA_VERSION) {
    throw new ManagerSchemaError(
      `manager lease document has schema version ${String(header.version)}, this bundle owns ${MANAGER_LEASE_SCHEMA_VERSION}`,
    );
  }
  const body = rows.find((row) => row.kind === "manager.lease");
  if (!body) throw new ManagerSchemaError("manager lease document has no lease record");
  const generation = body.generation;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new ManagerSchemaError("manager lease document has a non-integer generation");
  }
  return {
    effort_id: requireString(body, "effort_id"),
    host: requireString(body, "host"),
    generation,
    acquired_at: requireString(body, "acquired_at"),
    expires_at: requireString(body, "expires_at"),
  };
}

async function writeLeaseAtomic(path: string, lease: EffortLease): Promise<void> {
  const document = encodeLeaseDocument(lease);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, document, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

// ── Lease I/O ──────────────────────────────────────────────────────────────

/**
 * Write a lease unconditionally.
 *
 * Reserved for checkpoint import (slice #2296): an import is a declared
 * takeover, so it STAMPS the destination host as holder rather than negotiating
 * with an existing lease — the imported portfolio has no live writer to conflict
 * with, only a source host that has handed the cursor over.
 */
export async function writeLease(root: string, lease: EffortLease): Promise<EffortLease> {
  await writeLeaseAtomic(managerLeaseFile(root, lease.effort_id), lease);
  return lease;
}

/** Read the lease for an effort, or `null` when none exists. */
export async function readLease(root: string, effortId: string): Promise<EffortLease | null> {
  let text: string;
  try {
    text = await readFile(managerLeaseFile(root, effortId), "utf8");
  } catch {
    return null;
  }
  return decodeLeaseDocument(text);
}

/** Delete the lease file. Called on `end`; idempotent. */
export async function releaseLease(root: string, effortId: string): Promise<void> {
  try {
    await unlink(managerLeaseFile(root, effortId));
  } catch {
    // Already released or never written — idempotent.
  }
}

// ── Lifecycle transitions ──────────────────────────────────────────────────

const RESUMABLE: readonly EffortLifecycle[] = ["inbox", "paused"];
const TERMINAL: readonly EffortLifecycle[] = ["completed", "abandoned"];

export interface ManageEffortOptions {
  now?: () => Date;
  ttlMs?: number;
  host?: string;
}

/**
 * Transition an effort to `active` and acquire (or reclaim) its lease.
 *
 * Fresh-acquire (no existing lease): valid from `inbox`, `paused`. Transitions
 * lifecycle → active and writes the lease at the new generation.
 *
 * Stale-reclaim (lease exists and is TTL-expired): valid from any non-terminal
 * state. The effort may already be `active` (crashed session left it there).
 * Saves the effort — bumping the generation — and writes the lease at the new
 * generation, so a resurrected old writer receives ManagerGenerationError on
 * its next saveEffort call.
 *
 * Live lease held by a different host → fail closed (ManagerLeaseConflictError).
 */
export async function manageEffort(
  root: string,
  effort: EffortRecord,
  options: ManageEffortOptions = {},
): Promise<{ effort: EffortRecord; lease: EffortLease }> {
  const nowFn = options.now ?? (() => new Date());
  const now = nowFn();
  const ttlMs = options.ttlMs ?? LEASE_DEFAULT_TTL_MS;
  const host = options.host ?? hostname();

  // Read the existing lease BEFORE any mutation; fail closed against a live foreign lease.
  const existingLease = await readLease(root, effort.effort_id);
  const leaseIsLive = existingLease !== null && !isLeaseExpired(existingLease, now);
  const isReclaim = existingLease !== null && isLeaseExpired(existingLease, now);

  if (leaseIsLive && existingLease!.host !== host) {
    throw new ManagerLeaseConflictError(
      `effort ${effort.effort_id} lease held by ${existingLease!.host}; expires ${existingLease!.expires_at}`,
    );
  }

  // Lifecycle guard: fresh-acquire requires inbox/paused; reclaim allows non-terminal.
  if (isReclaim) {
    if (TERMINAL.includes(effort.lifecycle)) {
      throw new ManagerLifecycleError(
        `cannot reclaim lease for a ${effort.lifecycle} effort ${effort.effort_id}`,
      );
    }
  } else {
    if (!RESUMABLE.includes(effort.lifecycle)) {
      throw new ManagerLifecycleError(
        `cannot manage (resume) an effort in "${effort.lifecycle}" state; valid from: ${RESUMABLE.join(", ")}`,
      );
    }
  }

  // Target lifecycle: transition if coming from inbox/paused; keep as-is otherwise (reclaim).
  const targetLifecycle: EffortLifecycle =
    effort.lifecycle === "inbox" || effort.lifecycle === "paused" ? "active" : effort.lifecycle;

  // Save the effort (bumps generation), then write the lease.
  const saved = await saveEffort(root, { ...effort, lifecycle: targetLifecycle }, { now: () => now });

  const lease: EffortLease = {
    effort_id: saved.effort_id,
    host,
    generation: saved.generation,
    acquired_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };
  await writeLeaseAtomic(managerLeaseFile(root, saved.effort_id), lease);

  return { effort: saved, lease };
}

export interface EndEffortOptions {
  now?: () => Date;
}

/**
 * Transition an effort from `active` to `completed` and release its lease.
 *
 * Valid from: `active`.
 *
 * The lease is deleted after the effort is saved; `releaseLease` is idempotent
 * so a missing lease file does not cause an error.
 */
export async function endEffort(
  root: string,
  effort: EffortRecord,
  options: EndEffortOptions = {},
): Promise<EffortRecord> {
  if (effort.lifecycle !== "active") {
    throw new ManagerLifecycleError(
      `cannot end an effort in "${effort.lifecycle}" state; valid from: active`,
    );
  }
  const now = (options.now ?? (() => new Date()))();
  const completed = await saveEffort(root, { ...effort, lifecycle: "completed" }, { now: () => now });
  await releaseLease(root, completed.effort_id);
  return completed;
}
