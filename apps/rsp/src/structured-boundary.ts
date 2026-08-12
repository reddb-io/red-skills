import { isUtf8 } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { decode, encode, parseRecords, type JsonValue } from "@reddb-io/toon";
import { parseAllDocuments } from "yaml";

export interface StructuredBoundaryDependencies {
  readonly encode?: (value: JsonValue) => string;
  readonly decode?: (input: string) => unknown;
}

export interface CompletedOutputContract {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

export function renderStructuredContract<T extends CompletedOutputContract>(
  contract: T,
  dependencies: StructuredBoundaryDependencies = {},
): T {
  const stdout = renderStructuredBoundary(contract.stdout, dependencies);
  return stdout === contract.stdout ? contract : { ...contract, stdout };
}

/**
 * Render completed agent-facing stdout as canonical TOON when its decoded data
 * model survives an immediate encode/decode proof. Every uncertain or failed
 * path returns the original Buffer unchanged.
 */
export function renderStructuredBoundary(
  stdout: Buffer,
  dependencies: StructuredBoundaryDependencies = {},
): Buffer {
  if (stdout.length === 0 || !isUtf8(stdout)) return stdout;
  const text = stdout.toString("utf8");
  const trimmed = text.trim();
  if (trimmed === "") return stdout;

  const candidate = decodeStructuredText(trimmed, dependencies.decode ?? decode);
  if (!candidate) return stdout;
  const { value } = candidate;

  try {
    const rendered = (dependencies.encode ?? encode)(value as JsonValue);
    const proven = (dependencies.decode ?? decode)(rendered);
    if (!isDeepStrictEqual(value, proven)) return stdout;
    if (candidate.source === "toon" && trimmed !== rendered) return stdout;
    return trimmed === rendered ? stdout : Buffer.from(rendered);
  } catch {
    return stdout;
  }
}

type StructuredSource = "json" | "yaml" | "toon" | "toonl";

function decodeStructuredText(
  text: string,
  decodeToon: (input: string) => unknown,
): { value: unknown; source: StructuredSource } | undefined {
  try {
    return { value: JSON.parse(text), source: "json" };
  } catch {
    // Continue to the next structured syntax.
  }
  if ((text.startsWith("{") && !text.endsWith("}")) || (/^["']/.test(text) && text.at(-1) !== text[0])) return undefined;
  if (/^\s*\[(?:~|\t|\|)?\]\{[^}]+\}:/.test(text)) {
    try {
      return { value: parseRecords(text), source: "toonl" };
    } catch {
      return undefined;
    }
  }
  const yamlFlowOrQuoted = (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]")) ||
    (/^["']/.test(text) && text.at(-1) === text[0]);
  const structuredSyntax = /(?:^|\n)\s*(?:[^\s:#][^\n:]*:|\[(?:\d+)?\](?:\{[^}]+\})?:)/.test(text);
  if (structuredSyntax && !yamlFlowOrQuoted) {
    try {
      return { value: decodeToon(text), source: "toon" };
    } catch {
      // A YAML mapping can share TOON's leading shape but use YAML-only nesting.
    }
  }
  if (text.startsWith("---") || structuredSyntax || yamlFlowOrQuoted || /(?:^|\n)\s*-\s+\S/.test(text)) {
    try {
      const documents = parseAllDocuments(text, { prettyErrors: false, strict: true, uniqueKeys: true });
      if (documents.length !== 1 || documents[0]!.errors.length > 0 || documents[0]!.warnings.length > 0) return undefined;
      return { value: documents[0]!.toJS({ maxAliasCount: 100 }), source: "yaml" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
