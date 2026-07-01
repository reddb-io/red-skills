// TOON (Token-Oriented Object Notation) encoder -- the default agent-facing wire
// format for the dev plugin's read surfaces (monitor, dashboard, daily-review).
// PRD #928 / ADR 0081 adopt TOON up front: monitor/dashboard/daily-review/
// statusline are token-cheap *by design*, not just after RTK compresses verbose
// JSON/prose after the fact.
//
// TOON encodes a uniform array of flat objects as ONE header row plus bare CSV
// data rows -- `key[N]{f1,f2,...}:` followed by `v1,v2,...` lines -- instead of
// repeating every field name on every element the way `JSON.stringify` does.
// Scalars and nested objects fall back to indentation-based `key: value` lines.
// The win scales with row count and field-name length, exactly the shape the
// worker/cycle-time/challenge tables in those reports take.
//
// This encoder is PURE and deterministic: same value in -> same string out, no
// clock, no environment. It is a *minimal* serializer -- it covers scalars,
// nested objects, primitive arrays, and uniform-flat object arrays (the tabular
// fast path), with a list fallback for the rare non-uniform array. It is not a
// general TOON implementation and intentionally has no decoder.

/** A JSON-shaped value the encoder accepts. */
export type ToonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ToonValue[]
  | { [key: string]: ToonValue };

const INDENT = "  ";

function isPlainObject(value: ToonValue): value is { [key: string]: ToonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: ToonValue): boolean {
  return value === null || value === undefined || typeof value !== "object";
}

/** A string needs quoting when an unquoted reader could mis-tokenize it: empty,
 * padded, carrying a structural delimiter, or shaped like a number/bool/null. */
function needsQuote(s: string): boolean {
  if (s === "") return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/[,:"\n[\]{}#]/.test(s)) return true;
  if (s === "true" || s === "false" || s === "null") return true;
  if (/^-?\d/.test(s)) return true;
  return false;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Format a scalar as one TOON cell/value token. */
export function formatScalar(value: ToonValue): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  // Non-scalars never reach a cell in practice (callers route arrays/objects to
  // their own encoders); coerce defensively so the type stays total.
  if (typeof value !== "string") return "null";
  return needsQuote(value) ? quote(value) : value;
}

/** A signature of an object's key set, used to test array uniformity. */
function keySignature(obj: { [key: string]: ToonValue }): string {
  return JSON.stringify(Object.keys(obj));
}

/** True when every element is a flat object (only scalar fields) sharing one
 * identical, non-empty key set -- the precondition for the tabular fast path. */
function isUniformFlatObjectArray(arr: ToonValue[]): boolean {
  if (arr.length === 0) return false;
  if (!arr.every(isPlainObject)) return false;
  const first = arr[0] as { [key: string]: ToonValue };
  const keys = Object.keys(first);
  if (keys.length === 0) return false;
  const sig = keySignature(first);
  return arr.every((el) => {
    const obj = el as { [key: string]: ToonValue };
    return keySignature(obj) === sig && keys.every((key) => isScalar(obj[key]));
  });
}

function encodeArray(key: string, arr: ToonValue[], depth: number, lines: string[]): void {
  const pad = INDENT.repeat(depth);
  if (arr.length === 0) {
    lines.push(`${pad}${key}[0]:`);
    return;
  }
  // Tabular fast path: one header row + bare CSV data rows.
  if (isUniformFlatObjectArray(arr)) {
    const fields = Object.keys(arr[0] as { [key: string]: ToonValue });
    lines.push(`${pad}${key}[${arr.length}]{${fields.join(",")}}:`);
    const rowPad = INDENT.repeat(depth + 1);
    for (const el of arr) {
      const obj = el as { [key: string]: ToonValue };
      lines.push(`${rowPad}${fields.map((f) => formatScalar(obj[f])).join(",")}`);
    }
    return;
  }
  // All-scalar array: inline CSV on the header line.
  if (arr.every(isScalar)) {
    lines.push(`${pad}${key}[${arr.length}]: ${arr.map(formatScalar).join(",")}`);
    return;
  }
  // Mixed / nested fallback: one `-` block per element.
  lines.push(`${pad}${key}[${arr.length}]:`);
  const itemPad = INDENT.repeat(depth + 1);
  for (const el of arr) {
    if (isScalar(el)) {
      lines.push(`${itemPad}- ${formatScalar(el)}`);
    } else if (Array.isArray(el)) {
      encodeArray("-", el, depth + 1, lines);
    } else {
      const obj = el as { [key: string]: ToonValue };
      lines.push(`${itemPad}-`);
      encodeObjectFields(obj, depth + 2, lines);
    }
  }
}

function encodeObjectFields(obj: { [key: string]: ToonValue }, depth: number, lines: string[]): void {
  const pad = INDENT.repeat(depth);
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      encodeArray(key, value, depth, lines);
    } else if (isPlainObject(value)) {
      lines.push(`${pad}${key}:`);
      if (Object.keys(value).length > 0) encodeObjectFields(value, depth + 1, lines);
    } else {
      lines.push(`${pad}${key}: ${formatScalar(value)}`);
    }
  }
}

/**
 * Encode a value as TOON. The common case is a top-level object, whose fields
 * are emitted at indent 0. A top-level array is emitted under a synthetic
 * `items` key; a top-level scalar is emitted bare. Returns a newline-joined
 * string with no trailing newline (the caller appends one).
 */
export function encodeToon(value: ToonValue): string {
  if (Array.isArray(value)) {
    const lines: string[] = [];
    encodeArray("items", value, 0, lines);
    return lines.join("\n");
  }
  if (isPlainObject(value)) {
    const lines: string[] = [];
    encodeObjectFields(value, 0, lines);
    return lines.join("\n");
  }
  return formatScalar(value);
}
