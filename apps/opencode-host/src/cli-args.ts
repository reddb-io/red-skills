/**
 * cli-args — opencode-host's argument surface, stated as a schema the shared
 * contract parses (ADR 0114) instead of as a walk over argv.
 *
 * The questions a parser must answer — what counts as a flag, what happens to
 * an unknown one, whether `-v` is version or verbose, whether the command may
 * be omitted — are answered once in `@reddb-io/shared/args`, so every RedSkills
 * binary answers them the same way. This module only declares what
 * opencode-host accepts and maps the parsed values onto its options.
 */
import {
  parseFlags,
  routeCommand,
  UnknownCommandError,
  type FlagSchema,
} from "@reddb-io/shared/args.js";

/** The command set. `generate` is the only verb, and the default one. */
export type OpencodeHostCommand = "generate";

const FLAGS = {
  config: { kind: "value", aliases: ["c"], coerce: (raw: string) => raw },
  out: { kind: "value", aliases: ["o"], coerce: (raw: string) => raw },
  "out-dir": { kind: "value", aliases: ["d"], coerce: (raw: string) => raw },
  "plugins-root": { kind: "value", aliases: ["p"], coerce: (raw: string) => raw },
  plugin: { kind: "value", type: "array", coerce: (raw: string) => raw },
  // Negation is the contract's (`--no-slice-2`); `--with-slice-2` stays as the
  // spelling earlier callers used.
  "slice-2": { kind: "boolean", aliases: ["with-slice-2"] },
  copy: { kind: "boolean" },
  print: { kind: "boolean" },
  help: { kind: "boolean", aliases: ["h"] },
  version: { kind: "boolean", aliases: ["v"] },
  json: { kind: "boolean" },
} satisfies FlagSchema;

export interface OpencodeHostArgs {
  command: OpencodeHostCommand;
  configPath: string;
  /** Slice 1: write the provider block to this file path. */
  outPath: string;
  /** Slice 2: write the dist tree under this directory. */
  outDir: string;
  pluginsRoot: string;
  showHelp: boolean;
  showVersion: boolean;
  /** `--json`: print the structured build info instead of the version line. */
  versionJson: boolean;
  /** `--print`: write the Slice 1 JSON to stdout instead of a file. */
  printJson: boolean;
  copySkills: boolean;
  pluginFilter: string[] | null;
  slice2: boolean;
}

/** A usage failure: the caller wrote something the schema does not accept. */
export class OpencodeHostUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodeHostUsageError";
  }
}

/**
 * True when argv leads with a version token.
 *
 * Checked before routing so "which build is this?" stays answerable in exactly
 * the situation you need to ask it — a directory that never opted in, a config
 * that cannot be read, a tree with no plugins.
 */
export function isVersionRequest(argv: readonly string[]): boolean {
  return argv[0] === "--version" || argv[0] === "-v";
}

/** Parse `argv` into the options `generate` runs on, or throw a usage error. */
export function parseOpencodeHostArgs(argv: readonly string[]): OpencodeHostArgs {
  let routed;
  try {
    routed = routeCommand<OpencodeHostCommand>(argv, {
      commands: { generate: {} },
      default: "generate",
      errorOnUnknownCommand: true,
    });
  } catch (err) {
    if (err instanceof UnknownCommandError) throw new OpencodeHostUsageError(err.message);
    throw err;
  }

  let parsed;
  try {
    parsed = parseFlags(routed.args, FLAGS, { unknownFlags: "error" });
  } catch (err) {
    throw new OpencodeHostUsageError((err as Error).message);
  }

  const stray = parsed.positionals[0];
  if (stray !== undefined) {
    throw new OpencodeHostUsageError(`unexpected argument '${stray}'`);
  }

  const { values } = parsed;
  return {
    command: routed.command,
    configPath: values.config ?? "./.red/config.yaml",
    outPath: values.out ?? "./opencode.json",
    outDir: values["out-dir"] ?? "./dist/opencode",
    pluginsRoot: values["plugins-root"] ?? "./plugins",
    showHelp: values.help ?? false,
    showVersion: values.version ?? false,
    versionJson: values.json ?? false,
    printJson: values.print ?? false,
    copySkills: values.copy ?? false,
    pluginFilter: values.plugin ?? null,
    slice2: values["slice-2"] ?? true,
  };
}

/** The usage text, kept next to the schema it describes. */
export function renderHelp(): string {
  return `opencode-host generate — emit the opencode-host runtime tree

Slice 1: opencode.json (provider block) at <out>
Slice 2: dist tree at <out-dir>/<plugin>/{opencode.json, .opencode/...}

Usage:
  opencode-host [generate] [--config <path>] [--out <path>] [--out-dir <path>] [--plugins-root <path>] [--plugin <name>] [--copy] [--print] [--no-slice-2]
  opencode-host --version [--json]
  opencode-host --help

Options:
  -c, --config <path>        path to .red/config.yaml (default: ./.red/config.yaml)
  -o, --out <path>           Slice 1: path to write opencode.json (default: ./opencode.json)
  -d, --out-dir <path>       Slice 2: dist root (default: ./dist/opencode)
  -p, --plugins-root <path>  path to the plugins/ tree (default: ./plugins)
      --plugin <name>        emit only this plugin (repeatable; Slice 2 only)
      --copy                 copy SKILL.md instead of symlinking
      --with-slice-2         emit the Slice 2 dist tree (default; kept for compatibility)
      --no-slice-2           opt out of the Slice 2 dist tree
      --print                print Slice 1 JSON to stdout (Slice 2 not written)
  -v, --version              print the build version (--json for the build info)
      --json                 with --version: print the structured build info
  -h, --help                 show this help

Exit codes:
  0  wrote (or printed) successfully
  1  read/write failure or opt-in gate closed (plugins.dev.enabled: true missing)
  2  usage error

Notes:
  - The ADR 0067 strict opt-in gate applies: plugins.dev.enabled: true must be set.
  - Slice 1 (--out) is unaffected by --plugin/--no-slice-2; it is the standalone
    provider-block JSON file.
  - Planner errors (bad name, missing frontmatter) are reported on stderr but
    do NOT fail the build. The events the generator can map are emitted.
`;
}
