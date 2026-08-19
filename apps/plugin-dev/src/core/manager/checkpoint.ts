// core/manager/checkpoint.ts — point-in-time portfolio export/import
// (Spec #2290, slice #2296; architecture in ADR 0109).
//
// A checkpoint is a HANDOVER, not a replica. Export writes the secret-free
// portfolio to one operator-controlled document; import establishes the
// destination host as THE single active writer. There is no live-sync peer and
// no merge: multi-host live synchronization is explicitly out of scope, so the
// only safe semantics for two hosts holding the same effort is that exactly one
// of them may write it.
//
// How "single active writer" is enforced, mechanically:
//   Import writes each effort at a generation strictly greater than both the
//   imported and any locally stored one, then stamps a lease held by the
//   destination host. The source host still holds the exported generation, so
//   its next `saveEffort` raises ManagerGenerationError — it fails closed
//   instead of silently overwriting the host that took over.
//
// What a checkpoint carries, and what it must never carry:
//   Carried  — effort identity, lifecycle, intent, route, artifact references,
//              generation, timestamps, and the export metadata.
//   Excluded — credentials (refused at the encoder), leases (a lease is the
//              SOURCE host's write cursor; exporting one would hand a stale
//              claim to the destination), raw conversations, source code,
//              diffs, worker logs, and execution evidence, all of which stay
//              with the owner artifacts that produced them.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { managerCheckpointFile } from "@reddb-io/shared/red-paths.js";
import { encodeRecords, parseRecords } from "@reddb-io/toon";

type ToonlRecord = Record<string, string | number | boolean | null>;
import {
  LEASE_DEFAULT_TTL_MS,
  writeLease,
  type EffortLease,
} from "./effort-lease.js";
import {
  ManagerSchemaError,
  decodeEffortRow,
  encodeEffortRow,
  listEfforts,
  readEffort,
  writeEffortTakeover,
  type EffortLifecycle,
  type EffortRecord,
} from "./effort-store.js";

export const MANAGER_CHECKPOINT_SCHEMA = "red.manager.checkpoint";
export const MANAGER_CHECKPOINT_SCHEMA_VERSION = 1;

/** What the checkpoint records about its own provenance. */
export interface CheckpointMeta {
  exported_at: string;
  /** The host the portfolio was exported FROM — provenance, never authority. */
  source_host: string;
  effort_count: number;
}

export interface Checkpoint {
  meta: CheckpointMeta;
  efforts: EffortRecord[];
}

/** Lifecycles that still have work ahead, and therefore still need a writer. */
const NON_TERMINAL: readonly EffortLifecycle[] = ["inbox", "active", "paused"];

/**
 * Serialize a checkpoint: schema header, metadata record, then one row per
 * effort. Each row goes through the shared effort encoder, so the secret refusal
 * that guards the store guards the checkpoint too — "secret-free" is a property
 * of the document, not a promise from its caller.
 */
export function encodeCheckpointDocument(checkpoint: Checkpoint): string {
  const header: ToonlRecord = {
    kind: "manager.checkpoint.schema",
    schema: MANAGER_CHECKPOINT_SCHEMA,
    version: MANAGER_CHECKPOINT_SCHEMA_VERSION,
  };
  const meta: ToonlRecord = {
    kind: "manager.checkpoint.meta",
    exported_at: checkpoint.meta.exported_at,
    source_host: checkpoint.meta.source_host,
    effort_count: checkpoint.meta.effort_count,
  };
  const rows = checkpoint.efforts.map((effort) => encodeEffortRow(effort));
  return encodeRecords([header, meta, ...rows], {});
}

function requireString(row: ToonlRecord, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value === "") {
    throw new ManagerSchemaError(`manager checkpoint document is missing "${field}"`);
  }
  return value;
}

/**
 * Parse a checkpoint, refusing anything this bundle does not own. A refusal is
 * the correct outcome for a foreign or future document: importing half of an
 * unreadable checkpoint would take over efforts while dropping others.
 */
