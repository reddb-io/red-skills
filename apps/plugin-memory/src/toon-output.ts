import {
  appendSummaryField,
  decode,
  encode,
  projectFields,
  type JsonObject,
  type JsonValue,
} from "@reddb-io/toon";

type JsonRecord = Record<string, JsonValue>;

export interface RenderToonDocumentOptions {
  compact?: boolean;
}

function compactString(value: string, key: string): string {
  const normalized = value.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
  return key === "markdown"
    ? normalized.replace(/[\[\]{}]/g, " ").replace(/\s+/g, " ").trim()
    : normalized;
}

function toJsonValue(value: unknown, opts: RenderToonDocumentOptions = {}, key = ""): JsonValue {
  if (value == null) return null;
  if (typeof value === "string") {
    return opts.compact ? compactString(value, key) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return Number.isNaN(value) ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => toJsonValue(child, opts, key));
  }
  if (typeof value === "object") {
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined && typeof child !== "function" && typeof child !== "symbol") {
        out[key] = toJsonValue(child, opts, key);
      }
    }
    return out;
  }
  return String(value);
}

export interface ToonOutputOptions<Row extends JsonRecord> {
  rowsKey: string;
  rows: readonly Row[];
  fields: readonly (keyof Row & string)[];
  summary: JsonValue;
  extra?: JsonRecord;
}

/**
 * Shared AXI/TOON renderer for agent-facing structured CLI output.
 *
 * Callers choose the row key, fields, and summary. The helper only enforces
 * the common TOON shape: projected tabular rows plus a trailing summary field.
 */
export function renderToonOutput<Row extends JsonRecord>({
  rowsKey,
  rows,
  fields,
  summary,
  extra = {},
}: ToonOutputOptions<Row>): string {
  const value = {
    [rowsKey]: projectFields(rows, fields),
    ...extra,
  } as JsonObject;
  return appendSummaryField(value, summary);
}

export function renderToonDocument(value: unknown, opts: RenderToonDocumentOptions = {}): string {
  const output = opts.compact
    ? encode({
        _reduction: {
          mode: "compact",
          reduced: "string whitespace collapsed; markdown bracket characters removed",
          recover: "rerun without --compact",
        },
        value: toJsonValue(value, opts),
      })
    : encode(toJsonValue(value, opts));
  decode(output);
  return output;
}
