import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

// The JSONL Log Module: owns the AFK structured-log lane format end to end.
//
// A "lane" is an append-only JSONL file: one structured record per line, each a
// uniform envelope so a rollup reader never has to special-case a line's shape.
// The envelope is defined exactly once, here, with this field order:
//
//   {ts, lvl, worker, issue, attempt, type, msg, …extra}
//
// `ts` (ISO-8601) is the Module's only ambient input in bash; here it is always
// passed in as an explicit argument so the whole surface is pure and the test
// supplies a deterministic timestamp.
//
// Two lane kinds match the orchestrator's two write disciplines:
//   * per-attempt lanes have a single writer — a plain append is sufficient;
//   * shared cross-worker lanes have many concurrent writers — every write is
//     serialised so two writers never interleave a partial line.
//
// The agent lane is the per-attempt lane carrying the inner agent's own output.
// Its appender stamps `type=agent` and rejects any attempt to write a synthetic
// (orchestrator-authored) record type, so only agent output reaches it.

/** Canonical envelope field order, mirroring the bash schema exactly. */
export const ENVELOPE_FIELD_ORDER = ["ts", "lvl", "worker", "issue", "attempt", "type", "msg"] as const;

/** Keys the caller may never set via the `extra` fields map; the module owns them. */
const RESERVED_KEYS = new Set(["type", "msg", "ts"]);

/** Optional fields with bash defaults; everything else is an extra string field. */
export interface JsonlLogFields {
  lvl?: string;
  worker?: string;
  issue?: number | string;
  attempt?: number | string;
  /** Verbatim extra string fields (the "…extra" of the schema). */
  extra?: Record<string, string>;
}

/** The uniform envelope object, in canonical field order. */
export interface JsonlLogRecord {
  ts: string;
  lvl: string;
  worker: string;
  issue: number;
  attempt: number;
  type: string;
  msg: string;
  [extra: string]: string | number;
}

/** Thrown when input is malformed; `code` mirrors the bash return codes (2/3). */
export class JsonlLogError extends Error {
  constructor(message: string, readonly code: 2 | 3) {
    super(message);
    this.name = "JsonlLogError";
  }
}

/** A non-negative integer string (no sign, allows 0) — the bash `_is_int` rule. */
function isIntToken(token: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(token);
}

/** A usable JSON field name: non-empty, [A-Za-z_][A-Za-z0-9_]* — the bash `_valid_key` rule. */
function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function coerceInt(label: string, value: number | string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new JsonlLogError(`[jsonl-log] non-numeric ${label} ${JSON.stringify(value)}`, 3);
    }
    return value;
  }
  if (!isIntToken(value)) {
    throw new JsonlLogError(`[jsonl-log] non-numeric ${label} ${JSON.stringify(value)}`, 3);
  }
  return Number(value);
}

/**
 * Pure record-shaping: given (type, msg, ts, fields) return the canonical
 * uniform envelope object. Standard fields are emitted first, in canonical
 * order, then validated extras ride along verbatim as string fields. Throws a
 * {@link JsonlLogError} on malformed input — nothing is written by callers.
 */
export function buildRecord(type: string, msg: string, ts: string, fields: JsonlLogFields = {}): JsonlLogRecord {
  if (!type) throw new JsonlLogError("[jsonl-log] buildRecord: need <type>", 2);
  const record: JsonlLogRecord = {
    ts,
    lvl: fields.lvl ?? "info",
    worker: fields.worker ?? "",
    issue: coerceInt("issue", fields.issue),
    attempt: coerceInt("attempt", fields.attempt),
    type,
    msg,
  };
  for (const [key, value] of Object.entries(fields.extra ?? {})) {
    if (RESERVED_KEYS.has(key)) {
      throw new JsonlLogError(`[jsonl-log] reserved key ${JSON.stringify(key)} cannot be set via extra`, 3);
    }
    if (key === "lvl" || key === "worker" || key === "issue" || key === "attempt") {
      throw new JsonlLogError(`[jsonl-log] reserved key ${JSON.stringify(key)} cannot be set via extra`, 3);
    }
    if (!isValidKey(key)) {
      throw new JsonlLogError(`[jsonl-log] invalid extra key ${JSON.stringify(key)}`, 3);
    }
    record[key] = value;
  }
  return record;
}

/** Serialize a record to its single compact JSONL line (no trailing newline). */
export function formatRecordLine(record: JsonlLogRecord): string {
  return JSON.stringify(record);
}

/**
 * The append IO: a thin injectable sink. The default writes to the filesystem
 * with O_APPEND semantics (Node's `appendFile` opens with `a`, so each write is
 * atomic at the OS level — the analogue of the bash `>>` / flock discipline),
 * creating the parent directory first.
 */
export type AppendSink = (path: string, line: string) => Promise<void>;

export const fsAppendSink: AppendSink = async (path, line) => {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, "utf8");
};

export interface AppendOptions {
  ts: string;
  fields?: JsonlLogFields;
  sink?: AppendSink;
}

/**
 * Append one envelope line to a per-attempt lane (single writer).
 * Mirrors bash `jsonl_log_append`.
 */
export async function appendRecord(
  path: string,
  type: string,
  msg: string,
  options: AppendOptions,
): Promise<JsonlLogRecord> {
  if (!path) throw new JsonlLogError("[jsonl-log] appendRecord: need <path>", 2);
  if (!type) throw new JsonlLogError("[jsonl-log] appendRecord: need <type>", 2);
  const record = buildRecord(type, msg, options.ts, options.fields);
  await (options.sink ?? fsAppendSink)(path, formatRecordLine(record));
  return record;
}

/**
 * Append one `type=agent` envelope to the agent lane. The lane owns its type:
 * a synthetic type, or any explicit type other than `agent`, is a contract
 * violation. Mirrors bash `jsonl_log_append_agent`.
 */
export async function appendAgentRecord(
  path: string,
  msg: string,
  options: AppendOptions,
): Promise<JsonlLogRecord> {
  if (!path) throw new JsonlLogError("[jsonl-log] appendAgentRecord: need <path>", 2);
  const requestedType = options.fields?.extra?.type;
  if (requestedType !== undefined && requestedType !== "agent") {
    throw new JsonlLogError(
      `[jsonl-log] agent lane rejects type ${JSON.stringify(requestedType)} (lane carries agent output only)`,
      3,
    );
  }
  // Drop any redundant type=agent before building (the module stamps it itself).
  let fields = options.fields;
  if (fields?.extra && "type" in fields.extra) {
    const { type: _dropped, ...rest } = fields.extra;
    fields = { ...fields, extra: rest };
  }
  const record = buildRecord("agent", msg, options.ts, fields);
  await (options.sink ?? fsAppendSink)(path, formatRecordLine(record));
  return record;
}

/** Filter parsed records by `.worker`, preserving file order. */
export function filterByWorker(records: readonly JsonlLogRecord[], worker: string): JsonlLogRecord[] {
  return records.filter((r) => r.worker === worker);
}

/** Filter parsed records by `.type`, preserving file order. */
export function filterByType(records: readonly JsonlLogRecord[], type: string): JsonlLogRecord[] {
  return records.filter((r) => r.type === type);
}

/** Parse a lane's contents into records (one per non-empty line). */
export function parseLane(content: string): JsonlLogRecord[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonlLogRecord);
}
