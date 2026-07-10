import {
  appendSummaryField,
  projectFields,
  type JsonObject,
  type JsonValue,
} from "@reddb-io/toon";

type JsonRecord = Record<string, JsonValue>;

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
