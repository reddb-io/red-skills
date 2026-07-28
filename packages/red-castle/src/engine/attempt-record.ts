// attempt-record.ts — the resident-owned attempt record (ADR 0128).
//
// Two constraints from the ADR shape every line below:
//
//  1. THE RESIDENT WRITES IT, NEVER THE WORKER. `writer` is validated to
//     `"resident"`, and the record must survive the worker's death — that is
//     the case it exists for.
//  2. THE WRITE PATH DEGRADES, IT NEVER FAILS AN ATTEMPT. `record()` resolves
//     with a diagnostic instead of throwing, on validation errors and on I/O
//     errors alike. The record is diagnostic; it must never break execution.
//
// The lane is append-only: a prior attempt's record is NEVER rewritten in
// place. An attempt's record is the FOLD of every entry sharing its
// `attempt_id`, so a later fact is a new line, not an edit.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeLines, parseRecords, type ToonlRecord } from "@reddb-io/toon";
import {
  CASTLE_ATTEMPT_SCHEMA_ID,
  CASTLE_PUBLISHED_CONTRACTS,
  type CastleAttemptEntry,
  type CastleAttemptEvent,
  type CastleAttemptRecord,
} from "./contracts/index.js";
import type { EnginePaths } from "./paths.js";

export class CastleAttemptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastleAttemptValidationError";
  }
}

/** Every field a caller must supply. Missing any one of them is a rejection. */
export const CASTLE_ATTEMPT_REQUIRED_FIELDS = [
  "schema",
  "attempt_id",
  "worker_id",
  "issue",
  "try",
  "at",
  "event",
  "writer",
] as const satisfies readonly (keyof CastleAttemptEntry)[];

const ATTEMPT_FIELDS = new Set<string>(
  CASTLE_PUBLISHED_CONTRACTS.find(
    (candidate) => candidate.schemaId === CASTLE_ATTEMPT_SCHEMA_ID,
  )!.fields,
);

/** Object-valued fields, stored as JSON scalars in the TOONL row. */
const NESTED_FIELDS = [
  "claim",
  "routing",
  "gate",
  "landing",
  "outcome",
  "resources",
  "artifact",
  "payload",
] as const;

export interface CastleAttemptIdentity {
  worker_id: string;
  issue: number;
  try: number;
}

/** The attempt's stable identity: one worker × one ticket × one try. */
export function castleAttemptId(identity: CastleAttemptIdentity): string {
  return `${identity.worker_id}:${identity.issue}:${identity.try}`;
}

function reject(message: string): never {
  throw new CastleAttemptValidationError(message);
}

function assertNonEmptyString(
  raw: Record<string, unknown>,
  field: string,
): void {
  if (typeof raw[field] !== "string" || raw[field].length === 0) {
    reject(`attempt entry needs string ${field}`);
  }
}

function assertPositiveInteger(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    reject(`attempt entry ${field} must be a positive integer`);
  }
}

function assertOptionalObject(
  raw: Record<string, unknown>,
  field: string,
): void {
  const value = raw[field];
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`attempt entry ${field} must be an object`);
  }
}

export function validateCastleAttemptEntry(
  entry: CastleAttemptEntry,
): CastleAttemptEntry {
  const raw = entry as unknown as Record<string, unknown>;
  for (const field of Object.keys(raw)) {
    if (!ATTEMPT_FIELDS.has(field)) {
      reject(
        `${CASTLE_ATTEMPT_SCHEMA_ID} rejects unknown field ${JSON.stringify(field)}`,
      );
    }
  }
  for (const field of CASTLE_ATTEMPT_REQUIRED_FIELDS) {
    if (raw[field] === undefined) {
      reject(`attempt entry is missing required field ${field}`);
    }
  }
  if (raw.schema !== CASTLE_ATTEMPT_SCHEMA_ID) {
    reject(`attempt entry schema must be ${CASTLE_ATTEMPT_SCHEMA_ID}`);
  }
  // ADR 0128 §2: the resident owns the write. A worker-stamped entry is the
  // self-report the ADR forbids, so it never reaches the lane.
  if (raw.writer !== "resident") {
    reject("attempt entry writer must be resident, never the worker");
  }
  for (const field of ["attempt_id", "worker_id", "at", "event"]) {
    assertNonEmptyString(raw, field);
  }
  for (const field of ["issue", "try"]) assertPositiveInteger(raw, field);
  if (raw.attempt_id !== castleAttemptId(entry)) {
    reject(
      `attempt_id must be ${castleAttemptId(entry)} for this worker, issue, and try`,
    );
  }
  for (const field of NESTED_FIELDS) assertOptionalObject(raw, field);
  for (const field of ["branch", "commit", "note"]) {
    if (raw[field] !== undefined) assertNonEmptyString(raw, field);
  }
  if (raw.pr !== undefined) assertPositiveInteger(raw, "pr");
  return entry;
}

