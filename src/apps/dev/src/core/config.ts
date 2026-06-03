import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * config.ts — TypeScript port of scripts/config.sh.
 *
 * Loads the dev config from `.red/config.yaml`. Per ADR 0042 the canonical
 * location is the namespaced `plugins.dev.afk.*` block; the legacy top-level
 * `afk.*` block is still read as a back-compat fallback. `loadConfig` folds the
 * namespaced keys down to the bare `afk.*` accessor keys (the namespaced
 * location wins when both are present), so every `getConfig(cfg, "afk.…")`
 * caller is unchanged. Mirrors the shell loader's semantics exactly:
 *   - documented v1 defaults seed the map;
 *   - a missing file leaves all defaults;
 *   - malformed YAML emits one warning and falls back to all defaults;
 *   - unknown keys parse fine (forward compatibility) but are never read by
 *     any documented accessor.
 *
 * The parser is the same constrained subset the shell uses (nested mappings
 * keyed by `[a-zA-Z_][a-zA-Z0-9_-]*` with 2-space indentation, scalar leaves
 * only). No yaml dependency. All values round-trip as raw strings, matching
 * `config_get` in the shell — callers compare against literals like "false".
 */

/** Documented v1 defaults — the only way to expand the schema. */
export const CONFIG_DEFAULTS = {
  "afk.default_runner": "claude",
  "afk.fleet.target": "2",
  "afk.hooks.defaults.cargo": "true",
  "afk.hooks.defaults.gradle": "true",
} as const;

export type ConfigKey = keyof typeof CONFIG_DEFAULTS;

/** Every value in the flat config map is a raw string, like the shell's `config_get`. */
export const ConfigValuesSchema = z.record(z.string());
export type ConfigValues = z.infer<typeof ConfigValuesSchema>;

/** Thrown by `parseConfigYaml` when the input violates the tiny-YAML grammar. */
export class MalformedConfigError extends Error {
  constructor(message = "malformed YAML") {
    super(message);
    this.name = "MalformedConfigError";
  }
}

function configDefaults(): ConfigValues {
  return { ...CONFIG_DEFAULTS };
}

/**
 * Parse the constrained-subset YAML into `dotted.key -> value` entries.
 *
 * Pure: takes the file's text, returns the flat map of scalar leaves. Throws
 * `MalformedConfigError` on grammar violations (odd indentation, a non-mapping
 * line, or an unclosed quoted string) — exactly the cases where the shell
 * parser returns non-zero.
 */
export function parseConfigYaml(text: string): ConfigValues {
  const out: ConfigValues = {};
  const stack: string[] = [];
  const indents: number[] = [];
  // Per-parent running index for block-sequence items (`- value`). A sequence
  // under the dotted parent path `p` materialises as `p.0`, `p.1`, … so the
  // flat config map keeps its `dotted.key -> value` shape (see readBackpressure).
  const seqCounters: Record<string, number> = {};

  for (let raw of text.split("\n")) {
    // strip a trailing CR (CRLF tolerance)
    raw = raw.replace(/\r$/, "");

    // strip inline comments unless the line contains a quoted string
    let stripped = raw;
    if (!/".*"/.test(stripped) && !/'.*'/.test(stripped)) {
      const hash = stripped.indexOf("#");
      if (hash >= 0) stripped = stripped.slice(0, hash);
    }

    // skip blank / whitespace-only lines
    if (stripped.replace(/\s/g, "") === "") continue;

    const indentStr = stripped.match(/^\s*/)?.[0] ?? "";
    const indent = indentStr.length;
    if (indent % 2 !== 0) throw new MalformedConfigError();

    let rest = stripped.slice(indent).replace(/\s+$/, "");

    // Block-sequence item: `- value` under the current mapping key. Pop parents
    // whose indent is >= this line's, exactly like the mapping branch, then
    // append the scalar at `<parent>.<index>`. A sequence with no enclosing
    // mapping key (empty stack) or an empty item is malformed.
    if (/^-(\s|$)/.test(rest)) {
      while (indents.length > 0 && indents[indents.length - 1]! >= indent) {
        stack.pop();
        indents.pop();
      }
      if (stack.length === 0) throw new MalformedConfigError();

      let item = rest.slice(1).replace(/^\s+/, "");
      if (item === "") throw new MalformedConfigError();
      if (item.startsWith('"')) {
        if (!item.endsWith('"') || item.length < 2) throw new MalformedConfigError();
        item = item.slice(1, -1);
      } else if (item.startsWith("'")) {
        if (!item.endsWith("'") || item.length < 2) throw new MalformedConfigError();
        item = item.slice(1, -1);
      }

      const parent = stack.join(".");
      const idx = seqCounters[parent] ?? 0;
      seqCounters[parent] = idx + 1;
      out[`${parent}.${idx}`] = item;
      continue;
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*:/.test(rest)) throw new MalformedConfigError();

    const colon = rest.indexOf(":");
    const key = rest.slice(0, colon);
    let value = rest.slice(colon + 1).replace(/^\s+/, "");

    // unclosed-quote detection / strip matching quotes
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) throw new MalformedConfigError();
      value = value.slice(1, -1);
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) throw new MalformedConfigError();
      value = value.slice(1, -1);
    }

    // pop parents whose indent is >= current
    while (indents.length > 0 && indents[indents.length - 1]! >= indent) {
      stack.pop();
      indents.pop();
    }

    const full = stack.length > 0 ? `${stack.join(".")}.${key}` : key;

    if (value === "") {
      stack.push(key);
      indents.push(indent);
    } else {
      out[full] = value;
    }
  }

  return out;
}

