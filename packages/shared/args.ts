/**
 * Shared CLI argument layer for the RedSkills monorepo (ADR 0034).
 *
 * A thin, well-typed wrapper over the author's published `cli-args-parser`
 * package. It establishes one common CLI convention that every plugin under
 * `apps/*` consumes instead of re-implementing its own ad-hoc flag
 * scanning:
 *
 *  - `parseFlags(argv, schema)` — schema-driven flag parsing that returns a
 *    typed `{ values, positionals }` result. Each flag declares its kind
 *    (`boolean` / `value`), its aliases, and an optional `coerce` mapping the
 *    raw string to the value the caller wants. Built on the library's
 *    schema-aware `createParser` surface so `--flag`, `--flag=value`,
 *    `--flag value`, `-f`, and `-f value` are all recognised consistently,
 *    with a single, shared "<flag> requires a value" error for value flags
 *    missing their argument.
 *
 *  - `extractFlags(argv, schema)` — the same schema, applied to an argv that is
 *    only partly ours. It peels the declared flags out and hands back every
 *    other token untouched, in order, so a wrapper CLI can own `--brief` while
 *    the command it wraps keeps `--oneline` and `-n 5` verbatim. `parseFlags`
 *    cannot do this: it absorbs unknown flags, which is correct for a CLI that
 *    owns its whole argv and destructive for one that proxies a foreign tail.
 *
 *  - `routeCommand(argv, commands)` — a minimal command router: it peels the
 *    leading token, matches it (or an alias) against the known command set, and
 *    returns `{ command, args }` with the remaining argv untouched. Unknown
 *    leading tokens fall through to a declared default command, preserving the
 *    full argv.
 *
 * Dependency-light by design: the only import is `cli-args-parser`.
 */
import { createParser, looksLikeValue, tokenize, type OptionDefinition, type Token } from "cli-args-parser";

/** A flag that is present-or-absent, e.g. `--once`. */
export interface BooleanFlagSpec {
  kind: "boolean";
  /** Alternate spellings (long or short), without leading dashes. */
  aliases?: string[];
}

/** A flag that consumes a value, e.g. `--spec 42` / `--spec=42`. */
export interface ValueFlagSpec<T> {
  kind: "value";
  /** Accumulate repeated occurrences in order instead of keeping the last. */
  type?: "array";
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
  ? S extends { type: "array" }
    ? T[]
    : T
  : S extends BooleanFlagSpec
    ? boolean
    : never;

/** Typed result of `parseFlags`. Unset flags are absent from `values`. */
export interface ParseFlagsResult<Schema extends FlagSchema> {
  values: { [K in keyof Schema]?: FlagValue<Schema[K]> };
  positionals: string[];
}

/** How `parseFlags` answers a flag the schema never declared. */
export interface ParseFlagsOptions {
  /**
   * `"ignore"` (default) leaves undeclared flags alone for the caller to handle
   * elsewhere; `"error"` throws {@link UnknownFlagError} naming the first one.
   */
  unknownFlags?: "ignore" | "error";
}

/**
 * Raised by {@link parseFlags} under `unknownFlags: "error"` when argv carries a
 * flag the schema never declared — e.g. `--bogus`. Naming the flag is the point:
 * a binary that silently swallows a typo'd flag runs with a default the caller
 * believed they had overridden.
 */
export class UnknownFlagError extends Error {
  readonly flag: string;
  readonly known: readonly string[];
  constructor(flag: string, known: readonly string[]) {
    super(`unknown flag '${flag}'; expected one of: ${known.join(", ")}`);
    this.name = "UnknownFlagError";
    this.flag = flag;
    this.known = known;
  }
}

export interface LooseParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Full ordered values for schema-declared array options. */
  repeatedFlags?: Record<string, string[]>;
}

function buildParserOptions(schema: FlagSchema): Record<string, OptionDefinition> {
  const options: Record<string, OptionDefinition> = {};
  for (const [name, spec] of Object.entries(schema)) {
    options[name] = {
      type: spec.kind === "boolean" ? "boolean" : "string",
      ...(name.length === 1 ? { short: name } : {}),
      ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
    };
  }
  return options;
}

function collectArrayValues(argv: readonly string[], schema: FlagSchema): Map<string, string[]> {
  const names = new Map<string, string>();
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.kind !== "value" || spec.type !== "array") continue;
    names.set(name, name);
    for (const alias of spec.aliases ?? []) names.set(alias, name);
  }

  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") break;

    const match = arg.match(/^--([^=]+)(?:=(.*))?$/) ?? arg.match(/^-([^=])(?:=(.*))?$/);
    if (match === null) continue;

    const canonical = names.get(match[1]!);
    if (canonical === undefined) continue;

    let raw = match[2];
    if (raw === undefined && looksLikeValue(argv[index + 1])) {
      raw = argv[index + 1];
      index += 1;
    }
    if (raw === undefined) continue;

    const accumulated = values.get(canonical) ?? [];
    accumulated.push(raw);
    values.set(canonical, accumulated);
  }
  return values;
}