function toToonlRow(entry: CastleAttemptEntry): ToonlRecord {
  const row: ToonlRecord = {};
  for (const [key, value] of Object.entries(entry)) {
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

function fromToonlRow(row: unknown): CastleAttemptEntry {
  if (row === null || typeof row !== "object") {
    reject("attempt entry must be an object");
  }
  const raw = { ...(row as Record<string, unknown>) };
  for (const field of NESTED_FIELDS) {
    if (typeof raw[field] !== "string") continue;
    try {
      raw[field] = JSON.parse(raw[field]) as Record<string, unknown>;
    } catch {
      reject(`attempt entry ${field} is not valid JSON`);
    }
  }
  return validateCastleAttemptEntry(raw as unknown as CastleAttemptEntry);
}

/**
 * Parse a lane whose TAIL MAY BE TORN. A worker killed mid-flight can leave the
 * resident's last append half-written; dropping physical lines from the end
 * until the remainder parses keeps every complete entry readable, which is the
 * whole point of the record.
 */
function parseTolerantly(raw: string): ToonlRecord[] {
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let end = lines.length; end > 0; end--) {
    try {
      return parseRecords(`${lines.slice(0, end).join("\n")}\n`);
    } catch {
      // Torn tail — retry without the last physical line.
    }
  }
  return [];
}

async function readLane(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Every complete entry on the lane, oldest first. */
export async function readCastleAttemptEntries(
  path: string,
): Promise<CastleAttemptEntry[]> {
  const raw = await readLane(path);
  if (raw === undefined) return [];
  return parseTolerantly(raw).map(fromToonlRow);
}

/**
 * Fold entries into one record per attempt, in first-seen order. A ticket's
 * history and a worker's history are both filters over this — derived views,
 * never separately maintained state (ADR 0128 §1).
 */
export function foldCastleAttemptRecords(
  entries: readonly CastleAttemptEntry[],
): CastleAttemptRecord[] {
  const records = new Map<string, CastleAttemptRecord>();
  for (const entry of entries) {
    let record = records.get(entry.attempt_id);
    if (!record) {
      record = {
        attempt_id: entry.attempt_id,
        worker_id: entry.worker_id,
        issue: entry.issue,
        try: entry.try,
        opened_at: entry.at,
        updated_at: entry.at,
        closed: false,
        commits: [],
        gate: [],
        landing: [],
        artifacts: [],
        events: [],
      };
      records.set(entry.attempt_id, record);
    }
    record.updated_at = entry.at;
    record.events.push(entry);
    if (entry.claim) record.claim = entry.claim;
    if (entry.routing) record.routing = entry.routing;
    if (entry.branch) record.branch = entry.branch;
    if (entry.commit && !record.commits.includes(entry.commit)) {
      record.commits.push(entry.commit);
    }
    if (entry.pr !== undefined) record.pr = entry.pr;
    if (entry.gate) record.gate.push(entry.gate);
    if (entry.landing) record.landing.push(entry.landing);
    if (entry.resources) record.resources = entry.resources;
    if (entry.artifact) record.artifacts.push(entry.artifact);
    if (entry.outcome) {
      record.outcome = entry.outcome;
      record.closed = true;
    }
  }
  return [...records.values()];
}

export async function readCastleAttemptRecords(
  path: string,
): Promise<CastleAttemptRecord[]> {
  return foldCastleAttemptRecords(await readCastleAttemptEntries(path));
}

export interface CastleAttemptDiagnostic {
  at: string;
  /** `validation` — the entry was malformed; `write` — the lane was unwritable. */
  reason: "validation" | "write";
  message: string;
  attempt_id?: string;
  event?: string;
}

export interface CastleAttemptAppendResult {
  ok: boolean;
  entry?: CastleAttemptEntry;
  diagnostic?: CastleAttemptDiagnostic;
}

/** The narrative fields a caller supplies alongside the event. `at` defaults to
 * the recorder's clock, so the resident stamps the time it OBSERVED the fact. */
export type CastleAttemptEventFields = Omit<
  CastleAttemptEntry,
  | "schema"
  | "attempt_id"
  | "worker_id"
  | "issue"
  | "try"
  | "at"
  | "event"
  | "writer"
> & { at?: string };

export interface CastleAttemptLog {
  readonly attempt_id: string;
  readonly path: string;
  record(
    event: CastleAttemptEvent,
    fields?: CastleAttemptEventFields,
  ): Promise<CastleAttemptAppendResult>;
  read(): Promise<CastleAttemptRecord | undefined>;
}

export interface CastleAttemptRecorderOptions {
  readonly clock?: () => string;
  /** Where a degraded write is surfaced. Called instead of throwing. */
  readonly onDiagnostic?: (diagnostic: CastleAttemptDiagnostic) => void;
}

export interface CastleAttemptRecorder {
  readonly path: string;
  /** Open the resident's writer for one attempt. */
  attempt(identity: CastleAttemptIdentity): CastleAttemptLog;
  /** Every diagnostic this recorder degraded through, oldest first. */
  diagnostics(): readonly CastleAttemptDiagnostic[];
  read(): Promise<CastleAttemptRecord[]>;
}

async function appendEntry(
  path: string,
  entry: CastleAttemptEntry,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, encodeLines().push(toToonlRow(entry)), "utf8");
}

/**
 * Create the resident's attempt recorder for a `.red` root. Nothing here
 * throws: a caller can `await` every `record()` inside the attempt's own
 * control flow and know the attempt survives a broken lane.
 */
export function createCastleAttemptRecorder(
  paths: EnginePaths,
  options: CastleAttemptRecorderOptions = {},
): CastleAttemptRecorder {
  const path = paths.castleAttempts;
  const clock = options.clock ?? (() => new Date().toISOString());
  const diagnostics: CastleAttemptDiagnostic[] = [];

  function degrade(
    reason: CastleAttemptDiagnostic["reason"],
    err: unknown,
    context: { attempt_id?: string; event?: string },
  ): CastleAttemptAppendResult {
    const diagnostic: CastleAttemptDiagnostic = {
      at: clock(),
      reason,
      message: err instanceof Error ? err.message : String(err),
      ...context,
    };
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
    return { ok: false, diagnostic };
  }

  return {
    path,
    diagnostics: () => diagnostics,
    read: () => readCastleAttemptRecords(path),
    attempt(identity) {
      const attempt_id = castleAttemptId(identity);
      return {
        attempt_id,
        path,
        async record(event, fields = {}) {
          const { at, ...narrative } = fields;
          let entry: CastleAttemptEntry;
          try {
            entry = validateCastleAttemptEntry({
              schema: CASTLE_ATTEMPT_SCHEMA_ID,
              attempt_id,
              worker_id: identity.worker_id,
              issue: identity.issue,
              try: identity.try,
              at: at ?? clock(),
              event,
              writer: "resident",
              ...narrative,
            });
          } catch (err) {
            return degrade("validation", err, { attempt_id, event });
          }
          try {
            await appendEntry(path, entry);
          } catch (err) {
            return degrade("write", err, { attempt_id, event });
          }
          return { ok: true, entry };
        },
        async read() {
          const records = await readCastleAttemptRecords(path);
          return records.find((record) => record.attempt_id === attempt_id);
        },
      };
    },
  };
}
