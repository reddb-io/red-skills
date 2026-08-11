// core/manager/effort-store.ts — the Manager portfolio's durable half
// (Spec #2290, slice #2291; architecture in ADR 0109).
//
// One effort, one file: `<manager root>/.red/manager/efforts/<effort-id>.toonl`.
// Per-effort files are what let two sessions manage DIFFERENT efforts at the
// same time — the effort, not the portfolio, is the unit of the generation
// counter and (in a later slice) the writer lease. The root is operator-and-
// host-scoped and repo-independent, so an effort survives across checkouts.
//
// Four properties this module owns, all asserted at the file seam:
//   1. Atomic — every write is temp-write + rename, so a reader sees a whole
//      document or the previous one, never a half-written record.
//   2. Versioned — each document opens with a schema header record; a document
//      written by a future schema is REFUSED, never silently misread.
//   3. Generation-counted — every save bumps the counter and fails closed when
//      the stored generation already moved past the writer's.
//   4. Secret-free by construction — the encoder refuses secret-shaped content
//      instead of persisting it.
//
// This slice owns only the `inbox` lifecycle state's persistence; the remaining
// four ADR-0109 states, the lease, and reconciliation arrive in later slices.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { managerEffortFile, managerEffortsDir } from "@reddb-io/shared/red-paths.js";
import { encodeRecords, parseRecords } from "@reddb-io/toon";

type ToonlRecord = Record<string, string | number | boolean | null>;

/** The document schema name every effort file declares in its header record. */
export const MANAGER_EFFORT_SCHEMA = "red.manager.effort";

/** The schema version this bundle writes and is willing to read. */
export const MANAGER_EFFORT_SCHEMA_VERSION = 1;

/** The five owned lifecycle states (ADR 0109). This slice only mints `inbox`. */
export type EffortLifecycle = "inbox" | "active" | "paused" | "completed" | "abandoned";

/**
 * The owned state of one effort — everything the portfolio is the authority for.
 * Derived state (HITL, blocked, frontier) is NEVER stored: it is reconciled from
 * the tracker at render time, so this record can never go stale against it.
 */
export interface EffortRecord {
  /** Opaque, immutable identity. Carries no intent, host, or repo. */
  effort_id: string;
  /** Mutable human name. Renaming an effort never changes its id. */
  name: string;
  /** The operator's raw intent, as published. */
  intent: string;
  lifecycle: EffortLifecycle;
  /** Bumped on every save; a stale writer fails closed against it. */
  generation: number;
  created_at: string;
  updated_at: string;
  /**
   * The tracker issue number for the dispatched autonomous execution, when one
   * has been dispatched (Spec #2290, slice #2295). Absent if no dispatch has
   * occurred. Owned state only — the issue's current tracker state (open/closed,
   * labels, PRs) is reconciled from the tracker at render time as untrusted
   * evidence, never stored here.
   */
  dispatch_issue?: number;
  /** Skill name ask-red recommended for this effort (S3: routing slice). */
  route?: string;
  /** Artifact references captured from inline session-bound skill runs (S3). */
  artifact_refs?: readonly string[];
}

/** Base class for every refusal this store raises. */
export class ManagerStoreError extends Error {}

/** Raised when a document's schema header is absent, foreign, or unreadable. */
export class ManagerSchemaError extends ManagerStoreError {}

/** Raised when a write would persist secret-shaped content. */
export class ManagerSecretError extends ManagerStoreError {}

/** Raised when the stored generation already moved past the writer's. */
export class ManagerGenerationError extends ManagerStoreError {}

const EFFORT_ID_PREFIX = "eff_";
const EFFORT_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const EFFORT_ID_LENGTH = 26;
const EFFORT_FILE_SUFFIX = ".toonl";
const NAME_MAX_WORDS = 6;
const NAME_MAX_CHARS = 48;

/**
 * Mint an opaque effort id. Opaque means derived from randomness ALONE — never
 * from the intent, the host, or the repo — so the id leaks nothing and stays
 * valid when every one of those changes.
 */
export function mintEffortId(): string {
  const bytes = randomBytes(EFFORT_ID_LENGTH);
  let id = "";
  for (const byte of bytes) id += EFFORT_ID_ALPHABET[byte % EFFORT_ID_ALPHABET.length];
  return `${EFFORT_ID_PREFIX}${id}`;
}

/** True for a string shaped like a minted effort id (the filename guard). */
export function isEffortId(value: string): boolean {
  return new RegExp(`^${EFFORT_ID_PREFIX}[0-9a-z]{${EFFORT_ID_LENGTH}}$`).test(value);
}

/**
 * Derive the effort's first human name from the intent: the leading words,
 * bounded so a pasted paragraph still renders as a name. The name is mutable —
 * this is a starting label, not an identity.
 */
export function deriveEffortName(intent: string): string {
  const words = intent.trim().split(/\s+/).filter(Boolean).slice(0, NAME_MAX_WORDS);
  const name = words.join(" ").slice(0, NAME_MAX_CHARS).trim();
  return name || "untitled effort";
}