/**
 * Parse `argv` against a flag `schema`, returning typed values and positionals.
 *
 * Parsing is delegated to `cli-args-parser`'s schema-aware `createParser`, so
 * the supported surface — `--flag`, `--no-flag`, `--opt=value`, `-f`,
 * `-o value`, combined short flags — is the library's, shared across the whole
 * monorepo. The wrapper then maps the parsed values into the declared schema:
 *
 *  - boolean flag present → `true`
 *  - value flag with `=value` or a following token → `coerce(value)`
 *  - value flag with no available value → throws `"<flag> requires a value"`
 *
 * Last occurrence wins unless a value flag opts into `type: "array"`, which
 * accumulates occurrences in input order. Unknown flags are ignored (left for
 * the caller to handle elsewhere), matching the permissive scan dev relied on;
 * pass `{ unknownFlags: "error" }` to have the contract throw
 * {@link UnknownFlagError} naming the offending flag instead.
 */
export function parseFlags<Schema extends FlagSchema>(
  argv: readonly string[],
  schema: Schema,
  options: ParseFlagsOptions = {},
): ParseFlagsResult<Schema> {
  const parser = createParser({
    options: buildParserOptions(schema),
    separators: {},
    allowUnknown: true,
  });
  const parsed = parser.parse([...argv]);
  const values: Record<string, unknown> = {};
  const arrayValues = collectArrayValues(argv, schema);
  const missingValue = parsed.errors.find((error) => /^Option --?\S+ requires a value$/.test(error));
  if (missingValue !== undefined) {
    throw new Error(missingValue.replace(/^Option /, ""));
  }

  if (parsed.errors.length > 0) throw new Error(parsed.errors[0]);

  if (options.unknownFlags === "error") {
    // The parser normalises aliases and `--no-x` negation onto the canonical
    // name, so anything left in `options` that the schema never declared is a
    // flag nobody defined — report it in the spelling the caller can retype.
    const declared = new Set(Object.keys(schema));
    for (const name of Object.keys(parsed.options)) {
      if (declared.has(name)) continue;
      throw new UnknownFlagError(
        name.length === 1 ? `-${name}` : `--${name}`,
        Object.keys(schema).map((flag) => (flag.length === 1 ? `-${flag}` : `--${flag}`)),
      );
    }
  }

  for (const [name, spec] of Object.entries(schema)) {
    const raw = parsed.options[name];
    if (raw === undefined) continue;
    if (spec.kind === "boolean") {
      values[name] = raw;
    } else if (spec.type === "array") {
      values[name] = (arrayValues.get(name) ?? []).map((item) => spec.coerce(item));
    } else {
      values[name] = spec.coerce(String(raw));
    }
  }

  return { values, positionals: parsed.rest } as ParseFlagsResult<Schema>;
}

/** Typed result of `extractFlags`: the declared flags, and everything else. */
export interface ExtractFlagsResult<Schema extends FlagSchema> {
  values: { [K in keyof Schema]?: FlagValue<Schema[K]> };
  /** `argv` minus every declared flag and its value, order preserved. */
  rest: string[];
}

export interface ExtractFlagsOptions {
  /**
   * Stop at a bare `--` and copy the tail through untouched (default: true).
   *
   * Set false when the separator in this argv is the wrapped tool's own — `git
   * diff -- <path>` — rather than the boundary of what this CLI owns. Then the
   * whole argv is scanned, which is what a caller re-reading its own flag out of
   * an argv it already assembled needs.
   */
  stopAtSeparator?: boolean;
}

/** `--name`, `--name=value`, `-n`, `-n=value`. Anything else is not ours. */
const FLAG_TOKEN = /^--([^=]+)(?:=([\s\S]*))?$/;
const SHORT_FLAG_TOKEN = /^-([^-=])(?:=([\s\S]*))?$/;

function aliasIndexOf(schema: FlagSchema): Map<string, string> {
  const index = new Map<string, string>();
  for (const [name, spec] of Object.entries(schema)) {
    index.set(name, name);
    for (const alias of spec.aliases ?? []) index.set(alias, name);
  }
  return index;
}

/**
 * Peel the schema's flags out of `argv` and return the remaining tokens verbatim.
 *
 * This is the contract for a CLI that does not own its whole argv — a wrapper
 * whose tail is another program's command line. Only declared flags are touched:
 * an undeclared `--oneline` is not a parse error and not a positional, it is a
 * token this parser has no opinion about and copies through unchanged.
 *
 * A bare `--` ends extraction. Everything from it onward, including the `--`
 * itself, lands in `rest` untouched, because past that separator the tokens
 * belong to the wrapped command and a flag that merely shares our spelling is
 * not ours to consume.
 *
 * A declared value flag with no value throws the same `"<flag> requires a
 * value"` error {@link parseFlags} raises, so both entry points fail one way.
 */
