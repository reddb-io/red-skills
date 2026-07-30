import type { JsonObject, JsonValue } from "@reddb-io/toon";
import { extractFlags, type FlagSchema } from "@reddb-io/shared/args.js";

export interface QueryParseResult {
  argv: string[];
  query?: string;
}

/**
 * rsp's own levers, as they reach a wrapper: the rendering filter and the
 * "keep everything" escape hatch. Both are peeled back off before the argv is
 * handed to the wrapped tool, which has never heard of either.
 */
const LEVER_FLAGS = {
  query: { kind: "value", coerce: (raw: string) => raw },
  full: { kind: "boolean" },
} as const satisfies FlagSchema;

/**
 * A bare `--` here belongs to the wrapped tool (`git diff -- <path>`), not to
 * rsp, and rsp appends its own `--query` after it — so this scan deliberately
 * runs past the separator rather than stopping at it.
 */
const LEVER_SCAN = { stopAtSeparator: false } as const;

export function extractQueryArg(argv: readonly string[]): QueryParseResult {
  const { values, rest } = extractFlags(argv, { query: LEVER_FLAGS.query }, LEVER_SCAN);
  return { argv: rest, query: values.query?.trim() || undefined };
}

/** `extractQueryArg` plus `--full`, for the wrappers that honour both. */
export function extractLeverArgs(argv: readonly string[]): QueryParseResult & { full: boolean } {
  const { values, rest } = extractFlags(argv, LEVER_FLAGS, LEVER_SCAN);
  return { argv: rest, query: values.query?.trim() || undefined, full: values.full === true };
}

export function matchesQuery(value: unknown, query?: string): boolean {
  if (!query) return true;
  const haystack = queryText(value).toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((part) => haystack.includes(part));
}

export function filterRows<T>(rows: readonly T[], query?: string): T[] {
  if (!query) return [...rows];
  return rows.filter((row) => matchesQuery(row, query));
}

export function filterTextLines(text: string, query?: string): string {
  if (!query) return text;
  const lines = text.split("\n");
  const kept = lines.filter((line) => line && matchesQuery(line, query));
  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

export function withHelp(payload: JsonObject, help: readonly string[]): JsonObject {
  return withNextSteps(payload, help, { includeLegacyHelp: true });
}

export function withNextSteps(
  payload: JsonObject,
  nextSteps: readonly string[],
  options: { includeLegacyHelp?: boolean } = {},
): JsonObject {
  const clean = nextSteps.filter(Boolean);
  if (clean.length === 0) return payload;
  return {
    ...payload,
    ...(options.includeLegacyHelp ? { help: clean as JsonValue } : {}),
    next_steps: clean as JsonValue,
  };
}

function queryText(value: unknown): string {
  if (Array.isArray(value)) return value.map(queryText).join(" ");
  if (typeof value === "object" && value !== null) return Object.values(value).map(queryText).join(" ");
  return String(value ?? "");
}