/** Field names that must never appear in a persisted effort. */
const SECRET_FIELD_PATTERN = /(token|secret|password|passwd|credential|api[_-]?key|authorization)/i;

/**
 * Value shapes that are credentials wherever they appear. Deliberately narrow —
 * it matches issued-token formats, not English words — so an honest intent is
 * never refused for containing "key" or "secret".
 */
const SECRET_VALUE_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9-]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

/**
 * Refuse secret-shaped content at the ONLY seam that writes the store, so
 * "secret-free" is a property of the file rather than a habit of its callers.
 */
export function assertSecretFree(record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      throw new ManagerSecretError(`manager store refuses secret-shaped field "${key}"`);
    }
    if (typeof value !== "string") continue;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        throw new ManagerSecretError(
          `manager store refuses secret-shaped value in field "${key}"`,
        );
      }
    }
  }
}

/**
 * Serialize one effort as a single flat TOONL record.
 *
 * Exported because a checkpoint document (slice #2296) carries MANY efforts in
 * one file: the row shape is the unit both the per-effort document and the
 * checkpoint share, so the two can never drift into different field sets.
 */
export function encodeEffortRow(effort: EffortRecord): ToonlRecord {
  assertSecretFree(effort as unknown as Record<string, unknown>);
  const body: ToonlRecord = {
    kind: "manager.effort",
    effort_id: effort.effort_id,
    name: effort.name,
    intent: effort.intent,
    lifecycle: effort.lifecycle,
    generation: effort.generation,
    created_at: effort.created_at,
    updated_at: effort.updated_at,
  };
  if (effort.dispatch_issue !== undefined) body.dispatch_issue = effort.dispatch_issue;
  if (effort.route !== undefined) body.route = effort.route;
  // ToonlRecord is flat (no arrays), so encode the list as newline-separated.
  // URLs never contain newlines, so the delimiter is unambiguous.
  if (effort.artifact_refs !== undefined && effort.artifact_refs.length > 0) {
    body.artifact_refs = effort.artifact_refs.join("\n");
  }
  return body;
}

/** Serialize one effort as a TOONL document: schema header, then the effort. */
export function encodeEffortDocument(effort: EffortRecord): string {
  const header: ToonlRecord = {
    kind: "manager.effort.schema",
    schema: MANAGER_EFFORT_SCHEMA,
    version: MANAGER_EFFORT_SCHEMA_VERSION,
  };
  return encodeRecords([header, encodeEffortRow(effort)], {});
}

function requireString(row: ToonlRecord, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value === "") {
    throw new ManagerSchemaError(`manager effort document is missing "${field}"`);
  }
  return value;
}

function requireLifecycle(row: ToonlRecord): EffortLifecycle {
  const value = requireString(row, "lifecycle");
  const states: readonly string[] = ["inbox", "active", "paused", "completed", "abandoned"];
  if (!states.includes(value)) {
    throw new ManagerSchemaError(`manager effort document has unknown lifecycle "${value}"`);
  }
  return value as EffortLifecycle;
}

/**
 * Parse one flat effort record, refusing an unknown lifecycle, a non-integer
 * generation, or a missing field. Shared with the checkpoint decoder (slice
 * #2296), so an imported effort is validated exactly as a stored one is.
 */
export function decodeEffortRow(body: ToonlRecord): EffortRecord {
  const generation = body.generation;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new ManagerSchemaError("manager effort document has a non-integer generation");
  }
  const route = typeof body["route"] === "string" ? body["route"] : undefined;
  // artifact_refs is stored as a newline-separated string (ToonlRecord is flat).
  const rawRefs = body["artifact_refs"];
  const artifact_refs =
    typeof rawRefs === "string" && rawRefs.length > 0 ? rawRefs.split("\n") : undefined;

  const record: EffortRecord = {
    effort_id: requireString(body, "effort_id"),
    name: requireString(body, "name"),
    intent: requireString(body, "intent"),
    lifecycle: requireLifecycle(body),
    generation,
    created_at: requireString(body, "created_at"),
    updated_at: requireString(body, "updated_at"),
    ...(route !== undefined ? { route } : {}),
    ...(artifact_refs !== undefined ? { artifact_refs } : {}),
  };
  // dispatch_issue is optional — absent in efforts that predate slice #2295.
  const rawDispatch = body.dispatch_issue;
  if (typeof rawDispatch === "number" && Number.isInteger(rawDispatch) && rawDispatch > 0) {
    record.dispatch_issue = rawDispatch;
  }
  return record;
}

/**
 * Parse one effort document, refusing anything this bundle does not own: a
 * missing/foreign schema header, an unknown lifecycle, or a missing field. A
 * refusal is always louder than a silent partial read — a mis-read effort would
 * be overwritten by the next save.
 */
