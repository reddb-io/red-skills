import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const RSP_TELEMETRY_SPOOL = join(".red", "tmp", "rsp-telemetry.spool.jsonl");
export const RSP_TELEMETRY_INVOCATIONS_COLLECTION = "rsp_telemetry_invocations_v1";
export const RSP_TELEMETRY_DEGRADATIONS_COLLECTION = "rsp_telemetry_degradations_v1";
export const RSP_TELEMETRY_INDEX_COLLECTION = "rsp_telemetry_index_v1";

export interface RspTelemetryEvent {
  collection: typeof RSP_TELEMETRY_INVOCATIONS_COLLECTION | typeof RSP_TELEMETRY_DEGRADATIONS_COLLECTION;
  id?: string;
  created_at?: string;
  bytes?: number;
  [key: string]: unknown;
}

export function telemetrySpoolPath(rootDir: string): string {
  return join(rootDir, RSP_TELEMETRY_SPOOL);
}

export async function appendTelemetryEvent(rootDir: string, event: RspTelemetryEvent): Promise<void> {
  try {
    const path = telemetrySpoolPath(rootDir);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    try {
      await handle.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
    } finally {
      await handle.close();
    }
  } catch {}
}

export async function takeTelemetrySpool(rootDir: string): Promise<string[]> {
  const path = telemetrySpoolPath(rootDir);
  const drainingPath = `${path}.${process.pid}.${Date.now()}.drain`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await rename(path, drainingPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }

  try {
    await writeFile(path, "", { flag: "wx" }).catch(() => undefined);
    const text = await readFile(drainingPath, "utf8").catch(() => "");
    return text.split(/\r?\n/).filter((line) => line.trim() !== "");
  } finally {
    await rm(drainingPath, { force: true });
  }
}

export function parseTelemetryEvent(line: string): RspTelemetryEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    if (
      parsed.collection !== RSP_TELEMETRY_INVOCATIONS_COLLECTION &&
      parsed.collection !== RSP_TELEMETRY_DEGRADATIONS_COLLECTION
    ) return null;
    return parsed as RspTelemetryEvent;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
