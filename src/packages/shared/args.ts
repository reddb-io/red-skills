/**
 * Shared CLI argument layer for the RedSkills monorepo (ADR 0034).
 *
 * A thin, well-typed wrapper over the author's published `cli-args-parser`
 * package. It establishes one common CLI convention that every plugin under
 * `src/apps/*` consumes instead of re-implementing its own ad-hoc flag
 * scanning:
 *
 *  - `parseFlags(argv, schema)` — schema-driven flag parsing that returns a
 *    typed `{ values, positionals }` result. Each flag declares its kind
 *    (`boolean` / `value`), its aliases, and an optional `coerce` mapping the
 *    raw string to the value the caller wants. Built on the library's
 *    `tokenize` primitive so `--flag`, `--flag=value`, `--flag value`, `-f`,
 *    and `-f value` are all recognised consistently, with a single, shared
 *    "<flag> requires a value" error for value flags missing their argument.
 *
 *  - `routeCommand(argv, commands)` — a minimal command router: it peels the
 *    leading token, matches it (or an alias) against the known command set, and
 *    returns `{ command, args }` with the remaining argv untouched. Unknown
 *    leading tokens fall through to a declared default command, preserving the
 *    full argv.
 *
 * Dependency-light by design: the only import is `cli-args-parser`.
 */
import { tokenize, type Token } from "cli-args-parser";

/** A flag that is present-or-absent, e.g. `--once`. */
export interface BooleanFlagSpec {
  kind: "boolean";
  /** Alternate spellings (long or short), without leading dashes. */
  aliases?: string[];
}

/** A flag that consumes a value, e.g. `--prd 42` / `--prd=42`. */
export interface ValueFlagSpec<T> {
  kind: "value";
  /** Alternate spellings (long or short), without leading dashes. */
  aliases?: string[];
  /** Map the raw string value to the typed value the caller wants. */
  coerce: (raw: string) => T;
}

export type FlagSpec<T = unknown> = BooleanFlagSpec | ValueFlagSpec<T>;

/** Schema: a record of canonical flag name → spec. */
export type FlagSchema = Record<string, FlagSpec>;

/** Infer the value type produced by a single flag spec. */
type FlagValue<S> = S extends ValueFlagSpec<infer T>
  ? T
  : S extends BooleanFlagSpec
    ? boolean
    : never;

/** Typed result of `parseFlags`. Unset flags are absent from `values`. */
export interface ParseFlagsResult<Schema extends FlagSchema> {
  values: { [K in keyof Schema]?: FlagValue<Schema[K]> };
  positionals: string[];
}

export interface LooseParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function buildAliasIndex(schema: FlagSchema): Map<string, string> {
  const index = new Map<string, string>();
  for (const [name, spec] of Object.entries(schema)) {
    index.set(name, name);
    for (const alias of spec.aliases ?? []) index.set(alias, name);
  }
  return index;
}

/**
 * Parse `argv` against a flag `schema`, returning typed values and positionals.
 *
 * Tokenisation is delegated to `cli-args-parser`'s `tokenize`, so the supported
 * surface — `--flag`, `--no-flag`, `--opt=value`, `-f`, `-o value`, combined
 * short flags — is the library's, shared across the whole monorepo. The wrapper
 * then folds those tokens into the declared schema:
 *
 *  - boolean flag present → `true`
 *  - value flag with `=value` or a following token → `coerce(value)`
 *  - value flag with no available value → throws `"<flag> requires a value"`
 *
 * Last occurrence wins for repeated flags. Unknown flags are ignored (left for
 * the caller to handle elsewhere), matching the permissive scan dev relied on.
 */
