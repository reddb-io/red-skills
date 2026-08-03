/**
 * statusline-config — the declared defaults, and the flag that beats them.
 *
 * **Every statusline default is declarable in `.red/config.yaml`** — the modes,
 * the count budgets, the width and `verbose`. The block is
 * new rather than migrated: the file has never held a statusline key, so there
 * is no legacy spelling to keep working and no deprecation to carry.
 *
 * **Precedence is one sentence: flag beats config beats built-in.** An operator
 * declares the taste they hold every day and overrides it for the one read where
 * they want something else; a config that a flag could not override would make
 * the declaration a cage rather than a default.
 *
 * **A malformed value is ignored and named, never obeyed and never fatal.** This
 * is the one surface rendered on every turn of every session: a line that
 * refused to render because `max_width` says `wide` would replace a small
 * mistake with a blank statusline, which is the harder failure to diagnose.
 * The warning travels with the resolved options so a caller can surface it once.
 */
import { parseFlags } from "@reddb-io/shared/args.js";
import { flatConfigValue } from "@reddb-io/shared/plugin-gate.js";
import {
  REDSKILLED_STATUSLINE_DEFAULTS,
  type RedskilledStatuslineMode,
  type RedskilledStatuslineOptions,
} from "@reddb-io/redskilled-render";

/**
 * The canonical config block.
 *
 * Statusline behaviour is a dev-plugin surface — `/red-statusline` is a dev
 * skill — so the block lives under the plugin rather than at the sacred root.
 */
export const REDSKILLED_STATUSLINE_CONFIG_PREFIX = "plugins.dev.statusline";

/**
 * The folded spelling the config loader also accepts.
 *
 * `plugins.dev.*` folds to `dev.*` everywhere else in this repository; reading
 * both here means the statusline block is not the one place where the fold
 * silently does nothing.
 */
export const REDSKILLED_STATUSLINE_CONFIG_FOLD = "dev.statusline";

/** Every option a project may declare. Absent keys keep the built-in default. */
export interface RedskilledStatuslineConfig {
  readonly mode?: RedskilledStatuslineMode;
  readonly maxWorkers?: number;
  readonly maxProjects?: number;
  readonly maxWidth?: number;
  readonly verbose?: boolean;
}

/** A declared value that could not be honoured, in a sentence a human can act on. */
export interface RedskilledStatuslineConfigWarning {
  readonly key: string;
  readonly value: string;
  readonly reason: string;
}

export interface RedskilledStatuslineConfigRead {
  readonly config: RedskilledStatuslineConfig;
  readonly warnings: readonly RedskilledStatuslineConfigWarning[];
}

/** Overrides a caller states explicitly — the flags of one invocation. */
export interface RedskilledStatuslineFlags {
  readonly mode?: RedskilledStatuslineMode;
  readonly project?: string | null;
  readonly maxWorkers?: number;
  readonly maxProjects?: number;
  readonly maxWidth?: number;
  readonly verbose?: boolean;
}

export interface ResolveStatuslineOptionsInput {
  /** The TEXT of a `.red/config.yaml`; absent when the project has none. */
  readonly configText?: string;
  readonly flags?: RedskilledStatuslineFlags;
  /** The project this session belongs to, resolved by its own authority. */
  readonly project?: string | null;
}

export interface ResolvedStatuslineOptions {
  readonly options: RedskilledStatuslineOptions;
  readonly warnings: readonly RedskilledStatuslineConfigWarning[];
}

/** Read the statusline block out of a config file's text. PURE. */
export function readRedskilledStatuslineConfig(text: string): RedskilledStatuslineConfigRead {
  const warnings: RedskilledStatuslineConfigWarning[] = [];
  const raw = (leaf: string): { key: string; value: string } | undefined => {
    for (const prefix of [REDSKILLED_STATUSLINE_CONFIG_PREFIX, REDSKILLED_STATUSLINE_CONFIG_FOLD]) {
      const key = `${prefix}.${leaf}`;
      const value = flatConfigValue(text, key)?.trim();
      if (value != null && value !== "") return { key, value };
    }
    return undefined;
  };

  const mode = raw("mode");
  const config: {
    mode?: RedskilledStatuslineMode;
    maxWorkers?: number;
    maxProjects?: number;
    maxWidth?: number;
    verbose?: boolean;
  } = {};

  if (mode != null) {
    if (mode.value === "local" || mode.value === "global") config.mode = mode.value;
    else warnings.push({ ...mode, reason: "expected `local` or `global`" });
  }
  const counts = [
    { leaf: "max_workers", assign: (n: number) => { config.maxWorkers = n; } },
    { leaf: "max_projects", assign: (n: number) => { config.maxProjects = n; } },
    { leaf: "max_width", assign: (n: number) => { config.maxWidth = n; } },
  ] as const;
  for (const count of counts) {
    const declared = raw(count.leaf);
    if (declared == null) continue;
    const parsed = Number(declared.value);
    if (Number.isInteger(parsed) && parsed >= 0) count.assign(parsed);
    else warnings.push({ ...declared, reason: "expected a whole number of zero or more" });
  }

  const verbose = raw("verbose");
  if (verbose != null) {
    if (verbose.value === "true" || verbose.value === "false") config.verbose = verbose.value === "true";
    else warnings.push({ ...verbose, reason: "expected `true` or `false`" });
  }

  return { config, warnings };
}

