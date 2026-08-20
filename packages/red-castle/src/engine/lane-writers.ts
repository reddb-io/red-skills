import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LANE_RETENTION_REGISTRY,
  laneOverCeiling,
  trimLaneKeepLast,
  type LaneRetentionPolicy,
} from "@reddb-io/shared/lane-retention.js";
import {
  decode,
  encode,
  encodeToonlLines,
  parseRecords,
  type JsonValue,
} from "@reddb-io/toon";
import {
  CASTLE_HISTORY_SCHEMA_ID,
  CASTLE_LANE_SCHEMA_ID,
  CASTLE_PUBLISHED_CONTRACTS,
  CASTLE_STATE_SCHEMA_ID,
  DECISION_TRAIL_KINDS,
  type CastleHistoryRecord,
  type CastleLaneRecord,
  type CastleStateKind,
  type CastleStateSnapshot,
} from "./contracts/index.js";
import type { EnginePaths } from "./paths.js";

type ToonlRecord = Record<string, string | number | boolean | null>;

export class CastleLaneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastleLaneValidationError";
  }
}

export const CASTLE_LANE_FILENAMES = {
  worker: "worker.log.toonl",
  supervisor: "supervisor.log.toonl",
  monitor: "monitor.log.toonl",
  liveness: "liveness.toonl",
} as const;

export type CastleLaneName = keyof typeof CASTLE_LANE_FILENAMES;

function encodedRows(rows: readonly ToonlRecord[]): string {
  if (rows.length === 0) return "";
  const writer = encodeToonlLines({ trailer: false });
  return rows.map((row) => writer.push(row)).join("");
}

