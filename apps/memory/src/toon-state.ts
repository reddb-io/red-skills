import { readFile, writeFile } from "node:fs/promises";
import { decode, type JsonValue } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";

export function encodeMemoryStateToon(value: unknown): string {
  return `${encodeSnapshotToon(value as JsonValue)}\n`;
}

export function decodeMemoryStateDocument<T = unknown>(raw: string): T {
  const body = raw.trim();
  if (!body) return null as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    return decode(body) as T;
  }
}

export async function readMemoryStateFile<T = unknown>(path: string): Promise<T> {
  return decodeMemoryStateDocument<T>(await readFile(path, "utf8"));
}

export async function writeMemoryStateFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, encodeMemoryStateToon(value), "utf8");
}
