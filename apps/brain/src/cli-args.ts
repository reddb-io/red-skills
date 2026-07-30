/**
 * cli-args — brain's argument surface, stated as schemas the shared contract
 * parses (ADR 0114) instead of as a walk over argv.
 *
 * The questions a parser must answer — what counts as a flag, what happens to
 * an unknown one, whether `-v` is version or verbose, whether the command may
 * be omitted — are answered once in `@reddb-io/shared/args`, so every RedSkills
 * binary answers them the same way. This module only declares what `brain`
 * accepts: one schema per command, plus the flags the binary itself owns.
 */
import {
  parseFlags,
  routeCommand,
  UnknownCommandError,
  UnknownFlagError,
  type CommandSpec,
  type FlagSchema,
  type ParseFlagsResult,
  type RoutedCommand,
  type RouterSchema,
} from "@reddb-io/shared/args.js";
import { ARTIFACT_KINDS, CONNECTION_KINDS } from "./schema.js";

/** Every verb the binary routes. Aliases are declared on the router. */
export type BrainCommand =
  | "help"
  | "version"
  | "init"
  | "status"
  | "capture"
  | "search"
  | "think"
  | "get"
  | "link"
  | "backlinks"
  | "act"
  | "hook"
  | "ingest-events"
  | "schedule-ingest"
  | "kpi"
  | "dashboard"
  | "outcome-event";

const text = (raw: string): string => raw;

/** Coerce a count flag, naming the flag when the value is not a number. */
function count(flag: string): (raw: string) => number {
  return (raw: string): number => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${flag} must be a number`);
    return parsed;
  };
}

/**
 * Flags the binary itself answers, before any command. They are the binary's,
 * not a command's: a named command owns every flag that follows it, so
 * `brain search "topic" --version` searches rather than printing a version.
 */
export const BRAIN_BINARY_FLAGS = {
  version: { kind: "boolean", aliases: ["v"] },
  help: { kind: "boolean", aliases: ["h"] },
  json: { kind: "boolean" },
} satisfies FlagSchema;

/** `init` and `status` take no flags; declaring that is what rejects one. */
export const NO_FLAGS = {} satisfies FlagSchema;

export const CAPTURE_FLAGS = {
  title: { kind: "value", coerce: text },
  content: { kind: "value", coerce: text },
  file: { kind: "value", coerce: text },
  kind: { kind: "value", coerce: text },
  tag: { kind: "value", type: "array", coerce: text },
  agent: { kind: "value", coerce: text },
  runner: { kind: "value", coerce: text },
  session: { kind: "value", coerce: text },
} satisfies FlagSchema;

export const SEARCH_FLAGS = {
  query: { kind: "value", coerce: text },
  limit: { kind: "value", coerce: count("limit") },
} satisfies FlagSchema;

export const THINK_FLAGS = {
  query: { kind: "value", coerce: text },
  limit: { kind: "value", coerce: count("limit") },
  json: { kind: "boolean" },
} satisfies FlagSchema;

export const LINK_FLAGS = {
  from: { kind: "value", coerce: text },
  to: { kind: "value", coerce: text },
  kind: { kind: "value", coerce: text },
  reason: { kind: "value", coerce: text },
} satisfies FlagSchema;

export const ACT_FLAGS = {
  target: { kind: "value", coerce: text },
  message: { kind: "value", coerce: text },
} satisfies FlagSchema;

export const HOOK_FLAGS = {
  runner: { kind: "value", coerce: text },
} satisfies FlagSchema;

// `--cursor` and `--session` were the spellings the hand-rolled parser fell
// back to when the long form was absent; they stay as aliases so a caller that
// typed either keeps working, now with the contract's last-occurrence rule.
export const INGEST_EVENTS_FLAGS = {
  "after-cursor": { kind: "value", aliases: ["cursor"], coerce: text },
  "session-key": { kind: "value", aliases: ["session"], coerce: text },
  limit: { kind: "value", coerce: count("limit") },
} satisfies FlagSchema;

export const SCHEDULE_INGEST_FLAGS = {
  "session-key": { kind: "value", aliases: ["session"], coerce: text },
  limit: { kind: "value", coerce: count("limit") },
  state: { kind: "value", coerce: text },
} satisfies FlagSchema;

export const KPI_FLAGS = {
  interval: { kind: "value", coerce: text },
  "group-by": { kind: "value", coerce: text },
  "time-field": { kind: "value", coerce: text },
  from: { kind: "value", coerce: text },
  to: { kind: "value", coerce: text },
  platform: { kind: "value", coerce: text },
  "event-type": { kind: "value", coerce: text },
  target: { kind: "value", coerce: text },
} satisfies FlagSchema;

export const DASHBOARD_FLAGS = {
  out: { kind: "value", coerce: text },
  host: { kind: "value", coerce: text },
  port: { kind: "value", coerce: count("port") },
  json: { kind: "boolean" },
  serve: { kind: "boolean" },
} satisfies FlagSchema;

export const OUTCOME_EVENT_FLAGS = {
  root: { kind: "value", coerce: text },
} satisfies FlagSchema;

const BRAIN_COMMANDS: Record<BrainCommand, CommandSpec> = {
  help: {},
  version: {},
  init: {},
  status: {},
  capture: {},
  search: {},
  think: { aliases: ["query"] },
  get: {},
  link: {},
  backlinks: {},
  act: {},
  hook: {},
  "ingest-events": {},
  "schedule-ingest": {},
  kpi: { aliases: ["kpis"] },
  dashboard: {},
  "outcome-event": {},
};

/**
 * `help` is the default so a bare `brain` prints usage, and a typo'd command
 * errors instead of silently becoming one — the binary never guesses a verb.
 */
const BRAIN_ROUTER: RouterSchema<BrainCommand> = {
  commands: BRAIN_COMMANDS,
  default: "help",
  keepArgvOnDefault: true,
  errorOnUnknownCommand: true,
};

/** Peel the command off argv, naming a typo instead of guessing a verb. */
export function routeBrainCommand(argv: readonly string[]): RoutedCommand<BrainCommand> {
  try {
    return routeCommand<BrainCommand>(argv, BRAIN_ROUTER);
  } catch (error) {
    if (!(error instanceof UnknownCommandError)) throw error;
    throw new Error(`unknown brain command: ${error.token} — run \`brain help\` for the command list`);
  }
}

