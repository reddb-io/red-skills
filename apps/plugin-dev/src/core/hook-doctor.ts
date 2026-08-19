import { CANONICAL_HOOK_NAMES } from "./hook-config.js";

/**
 * hook-doctor.ts — the static validation half of the canonical hook registry
 * (#834, PRD #829). `/dev:doctor` reads `.red/config.yaml` + the `.red/hooks/`
 * tree and classifies every backpressure command and hook script **without
 * executing anything** — the trust model is "scripts in your own repo are
 * trusted", so the doctor never runs them; it only resolves them statically.
 *
 * The classification (issue #834 acceptance criteria):
 *   - a command referencing a missing `package.json` script or a non-existent
 *     file → `error` (`❌`) — caught before the next drain parks every issue;
 *   - a `red-<name>` library/shadow target that does not resolve → `error`;
 *   - a command it cannot statically resolve (e.g. a bare PATH binary) →
 *     `warn` (`⚠️`), conservative — a maybe-valid command is never a hard fail;
 *   - everything that resolves → `ok` (`✅`).
 *
 * Pure + IO-free: every filesystem fact (script names, file existence, library
 * targets) is injected, so the validator can be unit-tested with fixtures and
 * can never accidentally spawn a process.
 */

/** The three doctor verdicts, mapped to `✅` / `⚠️` / `❌` in the scorecard. */
export type Verdict = "ok" | "warn" | "error";

export interface CommandFinding {
  /** The command string as declared in config / the resolved hook script path. */
  readonly command: string;
  readonly verdict: Verdict;
  /** One-line evidence for the scorecard. */
  readonly reason: string;
}

export interface ClassifyContext {
  /** Script names declared in the repo's `package.json` `"scripts"` map. */
  readonly packageScripts: ReadonlySet<string>;
  /** Whether a path (resolved relative to the repo root) exists on disk. */
  readonly fileExists: (path: string) => boolean;
  /**
   * `red-<name>` library/shadow targets that resolve (the library hooks dir +
   * any project shadow). A `red-*` invoke-by-name command resolves iff its name
   * is in this set.
   */
  readonly libraryScripts: ReadonlySet<string>;
}

/** Package-manager launchers whose `run <script>` form maps to a package script. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** A token that names a file path (has a separator or a script-ish extension). */
function looksLikePath(token: string): boolean {
  // A URL (`https://…`) carries a `/` but is not a filesystem path — never a
  // missing-file error, just an argument to some bare binary.
  if (token.includes("://")) return false;
  if (token.includes("/")) return true;
  return /\.(sh|mjs|cjs|js|ts|py|rb)$/.test(token);
}

/** Split a command into whitespace-separated tokens, env-prefix stripped. */
function tokenize(command: string): string[] {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  // Drop leading `FOO=bar` env assignments — the real command starts after them.
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

/**
 * Classify a single backpressure / hook command statically. Never executes it.
 *
 * The resolution order is deliberate: explicit file paths and package-manager
 * `run` forms are decidable (→ `ok`/`error`); a `red-*` target checks the
 * library set; anything left is an unresolvable bare binary → `warn`.
 */
export function classifyCommand(command: string, ctx: ClassifyContext): CommandFinding {
  const finding = (verdict: Verdict, reason: string): CommandFinding => ({
    command,
    verdict,
    reason,
  });

  const tokens = tokenize(command);
  if (tokens.length === 0) return finding("warn", "empty command after env prefix");

  const bin = tokens[0]!;

  // 1. Package-manager script form: `npm run <s>` / `pnpm run <s>` / `yarn <s>`.
  if (PACKAGE_MANAGERS.has(bin)) {
    const usesRun = tokens[1] === "run";
    const scriptName = usesRun ? tokens[2] : tokens[1];
    if (scriptName !== undefined && /^[A-Za-z0-9:_-]+$/.test(scriptName)) {
      if (ctx.packageScripts.has(scriptName)) {
        return finding("ok", `package.json script "${scriptName}" exists`);
      }
      // `npm run <missing>` is unambiguously a missing script. Without `run`,
      // the word might be a pm builtin (`pnpm install`) — stay conservative.
      if (usesRun) {
        return finding("error", `package.json has no script "${scriptName}"`);
      }
      return finding("warn", `cannot resolve "${bin} ${scriptName}" statically`);
    }
    return finding("warn", `cannot resolve "${bin}" invocation statically`);
  }

  // 2. `red-<name>` invoke-by-name / shadow target.
  if (bin.startsWith("red-")) {
    if (ctx.libraryScripts.has(bin)) {
      return finding("ok", `library hook "${bin}" resolves`);
    }
    return finding("error", `no library/shadow hook named "${bin}"`);
  }

  // 3. An explicit file path (the bin itself, or any argument that names one).
  const pathToken = tokens.find(looksLikePath);
  if (pathToken !== undefined) {
    if (ctx.fileExists(pathToken)) {
      return finding("ok", `file "${pathToken}" exists`);
    }
    return finding("error", `file "${pathToken}" does not exist`);
  }

  // 4. A bare binary on PATH we cannot resolve without executing → conservative.
  return finding("warn", `cannot statically resolve "${bin}" (PATH binary?)`);
}

/**
 * Pre-catch unknown hook names read-only (today a hard boot error). Returns the
 * subset of declared names that are not in `CANONICAL_HOOK_NAMES`.
 */
export function unknownHookNames(declaredHookNames: readonly string[]): string[] {
  const canonical = new Set<string>(CANONICAL_HOOK_NAMES);
  return declaredHookNames.filter((n) => !canonical.has(n));
}

export interface ValidationInput {
  /** `afk.backpressure` commands, in order. */
  readonly backpressure?: readonly string[];
  /** Resolved hook commands, keyed by lifecycle point. */
  readonly hookCommands?: ReadonlyArray<{ readonly hook: string; readonly command: string }>;
  /** Hook names declared in config (to pre-catch unknown ones). */
  readonly declaredHookNames?: readonly string[];
}

export interface ValidationReport {
  readonly backpressure: CommandFinding[];
  readonly hooks: Array<{ hook: string; finding: CommandFinding }>;
  readonly unknownHooks: string[];
}

/**
 * Validate an AFK config's backpressure list and resolved hook commands
 * statically. The aggregate the doctor renders into its scorecard; never runs a
 * command.
 */
export function validateHookConfig(
  input: ValidationInput,
  ctx: ClassifyContext,
): ValidationReport {
  return {
    backpressure: (input.backpressure ?? []).map((c) => classifyCommand(c, ctx)),
    hooks: (input.hookCommands ?? []).map(({ hook, command }) => ({
      hook,
      finding: classifyCommand(command, ctx),
    })),
    unknownHooks: unknownHookNames(input.declaredHookNames ?? []),
  };
}
