/**
 * json.ts — narrow readers for the ONE place JSON is legitimate: GitHub's wire
 * format.
 *
 * These helpers exist so decoding an external payload never widens into "we
 * store JSON". They coerce at the boundary and hand the rest of the module
 * plain values; nothing here writes state or crosses a process boundary.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : "";
}

export function numberField(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  return typeof value === "number" ? value : 0;
}

/** Parse a GitHub JSON object, throwing when the payload is not an object. */
export function parseRecord(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("expected JSON object");
  return parsed;
}

export function optionAfter(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}