export function parseFlags<Schema extends FlagSchema>(
  argv: readonly string[],
  schema: Schema,
): ParseFlagsResult<Schema> {
  const aliasIndex = buildAliasIndex(schema);
  const args = [...argv];
  const tokens: Token[] = tokenize(args);

  const values: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const key = tok.key;

    if ((tok.type === "positional" || tok.type === "separator") && key === undefined) {
      positionals.push(tok.raw);
      continue;
    }

    // Tokens carrying a key are flag-long / flag-short / option-long /
    // option-short / negation. Resolve to a canonical schema name.
    if (key === undefined) {
      positionals.push(tok.raw);
      continue;
    }

    const canonical = aliasIndex.get(key);
    if (canonical === undefined) {
      // Unknown flag — preserve permissive behaviour, ignore it.
      continue;
    }
    const spec = schema[canonical]!;

    if (spec.kind === "boolean") {
      values[canonical] = true;
      continue;
    }

    // Value flag. The token may already carry an inline value (--flag=value or
    // -f=value). Otherwise consume the next argv token as the value.
    let raw: string | undefined = tok.value;
    if (raw === undefined) {
      const next = args[tok.index + 1];
      if (next !== undefined) {
        raw = next;
        // Skip the token we just consumed as a value so it is not re-read as a
        // positional / flag on a later iteration.
        for (let j = i + 1; j < tokens.length; j += 1) {
          if (tokens[j]!.index === tok.index + 1) {
            tokens.splice(j, 1);
            break;
          }
        }
      }
    }
    if (raw === undefined) {
      const display = key.length === 1 ? `-${key}` : `--${key}`;
      throw new Error(`${display} requires a value`);
    }
    values[canonical] = spec.coerce(raw);
  }

  return { values, positionals } as ParseFlagsResult<Schema>;
}

/**
 * Permissive command parser for broad CLIs with many command-specific flags.
 *
 * This keeps the familiar `{ command, positional, flags }` shape used by the
 * Memory CLIs while delegating tokenisation to `cli-args-parser`, so long/short
 * flags and `--flag=value` behave consistently with the schema-driven parser.
 */
export function parseLooseArgs(argv: readonly string[]): LooseParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const args = [...rest];
  const tokens: Token[] = tokenize(args);

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const key = tok.key;
    if (key === undefined) {
      if (tok.type === "positional" || tok.type === "separator") positional.push(tok.raw);
      continue;
    }
    if (!tok.raw.startsWith("-")) {
      positional.push(tok.raw);
      continue;
    }

    let value: string | boolean | undefined = tok.value;
    if (value === undefined) {
      const next = args[tok.index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        for (let j = i + 1; j < tokens.length; j += 1) {
          if (tokens[j]!.index === tok.index + 1) {
            tokens.splice(j, 1);
            break;
          }
        }
      } else {
        value = true;
      }
    }
    flags[key] = value;
  }

  return { command, positional, flags };
}

/** Result of `routeCommand`. */
export interface RoutedCommand<C extends string> {
  command: C;
  args: string[];
}

/** Command-router schema: canonical command → optional aliases. */
export interface CommandSpec {
  aliases?: string[];
}

export interface RouterSchema<C extends string> {
  commands: Record<C, CommandSpec>;
  /** Command used when the leading token matches no command. */
  default: C;
  /**
   * When the leading token matches no command and falls through to `default`,
   * keep the entire argv (default: true). When false, the leading token is
   * still dropped.
   */
  keepArgvOnDefault?: boolean;
}

/**
 * Peel the leading command token off `argv` and route it.
 *
 * If the first token matches a command name (or alias), returns that command
 * with the remaining args. Otherwise routes to `schema.default`; by default the
 * full argv is preserved (so a bare `--flag …` invocation still reaches the
 * default command with all its flags).
 */
export function routeCommand<C extends string>(
  argv: readonly string[],
  schema: RouterSchema<C>,
): RoutedCommand<C> {
  const [first, ...rest] = argv;
  if (first !== undefined) {
    for (const [name, spec] of Object.entries(schema.commands) as [C, CommandSpec][]) {
      if (first === name || (spec.aliases ?? []).includes(first)) {
        return { command: name, args: rest };
      }
    }
  }
  const keepArgv = schema.keepArgvOnDefault ?? true;
  return { command: schema.default, args: keepArgv ? [...argv] : rest };
}
