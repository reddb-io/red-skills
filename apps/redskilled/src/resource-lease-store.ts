/** Durable generic host-resource authority across daemon handover. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { isRedskilledResourceLease, type RedskilledResourceLease } from "./resource-lease.js";

export interface RedskilledResourceLeaseStore {
  read(): Promise<readonly RedskilledResourceLease[]>;
  replace(leases: readonly RedskilledResourceLease[]): Promise<void>;
  flush(): Promise<void>;
}

export function createRedskilledResourceLeaseStore(path: string): RedskilledResourceLeaseStore {
  let pending: readonly RedskilledResourceLease[] | null = null;
  let tail: Promise<void> = Promise.resolve();
  let failure: unknown = null;

  async function write(leases: readonly RedskilledResourceLease[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${encode({ version: 1, leases: [...leases] } as unknown as JsonValue)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  function schedule(): Promise<void> {
    tail = tail.then(async () => {
      while (pending !== null) {
        const next = pending;
        pending = null;
        await write(next);
      }
      failure = null;
    }).catch((error: unknown) => {
      failure = error;
    });
    return tail;
  }

  return {
    async read() {
      await tail;
      try {
        const raw = await readFile(path, "utf8");
        const parsed: unknown = decode(raw.trim());
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
        const leases = (parsed as Record<string, unknown>).leases;
        return Array.isArray(leases) ? leases.filter(isRedskilledResourceLease) : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    replace(leases) {
      pending = [...leases];
      return schedule();
    },
    async flush() {
      await tail;
      if (pending !== null) await schedule();
      await tail;
      if (failure != null) throw failure;
    },
  };
}
