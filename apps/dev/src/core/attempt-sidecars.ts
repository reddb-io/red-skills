import { encodeLines, parseRecords, type JsonValue } from "@reddb-io/toon";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "./toon-snapshot.js";

/**
 * attempt-sidecars — the ONE owner of the per-attempt sidecar file formats.
 *
 * Four sidecars predate the TOON adoption program (ADR 0097) and wrote legacy
 * formats: `validation.jsonl` (JSONL), `identity.json` (JSON), `failure.reason`
 * (bare text) and `afk.log` (plain-text narrative). ADR 0097 Decision 1 puts
 * every structured on-disk surface on TOON/TOONL, and all four are read by
 * agents during diagnosis — so all four migrate. `handoff.md` stays markdown:
 * it is prompt prose, the ADR's standing exception.
 *
 * The migration is expand-contract, exactly like the wave-1 lanes: the writer
 * emits ONLY the new file, and every reader sniffs — new format first, legacy
 * second — so attempt dirs written by an older bundle still parse for boot
 * sweeps, `/retake` reports and the restart-context ledger.
 */

/** Canonical (TOON/TOONL) sidecar filenames inside an attempt dir. */
export const ATTEMPT_SIDECAR_FILES = {
  validation: "validation.toonl",
  identity: "identity.toon",
  failure: "failure.toon",
  log: "afk.log.toonl",
} as const;

/** Pre-migration filenames, still accepted by every reader. */
export const LEGACY_ATTEMPT_SIDECAR_FILES = {
  validation: "validation.jsonl",
  identity: "identity.json",
  failure: "failure.reason",
  log: "afk.log",
} as const;

export type AttemptSidecarKind = keyof typeof ATTEMPT_SIDECAR_FILES;

/** The schema id stamped on the `failure.toon` snapshot. */
export const FAILURE_SCHEMA = "red.afk.failure.v1" as const;

/** A TOONL header line, e.g. `[]{at,kind,msg}:` or `[3]{schema,name,status}:`. */
const TOONL_HEADER_RE = /^\[\d*\]\{[^}]*\}:\s*$/;

/** True when a document's first non-empty line is a TOONL segment header. */
export function looksLikeToonl(text: string): boolean {
  const first = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first !== undefined && TOONL_HEADER_RE.test(first.trim());
}

// ---------- validation.toonl ----------

/**
 * Encode the validation sidecar. Records are heterogeneous (`command`,
 * `exitCode`, `durationMs` and `summary` are present only for checks that ran),
 * so each record gets its own segment header — the same rotation the castle-root
 * `validation.toonl` twin uses. Empty input yields an empty document.
 *
 * `lines` is the in-memory JSONL carrier the feedback/backpressure modules
 * already build (it also feeds the envelope text and the Memory attempt record,
 * both out of scope here); the FILE is TOONL. Unparseable carrier lines are
 * dropped rather than corrupting the document.
 */
export function encodeValidationSidecar(lines: readonly string[]): string {
  let out = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    out += encodeLines().push(toToonlRow(record as Record<string, unknown>));
  }
  return out;
}

/**
 * Read the validation sidecar in either format: TOONL when the document opens
 * with a segment header, legacy JSONL otherwise. Broken rows are skipped so a
 * half-written sidecar degrades to the records that do parse.
 */
export function parseValidationSidecar(text: string): Array<Record<string, unknown>> {
  if (text.trim().length === 0) return [];
  if (looksLikeToonl(text)) {
    try {
      return parseRecords(text) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (record !== null && typeof record === "object" && !Array.isArray(record)) {
        out.push(record as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return out;
}

// ---------- failure.toon ----------

/**
 * Encode the terminal failure marker as a TOON snapshot. The legacy file was a
 * bare reason string with its own trailing newline; the reason is carried
 * verbatim in the `reason` field (the encoder's quoting is the only cell
 * safety — never pre-encode mutation, ADR 0097 Decision 8).
 */
export function encodeFailureReason(reason: string): string {
  return encodeDevSnapshotToon({ schema: FAILURE_SCHEMA, reason } as unknown as JsonValue);
}

/**
 * Read the failure marker in either format: the TOON snapshot's `reason` field,
 * or — for a pre-migration `failure.reason` — the raw text verbatim. Returns
 * null when the text carries no reason.
 */
export function parseFailureReason(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    const decoded = decodeDevSnapshotSniff(text);
    if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
      const record = decoded as Record<string, unknown>;
      // Only a schema-stamped snapshot is the migrated form; anything else is
      // legacy free text that merely happened to parse, and stays verbatim.
      if (record.schema === FAILURE_SCHEMA) {
        return typeof record.reason === "string" && record.reason.length > 0 ? record.reason : null;
      }
    }
  } catch {
    // Not a TOON/JSON document — fall through to the legacy bare-text read.
  }
  return text.length > 0 ? text : null;
}

// ---------- afk.log.toonl ----------

/** One narrative record in the attempt log lane. */
export interface AttemptLogRecord {
  /** ISO timestamp of the append. */
  at: string;
  /** Namespaced-ish producer tag (`log`, `heartbeat`, `agent`, `run-started`). */
  kind: string;
  /** The narrative line, verbatim. */
  msg: string;
}

/** The attempt log's ONE segment header. Every row carries all three fields, so
 * the header is written once at file creation and never rotates — one physical
 * line per narrative line, which a rotating header would have doubled. */
export const ATTEMPT_LOG_HEADER = "[]{at,kind,msg}:";

const ATTEMPT_LOG_FIELDS = ["at", "kind", "msg"] as const;

/** Encode one attempt-log row (no header, newline-terminated). */
export function encodeAttemptLogRow(record: AttemptLogRecord): string {
  const chunk = encodeLines().push({ at: record.at, kind: record.kind, msg: record.msg });
  return chunk.slice(chunk.indexOf("\n") + 1);
}

/**
 * The exact bytes to append for one narrative line. `hasHeader` is false only
 * for the first append into a fresh attempt-log file, which prepends the single
 * segment header.
 */
export function encodeAttemptLogAppend(record: AttemptLogRecord, hasHeader: boolean): string {
  return (hasHeader ? "" : `${ATTEMPT_LOG_HEADER}\n`) + encodeAttemptLogRow(record);
}

/**
 * Read the attempt log in either format. A TOONL document yields one record per
 * row; a pre-migration plain-text `afk.log` yields one record per line with an
 * empty `at`/`kind`, so tails and monitors render identically across the
 * transition.
 */
export function parseAttemptLog(text: string): AttemptLogRecord[] {
  if (text.length === 0) return [];
  if (looksLikeToonl(text)) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = parseRecords(text) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
    return rows.map((row) => ({
      at: typeof row.at === "string" ? row.at : "",
      kind: typeof row.kind === "string" ? row.kind : "",
      msg: typeof row.msg === "string" ? row.msg : String(row.msg ?? ""),
    }));
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => ({ at: "", kind: "", msg: line }));
}

/** Render parsed attempt-log records back to the plain narrative every log-tail
 * consumer (envelope tails, reap notes, monitors) already expects. */
export function renderAttemptLogLines(records: readonly AttemptLogRecord[]): string {
  return records.map((record) => record.msg).join("\n");
}

// ---------- shared ----------

/** Flatten a record into TOONL-safe scalar cells (objects are JSON-stringified,
 * `undefined` fields dropped) — the same normalisation the castle lane writers
 * apply before `encodeLines().push`. */
function toToonlRow(record: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const row: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    row[key] =
      value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }
  return row;
}

export { ATTEMPT_LOG_FIELDS };
