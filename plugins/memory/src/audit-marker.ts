/**
 * The **audit-marker contract** — proof that `memory ingest` ran against a
 * specific commit SHA. Two recognised forms satisfy it (either is sufficient):
 *
 *  - **Commit trailer** in a commit message:
 *      `Memory-Ingested: <ingest-sha>`   — the tree at <ingest-sha> was ingested
 *      `Memory-NoIngest: <reason>`       — explicit bypass (typos, formatting-only)
 *  - **Audit-log entry** of the shape `<iso8601> ingest <path> <ingest-sha>`.
 *
 * This module is the pure parser/serialiser for that contract. It performs no
 * I/O — the CLI and the future CI drift guard (#224) own where markers live.
 *
 * RedSkills ships the **commit-trailer** form as the written surface (see
 * `.red/agents/memory.md`); `memory ingest` emits {@link ingestGuidance} rather
 * than writing an on-disk log. The audit-log form is still recognised here so a
 * project that chooses to maintain one is supported by the same parser.
 */

/** A parsed, contract-valid audit marker. */
export type AuditMarker =
  | { form: "commit-trailer"; kind: "ingested"; sha: string }
  | { form: "commit-trailer"; kind: "noingest"; reason: string }
  | { form: "audit-log"; at: string; path: string; sha: string };

export const INGEST_TRAILER_KEY = "Memory-Ingested";
export const NOINGEST_TRAILER_KEY = "Memory-NoIngest";
const AUDIT_LOG_ACTION = "ingest";

/** Git object names: short (7) through full (40) lowercase hex. */
const SHA_RE = /^[0-9a-f]{7,40}$/;
/** ISO-8601 instant with `Z` or numeric offset; fractional seconds optional. */
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function assertSha(value: string, context: string): string {
  if (!SHA_RE.test(value)) {
    throw new Error(
      `audit marker: ${context} — expected a 7–40 char lowercase hex SHA, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertIso8601(value: string): string {
  if (!ISO8601_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `audit marker: malformed timestamp — expected an ISO-8601 instant, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Parse a single line into an {@link AuditMarker}. Recognises both contract
 * forms; throws an `Error` with a clear, actionable message on anything
 * malformed. Surrounding whitespace is tolerated.
 */
export function parseAuditMarker(input: string): AuditMarker {
  const line = input.trim();
  if (line === "") {
    throw new Error("audit marker: empty input is not a recognised marker");
  }

  if (line.startsWith(`${INGEST_TRAILER_KEY}:`)) {
    const sha = line.slice(INGEST_TRAILER_KEY.length + 1).trim();
    return {
      form: "commit-trailer",
      kind: "ingested",
      sha: assertSha(sha, `malformed ${INGEST_TRAILER_KEY} trailer`),
    };
  }

  if (line.startsWith(`${NOINGEST_TRAILER_KEY}:`)) {
    const reason = line.slice(NOINGEST_TRAILER_KEY.length + 1).trim();
    if (reason === "") {
      throw new Error(
        `audit marker: ${NOINGEST_TRAILER_KEY} trailer requires a non-empty reason`,
      );
    }
    return { form: "commit-trailer", kind: "noingest", reason };
  }

  // Audit-log entry: exactly `<iso8601> ingest <path> <ingest-sha>`.
  const fields = line.split(/\s+/);
  if (fields.length === 4 && fields[1] === AUDIT_LOG_ACTION) {
    const [at, , path, sha] = fields;
    return {
      form: "audit-log",
      at: assertIso8601(at),
      path,
      sha: assertSha(sha, "malformed audit-log SHA"),
    };
  }
  if (fields.length === 4 && /^\d{4}-/.test(fields[0])) {
    throw new Error(
      `audit marker: audit-log entry must use the "${AUDIT_LOG_ACTION}" action, got ${JSON.stringify(fields[1])}`,
    );
  }

  throw new Error(
    `audit marker: unrecognised — expected "${INGEST_TRAILER_KEY}: <sha>", ` +
      `"${NOINGEST_TRAILER_KEY}: <reason>", or "<iso8601> ${AUDIT_LOG_ACTION} <path> <sha>", ` +
      `got ${JSON.stringify(input)}`,
  );
}

/** Serialise a `Memory-Ingested: <sha>` trailer. Validates the SHA at the source. */
export function formatIngestTrailer(sha: string): string {
  return `${INGEST_TRAILER_KEY}: ${assertSha(sha, `invalid SHA for ${INGEST_TRAILER_KEY} trailer`)}`;
}

/** Serialise a `Memory-NoIngest: <reason>` bypass trailer. */
export function formatNoIngestTrailer(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") {
    throw new Error(`audit marker: ${NOINGEST_TRAILER_KEY} trailer requires a non-empty reason`);
  }
  return `${NOINGEST_TRAILER_KEY}: ${trimmed}`;
}

/** Serialise an `<iso8601> ingest <path> <sha>` audit-log entry. */
export function formatAuditLogEntry(at: string, path: string, sha: string): string {
  return [
    assertIso8601(at),
    AUDIT_LOG_ACTION,
    path,
    assertSha(sha, "invalid SHA for audit-log entry"),
  ].join(" ");
}

/**
 * Human-facing guidance printed by `memory ingest`: how to record the audit
 * marker for the commit that lands this ingest. When the current HEAD SHA is
 * known it is substituted into a ready-to-paste trailer; otherwise a
 * `<ingest-sha>` placeholder is shown.
 */
export function ingestGuidance(headSha: string | null): string {
  const sha = headSha && SHA_RE.test(headSha) ? headSha : "<ingest-sha>";
  const trailer =
    sha === "<ingest-sha>" ? `${INGEST_TRAILER_KEY}: <ingest-sha>` : formatIngestTrailer(sha);
  return [
    "  audit marker — add a trailer to the commit that lands this ingest:",
    `      ${trailer}`,
    `  or, to bypass (formatting-only / typo edits): ${NOINGEST_TRAILER_KEY}: <reason>`,
  ].join("\n");
}
