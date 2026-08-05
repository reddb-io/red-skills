import { mkdir, appendFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, encode, encodeLines, parseRecords, type JsonValue, type ToonlLineEmitter, type ToonlRecord } from "@reddb-io/toon";

// The JSONL Log Module: owns the AFK structured-log lane format end to end.
//
// A "lane" is an append-only JSONL file: one structured record per line, each a
// uniform envelope so a rollup reader never has to special-case a line's shape.
// The envelope is defined exactly once, here, with this field order:
//
//   {ts, lvl?, worker?, issue?, attempt?, type, msg, …extra}
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
  /** Verbatim extra JSON fields (the "…extra" of the schema). */
  extra?: Record<string, JsonlLogValue>;
}

export type JsonlLogValue =
  | string
  | number
  | boolean
  | null
  | JsonlLogValue[]
  | { [key: string]: JsonlLogValue };

/** The uniform envelope object, in canonical field order. */
export interface JsonlLogRecord {
  ts: string;
  lvl?: string;
  worker?: string;
  issue?: number;
  attempt?: number;
  type: string;
  msg: JsonlLogValue;
  [extra: string]: JsonlLogValue | undefined;
}

/** Thrown when input is malformed; `code` mirrors the bash return codes (2/3). */
export class JsonlLogError extends Error {
  constructor(message: string, readonly code: 2 | 3) {
    super(message);
    this.name = "JsonlLogError";
  }
}

export interface ToonlLaneCursor {
  /** Byte offset immediately after the last fully-consumed line. */
  byteOffset: number;
  /** The active TOONL header needed to decode positional rows after resume. */
  activeHeader: string;
  /** Number of decoded rows since the active header was observed. */
  rowsSinceHeader: number;
  /** Tagged-row headers needed to decode `tag:...` rows after resume. */
  taggedHeaders?: Record<string, string>;
}

export class ToonlCursorInvalidationError extends Error {
  readonly code = "TOONL_CURSOR_INVALIDATED";

