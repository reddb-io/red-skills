/**
 * Durable project intent for the host daemon.
 *
 * A daemon replacement must not erase the registrations whose Workers it leaves
 * running. This snapshot is the daemon's durable copy of the opaque records it
 * already holds; it derives nothing from them and removes them when the live set
 * does. Writes are serialised and atomic so a crash leaves either the preceding
 * complete snapshot or the next one, never half a registration.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, type JsonValue } from "@reddb-io/toon";
import { serialize as encode } from "@reddb-io/toon/legacy";
import {
  isRedskilledProjectRegistration,
  type RedskilledProjectRegistration,
} from "./project-registration.js";

interface RedskilledRegistrationIntentSnapshot {
  readonly version: 1;
  readonly registrations: readonly RedskilledProjectRegistration[];
}

export interface RedskilledRegistrationIntentStore {
  read(): Promise<readonly RedskilledProjectRegistration[]>;
  replace(registrations: readonly RedskilledProjectRegistration[]): Promise<void>;
  flush(): Promise<void>;
}

export function createRedskilledRegistrationIntentStore(
  path: string,
): RedskilledRegistrationIntentStore {
  let tail: Promise<unknown> = Promise.resolve();
  let failure: unknown | null = null;

  async function read(): Promise<readonly RedskilledProjectRegistration[]> {
    await tail;
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = parseSnapshot(raw);
    return isSnapshot(parsed) ? parsed.registrations : [];
  }

  async function write(registrations: readonly RedskilledProjectRegistration[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const snapshot: RedskilledRegistrationIntentSnapshot = {
      version: 1,
      registrations: [...registrations],
    };
    await writeFile(temporary, `${encode(snapshot as unknown as JsonValue, { keyedMapCollapse: true })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  return {
    read,
    replace(registrations) {
      const writeSnapshot = tail.then(() => write(registrations));
      tail = writeSnapshot.then(
        () => {
          failure = null;
        },
        (error: unknown) => {
          failure = error;
        },
      );
      return writeSnapshot;
    },
    async flush() {
      await tail;
      if (failure != null) throw failure;
    },
  };
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

function isSnapshot(value: unknown): value is RedskilledRegistrationIntentSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.version === 1 &&
    Array.isArray(snapshot.registrations) &&
    snapshot.registrations.every(isRedskilledProjectRegistration);
}
