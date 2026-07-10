import { encode } from "@toon-format/toon";
import type { EncodeOptions, JsonObject, JsonValue } from "@toon-format/toon";

export {
  DEFAULT_DELIMITER,
  DELIMITERS,
  ToonDecodeError,
  decode,
  decodeFromLines,
  decodeStream,
  decodeStreamSync,
  encode,
  encodeLines,
} from "@toon-format/toon";
export type {
  DecodeOptions,
  DecodeStreamOptions,
  Delimiter,
  DelimiterKey,
  EncodeOptions,
  EncodeReplacer,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonStreamEvent,
  JsonValue,
  ResolvedDecodeOptions,
  ResolvedEncodeOptions,
} from "@toon-format/toon";

type JsonRecord = Record<string, JsonValue>;

function entriesWithoutSummary(value: JsonObject): [string, JsonValue][] {
  return Object.entries(value).filter(([key]) => key !== "summary") as [string, JsonValue][];
}

/**
 * Encodes an object with a trailing spec-legal `summary:` field.
 *
 * This retires the old bare summary-line dialect: the returned bytes are one
 * conforming TOON document, so `decode(output)` parses the rollup with the rest
 * of the payload.
 */
export function appendSummaryField(value: JsonObject, summary: JsonValue, options?: EncodeOptions): string {
  return encode(Object.fromEntries([...entriesWithoutSummary(value), ["summary", summary]]) as JsonRecord, options);
}

/**
 * Projects object rows onto an explicit minimal schema, preserving allowlist
 * order and dropping all non-allowlisted fields.
 */
export function projectFields<T extends Readonly<Record<string, JsonValue>>, const Field extends readonly string[]>(
  rows: readonly T[],
  fields: Field,
): Array<Partial<Record<Field[number], JsonValue>>> {
  return rows.map((row) => {
    const projected: Partial<Record<Field[number], JsonValue>> = {};
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        projected[field as Field[number]] = row[field] as JsonValue;
      }
    }
    return projected;
  });
}