export function extractFlags<Schema extends FlagSchema>(
  argv: readonly string[],
  schema: Schema,
  options: ExtractFlagsOptions = {},
): ExtractFlagsResult<Schema> {
  const canonical = aliasIndexOf(schema);
  const stopAtSeparator = options.stopAtSeparator ?? true;
  const values: Record<string, unknown> = {};
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--" && stopAtSeparator) {
      rest.push(...argv.slice(index));
      break;
    }

    const match = FLAG_TOKEN.exec(token) ?? SHORT_FLAG_TOKEN.exec(token);
    const name = match === null ? undefined : canonical.get(match[1]!);
    const spec = name === undefined ? undefined : schema[name];
    if (name === undefined || spec === undefined) {
      rest.push(token);
      continue;
    }

    if (spec.kind === "boolean") {
      values[name] = true;
      continue;
    }

    let raw = match![2];
    if (raw === undefined && looksLikeValue(argv[index + 1])) {
      raw = argv[index + 1];
      index += 1;
    }
    if (raw === undefined) throw new Error(`${token} requires a value`);

    if (spec.type === "array") {
      const accumulated = (values[name] as unknown[] | undefined) ?? [];
      accumulated.push(spec.coerce(raw));
      values[name] = accumulated;
    } else {
      values[name] = spec.coerce(raw);
    }
  }

  return { values, rest } as ExtractFlagsResult<Schema>;
}

/**
 * Permissive command parser for broad CLIs with many command-specific flags.
 *
 * This keeps the familiar `{ command, positional, flags }` shape used by the
 * Memory CLIs while delegating tokenisation to `cli-args-parser`, so long/short
 * flags and `--flag=value` behave consistently with the schema-driven parser.
 * Callers may declare value options with `type: "array"` to accumulate their
 * occurrences in input order while unknown options retain loose parsing.
 */
export function parseLooseArgs(
  argv: readonly string[],
  schema: FlagSchema = {},
): LooseParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const repeatedFlags: Record<string, string[]> = {};
  const positional: string[] = [];
  const args = [...rest];
  const tokens: Token[] = tokenize(args);
  const aliasIndex = new Map<string, string>();
  for (const [name, spec] of Object.entries(schema)) {
    aliasIndex.set(name, name);
    for (const alias of spec.aliases ?? []) aliasIndex.set(alias, name);
  }

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

    const canonical = aliasIndex.get(key) ?? key;
    const spec = schema[canonical];
    let value: string | boolean | undefined = tok.value;
    if (value === undefined) {
      const next = args[tok.index + 1];
      const acceptsSingleDashValue = spec?.kind === "value" && !next?.startsWith("--");
      if (next !== undefined && (!next.startsWith("-") || acceptsSingleDashValue)) {
        value = next;
        for (let j = tokens.length - 1; j > i; j -= 1) {
          if (tokens[j]!.index === tok.index + 1) {
            tokens.splice(j, 1);
          }
        }
      } else {
        value = true;
      }
    }
    if (spec?.kind === "value" && spec.type === "array") {
      if (value === true) {
        const display = key.length === 1 ? `-${key}` : `--${key}`;
        throw new Error(`${display} requires a value`);
      }
      (repeatedFlags[canonical] ??= []).push(value);
      flags[canonical] = value;
    } else {
      flags[canonical] = value;
    }
  }

  return {
    command,
    positional,
    flags,
    ...(Object.keys(repeatedFlags).length > 0 ? { repeatedFlags } : {}),
  };
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
  /**
   * When true, a leading token that is a non-flag positional (does not start
   * with `-`) and matches no command throws {@link UnknownCommandError} instead
   * of falling through to `default`. Flag-led (`--spec …`) and empty invocations
   * still reach the default command — only a typo'd subcommand errors. Off by
   * default to preserve the permissive fall-through.
   */
  errorOnUnknownCommand?: boolean;
}

/**
 * Raised by {@link routeCommand} when `errorOnUnknownCommand` is set and the
 * leading token looks like a subcommand (a non-flag positional) but matches no
 * known command — e.g. a typo such as `moniter`. Lets the CLI fail loudly
 * rather than silently defaulting (which, for `run`, would launch a worker).
 */
export class UnknownCommandError extends Error {
  readonly token: string;
  readonly known: readonly string[];
  constructor(token: string, known: readonly string[]) {
    super(`unknown command '${token}'; expected one of: ${known.join(", ")}`);
    this.name = "UnknownCommandError";
    this.token = token;
    this.known = known;
  }
}

/**
 * Peel the leading command token off `argv` and route it.
 *
 * If the first token matches a command name (or alias), returns that command
 * with the remaining args. Otherwise routes to `schema.default`; by default the
 * full argv is preserved (so a bare `--flag …` invocation still reaches the
 * default command with all its flags). With `errorOnUnknownCommand`, a leading
 * non-flag positional that matches no command throws {@link UnknownCommandError}
 * instead.
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
    // A non-flag leading token that matched no command is a typo'd subcommand,
    // not flags for the default command — error rather than silently default.
    if (schema.errorOnUnknownCommand && !first.startsWith("-")) {
      throw new UnknownCommandError(first, Object.keys(schema.commands));
    }
  }
  const keepArgv = schema.keepArgvOnDefault ?? true;
  return { command: schema.default, args: keepArgv ? [...argv] : rest };
}
