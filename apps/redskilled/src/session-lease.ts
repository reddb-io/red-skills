/**
 * session-lease — the user-session singleton record for `redskilled`.
 *
 * The castle's `singleton-lease` proved the mechanics on a repository-scoped
 * lease: `wx` creation makes acquisition a race exactly one caller wins, a crash
 * deliberately leaves the record behind, and the next acquirer reaps it once the
 * recorded pid is dead. ADR 0130 keeps the mechanics and moves the scope: the
 * key is the user session, and the host identity rides along as a label.
 *
 * `start_time` is what makes ownership honest. A pid is not an identity — the OS
 * reuses it — so a former holder whose number came round again must be unable to
 * renew or release the lease of whoever holds it now. Every mutation therefore
 * matches pid AND start time, and refuses on a mismatch instead of overwriting.
 *
 * TOON on disk (repo mandate): the lease is a machine-read snapshot, so it is
 * written with the TOON encoder and read with a JSON-then-TOON sniff, which
 * keeps a record written by an older bundle readable.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";

export interface RedskilledLeaseOwner {
  readonly pid: number;
  readonly startTime: string;
}

export interface RedskilledLease {
  readonly version: 1;
  readonly pid: number;
  readonly start_time: string;
  readonly session_key_hash: string;
  readonly machine_id_hash: string;
  readonly socket_path: string;
  readonly acquired_at: string;
  readonly renewed_at: string;
}

export type RedskilledLeaseAcquireResult =
  | { readonly acquired: true; readonly reaped: boolean; readonly lease: RedskilledLease }
  | { readonly acquired: false; readonly lease: RedskilledLease };

export class RedskilledLeaseOwnershipError extends Error {
  constructor(leasePath: string) {
    super(`redskilled lease ${JSON.stringify(leasePath)} is held by another owner`);
    this.name = "RedskilledLeaseOwnershipError";
  }
}

export interface RedskilledLeaseLabels {
  readonly sessionKeyHash: string;
  readonly machineIdHash: string;
  readonly socketPath: string;
}

export interface RedskilledLeaseStoreOptions {
  readonly clock?: () => string;
  readonly isPidAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface RedskilledLeaseStore {
  read(): Promise<RedskilledLease | undefined>;
  acquire(owner: RedskilledLeaseOwner): Promise<RedskilledLeaseAcquireResult>;
  renew(owner: RedskilledLeaseOwner): Promise<RedskilledLease>;
  release(owner: RedskilledLeaseOwner): Promise<boolean>;
}

/**
 * Read a lease record off disk without acquiring anything.
 *
 * A reader that only wants to know who holds a session — `reclaim`, a doctor,
 * a bug report — must not have to mint the labels an acquirer needs, because
 * inventing labels to read a record is how a reader ends up writing one.
 * Absent or unreadable reads as `undefined`, never as a throw: the whole point
 * of looking is that the record may be missing or corrupt.
 */
export async function readRedskilledLeaseFile(
  leasePath: string,
): Promise<RedskilledLease | undefined> {
  let raw: string;
  try {
    raw = await readFile(leasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = parseSnapshot(raw);
  return isLease(parsed) ? parsed : undefined;
}

let cachedProcessOwner: RedskilledLeaseOwner | undefined;

/**
 * This process's lease identity — its pid plus the wall-clock instant it began.
 *
 * Memoised because it must not drift: two calls that disagreed by a millisecond
 * would make a live daemon fail to renew its own lease.
 */
export function currentProcessOwner(): RedskilledLeaseOwner {
  cachedProcessOwner ??= {
    pid: process.pid,
    startTime: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
  };
  return cachedProcessOwner;
}

export function createRedskilledLeaseStore(
  leasePath: string,
  labels: RedskilledLeaseLabels,
  options: RedskilledLeaseStoreOptions = {},
): RedskilledLeaseStore {
  const clock = options.clock ?? (() => new Date().toISOString());
  const pidAlive = options.isPidAlive ?? isPidAlive;

  async function readLease(): Promise<RedskilledLease | undefined> {
    return await readRedskilledLeaseFile(leasePath);
  }

  async function replace(lease: RedskilledLease): Promise<void> {
    const temporary = `${leasePath}.${lease.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialize(lease), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, leasePath);
  }

  function mint(owner: RedskilledLeaseOwner, now: string): RedskilledLease {
    return {
      version: 1,
      pid: owner.pid,
      start_time: owner.startTime,
      session_key_hash: labels.sessionKeyHash,
      machine_id_hash: labels.machineIdHash,
      socket_path: labels.socketPath,
      acquired_at: now,
      renewed_at: now,
    };
  }

  return {
    read: readLease,

    async acquire(owner) {
      await mkdir(dirname(leasePath), { recursive: true, mode: 0o700 });
      let reaped = false;
      for (;;) {
        const now = clock();
        const lease = mint(owner, now);
        try {
          await writeFile(leasePath, serialize(lease), { encoding: "utf8", mode: 0o600, flag: "wx" });
          return { acquired: true, reaped, lease };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }

        const existing = await readLease();
        // A record that is missing or unreadable is not an owner: drop it and
        // retry, rather than deadlocking behind bytes nobody can interpret.
        if (!existing) {
          await rm(leasePath, { force: true });
          reaped = true;
          continue;
        }
        if (belongsTo(existing, owner)) return { acquired: true, reaped, lease: existing };
        if (await pidAlive(existing.pid)) return { acquired: false, lease: existing };
        await rm(leasePath, { force: true });
        reaped = true;
      }
    },

    async renew(owner) {
      const existing = await readLease();
      if (!existing || !belongsTo(existing, owner)) throw new RedskilledLeaseOwnershipError(leasePath);
      const renewed: RedskilledLease = { ...existing, renewed_at: clock() };
      await replace(renewed);
      return renewed;
    },

    async release(owner) {
      const existing = await readLease();
      if (!existing) return false;
      if (!belongsTo(existing, owner)) throw new RedskilledLeaseOwnershipError(leasePath);
      await rm(leasePath, { force: true });
      return true;
    },
  };
}

function belongsTo(lease: RedskilledLease, owner: RedskilledLeaseOwner): boolean {
  return lease.pid === owner.pid && lease.start_time === owner.startTime;
}

function serialize(lease: RedskilledLease): string {
  return `${encode(lease as unknown as JsonValue)}\n`;
}

function parseSnapshot(raw: string): unknown {
  const body = raw.trim();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    try {
      return decode(body);
    } catch {
      return null;
    }
  }
}

function isLease(value: unknown): value is RedskilledLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  if (lease.version !== 1) return false;
  if (!Number.isInteger(lease.pid) || (lease.pid as number) <= 0) return false;
  for (const field of ["start_time", "session_key_hash", "machine_id_hash", "socket_path", "acquired_at", "renewed_at"] as const) {
    if (typeof lease[field] !== "string" || lease[field].length === 0) return false;
  }
  return true;
}
