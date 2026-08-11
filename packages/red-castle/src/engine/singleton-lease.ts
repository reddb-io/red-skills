/**
 * Repo-scoped singleton ownership in the durable Castle state tier.
 *
 * A clean owner releases its lease during shutdown. A crash intentionally
 * leaves the lease on disk; the next acquirer tests the recorded PID and reaps
 * the stale record when that process is dead. `start_time` pins ownership so a
 * former process cannot renew or release a later holder that reused its PID.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "@reddb-io/toon";
import { parse as decode, serialize as encode } from "@reddb-io/toon/legacy";
import type { EnginePaths } from "./paths.js";

export interface SingletonLeaseOwner {
  readonly pid: number;
  readonly startTime: string;
}

export interface SingletonLease {
  readonly pid: number;
  readonly start_time: string;
  readonly acquired_at: string;
  readonly renewed_at: string;
}

export type SingletonLeaseAcquireResult =
  | {
      readonly acquired: true;
      readonly reaped: boolean;
      readonly lease: SingletonLease;
    }
  | { readonly acquired: false; readonly lease: SingletonLease };

export interface SingletonLeaseFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; flag?: string },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(path: string, options: { force: true }): Promise<unknown>;
}

export interface SingletonLeaseStoreOptions {
  readonly fs?: SingletonLeaseFs;
  readonly clock?: () => string;
  readonly isPidAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface SingletonLeaseStore {
  read(name: string): Promise<SingletonLease | undefined>;
  acquire(
    name: string,
    owner: SingletonLeaseOwner,
  ): Promise<SingletonLeaseAcquireResult>;
  renew(name: string, owner: SingletonLeaseOwner): Promise<SingletonLease>;
  release(name: string, owner: SingletonLeaseOwner): Promise<boolean>;
}

export class SingletonLeaseOwnershipError extends Error {
  constructor(name: string) {
    super(`singleton lease ${JSON.stringify(name)} is held by another owner`);
    this.name = "SingletonLeaseOwnershipError";
  }
}

const SINGLETON_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function assertSingletonName(name: string): void {
  if (!SINGLETON_NAME_RE.test(name) || name === "." || name === "..") {
    throw new Error(`invalid singleton name ${JSON.stringify(name)}`);
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function validateLease(value: unknown): SingletonLease {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("singleton lease must be a record");
  }
  const lease = value as Record<string, unknown>;
  if (!Number.isInteger(lease.pid) || (lease.pid as number) <= 0) {
    throw new Error("singleton lease pid must be a positive integer");
  }
  for (const field of ["start_time", "acquired_at", "renewed_at"] as const) {
    if (typeof lease[field] !== "string" || lease[field].length === 0) {
      throw new Error(`singleton lease ${field} must be a non-empty string`);
    }
  }
  return lease as unknown as SingletonLease;
}

function belongsTo(lease: SingletonLease, owner: SingletonLeaseOwner): boolean {
  return lease.pid === owner.pid && lease.start_time === owner.startTime;
}

export function singletonLeasePath(paths: EnginePaths, name: string): string {
  assertSingletonName(name);
  return join(paths.castleStateRoot, "singletons", name, "lease.toon");
}

export function createSingletonLeaseStore(
  paths: EnginePaths,
  options: SingletonLeaseStoreOptions = {},
): SingletonLeaseStore {
  const fs = options.fs ?? { mkdir, readFile, rename, rm, writeFile };
  const clock = options.clock ?? (() => new Date().toISOString());
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;

  async function readLease(path: string): Promise<SingletonLease | undefined> {
    try {
      return validateLease(decode(await fs.readFile(path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async function replace(path: string, lease: SingletonLease): Promise<void> {
    const temporary = `${path}.tmp-${lease.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(
      temporary,
      encode(lease as unknown as JsonValue, { keyedMapCollapse: true }),
      { encoding: "utf8" },
    );
    await fs.rename(temporary, path);
  }

  return {
    read(name) {
      return readLease(singletonLeasePath(paths, name));
    },

    async acquire(name, owner) {
      const path = singletonLeasePath(paths, name);
      await fs.mkdir(dirname(path), { recursive: true });
      let reaped = false;

      for (;;) {
        const now = clock();
        const lease: SingletonLease = {
          pid: owner.pid,
          start_time: owner.startTime,
          acquired_at: now,
          renewed_at: now,
        };
        try {
          await fs.writeFile(
            path,
            encode(lease as unknown as JsonValue, { keyedMapCollapse: true }),
            { encoding: "utf8", flag: "wx" },
          );
          return { acquired: true, reaped, lease };
        } catch (error) {
          if (!isExisting(error)) throw error;
        }

        const existing = await readLease(path);
        if (!existing) continue;
        if (belongsTo(existing, owner)) {
          return { acquired: true, reaped, lease: existing };
        }
        if (await isPidAlive(existing.pid)) {
          return { acquired: false, lease: existing };
        }
        await fs.rm(path, { force: true });
        reaped = true;
      }
    },

    async renew(name, owner) {
      const path = singletonLeasePath(paths, name);
      const existing = await readLease(path);
      if (!existing || !belongsTo(existing, owner)) {
        throw new SingletonLeaseOwnershipError(name);
      }
      const renewed = { ...existing, renewed_at: clock() };
      await replace(path, renewed);
      return renewed;
    },

    async release(name, owner) {
      const path = singletonLeasePath(paths, name);
      const existing = await readLease(path);
      if (!existing) return false;
      if (!belongsTo(existing, owner)) {
        throw new SingletonLeaseOwnershipError(name);
      }
      await fs.rm(path, { force: true });
      return true;
    },
  };
}
