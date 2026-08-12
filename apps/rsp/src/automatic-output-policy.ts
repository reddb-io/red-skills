import { decode, encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import type { RspLossLevel, RspMintMeta } from "./elision-store.js";
import { renderStructuredBoundary } from "./structured-boundary.js";

export interface AutomaticOutputOptions {
  readonly command: string;
  readonly level: RspLossLevel;
  readonly store?: AutomaticOutputStore;
  readonly sizeThresholdBytes?: number;
  readonly repetitionThresholdRows?: number;
  readonly topRows?: number;
}

export interface AutomaticOutputStore {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
}

export interface AutomaticOutputResult {
  readonly stdout: Buffer;
  readonly lossy: boolean;
  readonly handle?: string;
  readonly bytesElided?: number;
}

/** Apply the agent-facing output policy after a command has completed. */
export async function renderAutomaticOutput(
  original: Buffer,
  options: AutomaticOutputOptions,
): Promise<AutomaticOutputResult> {
  const complete = renderStructuredBoundary(original);
  if (options.level === "full") return { stdout: complete, lossy: false };

  const value = decodedValue(complete);
  if (!Array.isArray(value) || !value.every(isJsonObject)) return { stdout: complete, lossy: false };

  const rows = value as JsonObject[];
  const sizeThresholdBytes = positiveInteger(options.sizeThresholdBytes, 8 * 1024);
  const repetitionThresholdRows = positiveInteger(options.repetitionThresholdRows, 20);
  const topRows = positiveInteger(options.topRows, options.level === "terse" ? 5 : 12);
  const repeatedRows = majorityShapeCount(rows);
  const crossesAutomaticThreshold = original.length > sizeThresholdBytes &&
    repeatedRows >= repetitionThresholdRows &&
    repeatedRows / rows.length >= 0.8;
  const shouldReduce = rows.length > topRows && (options.level === "terse" || crossesAutomaticThreshold);
  if (!shouldReduce) return { stdout: complete, lossy: false };

  let handle: string;
  try {
    handle = await options.store?.mint(original, {
      command: options.command,
      loss: { level: options.level === "lossless" ? "brief" : options.level, bytes_elided: original.length },
    }) ?? "";
  } catch {
    return { stdout: complete, lossy: false };
  }
  if (!handle) return { stdout: complete, lossy: false };

  const rowsKept = Math.min(topRows, rows.length);
  const rowsOmitted = rows.length - rowsKept;
  const payload = {
    family: "automatic-output",
    content: "structured-array",
    reduction: {
      reason: options.level === "terse" ? "explicit-terse" : "size-and-repetition-threshold",
      input_bytes: original.length,
      size_threshold_bytes: sizeThresholdBytes,
      repeated_shape_rows: repeatedRows,
      repetition_threshold_rows: repetitionThresholdRows,
      rows_total: rows.length,
      rows_kept: rowsKept,
      rows_omitted: rowsOmitted,
      changes: [`rows capped to first ${rowsKept}; ${rowsOmitted} omitted`],
    },
    summary: { numeric: numericAggregates(rows) },
    rows: rows.slice(0, rowsKept),
    next_steps: [
      "Recover exact bytes with rsp show <handle>",
      `Re-run ${options.command} with --full to suppress reduction`,
    ],
    recovery: { original: `rsp show ${handle}` },
  } satisfies JsonObject;
  return {
    stdout: Buffer.from(`${encode(payload)}\n`),
    lossy: true,
    handle,
    bytesElided: original.length,
  };
}

function decodedValue(stdout: Buffer): unknown {
  try {
    return decode(stdout.toString("utf8"));
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function majorityShapeCount(rows: readonly JsonObject[]): number {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const shape = Object.keys(row).sort((left, right) => left.localeCompare(right)).join("\u0000");
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function numericAggregates(rows: readonly JsonObject[]): JsonObject {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort((left, right) => left.localeCompare(right));
  const out: JsonObject = {};
  for (const key of keys) {
    const values = rows.map((row) => row[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length !== rows.length) continue;
    out[key] = {
      min: Math.min(...values),
      max: Math.max(...values),
      sum: stableNumber(values.reduce((sum, value) => sum + value, 0)),
    } satisfies JsonObject;
  }
  return out;
}

function stableNumber(value: number): number {
  return Number(value.toPrecision(15));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
