import { decode, encode, type JsonObject } from "@reddb-io/toon";
import type { RspLossLevel, RspMintMeta } from "./elision-store.js";
import { renderStructuredBoundary } from "./structured-boundary.js";

export interface AutomaticOutputOptions {
  readonly command: string;
  readonly level: AutomaticOutputLevel;
  readonly store?: AutomaticOutputStore;
  readonly sizeThresholdBytes?: number;
  readonly repetitionThresholdRows?: number;
  readonly topRows?: number;
}

export type AutomaticOutputLevel = RspLossLevel | "automatic";

export interface AutomaticOutputStore {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
}

export interface AutomaticOutputResult {
  readonly stdout: Buffer;
  readonly lossy: boolean;
  readonly handle?: string;
  readonly bytesElided?: number;
}

/** Agent-boundary adapter that opens the resident only when reduction mints a handle. */
export async function renderAutomaticCommandOutput(
  original: Buffer,
  command: string,
  level: AutomaticOutputLevel = "automatic",
): Promise<Buffer> {
  let resident: import("./resident-client.js").ResidentRspElisionStore | undefined;
  const store = {
    mint: async (bytes: Uint8Array | Buffer, meta: RspMintMeta) => {
      const [{ resolveRspConfig }, { residentElisionStore }] = await Promise.all([
        import("./config.js"),
        import("./resident-store.js"),
      ]);
      const config = resolveRspConfig(process.cwd(), process.env);
      if (!config.enabled) return "";
      resident ??= residentElisionStore(process.cwd(), config);
      return await resident.mint(bytes, meta);
    },
  };
  try {
    return (await renderAutomaticOutput(original, {
      command,
      level,
      store,
    })).stdout;
  } finally {
    await resident?.close();
  }
}

/** Apply the agent-facing output policy after a command has completed. */
export async function renderAutomaticOutput(
  original: Buffer,
  options: AutomaticOutputOptions,
): Promise<AutomaticOutputResult> {
  const complete = isDocumentationCommand(options.command) ? original : renderStructuredBoundary(original);
  if (options.level === "full" || options.level === "lossless") return { stdout: complete, lossy: false };

  const sizeThresholdBytes = positiveInteger(options.sizeThresholdBytes, 8 * 1024);
  const repetitionThresholdRows = positiveInteger(options.repetitionThresholdRows, 20);
  const topRows = positiveInteger(options.topRows, options.level === "terse" ? 5 : 12);
  const diskRows = parseDiskCensus(original);
  if (diskRows) {
    const shouldReduce = diskRows.length > topRows &&
      (options.level === "terse" || (original.length > sizeThresholdBytes && diskRows.length >= repetitionThresholdRows));
    if (!shouldReduce) return { stdout: complete, lossy: false };
    const handle = await mintBeforeReduction(original, options);
    if (!handle) return { stdout: complete, lossy: false };
    const sorted = [...diskRows].sort((left, right) => right.size_kib - left.size_kib || left.path.localeCompare(right.path));
    const rowsKept = Math.min(topRows, sorted.length);
    const rowsOmitted = sorted.length - rowsKept;
    const payload = {
      family: "automatic-output",
      content: "disk-census",
      reduction: {
        reason: options.level === "terse" ? "explicit-terse" : "size-and-repetition-threshold",
        rows_total: sorted.length,
        rows_kept: rowsKept,
        rows_omitted: rowsOmitted,
        changes: [`rows sorted by size_kib descending; capped to top ${rowsKept}; ${rowsOmitted} omitted`],
      },
      summary: {
        total_size_kib: sorted.reduce((sum, row) => sum + row.size_kib, 0),
        largest_size_kib: sorted[0]?.size_kib ?? 0,
      },
      rows: sorted.slice(0, rowsKept),
      next_steps: [
        "Recover exact bytes with rsp show <handle>",
        "Repeat the same rsp invocation with --full to suppress reduction",
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

  const structured = structuredRows(decodedValue(complete));
  if (!structured) return { stdout: complete, lossy: false };

  const { rows } = structured;
  const repeatedRows = majorityShapeCount(rows);
  const crossesAutomaticThreshold = original.length > sizeThresholdBytes &&
    repeatedRows >= repetitionThresholdRows &&
    repeatedRows / rows.length >= 0.8;
  const shouldReduce = rows.length > topRows && (options.level === "terse" || crossesAutomaticThreshold);
  if (!shouldReduce) return { stdout: complete, lossy: false };

  const handle = await mintBeforeReduction(original, options);
  if (!handle) return { stdout: complete, lossy: false };

  const rowsKept = Math.min(topRows, rows.length);
  const rowsOmitted = rows.length - rowsKept;
  const payload = {
    family: "automatic-output",
    content: "structured-array",
    ...(structured.sourcePath ? { source_path: structured.sourcePath, context: structured.context } : {}),
    reduction: {
      reason: options.level === "terse" ? "explicit-terse" : "size-and-repetition-threshold",
      input_bytes: original.length,
      size_threshold_bytes: sizeThresholdBytes,
      repeated_shape_rows: repeatedRows,
      repetition_threshold_rows: repetitionThresholdRows,
      rows_total: rows.length,
      rows_kept: rowsKept,
      rows_omitted: rowsOmitted,
      changes: [structured.sourcePath
        ? `rows at ${structured.sourcePath} capped to first ${rowsKept}; ${rowsOmitted} omitted`
        : `rows capped to first ${rowsKept}; ${rowsOmitted} omitted`],
    },
    summary: { numeric: numericAggregates(rows) },
    rows: rows.slice(0, rowsKept),
    next_steps: [
      "Recover exact bytes with rsp show <handle>",
      "Repeat the same rsp invocation with --full to suppress reduction",
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

function isDocumentationCommand(command: string): boolean {
  return /(?:^|\s)(?:--help|-h)(?:\s|$)/.test(command);
}

async function mintBeforeReduction(original: Buffer, options: AutomaticOutputOptions): Promise<string> {
  try {
    const handle = await options.store?.mint(original, {
      command: options.command,
      loss: { level: options.level === "automatic" ? "brief" : options.level, bytes_elided: original.length },
    }) ?? "";
    return handle.startsWith("el:") ? handle : "";
  } catch {
    return "";
  }
}

function parseDiskCensus(stdout: Buffer): Array<{ size_kib: number; path: string }> | undefined {
  const lines = stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return undefined;
  const rows: Array<{ size_kib: number; path: string }> = [];
  for (const line of lines) {
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match || !match[2]?.includes("target")) return undefined;
    rows.push({ size_kib: Number(match[1]), path: match[2] });
  }
  return rows;
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

function structuredRows(value: unknown): { rows: JsonObject[]; sourcePath?: string; context?: JsonObject } | undefined {
  if (Array.isArray(value) && value.every(isJsonObject)) return { rows: value };
  if (!isJsonObject(value)) return undefined;
  const candidates = Object.entries(value)
    .filter((entry): entry is [string, JsonObject[]] => Array.isArray(entry[1]) && entry[1].every(isJsonObject))
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
  const selected = candidates[0];
  if (!selected) return undefined;
  const [sourcePath, rows] = selected;
  const context = Object.fromEntries(Object.entries(value).filter(([key]) => key !== sourcePath)) as JsonObject;
  return { rows, sourcePath, context };
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
