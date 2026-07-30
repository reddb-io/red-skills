/**
 * args.ts — rsp's argv, answered by the one repository arg contract (ADR 0114).
 *
 * rsp is a wrapper, so its argv is two argvs: a prefix it owns and a tail that
 * belongs to the command it wraps. That is the whole reason this file exists as
 * a thin declaration rather than a parser — `@reddb-io/shared/args` already
 * answers what counts as a flag, what a missing value costs, and whether `-v`
 * means version or verbose, and it answers the same way for every binary here.
 * What rsp declares is only which flags and commands are ITS own; every other
 * token reaches the wrapped command byte for byte.
 */
import {
  extractFlags,
  parseFlags,
  routeCommand,
  UnknownCommandError,
  type FlagSchema,
  type RouterSchema,
} from "@reddb-io/shared/args.js";
import { renderStructuredError } from "../structured-error.js";
import type { ParsedArgs } from "./types.js";

/**
 * Flags rsp owns wherever they appear, including after the subcommand, because
 * `rsp git log --terse` is the documented spelling. They are peeled out before
 * the wrapped command ever sees its argv — a wrapper that received `--terse`
 * would reject it as a flag `git` does not have.
 */
const RSP_FLAGS = {
  "store-uri": { kind: "value", coerce: (raw: string) => raw },
  brief: { kind: "boolean" },
  terse: { kind: "boolean" },
  query: { kind: "value", coerce: (raw: string) => raw },
} as const satisfies FlagSchema;

/** Flags on the version answer itself, parsed from what follows `--version`. */
const VERSION_FLAGS = { json: { kind: "boolean" } } as const satisfies FlagSchema;

/** `--help`/`-h` is honoured after any subcommand, so it is peeled like a flag. */
const HELP_FLAGS = { help: { kind: "boolean", aliases: ["h"] } } as const satisfies FlagSchema;

/**
 * Every rsp subcommand. `dashboard` is the bare invocation's name: routing needs
 * a default command, and naming the thing rsp already does with no arguments is
 * better than a sentinel only this file understands.
 */
export const RSP_ROUTER: RouterSchema<RspCommand> = {
  commands: {
    dashboard: {},
    stats: {},
    gains: {},
    show: {},
    git: {},
    gh: {},
    vitest: {},
    cargo: {},
    cat: {},
    exec: {},
    proxy: {},
    wait: {},
    doctor: {},
    status: {},
    sweep: {},
    setup: {},
    mcp: {},
    "shell-init": {},
    server: {},
    "warm-resident": {},
    "gh-api-json": {},
    hook: {},
  },
  default: "dashboard",
  keepArgvOnDefault: true,
  // A leading token that is not a subcommand is a typo, not an argument to the
  // dashboard: `rsp statz` should name what it did not recognise.
  errorOnUnknownCommand: true,
};

export type RspCommand =
  | "dashboard"
  | "stats"
  | "gains"
  | "show"
  | "git"
  | "gh"
  | "vitest"
  | "cargo"
  | "cat"
  | "exec"
  | "proxy"
  | "wait"
  | "doctor"
  | "status"
  | "sweep"
  | "setup"
  | "mcp"
  | "shell-init"
  | "server"
  | "warm-resident"
  | "gh-api-json"
  | "hook";

/** What the invocation is asking for before any of it is acted on. */
export type RspEntryIntent =
  | { kind: "version"; json: boolean }
  | { kind: "help" }
  | { kind: "command" };

/**
 * Answer "which build is this?" and "how do I use this?" from the argv alone.
 *
 * Both answers precede config, enablement, the store, and the socket, which is
 * the point: the moment you need to ask which build is answering is exactly the
 * moment the directory never opted in or the resident will not start.
 *
 * `--version` is recognised only in leading position, so `rsp git --version`
 * still asks git what git is. `--help` is recognised anywhere before `--`,
 * because scoped help after a subcommand is the documented surface.
 */
export function parseEntryIntent(argv: readonly string[]): RspEntryIntent {
  const { command, args } = routeCommand(argv, VERSION_ROUTER);
  if (command === "--version") {
    return { kind: "version", json: parseFlags(args, VERSION_FLAGS).values.json === true };
  }
  if (isHelpRequest(argv)) return { kind: "help" };
  return { kind: "command" };
}

/**
 * The version flags routed as commands, which is what they are: `--version` is
 * not a modifier on an rsp run, it replaces it. Declaring them here keeps the
 * leading-position rule in the router rather than in an `argv[0] ===` branch.
 */
const VERSION_ROUTER: RouterSchema<"--version" | "run"> = {
  commands: { "--version": { aliases: ["-v"] }, run: {} },
  default: "run",
  keepArgvOnDefault: true,
};

export function isHelpRequest(argv: readonly string[]): boolean {
  return extractFlags(argv, HELP_FLAGS).values.help === true;
}