  constructor(message: string) {
    super(message);
    this.name = "ToonlCursorInvalidationError";
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
export function buildRecord(type: string, msg: JsonlLogValue, ts: string, fields: JsonlLogFields = {}): JsonlLogRecord {
  if (!type) throw new JsonlLogError("[jsonl-log] buildRecord: need <type>", 2);
  const record: Partial<JsonlLogRecord> = {
    ts,
  };
  if (fields.lvl !== undefined && fields.lvl !== "info") record.lvl = fields.lvl;
  if (fields.worker !== undefined && fields.worker !== "") record.worker = fields.worker;
  const issue = coerceInt("issue", fields.issue);
  if (issue !== 0) record.issue = issue;
  const attempt = coerceInt("attempt", fields.attempt);
  if (attempt !== 0) record.attempt = attempt;
  record.type = type;
  record.msg = msg;
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
  return record as JsonlLogRecord;
}

/** Serialize a record to its single compact JSONL line (no trailing newline). */
export function formatRecordLine(record: JsonlLogRecord): string {
  return JSON.stringify(record);
}

/** Serialize one agent-lane record as a standalone TOONL segment. Concatenating
 * segments keeps appends O_APPEND-safe and lets a restart naturally open a new
 * segment without rewriting earlier rows. */
export function formatRecordToonl(record: JsonlLogRecord): string {
  return encode([record] as unknown as JsonValue).trimEnd();
}

function formatRecordToonlParts(record: JsonlLogRecord): { header: string; row: string } {
  const lines = formatRecordToonl(record).split(/\r?\n/);
  const header = lines[0] ?? "";
  const row = lines.slice(1).join("\n");
  return { header, row };
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

const taggedRowEmitters = new Map<string, ToonlLineEmitter>();

function toToonlRecord(record: JsonlLogRecord): ToonlRecord {
  const out: ToonlRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    out[key] =
      value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }
  return out;
}

/**
 * Append one envelope line to a per-attempt lane (single writer).
 * Mirrors bash `jsonl_log_append`.
 */
export async function appendRecord(
  path: string,
  type: string,
  msg: JsonlLogValue,
  options: AppendOptions,
): Promise<JsonlLogRecord> {
  if (!path) throw new JsonlLogError("[jsonl-log] appendRecord: need <path>", 2);
  if (!type) throw new JsonlLogError("[jsonl-log] appendRecord: need <type>", 2);
  const record = buildRecord(type, msg, options.ts, options.fields);
  await (options.sink ?? fsAppendSink)(path, formatRecordLine(record));
  return record;
}

/**
 * Append one envelope record as a standalone TOONL segment.
 * Used by append-only lanes that have moved their writer to TOONL while keeping
 * format-sniff readers tolerant of legacy JSONL and mixed transition files.
 */
export async function appendRecordToonl(
  path: string,
  type: string,
  msg: JsonlLogValue,
  options: AppendOptions,
): Promise<JsonlLogRecord> {
  if (!path) throw new JsonlLogError("[jsonl-log] appendRecordToonl: need <path>", 2);
  if (!type) throw new JsonlLogError("[jsonl-log] appendRecordToonl: need <type>", 2);
  const record = buildRecord(type, msg, options.ts, options.fields);
  await (options.sink ?? fsAppendSink)(path, formatRecordToonl(record));
  return record;
}

/**
 * Append one envelope record to a stable-schema TOONL lane. The first append
 * writes the TOONL header plus row; later appends write only rows. Callers must
 * keep the record shape stable for the lifetime of the file.
 */
export async function appendRecordToonlRow(
  path: string,
  type: string,
  msg: JsonlLogValue,
  options: AppendOptions,
): Promise<JsonlLogRecord> {
  if (!path) throw new JsonlLogError("[jsonl-log] appendRecordToonlRow: need <path>", 2);
  if (!type) throw new JsonlLogError("[jsonl-log] appendRecordToonlRow: need <type>", 2);
  const record = buildRecord(type, msg, options.ts, options.fields);
  const { header, row } = formatRecordToonlParts(record);
  if (options.sink) {
    await options.sink(path, `${header}\n${row}`);
    return record;
  }
  await mkdir(dirname(path), { recursive: true });
  let empty = true;
  try {
    empty = (await stat(path)).size === 0;
  } catch {
    empty = true;
  }
  await appendFile(path, `${empty ? `${header}\n` : ""}${row}\n`, "utf8");
  return record;
}

/**
 * Append one record to a TOONL v0.2 tagged-row lane. Tags multiplex record
 * shapes inside one append-only file: the first row for a tag declares
 * `[]<tag>{fields}:`, then later rows use `tag:...` until that tag's shape
 * changes. The emitter canonicalizes field order per shape, avoiding the
 * old one-header-per-record thrash while keeping legacy `.jsonl` filenames.
 */
export async function appendRecordToonlTaggedRow(
  path: string,
  type: string,
  msg: JsonlLogValue,
  options: AppendOptions,
): Promise<JsonlLogRecord> {
  if (!path) throw new JsonlLogError("[jsonl-log] appendRecordToonlTaggedRow: need <path>", 2);
  if (!type) throw new JsonlLogError("[jsonl-log] appendRecordToonlTaggedRow: need <type>", 2);
  const record = buildRecord(type, msg, options.ts, options.fields);
  const emitterKey = options.sink ? `${path}\0sink` : path;
  let emitter = taggedRowEmitters.get(emitterKey);
  if (!emitter) {
    emitter = encodeLines({ trailer: false });
    taggedRowEmitters.set(emitterKey, emitter);
  }
  const chunk = emitter.pushTagged(type, toToonlRecord(record)).trimEnd();
  await (options.sink ?? fsAppendSink)(path, chunk);
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
  await (options.sink ?? fsAppendSink)(path, formatRecordToonl(record));
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
  return parseLaneSinceCursor(content).records;
}

function normalizeCursor(cursor: ToonlLaneCursor | undefined, contentBytes: number): ToonlLaneCursor {
  if (cursor === undefined) {
    return { byteOffset: 0, activeHeader: "", rowsSinceHeader: 0, taggedHeaders: {} };
  }
  if (!Number.isSafeInteger(cursor.byteOffset) || cursor.byteOffset < 0 || cursor.byteOffset > contentBytes) {
    throw new ToonlCursorInvalidationError(
      `[jsonl-log] TOONL cursor invalidated: byte offset ${cursor.byteOffset} outside lane size ${contentBytes}`,
    );
  }
  if (!Number.isSafeInteger(cursor.rowsSinceHeader) || cursor.rowsSinceHeader < 0) {
    throw new ToonlCursorInvalidationError("[jsonl-log] TOONL cursor invalidated: rowsSinceHeader is invalid");
  }
  return {
    byteOffset: cursor.byteOffset,
    activeHeader: typeof cursor.activeHeader === "string" ? cursor.activeHeader : "",
    rowsSinceHeader: cursor.rowsSinceHeader,
    taggedHeaders: cursor.taggedHeaders && typeof cursor.taggedHeaders === "object" ? { ...cursor.taggedHeaders } : {},
  };
}

function completeLinesFrom(content: string, startByteOffset: number, includeFinalLine = false): Array<{ line: string; nextOffset: number }> {
  const buffer = Buffer.from(content, "utf8");
  const out: Array<{ line: string; nextOffset: number }> = [];
  let start = startByteOffset;
  while (start < buffer.length) {
    const newline = buffer.indexOf(10, start);
    if (newline === -1) {
      if (includeFinalLine) out.push({ line: buffer.subarray(start).toString("utf8"), nextOffset: buffer.length });
      break;
    }
    const end = newline > start && buffer[newline - 1] === 13 ? newline - 1 : newline;
    out.push({ line: buffer.subarray(start, end).toString("utf8"), nextOffset: newline + 1 });
    start = newline + 1;
  }
  return out;
}

function decodeToonlRow(header: string, line: string): JsonlLogRecord | null {
  try {
    const row = header.startsWith("[]")
      ? parseRecords(`${header}\n${line}\n`)[0]
      : (() => {
          const value = decode(header.replace(/^\[(?:[0-9]+)?\]/, "[1]") + "\n" + line + "\n");
          return Array.isArray(value) ? value[0] : value;
        })();
    return row && typeof row === "object" ? row as JsonlLogRecord : null;
  } catch {
    // TOONL readers are crash-tail tolerant during rollout.
    return null;
  }
}

/**
 * Parse complete records after a reader-owned TOONL cursor. The cursor captures
 * only reader state: byte offset, active header, and rows-since-header. Losing
 * it is safe because callers can re-run with no cursor and rescan the lane.
 */
export function parseLaneSinceCursor(
  content: string,
  cursor?: ToonlLaneCursor,
): { records: JsonlLogRecord[]; cursor: ToonlLaneCursor } {
  const contentBytes = Buffer.byteLength(content, "utf8");
  const normalized = normalizeCursor(cursor, contentBytes);
  const records: JsonlLogRecord[] = [];
  let header = normalized.activeHeader;
  let rowsSinceHeader = normalized.rowsSinceHeader;
  const taggedHeaders = new Map<string, string>(Object.entries(normalized.taggedHeaders ?? {}));
  let byteOffset = normalized.byteOffset;
  const lineEntries = completeLinesFrom(content, normalized.byteOffset, cursor === undefined);
  for (const raw of lineEntries) {
    const line = raw.line.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      byteOffset = raw.nextOffset;
      continue;
    }
    if (trimmed.startsWith("{")) {
      try {
        records.push(JSON.parse(trimmed) as JsonlLogRecord);
        byteOffset = raw.nextOffset;
      } catch {
        // Crash tails can leave a torn final row; keep the parseable prefix.
      }
      continue;
    }
    if (/^\[(?:[0-9]+)?\]\{[^}]+\}:$/.test(trimmed)) {
      header = trimmed;
      rowsSinceHeader = 0;
      byteOffset = raw.nextOffset;
      continue;
    }
    const taggedHeader = trimmed.match(/^\[\]<([A-Za-z0-9_-]+)>(\{[^}]+\}:)$/);
    if (taggedHeader) {
      taggedHeaders.set(taggedHeader[1]!, `[1]${taggedHeader[2]}`);
      header = trimmed;
      rowsSinceHeader = 0;
      byteOffset = raw.nextOffset;
      continue;
    }
    const taggedRow = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (taggedRow) {
      const tagged = taggedHeaders.get(taggedRow[1]!);
      if (!tagged) continue;
      const row = decodeToonlRow(tagged, `  ${taggedRow[2]}`);
      if (row) {
        records.push(row);
        rowsSinceHeader += 1;
        byteOffset = raw.nextOffset;
      }
      continue;
    }
    if (!header) continue;
    const row = decodeToonlRow(header, line);
    if (row) {
      records.push(row);
      rowsSinceHeader += 1;
      byteOffset = raw.nextOffset;
    }
  }
  return {
    records,
    cursor: {
      byteOffset,
      activeHeader: header,
      rowsSinceHeader,
      taggedHeaders: Object.fromEntries(taggedHeaders),
    },
  };
}
