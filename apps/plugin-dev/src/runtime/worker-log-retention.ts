import { readFile } from "node:fs/promises";
import {
  LANE_RETENTION_REGISTRY,
  trimLaneKeepLast,
  type TrimLaneKeepLastOptions,
} from "@reddb-io/shared/lane-retention.js";
import { parseRecords } from "@reddb-io/toon";

export interface WorkerLogRetentionOptions {
  /** Tiny override for posed tests; production uses the shared registry. */
  readonly maxLines?: number;
  readonly trimOptions?: TrimLaneKeepLastOptions;
}

function maxLines(options: WorkerLogRetentionOptions): number {
  return options.maxLines ?? LANE_RETENTION_REGISTRY["worker-log"].maxLines;
}

/**
 * Bound one Worker's structured log only after its foreign file logger has
 * closed. The caller owns that lifecycle proof; this function performs no
 * rename unless the complete record count is actually over the ceiling.
 */
export async function trimWorkerLogAtQuiescentPoint(
  path: string,
  options: WorkerLogRetentionOptions = {},
): Promise<boolean> {
  const keepLast = maxLines(options);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (parseRecords(raw).length <= keepLast) return false;
  await trimLaneKeepLast(path, keepLast, options.trimOptions);
  return true;
}

/**
 * The runner promise settles only after Sandcastle closes its file logger.
 * Keeping the trim in this `finally` boundary makes both success and failure
 * quiescent without ever rotating the lane during an in-flight invocation.
 * Retention is best-effort and must not replace the runner's real outcome.
 */
export async function runWithQuiescentWorkerLogTrim<T>(
  path: string,
  run: () => Promise<T>,
  options: WorkerLogRetentionOptions = {},
): Promise<T> {
  try {
    return await run();
  } finally {
    await trimWorkerLogAtQuiescentPoint(path, options).catch(() => {});
  }
}