const STATUSLINE_FLAGS = {
  mode: { kind: "value", coerce: (raw: string) => raw },
  verbose: { kind: "boolean" },
  project: { kind: "value", coerce: (raw: string) => raw },
  "max-workers": { kind: "value", coerce: (raw: string) => raw },
  "max-projects": { kind: "value", coerce: (raw: string) => raw },
  "max-width": { kind: "value", coerce: (raw: string) => raw },
} as const;

/**
 * One invocation's flags, from argv.
 *
 * `global` is accepted as a bare word because that is how an operator says it —
 * `/red-statusline global` — and making the short spelling a second-class alias
 * of `--mode global` would leave the documented invocation unparsed.
 * An unreadable flag is a warning and a fall-through to the declared default,
 * for the same reason a malformed config key is.
 */
export function parseRedskilledStatuslineFlags(argv: readonly string[]): {
  readonly flags: RedskilledStatuslineFlags;
  readonly warnings: readonly RedskilledStatuslineConfigWarning[];
} {
  const { values, positionals } = parseFlags(argv, STATUSLINE_FLAGS);
  const warnings: RedskilledStatuslineConfigWarning[] = [];
  const flags: {
    mode?: RedskilledStatuslineMode;
    project?: string | null;
    maxWorkers?: number;
    maxProjects?: number;
    maxWidth?: number;
    verbose?: boolean;
  } = {};

  const declaredMode = values.mode ?? positionals.find((word) => word === "global" || word === "local");
  if (declaredMode != null) {
    if (declaredMode === "local" || declaredMode === "global") flags.mode = declaredMode;
    else warnings.push({ key: "--mode", value: declaredMode, reason: "expected `local` or `global`" });
  }
  if (values.project != null) flags.project = values.project;
  // `--no-verbose` is a stated `false`, not an absent flag: an operator who
  // declared `verbose: true` in config needs one read without it.
  if (values.verbose !== undefined) flags.verbose = values.verbose === true;

  const counts = [
    { flag: "max-workers", assign: (n: number) => { flags.maxWorkers = n; } },
    { flag: "max-projects", assign: (n: number) => { flags.maxProjects = n; } },
    { flag: "max-width", assign: (n: number) => { flags.maxWidth = n; } },
  ] as const;
  for (const count of counts) {
    const raw = values[count.flag];
    if (raw == null) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) count.assign(parsed);
    else warnings.push({ key: `--${count.flag}`, value: raw, reason: "expected a whole number of zero or more" });
  }

  return { flags, warnings };
}

/**
 * The options one render runs under: built-in, then config, then flags.
 *
 * The session's project is not a taste and so is not a config key — it is a fact
 * about where the session is, resolved by the identity authority and handed in.
 * A flag may still override it, which is how one session inspects another
 * project's local view without moving.
 */
export function resolveRedskilledStatuslineOptions(
  input: ResolveStatuslineOptionsInput = {},
): ResolvedStatuslineOptions {
  const read = input.configText == null
    ? { config: {}, warnings: [] as readonly RedskilledStatuslineConfigWarning[] }
    : readRedskilledStatuslineConfig(input.configText);
  const flags = input.flags ?? {};

  return {
    options: {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      mode: flags.mode ?? read.config.mode ?? REDSKILLED_STATUSLINE_DEFAULTS.mode,
      project: flags.project !== undefined ? flags.project : input.project ?? REDSKILLED_STATUSLINE_DEFAULTS.project,
      maxWorkers: flags.maxWorkers ?? read.config.maxWorkers ?? REDSKILLED_STATUSLINE_DEFAULTS.maxWorkers,
      maxProjects: flags.maxProjects ?? read.config.maxProjects ?? REDSKILLED_STATUSLINE_DEFAULTS.maxProjects,
      maxWidth: flags.maxWidth ?? read.config.maxWidth ?? REDSKILLED_STATUSLINE_DEFAULTS.maxWidth,
      verbose: flags.verbose ?? read.config.verbose ?? REDSKILLED_STATUSLINE_DEFAULTS.verbose,
    },
    warnings: read.warnings,
  };
}
