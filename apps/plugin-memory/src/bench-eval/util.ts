export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function ratio(candidate: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return round4(candidate / baseline);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