/**
 * Split an rsp invocation into the flags rsp owns and the argv it passes on.
 *
 * `positional` keeps the subcommand at index 0 and every wrapped token in place,
 * because it IS the command line handed to the wrapper — and to `spawn` on the
 * fail-open path, where a token rewritten here would change what the user's own
 * command does.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const { values, rest } = extractRspFlags(argv);

  // A leading flag that survived extraction is a flag rsp does not have. Past
  // the subcommand the same token belongs to the wrapped command, so only the
  // leading position is rsp's to reject.
  const leading = rest[0];
  if (leading !== undefined && leading !== "--" && leading.startsWith("--")) {
    throw CliUsageError.unknownFlag(leading);
  }

  const command = routeCommand(rest, RSP_ROUTER).command;
  const positional = [...rest];
  const query = values.query;
  // The wrappers re-read `--query` from the argv they are given, so a query that
  // was peeled off here is handed back to them. `show` takes a handle, not a
  // filter, so it never receives one.
  if (query !== undefined && command !== "show") positional.push("--query", query);

  return {
    command,
    handle: rest[1],
    storeUri: values["store-uri"],
    query,
    // A level is a ceiling, not a sequence: asked for both, rsp emits the less.
    level: values.terse === true ? "terse" : values.brief === true ? "brief" : "lossless",
    positional,
  };
}

/**
 * The shared contract's flag errors, in rsp's own structured-error shape.
 *
 * Both of the questions a flag can fail — "rsp has no such flag" and "that flag
 * takes a value" — answer with the same rendering and the same exit code, so a
 * caller does not have to learn two failure shapes for one mistake.
 */
export class CliUsageError extends Error {
  static unknownFlag(flag: string): CliUsageError {
    return new CliUsageError(`unknown flag: ${flag}`);
  }

  render(): Buffer {
    return renderStructuredError({
      command: "rsp",
      category: "usage",
      error: this.message,
      help: "rsp --help",
      validFlags: RSP_FLAG_NAMES,
    });
  }
}

const RSP_FLAG_NAMES = Object.keys(RSP_FLAGS).map((name) => `--${name}`);

/** Peel rsp's flags, turning the contract's parse failure into a usage error. */
function extractRspFlags(argv: readonly string[]) {
  try {
    return extractFlags(argv, RSP_FLAGS);
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }
}

/** A typo'd subcommand, rendered in rsp's own structured-error shape. */
export function renderUnknownCommand(err: UnknownCommandError): Buffer {
  return renderStructuredError({
    command: `rsp ${err.token}`,
    category: "usage",
    error: `unknown command: ${err.token}`,
    help: "rsp --help",
    validFlags: err.known,
  });
}

export function isUnknownCommandError(err: unknown): err is UnknownCommandError {
  return err instanceof UnknownCommandError;
}

export function isStructuredUsageRenderable(err: unknown): err is { render: () => Buffer } {
  return typeof err === "object" && err !== null && "render" in err &&
    typeof (err as { render?: unknown }).render === "function";
}

/** `rsp server` / `rsp warm-resident` tuning knobs — all optional overrides. */
const RESIDENT_FLAGS = {
  socket: { kind: "value", coerce: (raw: string) => raw },
  "pid-file": { kind: "value", coerce: (raw: string) => raw },
  "wake-lock": { kind: "value", coerce: (raw: string) => raw },
  registry: { kind: "value", coerce: (raw: string) => raw },
  "resident-version": { kind: "value", coerce: (raw: string) => raw },
  "ttl-days": { kind: "value", coerce: positiveNumber },
  "ephemeral-ttl-hours": { kind: "value", coerce: positiveNumber },
  "byte-budget": { kind: "value", coerce: positiveNumber },
  "telemetry-ttl-days": { kind: "value", coerce: positiveNumber },
  "telemetry-byte-budget": { kind: "value", coerce: positiveNumber },
  "telemetry-drain-interval-ms": { kind: "value", coerce: positiveNumber },
  "telemetry-drain-timeout-ms": { kind: "value", coerce: positiveNumber },
  "idle-ms": { kind: "value", coerce: positiveNumber },
} as const satisfies FlagSchema;

export type ResidentFlags = ReturnType<typeof parseResidentFlags>;

export function parseResidentFlags(positional: readonly string[]) {
  return parseFlags(positional, RESIDENT_FLAGS).values;
}

/** `--since <n>d` on `stats`, `gains`, and `doctor`, plus `--full` on `stats`. */
const REPORT_FLAGS = {
  since: { kind: "value", coerce: parseSinceDays },
  full: { kind: "boolean" },
} as const satisfies FlagSchema;

export function sinceDays(args: readonly string[], fallback: number): number {
  return parseFlags(args, REPORT_FLAGS).values.since ?? fallback;
}

export function statsFull(args: readonly string[]): boolean {
  return parseFlags(args, REPORT_FLAGS).values.full === true;
}

/** `-f name=value` / `-F name=value`, repeated, as GitHub's own CLI spells it. */
const GH_API_FLAGS = {
  field: { kind: "value", type: "array", aliases: ["f", "F"], coerce: (raw: string) => raw },
} as const satisfies FlagSchema;

export function parseGhApiJsonArgs(argv: readonly string[]): { path: string; params: Record<string, string> } | null {
  const { values, rest } = extractFlags(argv, GH_API_FLAGS);
  const path = rest[1];
  if (!path) return null;
  const params: Record<string, string> = {};
  for (const assignment of values.field ?? []) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    params[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return { path, params };
}

/** A tuning knob only accepts a real positive number; anything else is absent. */
function positiveNumber(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `7d` or `7`; anything else leaves the caller on its documented default. */
function parseSinceDays(raw: string): number | undefined {
  const match = /^(\d+)(d)?$/.exec(raw);
  if (!match) return undefined;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? days : undefined;
}
