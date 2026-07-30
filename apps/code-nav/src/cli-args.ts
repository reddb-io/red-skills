/**
 * cli-args — code-nav's argument surface, stated as a schema the shared
 * contract parses (ADR 0114) instead of as a walk over `process.argv`.
 *
 * The questions a parser must answer — what counts as a flag, what happens to
 * an unknown one, whether `-v` is version or verbose, whether the command may
 * be omitted — are answered once in `@reddb-io/shared/args`, so every RedSkills
 * binary answers them the same way. This module only declares what code-nav
 * accepts and maps the parsed values onto its options.
 */
import {
  parseFlags,
  routeCommand,
  UnknownCommandError,
  type FlagSchema,
} from "@reddb-io/shared/args.js";

/**
 * The command set. `serve` runs the MCP stdio server and is the default, so a
 * bare invocation still starts the navigator the way an MCP host expects.
 * `version` stays a command because the hand-rolled parser accepted it.
 */
export type CodeNavCommand = "serve" | "version";

const FLAGS = {
  help: { kind: "boolean", aliases: ["h"] },
  version: { kind: "boolean", aliases: ["v"] },
  json: { kind: "boolean" },
} satisfies FlagSchema;

export interface CodeNavArgs {
  command: CodeNavCommand;
  showHelp: boolean;
  showVersion: boolean;
  /** `--json`: print the structured build info instead of the version line. */
  versionJson: boolean;
}

/** A usage failure: the caller wrote something the schema does not accept. */
export class CodeNavUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeNavUsageError";
  }
}

/**
 * True when argv leads with a version token.
 *
 * Checked before routing so "which build is this?" stays answerable in exactly
 * the situation you need to ask it — a box with no language server installed, a
 * `CODE_NAV_SERVERS` override that will not parse, an MCP host that never
 * connected its stdio transport.
 */
export function isVersionRequest(argv: readonly string[]): boolean {
  return argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version";
}

/** Parse `argv` into the options code-nav runs on, or throw a usage error. */
export function parseCodeNavArgs(argv: readonly string[]): CodeNavArgs {
  let routed;
  try {
    routed = routeCommand<CodeNavCommand>(argv, {
      commands: { serve: {}, version: {} },
      default: "serve",
      errorOnUnknownCommand: true,
    });
  } catch (err) {
    if (err instanceof UnknownCommandError) throw new CodeNavUsageError(err.message);
    throw err;
  }

  let parsed;
  try {
    parsed = parseFlags(routed.args, FLAGS, { unknownFlags: "error" });
  } catch (err) {
    throw new CodeNavUsageError((err as Error).message);
  }

  const stray = parsed.positionals[0];
  if (stray !== undefined) {
    throw new CodeNavUsageError(`unexpected argument '${stray}'`);
  }

  const { values } = parsed;
  return {
    command: routed.command,
    showHelp: values.help ?? false,
    // The `version` command and the `--version` flag are one answer, so a
    // caller may reach it either way.
    showVersion: routed.command === "version" || (values.version ?? false),
    versionJson: values.json ?? false,
  };
}

/** The usage text, kept next to the schema it describes. */
export function renderHelp(): string {
  return `code-nav — LSP-backed code navigation as an MCP server

Serves goto-definition, find-references, document/workspace symbols and hover
over stdio, so a code agent resolves symbols instead of grepping for names.

Usage:
  code-nav [serve]
  code-nav --version [--json]
  code-nav --help

Options:
  -v, --version    print the build version (--json for the build info)
      --json       with --version: print the structured build info
  -h, --help       show this help

Environment:
  CODE_NAV_ROOT     workspace root the language servers index (default: cwd)
  CODE_NAV_SERVERS  JSON registry overriding the default language servers, e.g.
                    '{"go":{"command":"gopls","args":[],"extensions":[".go"],"languageId":"go"}}'

Exit codes:
  0  served until the transport closed, or printed the version/help
  1  fatal error while serving
  2  usage error
`;
}
