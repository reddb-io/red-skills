import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  // Feedback gate (the scope-derived merge gate, ADR 0008 + #832). The gate runs
  // between a green attempt and the merge: `pre_feedback` brackets it (a pre_*
  // point — a non-zero exit VETOES the gate and routes the attempt to the
  // abort-after-claim terminal); `on_baseline_probe` fires when the "already
  // failing on main?" probe ran (ADR 0071); `on_feedback_classify` is MUTABLE —
  // a hook can override the INFRA-vs-SEMANTIC classification via stdout JSON;
  // `post_feedback` reports the gate's verdict.
  "pre_feedback",
  "on_baseline_probe",
  "on_feedback_classify",
  "post_feedback",
  "pre_merge",
  "post_merge",
  "on_attempt_error",
  // Commit-anchored progress guard fired (ADR 0044/0045 + #832): the attempt was
  // alive but produced no new commit within the cap. Fires before the no-agent
  // reconcile / escalation routing decides what to do with the parked branch.
  "on_attempt_timeout",
  // Recovery disposition (#832). `on_recovery_decision` is MUTABLE — fired with
  // the composer's proposed retry-vs-escalate decision (core/disposition); a
  // hook can override it via stdout JSON before the labels are applied.
  // `on_blocked` fires once an issue is actually parked to a human gate
  // (escalate path). `on_reconcile` fires after the ADR 0055 no-agent reconcile
  // re-validated a parked mechanical branch and landed/parked/skipped it.
  "on_recovery_decision",
  "on_blocked",
  "on_reconcile",
  "on_idle",
  // Periodic proof-of-life (PR-B): fired once per attempt-guard poll (~60s)
  // during an inner-agent run, NOT a once-per-lifecycle point. A user shell
  // command here receives the heartbeat context (issue/branch/runner + the full
  // worker vitals, ADR 0065/#832) so an external monitor can be pinged or drive
  // custom live alerting. No built-in default; absent config → no-op.
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

/** Injectable directory lister — returns filenames (not full paths). */
export type ListFiles = (dir: string) => string[];

/**
 * Sort key for a hook script filename: the leading integer prefix (e.g. 10 from
 * "10-foo.sh"), or Infinity when there is no numeric prefix so un-prefixed
 * scripts sort after all numbered ones.
 */
function numericPrefix(filename: string): number {
  const m = /^(\d+)/.exec(filename);
  return m ? parseInt(m[1]!, 10) : Infinity;
}

function compareFilenames(a: string, b: string): number {
  const diff = numericPrefix(a) - numericPrefix(b);
  return diff !== 0 ? diff : a.localeCompare(b);
}

/**
 * Resolve the per-point layered script directories into an ordered command list.
 *
 * For a given lifecycle point, collects every non-hidden file from the library
 * dir (`<libraryHooksDir>/<point>/`) and the project dir
 * (`<projectHooksDir>/<point>/`), merges them with project-wins shadowing (a
 * project file with the same filename overwrites the library file), and returns
 * the full paths sorted by numeric filename prefix then lexically. Either dir
 * may be undefined or absent — its contribution is simply empty.
 */
export function resolveDirScripts(
  point: HookName | string,
  libraryHooksDir: string | undefined,
  projectHooksDir: string | undefined,
  listFiles: ListFiles,
  dirExists: (dir: string) => boolean,
): string[] {
  const listDir = (base: string | undefined): Map<string, string> => {
    const map = new Map<string, string>();
    if (!base) return map;
    const dir = join(base, point);
    if (!dirExists(dir)) return map;
    for (const f of listFiles(dir)) {
      if (!f.startsWith(".")) map.set(f, join(dir, f));
    }
    return map;
  };

  const libMap = listDir(libraryHooksDir);
  const projMap = listDir(projectHooksDir);

  // Merge: project shadows library on same filename.
  const merged = new Map<string, string>([...libMap, ...projMap]);
  const sorted = [...merged.keys()].sort(compareFilenames);
  return sorted.map((f) => merged.get(f)!);
}

export interface ResolveHooksOptions {
  /** Resolves each built-in default to its command string (library or shadow). */
  defaultCommand: HookDefaultResolver;
  /**
   * The plugin's library hooks directory (`<skill>/hooks/`). Per-point
   * subdirectories under it are scanned for auto-run scripts (ADR 0026 layered
   * PATH extension). When undefined (e.g. bundled without the surrounding tree),
   * the library contribution is empty.
   */
  libraryHooksDir?: string;
  /**
   * The project's hooks directory (`.red/hooks/`). Per-point subdirectories
   * under it are scanned for auto-run scripts that may shadow library scripts.
   * When undefined or absent on disk, the project contribution is empty.
   */
  projectHooksDir?: string;
  /** Injected dir lister for testing (defaults to readdirSync). */
  listFiles?: ListFiles;
  /** Injected existence check for testing (defaults to existsSync). */
  dirExists?: (dir: string) => boolean;
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

  const { libraryHooksDir, projectHooksDir } = options;
  const listFiles = options.listFiles ?? ((dir) => readdirSync(dir));
  const dirExists = options.dirExists ?? existsSync;

  // Build the resolved map: defaults first, then directory scripts, then inline.
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

    // Directory scripts (library + project, merged, shadowed) run after defaults
    // and before inline config entries.
    if (libraryHooksDir !== undefined || projectHooksDir !== undefined) {
      list.push(...resolveDirScripts(name, libraryHooksDir, projectHooksDir, listFiles, dirExists));
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