/**
 * Parse `argv` against one command's schema, naming an undeclared flag.
 *
 * Naming it is the point: a binary that silently swallows a typo'd flag runs
 * with a default the caller believed they had overridden.
 */
export function parseBrainFlags<Schema extends FlagSchema>(
  argv: readonly string[],
  schema: Schema,
): ParseFlagsResult<Schema> {
  try {
    return parseFlags(argv, schema, { unknownFlags: "error" });
  } catch (error) {
    if (!(error instanceof UnknownFlagError)) throw error;
    throw new Error(`unknown brain flag: ${error.flag} — run \`brain help\` for usage`);
  }
}

/** The usage text, kept next to the schemas it describes. */
export const BRAIN_USAGE = `brain commands:
  init
  status
  capture [text] --title <title> --kind <${ARTIFACT_KINDS.join("|")}> --tag <tag>
  search <query> [--limit N]
  think <query> [--limit N] [--json]
  get <rid|id>
  link --from <rid|id> --to <rid|id> --kind <${CONNECTION_KINDS.join("|")}>
  backlinks <rid|id>
  act --target <channel> --message <text>
  ingest-events [--after-cursor N] [--session-key KEY] [--limit N]
  schedule-ingest [--session-key KEY] [--limit N] [--state PATH]
  kpi [--interval hour|day|week|month] [--group-by platform|event_type|target] [--time-field event|ingested] [--from T] [--to T] [--platform P] [--event-type T] [--target T]
  dashboard [--out PATH] [--json] [--serve] [--host 127.0.0.1] [--port 4738]
  outcome-event record [--root PATH] < event.json

brain flags (answered before any command, and before config or the store):
  -v, --version   print the build version
      --json      with --version: print the structured build info
  -h, --help      show this help
`;