export function decodeCheckpointDocument(text: string): Checkpoint {
  let rows: ToonlRecord[];
  try {
    rows = parseRecords(text);
  } catch (error) {
    throw new ManagerSchemaError(
      `manager checkpoint document is not readable TOONL: ${(error as Error).message}`,
    );
  }
  const header = rows.find((row) => row.kind === "manager.checkpoint.schema");
  if (!header) throw new ManagerSchemaError("manager checkpoint document has no schema header");
  if (header.schema !== MANAGER_CHECKPOINT_SCHEMA) {
    throw new ManagerSchemaError(
      `manager checkpoint document has foreign schema "${String(header.schema)}"`,
    );
  }
  if (header.version !== MANAGER_CHECKPOINT_SCHEMA_VERSION) {
    throw new ManagerSchemaError(
      `manager checkpoint document has schema version ${String(header.version)}, this bundle owns ${MANAGER_CHECKPOINT_SCHEMA_VERSION}`,
    );
  }
  const metaRow = rows.find((row) => row.kind === "manager.checkpoint.meta");
  if (!metaRow) throw new ManagerSchemaError("manager checkpoint document has no metadata record");
  const effortCount = metaRow.effort_count;
  if (typeof effortCount !== "number" || !Number.isInteger(effortCount) || effortCount < 0) {
    throw new ManagerSchemaError("manager checkpoint document has a non-integer effort_count");
  }
  const efforts = rows.filter((row) => row.kind === "manager.effort").map(decodeEffortRow);
  if (efforts.length !== effortCount) {
    throw new ManagerSchemaError(
      `manager checkpoint document declares ${effortCount} efforts but carries ${efforts.length}`,
    );
  }
  return {
    meta: {
      exported_at: requireString(metaRow, "exported_at"),
      source_host: requireString(metaRow, "source_host"),
      effort_count: effortCount,
    },
    efforts,
  };
}

export interface ExportCheckpointOptions {
  now?: () => Date;
  host?: string;
}

/**
 * Read the whole portfolio and render it as a checkpoint document. Nothing is
 * mutated: an export is a read, so taking one never disturbs the writer that
 * currently holds an effort.
 */
export async function exportCheckpoint(
  root: string,
  options: ExportCheckpointOptions = {},
): Promise<{ document: string; checkpoint: Checkpoint }> {
  const exportedAt = (options.now ?? (() => new Date()))().toISOString();
  const efforts = await listEfforts(root);
  const checkpoint: Checkpoint = {
    meta: {
      exported_at: exportedAt,
      source_host: options.host ?? hostname(),
      effort_count: efforts.length,
    },
    efforts,
  };
  return { document: encodeCheckpointDocument(checkpoint), checkpoint };
}

/** A filename-safe instant: `20260721T000000Z`, so a listing sorts by time. */
export function checkpointStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Export the portfolio and write it into the checkpoint lane, returning the
 * path the operator can carry to the destination host.
 */
export async function writeCheckpointFile(
  root: string,
  options: ExportCheckpointOptions & { path?: string } = {},
): Promise<{ path: string; checkpoint: Checkpoint }> {
  const at = (options.now ?? (() => new Date()))();
  const { document, checkpoint } = await exportCheckpoint(root, {
    now: () => at,
    ...(options.host !== undefined ? { host: options.host } : {}),
  });
  const path = options.path ?? managerCheckpointFile(root, checkpointStamp(at));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, document, "utf8");
  return { path, checkpoint };
}

export interface ImportCheckpointOptions {
  now?: () => Date;
  /** The host that becomes the single active writer; defaults to this host. */
  host?: string;
  ttlMs?: number;
}

export interface ImportCheckpointResult {
  /** Every effort as it now stands locally, at its post-takeover generation. */
  imported: EffortRecord[];
  /** The host that now holds the write cursor for the imported efforts. */
  host: string;
  meta: CheckpointMeta;
}

/**
 * Import a checkpoint, making this host the single active writer for every
 * effort it carries.
 *
 * The generation is `max(imported, stored) + 1` — strictly ahead of BOTH, so
 * the takeover is unambiguous whether the destination has never seen the effort
 * or is re-adopting one it previously exported. Non-terminal efforts also
 * receive a lease held by the destination host; terminal ones do not, because a
 * completed or abandoned effort needs no writer.
 */
export async function importCheckpoint(
  root: string,
  text: string,
  options: ImportCheckpointOptions = {},
): Promise<ImportCheckpointResult> {
  const checkpoint = decodeCheckpointDocument(text);
  const now = (options.now ?? (() => new Date()))();
  const host = options.host ?? hostname();
  const ttlMs = options.ttlMs ?? LEASE_DEFAULT_TTL_MS;

  const imported: EffortRecord[] = [];
  for (const effort of checkpoint.efforts) {
    const stored = await readEffort(root, effort.effort_id);
    const generation = Math.max(effort.generation, stored?.generation ?? 0) + 1;
    const adopted = await writeEffortTakeover(root, {
      ...effort,
      generation,
      updated_at: now.toISOString(),
    });
    if (NON_TERMINAL.includes(adopted.lifecycle)) {
      const lease: EffortLease = {
        effort_id: adopted.effort_id,
        host,
        generation: adopted.generation,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      };
      await writeLease(root, lease);
    }
    imported.push(adopted);
  }
  return { imported, host, meta: checkpoint.meta };
}

/** Read a checkpoint file and import it. */
export async function importCheckpointFile(
  root: string,
  path: string,
  options: ImportCheckpointOptions = {},
): Promise<ImportCheckpointResult> {
  const text = await readFile(path, "utf8");
  return importCheckpoint(root, text, options);
}
