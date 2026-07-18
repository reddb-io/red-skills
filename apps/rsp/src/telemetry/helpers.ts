export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function numeric(value: unknown): number {
  return optionalNumeric(value) ?? 0;
}

export function optionalNumeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
