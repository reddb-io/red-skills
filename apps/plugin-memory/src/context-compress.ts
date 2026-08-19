import type { NodeType } from "./schema.js";

/**
 * Reversible, content-type-aware compression of recalled-node content for the
 * context-pack (issue #827). Instead of slicing content to a fixed width and
 * dropping whole entries once the budget fills, every entry is compressed by
 * its content type — code keeps signatures/imports/types, structured content
 * gets a field-level summary, prose gets a leading summary — so more governed
 * facts fit the same budget. Each compressed entry pairs with an expand handle
 * (`memory:recall <rid>`) so the full node stays one recall away; nothing is
 * lost, only deferred.
 */

export type CompressedContentKind = "code" | "structured" | "prose";

export interface CompressedContent {
  /** The compressed, single-line excerpt to render in the pack. */
  text: string;
  /** Which content-type strategy produced `text`. */
  kind: CompressedContentKind;
  /** True when compression dropped content — the expand handle then matters. */
  lossy: boolean;
}

export interface CompressHints {
  nodeType: NodeType;
  language?: string | null;
}

/** Hard cap on a compressed excerpt; compression should land well under it. */
const MAX_COMPRESSED_CHARS = 400;

/** Node types whose content is code regardless of how it reads. */
const CODE_NODE_TYPES = new Set<NodeType>(["file", "import", "symbol"]);

/** Lines worth keeping when compressing code: imports, exports, signatures, types. */
const CODE_KEEP_LINE =
  /^\s*(?:@|import\b|export\b|from\b|public\b|private\b|protected\b|static\b|abstract\b|async\b|function\b|class\b|interface\b|type\b|enum\b|namespace\b|module\b|const\b|let\b|var\b|def\b|fn\b|struct\b|trait\b|impl\b)/;

/** Strong signals that free-form content is actually code. */
const CODE_SIGNAL =
  /(^|\n)\s*(?:import |export |from |function |async function |class |interface |type \w+\s*=|enum |def |fn |public |private )|=>/;

const FIELD_LINE = /^\s*["']?([\w.$-]+)["']?\s*[:=]\s*\S/;

/**
 * Compress `raw` by its content type. Pure and deterministic. Never throws on
 * malformed input — it degrades to the prose path — but callers should still
 * wrap it so any future strategy that throws falls back to the original entry.
 */
export function compressContent(raw: string, hints: CompressHints): CompressedContent {
  const content = typeof raw === "string" ? raw : "";
  const kind = classifyContent(content, hints);
  let text: string;
  switch (kind) {
    case "code":
      text = compressCode(content);
      break;
    case "structured":
      text = compressStructured(content);
      break;
    default:
      text = compressProse(content);
      break;
  }
  text = text.slice(0, MAX_COMPRESSED_CHARS).trim();
  const fullLength = collapse(content).length;
  if (text.length === 0) {
    text = collapse(content).slice(0, MAX_COMPRESSED_CHARS);
  }
  return { text, kind, lossy: text.length < fullLength };
}

function classifyContent(content: string, hints: CompressHints): CompressedContentKind {
  if (hints.language || CODE_NODE_TYPES.has(hints.nodeType) || looksLikeCode(content)) {
    return "code";
  }
  if (looksStructured(content)) return "structured";
  return "prose";
}

function looksLikeCode(content: string): boolean {
  return CODE_SIGNAL.test(content);
}

function looksStructured(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return true;
    } catch {
      // fall through to the line-shape heuristic
    }
  }
  const lines = nonEmptyLines(content);
  if (lines.length < 2) return false;
  const fieldLines = lines.filter((line) => FIELD_LINE.test(line)).length;
  return fieldLines >= 2 && fieldLines / lines.length >= 0.6;
}

function compressCode(content: string): string {
  const kept = nonEmptyLines(content)
    .map((line) => line.trim())
    .filter((line) => CODE_KEEP_LINE.test(line))
    .map(signatureOnly);
  if (kept.length === 0) return collapse(content);
  return dedupe(kept).join("; ");
}

/**
 * Trim a declaration to its signature: collapse a trailing block-body opener
 * (`… {`) to `{ … }`. Mid-line braces — e.g. an `import { x } from …` clause —
 * are load-bearing and kept verbatim.
 */
function signatureOnly(line: string): string {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (/\{\s*$/.test(normalized)) {
    return normalized.replace(/\s*\{\s*$/, " { … }");
  }
  return normalized;
}

function compressStructured(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length > 0) {
          return `{ ${keys.map((key) => `${key}: ${valueType(parsed[key])}`).join(", ")} }`;
        }
      }
      if (Array.isArray(parsed)) {
        return `[${parsed.length} item(s) of ${valueType(parsed[0])}]`;
      }
    } catch {
      // fall through
    }
  }
  const fields: string[] = [];
  for (const line of nonEmptyLines(content)) {
    const match = FIELD_LINE.exec(line);
    if (match) fields.push(match[1]);
  }
  if (fields.length === 0) return collapse(content);
  return `fields: ${dedupe(fields).join(", ")} (${fields.length} total)`;
}

function compressProse(content: string): string {
  const collapsed = collapse(content);
  if (collapsed.length <= MAX_COMPRESSED_CHARS) return collapsed;
  const sentences = collapsed.split(/(?<=[.!?])\s+/);
  let summary = "";
  for (const sentence of sentences) {
    if (summary.length > 0 && summary.length + sentence.length > MAX_COMPRESSED_CHARS) break;
    summary = summary.length > 0 ? `${summary} ${sentence}` : sentence;
    if (summary.length >= MAX_COMPRESSED_CHARS) break;
  }
  return summary.length > 0 ? summary : collapsed.slice(0, MAX_COMPRESSED_CHARS);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function nonEmptyLines(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