function keepLastWithinByteTarget(
  rows: readonly ToonlRecord[],
  incomingBytes: number,
  targetBytes: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(encodedRows(rows.slice(-middle))) + incomingBytes <=
      targetBytes
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

const CONTRACT_FIELDS = new Map(
  CASTLE_PUBLISHED_CONTRACTS.map((contract) => [
    contract.schemaId,
    new Set<string>(contract.fields),
  ]),
);

function fieldsFor(schemaId: string): Set<string> {
  const fields = CONTRACT_FIELDS.get(schemaId);
  if (!fields) {
    throw new CastleLaneValidationError(`unknown castle contract ${schemaId}`);
  }
  return fields;
}

function assertKnownFields(
  schemaId: string,
  record: Record<string, unknown>,
): void {
  const fields = fieldsFor(schemaId);
  for (const field of Object.keys(record)) {
    if (!fields.has(field)) {
      throw new CastleLaneValidationError(
        `${schemaId} rejects unknown field ${JSON.stringify(field)}`,
      );
    }
  }
}

function assertString(record: Record<string, unknown>, field: string): void {
  if (typeof record[field] !== "string" || record[field].length === 0) {
    throw new CastleLaneValidationError(`castle record needs string ${field}`);
  }
}

function assertOptionalNumber(
  record: Record<string, unknown>,
  field: string,
): void {
  const value = record[field];
  if (value !== undefined && typeof value !== "number") {
    throw new CastleLaneValidationError(
      `castle record ${field} must be number`,
    );
  }
}

function assertOptionalObject(
  record: Record<string, unknown>,
  field: string,
): void {
  const value = record[field];
  if (
    value !== undefined &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  ) {
    throw new CastleLaneValidationError(
      `castle record ${field} must be object`,
    );
  }
}

const POINTER_PREFIXES = [
  "https://",
  "http://",
  "file://",
  "git://",
  "gh:",
  "file:",
] as const;

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const ISSUE_REF_PATTERN = /^#\d+$/;

function isEvidencePointer(value: string): boolean {
  if (POINTER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return true;
  }
  if (value.startsWith("/") || /^[a-z]:\\/i.test(value)) {
    return true;
  }
  if (SHA_PATTERN.test(value)) {
    return true;
  }
  if (ISSUE_REF_PATTERN.test(value)) {
    return true;
  }
  return false;
}

function validateDecisionTrailPayload(payload: Record<string, unknown>): void {
  const decision = payload.decision;
  const why = payload.why;
  const evidence = payload.evidence;
  const result = payload.result;

  if (typeof decision !== "string" || decision.length === 0) {
    throw new CastleLaneValidationError(
      "decision trail payload must have non-empty string decision",
    );
  }
  if (typeof why !== "string" || why.length === 0) {
    throw new CastleLaneValidationError(
      "decision trail payload must have non-empty string why",
    );
  }
  if (typeof evidence !== "string" || evidence.length === 0) {
    throw new CastleLaneValidationError(
      "decision trail payload must have non-empty string evidence",
    );
  }
  if (!isEvidencePointer(evidence)) {
    throw new CastleLaneValidationError(
      "decision trail evidence must be a pointer (URL, file path, SHA, or issue ref), not prose",
    );
  }
  if (typeof result !== "string" || result.length === 0) {
    throw new CastleLaneValidationError(
      "decision trail payload must have non-empty string result",
    );
  }
}

export function validateCastleLaneRecord(
  record: CastleLaneRecord,
): CastleLaneRecord {
  const raw = record as unknown as Record<string, unknown>;
  assertKnownFields(CASTLE_LANE_SCHEMA_ID, raw);
  assertString(raw, "at");
  assertString(raw, "kind");
  if (!String(raw.kind).includes(".")) {
    throw new CastleLaneValidationError("castle lane kind must be namespaced");
  }
  assertOptionalNumber(raw, "issue");
  assertOptionalNumber(raw, "attempt");
  if (raw.msg !== undefined && typeof raw.msg !== "string") {
    throw new CastleLaneValidationError("castle record msg must be string");
  }
  assertOptionalObject(raw, "payload");
  const kind = String(raw.kind);
  if (kind.startsWith("decision.")) {
    if (!DECISION_TRAIL_KINDS.includes(kind as (typeof DECISION_TRAIL_KINDS)[number])) {
      throw new CastleLaneValidationError(
        `decision trail kind ${JSON.stringify(kind)} is not in the declared vocabulary: ${DECISION_TRAIL_KINDS.join(", ")}`,
      );
    }
    if (raw.payload == null || typeof raw.payload !== "object") {
      throw new CastleLaneValidationError(
        "decision trail record must have a payload object",
      );
    }
    validateDecisionTrailPayload(raw.payload as Record<string, unknown>);
  }
  return record;
}

export function validateCastleStateSnapshot(
  snapshot: CastleStateSnapshot,
): CastleStateSnapshot {
  const raw = snapshot as unknown as Record<string, unknown>;
  assertKnownFields(CASTLE_STATE_SCHEMA_ID, raw);
  assertString(raw, "kind");
  if (raw.kind !== "worker" && raw.kind !== "supervisor") {
    throw new CastleLaneValidationError(
      "castle state kind must be worker or supervisor",
    );
  }
  assertString(raw, "id");
  if (typeof raw.version !== "number") {
    throw new CastleLaneValidationError("castle state version must be number");
  }
  assertString(raw, "updated_at");
  assertOptionalNumber(raw, "pid");
  return snapshot;
}

export function validateCastleHistoryRecord(
  record: CastleHistoryRecord,
): CastleHistoryRecord {
  const raw = record as unknown as Record<string, unknown>;
  assertKnownFields(CASTLE_HISTORY_SCHEMA_ID, raw);
  assertString(raw, "ts");
  assertString(raw, "worker");
  assertString(raw, "event");
  assertString(raw, "runner");
  for (const field of ["epoch", "issue", "duration_s"]) {
    if (typeof raw[field] !== "number") {
      throw new CastleLaneValidationError(
        `castle history ${field} must be number`,
      );
    }
  }
  return record;
}

async function appendToonlRecord<T extends Record<string, unknown>>(
  path: string,
  record: T,
  retentionPolicy?: LaneRetentionPolicy,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const encoded = encodeToonlLines().push(toToonlRecord(record));
  if (
    retentionPolicy?.maxBytes !== undefined &&
    await laneOverCeiling(path, Buffer.byteLength(encoded), retentionPolicy)
  ) {
    const ceiling = retentionPolicy.maxBytes;
    const incomingBytes = Buffer.byteLength(encoded);
    if (incomingBytes > ceiling) {
      throw new Error(`castle lane record exceeds its ${ceiling}-byte ceiling`);
    }
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const rows = raw === "" ? [] : parseRecords(raw);
    const targetBytes = Math.max(
      incomingBytes,
      Math.floor(ceiling * (retentionPolicy.targetRatio ?? 0.5)),
    );
    const keepLast = keepLastWithinByteTarget(
      rows,
      incomingBytes,
      targetBytes,
    );
    await trimLaneKeepLast(path, keepLast);
  }
  // `appendFile` opens and closes the lane for every beat. That close-before-
  // next-stat lifecycle is what makes the preceding atomic replacement safe.
  await appendFile(path, encoded, "utf8");
}

function toToonlRecord(record: Record<string, unknown>): ToonlRecord {
  const row: ToonlRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    row[key] =
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }
  return row;
}

function normalizeCastleLaneRecord(record: unknown): CastleLaneRecord {
  if (record === null || typeof record !== "object") {
    throw new CastleLaneValidationError("castle lane record must be an object");
  }
  const raw = { ...(record as Record<string, unknown>) };
  if (typeof raw.payload === "string") {
    try {
      raw.payload = JSON.parse(raw.payload) as Record<string, unknown>;
    } catch {
      throw new CastleLaneValidationError(
        "castle lane payload is not valid JSON",
      );
    }
  }
  return validateCastleLaneRecord(raw as unknown as CastleLaneRecord);
}

