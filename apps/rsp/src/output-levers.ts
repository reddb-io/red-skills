import type { JsonObject, JsonValue } from "@reddb-io/toon";

export interface QueryParseResult {
  argv: string[];
  query?: string;
}

export function extractQueryArg(argv: readonly string[]): QueryParseResult {
  const out: string[] = [];
  let query: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--query") {
      query = argv[++i];
      continue;
    }
    if (arg.startsWith("--query=")) {
      query = arg.slice("--query=".length);
      continue;
    }
    out.push(arg);
  }
  return { argv: out, query: query?.trim() || undefined };
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
  const clean = help.filter(Boolean);
  if (clean.length === 0) return payload;
  return { ...payload, help: clean as JsonValue };
}

function queryText(value: unknown): string {
  if (Array.isArray(value)) return value.map(queryText).join(" ");
  if (typeof value === "object" && value !== null) return Object.values(value).map(queryText).join(" ");
  return String(value ?? "");
}