export function decodeEffortDocument(text: string): EffortRecord {
  let rows: ToonlRecord[];
  try {
    rows = parseRecords(text);
  } catch (error) {
    throw new ManagerSchemaError(
      `manager effort document is not readable TOONL: ${(error as Error).message}`,
    );
  }
  const header = rows.find((row) => row.kind === "manager.effort.schema");
  if (!header) throw new ManagerSchemaError("manager effort document has no schema header");
  if (header.schema !== MANAGER_EFFORT_SCHEMA) {
    throw new ManagerSchemaError(`manager effort document has foreign schema "${header.schema}"`);
  }
  if (header.version !== MANAGER_EFFORT_SCHEMA_VERSION) {
    throw new ManagerSchemaError(
      `manager effort document has schema version ${String(header.version)}, this bundle owns ${MANAGER_EFFORT_SCHEMA_VERSION}`,
    );
  }
  const body = rows.find((row) => row.kind === "manager.effort");
  if (!body) throw new ManagerSchemaError("manager effort document has no effort record");
  return decodeEffortRow(body);
}

/** Temp-write + rename, so a concurrent reader never observes a partial file. */
async function writeEffortAtomic(path: string, effort: EffortRecord): Promise<void> {
  const document = encodeEffortDocument(effort);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, document, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

export interface StartEffortOptions {
  /** The directory that CONTAINS `.red/manager` (see `resolveManagerRoot`). */
  root: string;
  /** The operator's raw intent. */
  intent: string;
  /** Injected clock, so tests pin timestamps. */
  now?: () => Date;
  /** Injected id minter, so tests pin identity. */
  mintId?: () => string;
}

/**
 * Mint an effort from an intent and persist it. The effort starts in `inbox` at
 * generation 1 — routing and dispatch are later slices; this slice proves the
 * effort survives the session.
 */
export async function startEffort(options: StartEffortOptions): Promise<EffortRecord> {
  const stamp = (options.now ?? (() => new Date()))().toISOString();
  const effort: EffortRecord = {
    effort_id: (options.mintId ?? mintEffortId)(),
    name: deriveEffortName(options.intent),
    intent: options.intent.trim(),
    lifecycle: "inbox",
    generation: 1,
    created_at: stamp,
    updated_at: stamp,
  };
  await writeEffortAtomic(managerEffortFile(options.root, effort.effort_id), effort);
  return effort;
}

/** Read one effort, or `null` when the portfolio has never seen that id. */
export async function readEffort(root: string, effortId: string): Promise<EffortRecord | null> {
  let text: string;
  try {
    text = await readFile(managerEffortFile(root, effortId), "utf8");
  } catch {
    return null;
  }
  return decodeEffortDocument(text);
}

/** Every stored effort id. Files that are not effort documents are ignored. */
export async function listEffortIds(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(managerEffortsDir(root));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(EFFORT_FILE_SUFFIX))
    .map((entry) => entry.slice(0, -EFFORT_FILE_SUFFIX.length))
    .filter(isEffortId);
}

/** Every stored effort, newest-created first. */
export async function listEfforts(root: string): Promise<EffortRecord[]> {
  const efforts: EffortRecord[] = [];
  for (const id of await listEffortIds(root)) {
    const effort = await readEffort(root, id);
    if (effort) efforts.push(effort);
  }
  return efforts.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The effort the operator most recently started — `status`'s default subject. */
export async function latestEffort(root: string): Promise<EffortRecord | null> {
  return (await listEfforts(root))[0] ?? null;
}

/**
 * Write an effort at an explicit generation, BYPASSING the compare-and-set
 * guard `saveEffort` enforces.
 *
 * Reserved for checkpoint import (slice #2296), which is a declared TAKEOVER
 * rather than a concurrent write: the operator is asserting that this host is
 * now the single active writer. The caller is responsible for choosing a
 * generation strictly greater than both the imported and the stored one, which
 * is what makes every other host's writer fail closed on its next save.
 */
export async function writeEffortTakeover(
  root: string,
  effort: EffortRecord,
): Promise<EffortRecord> {
  await writeEffortAtomic(managerEffortFile(root, effort.effort_id), effort);
  return effort;
}

export interface SaveEffortOptions {
  /** Injected clock, so tests pin `updated_at`. */
  now?: () => Date;
}

/**
 * Persist a mutated effort, bumping its generation.
 *
 * `effort.generation` is the generation the caller READ. When the stored file
 * already moved past it — another session, or a resurrected writer after a
 * crash — the save FAILS CLOSED: it refuses rather than overwriting the newer
 * transition, which is the whole point of the counter.
 */
export async function saveEffort(
  root: string,
  effort: EffortRecord,
  options: SaveEffortOptions = {},
): Promise<EffortRecord> {
  const stored = await readEffort(root, effort.effort_id);
  if (stored && stored.generation !== effort.generation) {
    throw new ManagerGenerationError(
      `effort ${effort.effort_id} moved to generation ${stored.generation}; writer holds ${effort.generation}`,
    );
  }
  const next: EffortRecord = {
    ...effort,
    generation: effort.generation + 1,
    updated_at: (options.now ?? (() => new Date()))().toISOString(),
  };
  await writeEffortAtomic(managerEffortFile(root, next.effort_id), next);
  return next;
}