function normalizeCastleHistoryRecord(record: unknown): CastleHistoryRecord {
  if (record === null || typeof record !== "object") {
    throw new CastleLaneValidationError("castle history record must be an object");
  }
  const raw = { ...(record as Record<string, unknown>) };
  for (const field of ["merge_sha", "reason"]) {
    if (raw[field] === null) delete raw[field];
  }
  return validateCastleHistoryRecord(raw as unknown as CastleHistoryRecord);
}

export async function appendCastleLaneRecord(
  path: string,
  record: CastleLaneRecord,
  options: { readonly retentionPolicy?: LaneRetentionPolicy } = {},
): Promise<CastleLaneRecord> {
  const validated = validateCastleLaneRecord(record);
  await appendToonlRecord(
    path,
    validated as unknown as Record<string, unknown>,
    options.retentionPolicy,
  );
  return validated;
}

export async function appendCastleHistoryRecord(
  path: string,
  record: CastleHistoryRecord,
): Promise<CastleHistoryRecord> {
  const validated = validateCastleHistoryRecord(record);
  await appendToonlRecord(
    path,
    validated as unknown as Record<string, unknown>,
  );
  return validated;
}

export async function writeCastleStateSnapshot(
  path: string,
  snapshot: CastleStateSnapshot,
): Promise<CastleStateSnapshot> {
  const validated = validateCastleStateSnapshot(snapshot);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(
    tmpPath,
    encode(validated as unknown as JsonValue),
    "utf8",
  );
  await rename(tmpPath, path);
  return validated;
}

export async function readCastleLaneRecords(
  path: string,
): Promise<CastleLaneRecord[]> {
  try {
    return parseRecords(await readFile(path, "utf8")).map(
      normalizeCastleLaneRecord,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function readCastleHistoryRecords(
  path: string,
): Promise<CastleHistoryRecord[]> {
  try {
    return parseRecords(await readFile(path, "utf8")).map(
      normalizeCastleHistoryRecord,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function readCastleStateSnapshot(
  path: string,
): Promise<CastleStateSnapshot | undefined> {
  try {
    return validateCastleStateSnapshot(
      decode(await readFile(path, "utf8")) as unknown as CastleStateSnapshot,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function castleLanePath(
  paths: EnginePaths,
  lane: CastleLaneName,
  id: string,
): string {
  switch (lane) {
    case "worker":
    case "liveness":
      return join(paths.worker(id), CASTLE_LANE_FILENAMES[lane]);
    case "supervisor":
      return join(paths.supervisor(id), CASTLE_LANE_FILENAMES.supervisor);
    case "monitor":
      return join(paths.monitor(id), CASTLE_LANE_FILENAMES.monitor);
  }
}

export function castleStateSnapshotPath(
  paths: EnginePaths,
  kind: CastleStateKind,
  id: string,
): string {
  return join(paths.castleStateRoot, `${kind}s`, id, "state.toon");
}

export interface CastleLaneWriter {
  readonly path: string;
  append(
    record: Omit<CastleLaneRecord, "at"> & { at?: string },
  ): Promise<CastleLaneRecord>;
}

export interface CastleLaneWriters {
  worker(id: string): CastleLaneWriter;
  supervisor(id: string): CastleLaneWriter;
  monitor(id: string): CastleLaneWriter;
  liveness(workerId: string): CastleLaneWriter;
}

export interface CastleLaneWritersOptions {
  readonly clock?: () => string;
  /** Tiny override for posed tests; production uses the shared 1 MiB policy. */
  readonly livenessMaxBytes?: number;
}

function makeLaneWriter(
  path: string,
  clock: () => string,
  retentionPolicy?: LaneRetentionPolicy,
): CastleLaneWriter {
  return {
    path,
    async append(record) {
      return appendCastleLaneRecord(
        path,
        {
          at: record.at ?? clock(),
          ...record,
        },
        { retentionPolicy },
      );
    },
  };
}

export function createCastleLaneWriters(
  paths: EnginePaths,
  options: CastleLaneWritersOptions = {},
): CastleLaneWriters {
  const clock = options.clock ?? (() => new Date().toISOString());
  const livenessPolicy: LaneRetentionPolicy = {
    ...LANE_RETENTION_REGISTRY["worker-liveness"],
    ...(options.livenessMaxBytes === undefined
      ? {}
      : { maxBytes: options.livenessMaxBytes }),
  };
  return {
    worker: (id) => makeLaneWriter(castleLanePath(paths, "worker", id), clock),
    supervisor: (id) =>
      makeLaneWriter(castleLanePath(paths, "supervisor", id), clock),
    monitor: (id) =>
      makeLaneWriter(castleLanePath(paths, "monitor", id), clock),
    liveness: (workerId) =>
      makeLaneWriter(
        castleLanePath(paths, "liveness", workerId),
        clock,
        livenessPolicy,
      ),
  };
}
