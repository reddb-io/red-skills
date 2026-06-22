// runtime/hooks.ts — the real HookExec + default-resolver wiring for the
// lifecycle hook dispatcher (ADR 0026).
//
// hook-config's `resolveHooks` turns the parsed `.red/config.yaml` into an
// ordered command list per lifecycle point (built-in defaults first, then
// user-declared commands); hook-dispatcher then runs each command through an
// injected `HookExec`, piping the current mutable context as JSON on stdin and
// reading the (optionally JSON) mutated context back from stdout. This module
// supplies that executor over a real shell, plus the env every hook receives.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execTool } from "./exec.js";
import type { HookExec } from "../core/hook-dispatcher.js";
import { scriptDefaultResolver, type ResolveHooksOptions } from "../core/hook-config.js";
import { skillDirFromModule } from "../platform/skill-paths.js";

/**
 * A real `HookExec`: runs the hook command through `sh -c`, passing the
 * documented RED_AFK_* env and the mutable context JSON on stdin, and returns
 * the exit code + captured stdout. The command string is whatever the config /
 * default resolver registered (a script path or a shell snippet).
 */
export function makeHookExec(cwd: string): HookExec {
  return async (command, env, stdinJson) => {
    const r = await execTool("sh", ["-c", command], {
      cwd,
      env: { ...process.env, ...env },
      input: stdinJson,
    });
    return { code: r.code, stdout: r.stdout };
  };
}

/**
 * The default-command resolver bound to the shipped `red-*` library scripts.
 * The built-in defaults (red-cargo / red-gradle / red-heartbeat / red-envelope /
 * red-validation) ship inside the AFK skill at `<plugin>/hooks/red-*` — NOT in
 * the consuming project's checkout. Project-local shadows in `<root>/.red/hooks/`
 * take precedence over the library scripts, so an operator can replace or disable
 * any built-in by placing a same-named file there.
 *
 * Resolves the plugin root from this module's own location, falling back to a
 * non-existent project path if the skill dir cannot be located (e.g. a bundled
 * copy without the surrounding tree), so an install without the scripts simply
 * runs no default for that point.
 */
export function makeHookResolveOptions(root: string): ResolveHooksOptions {
  let libHooksDir: string;
  try {
    libHooksDir = join(skillDirFromModule(), "hooks");
  } catch {
    libHooksDir = join(root, ".red", "hooks", "lib");
  }
  const projectHooksDir = join(root, ".red", "hooks");
  return { defaultCommand: scriptDefaultResolver(libHooksDir, projectHooksDir, existsSync) };
}

/**
 * The base RED_AFK_* env handed to every hook command. Event-specific context
 * can override RED_AFK_WORKSPACE when dispatchHooks layers per-hook variables.
 */
export function hookEnv(repo: string, root: string, slot?: number, runner?: string): Record<string, string> {
  const env: Record<string, string> = {
    RED_AFK_REPO: repo,
    RED_AFK_ROOT: root,
    RED_AFK_WORKSPACE: root,
  };
  if (runner !== undefined && runner.length > 0) {
    env.RED_AFK_RUNNER = runner;
  }
  if (slot !== undefined) {
    env.RED_AFK_SLOT = String(slot);
  }
  return env;
}
