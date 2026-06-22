import { existsSync } from "node:fs";
import type { ConfigValues } from "./config.js";

/**
 * hook-config.ts — TypeScript port of the resolution half of
 * scripts/lib/hook-config.sh.
 *
 * Resolves the `afk.hooks.*` block of the parsed `.red/config.yaml` (see
 * config.ts) into an ordered command list per lifecycle point. The contract
 * (ADR 0026, SKILL.md "Lifecycle Hooks"):
 *
 *   - lifecycle points are a fixed canonical set; an unknown hook name is a
 *     hard error at boot;
 *   - within a point, built-in DEFAULTS run first (fixed registration order,
 *     never reorderable), then user-declared commands in declaration order;
 *   - users can *shadow* a built-in default by placing a same-named script in
 *     `.red/hooks/` (the shadow wins over the library script); to disable a
 *     default entirely, shadow it with a no-op script that exits 0;
 *   - a bare string is shorthand for a one-element list.
 *
 * The resolution is pure: it reads the already-parsed flat config map and a
 * `defaultCommand` resolver injected by the caller (so the executable-script
 * presence check the shell does stays out of this module). The default
 * resolver only needs to return the command string for an enabled default, or
 * `undefined` to skip it (e.g. the script does not exist for this install).
 */

/**
 * The canonical lifecycle points, in execution order (ADR 0026). The
 * deprecated `*_worker` aliases are intentionally absent — they are translated
 * to their canonical `*_attempt` names upstream, before resolution.
 */
export const CANONICAL_HOOK_NAMES = [
  "pre_session",
  "pre_pick",
  "post_pick",
  "pre_worktree",
  "pre_attempt",
  "post_attempt",
  "pre_merge",
  "post_merge",
  "on_attempt_error",
  "on_idle",
  // Periodic proof-of-life (PR-B): fired once per attempt-guard poll (~60s)
  // during an inner-agent run, NOT a once-per-lifecycle point. A user shell
  // command here receives the heartbeat context (issue/branch/runner) so an
  // external monitor can be pinged. No built-in default; absent config → no-op.
  "on_heartbeat",
  "post_session",
  "on_session_error",
] as const;

export type HookName = (typeof CANONICAL_HOOK_NAMES)[number];

/**
 * Which built-in defaults attach to which lifecycle point, in the fixed
 * registration order (SKILL.md "Built-in defaults" table). The order encodes
 * correctness invariants and is not user-reorderable.
 */
export const HOOK_DEFAULTS_REGISTRY = {
  pre_worktree: ["cargo", "gradle"],
  post_attempt: ["heartbeat", "envelope"],
  post_merge: ["validation"],
} as const satisfies Partial<Record<HookName, readonly string[]>>;

/** The flat set of built-in default names, derived from the registry. */
export const HOOK_DEFAULT_NAMES = Object.values(HOOK_DEFAULTS_REGISTRY).flat();

export type HookDefaultName = (typeof HOOK_DEFAULT_NAMES)[number];

/** The resolved, ordered command list for every canonical lifecycle point. */
export type ResolvedHooks = Record<HookName, string[]>;

/** Thrown when `.red/config.yaml` declares a hook under an unknown name. */
export class UnknownHookError extends Error {
  constructor(public readonly hookName: string) {
    super(`unknown hook name '${hookName}'`);
    this.name = "UnknownHookError";
  }
}

/**
 * Resolves a single built-in default to its command string, or `undefined` to
 * skip it. Injected so the executable-script presence check (and its base
 * directory) lives outside this pure module. Defaults the caller does not
 * provide a command for are simply omitted.
 */
export type HookDefaultResolver = (name: HookDefaultName) => string | undefined;

const HOOK_NAME_SET = new Set<string>(CANONICAL_HOOK_NAMES);

function isCanonical(name: string): name is HookName {
  return HOOK_NAME_SET.has(name);
}

const HOOKS_PREFIX = "afk.hooks.";
const DEFAULTS_PREFIX = "afk.hooks.defaults.";

export interface ResolveHooksOptions {
  /** Resolves each built-in default to its command string (library or shadow). */
  defaultCommand: HookDefaultResolver;
}

/**
 * Resolve the parsed config into the ordered command list per lifecycle point.
 *
 * Defaults register first (resolved from the library hook dir, with project
 * shadows in `.red/hooks/` taking precedence), then user-declared commands
 * replay in declaration order. A bare-string user value is a one-element list;
 * a newline-joined value (how the config loader stores a block list) splits
 * into its elements with blanks dropped. An unknown hook name throws
 * `UnknownHookError`.
 *
 * The `afk.hooks.defaults.<name>: false` toggle is no longer honored — shadow
 * the built-in with a same-named no-op script in `.red/hooks/` instead. Old
 * configs that still carry the key are silently ignored (no error).
 */
export function resolveHooks(
  config: ConfigValues,
  options: ResolveHooksOptions,
): ResolvedHooks {
  const { defaultCommand } = options;

  // Walk the flat config once, collecting per-point user command lists and
  // validating hook names eagerly.
  const userLists = new Map<HookName, string[]>();

  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith(HOOKS_PREFIX)) continue;

    // afk.hooks.defaults.* keys are legacy disable toggles — silently ignored
    // now that same-filename shadowing in .red/hooks/ replaces them.
    if (key.startsWith(DEFAULTS_PREFIX)) continue;

    const name = key.slice(HOOKS_PREFIX.length);
    if (!isCanonical(name)) throw new UnknownHookError(name);

    const commands = value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    userLists.set(name, commands);
  }

  // Build the resolved map: every canonical point present, defaults first.
  const resolved = {} as ResolvedHooks;
  for (const name of CANONICAL_HOOK_NAMES) {
    const list: string[] = [];

    const defaults = HOOK_DEFAULTS_REGISTRY[name as keyof typeof HOOK_DEFAULTS_REGISTRY];
    if (defaults) {
      for (const defaultName of defaults) {
        const command = defaultCommand(defaultName);
        if (command !== undefined) list.push(command);
      }
    }

    const userCommands = userLists.get(name);
    if (userCommands) list.push(...userCommands);

    resolved[name] = list;
  }

  return resolved;
}

/**
 * A `HookDefaultResolver` backed by the shipped `red-*` library scripts under
 * `libHooksDir`, with optional project-local shadow support. When `projectHooksDir`
 * is provided and a same-named `red-<name>` file exists there, the project shadow
 * wins over the library script — this is the mechanism by which operators customize
 * or disable a built-in default (place a no-op script in `.red/hooks/red-<name>`).
 *
 * Returns `undefined` when neither the shadow nor the library script is present,
 * mirroring the shell loader's `-x "$hooks_dir/<script>"` presence guard. The
 * `exists` predicate is injectable for testing.
 */
export function scriptDefaultResolver(
  libHooksDir: string,
  projectHooksDir?: string,
  exists: (path: string) => boolean = existsSync,
): HookDefaultResolver {
  const scripts: Record<HookDefaultName, string> = {
    cargo: "red-cargo",
    gradle: "red-gradle",
    heartbeat: "red-heartbeat",
    envelope: "red-envelope",
    validation: "red-validation",
  };
  return (name) => {
    const filename = scripts[name];
    // Project shadow wins over library script.
    if (projectHooksDir) {
      const shadowPath = `${projectHooksDir}/${filename}`;
      if (exists(shadowPath)) return shadowPath;
    }
    const libPath = `${libHooksDir}/${filename}`;
    return exists(libPath) ? libPath : undefined;
  };
}
