/**
 * `src/packages/shared` — code common to two or more `src/apps/*` plugins (ADR 0034).
 *
 * Re-exports the shared CLI argument layer built over `cli-args-parser`.
 */
export {
  parseFlags,
  parseLooseArgs,
  routeCommand,
  type BooleanFlagSpec,
  type ValueFlagSpec,
  type FlagSpec,
  type FlagSchema,
  type ParseFlagsResult,
  type LooseParsedArgs,
  type RoutedCommand,
  type CommandSpec,
  type RouterSchema,
} from "./args.js";
export * from "./log.js";