/** Injectable file reader. Returns the file's text, or `undefined` if absent. */
export type ConfigReader = (path: string) => string | undefined;

/** Injectable warning sink, defaulting to stderr like the shell loader. */
export type ConfigWarn = (message: string) => void;

export interface LoadConfigOptions {
  read?: ConfigReader;
  warn?: ConfigWarn;
}

const defaultReader: ConfigReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const defaultWarn: ConfigWarn = (message) => {
  process.stderr.write(`${message}\n`);
};

/**
 * Load config from `path`, merging file overrides onto the v1 defaults.
 *
 * Mirrors `config_load`:
 *   - missing file → all defaults, no warning;
 *   - malformed YAML → exactly one warning mentioning the path, all defaults;
 *   - well-formed file → defaults overlaid with every parsed key (including
 *     unknown ones, for forward compatibility).
 */
export function loadConfig(path: string, options: LoadConfigOptions = {}): ConfigValues {
  const read = options.read ?? defaultReader;
  const warn = options.warn ?? defaultWarn;

  const values = configDefaults();
  const text = read(path);
  if (text === undefined) return values;

  let parsed: ConfigValues;
  try {
    parsed = parseConfigYaml(text);
  } catch {
    warn(`[afk:config] warn: malformed YAML in ${path} — using defaults`);
    return configDefaults();
  }

  // Copy raw parsed keys (forward compatibility), then fold the namespaced
  // `plugins.dev.*` block down to the bare accessor keys so the new location
  // wins over the legacy top-level one (ADR 0042).
  for (const [key, value] of Object.entries(parsed)) values[key] = value;
  for (const [key, value] of Object.entries(parsed)) {
    const m = /^plugins\.dev\.(.+)$/.exec(key);
    if (m) values[m[1]!] = value;
  }
  return values;
}

/** Read a dotted key. Empty string when unset — same contract as `config_get`. */
export function getConfig(values: ConfigValues, key: string): string {
  return values[key] ?? "";
}

/**
 * Read the operator-declared backpressure command list (`afk.backpressure`),
 * in declaration order (issue #430). The list form
 *
 *   afk:
 *     backpressure:
 *       - npm run test
 *       - npm run lint
 *
 * materialises as the indexed keys `afk.backpressure.0`, `afk.backpressure.1`, …
 * which this reads back in order until the first gap. The namespaced
 * `plugins.dev.afk.backpressure.*` location already folds down to the bare keys
 * in {@link loadConfig} (ADR 0042), so both locations are honoured with the
 * namespaced one winning. A single-line scalar (`afk.backpressure: npm run test`)
 * is accepted as a one-command list. Absent/empty → `[]` (the gate is a no-op).
 * Blank entries are dropped.
 */
export function readBackpressure(values: ConfigValues): string[] {
  const indexed: string[] = [];
  for (let i = 0; ; i++) {
    const v = values[`afk.backpressure.${i}`];
    if (v === undefined) break;
    if (v.trim() !== "") indexed.push(v);
  }
  if (indexed.length > 0) return indexed;
  const scalar = values["afk.backpressure"];
  return scalar && scalar.trim() !== "" ? [scalar] : [];
}
