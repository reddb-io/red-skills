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
import { hooksDir } from "@reddb-io/shared/red-paths.js";
import { execTool } from "./exec.js";
import type { HookExec } from "../core/hook-dispatcher.js";
import {
  scriptDefaultResolver,
  type ResolveHooksOptions,
} from "../core/hook-config.js";
import { skillDirFromModule } from "../platform/skill-paths.js";

/**
 * A real `HookExec`: runs the hook command through `bash -c`, passing the
 * documented RED_AFK_* env and the mutable context JSON on stdin, and returns
 * the exit code + captured stdout. When `libraryHooksDir` is supplied it is
 * prepended to PATH so inline config entries can call library scripts by name
 * (invoke-by-name mode, e.g. `red-notify --channel=slack`).
 */
export function makeHookExec(cwd: string, libraryHooksDir?: string): HookExec {
  return async (command, env, stdinJson) => {
    const fullEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    if (libraryHooksDir) {
      fullEnv.PATH = `${libraryHooksDir}${fullEnv.PATH ? `:${fullEnv.PATH}` : ""}`;
    }
    const r = await execTool("bash", ["-c", command], {
      cwd,
      env: fullEnv,
      input: stdinJson,
    });
    return { code: r.code, stdout: r.stdout };
  };
}

/**
 * The default-command resolver + directory hooks options bound to the shipped
 * hook scripts. The built-in defaults (cargo / gradle / heartbeat / envelope /
 * validation) ship inside the AFK skill as `red-*` scripts directly under
 * `<plugin>/hooks/` — NOT in the consuming project's checkout. Per-point library
 * hook scripts also live under `<plugin>/hooks/<point>/`, and the project's own
 * hooks live under `<root>/.red/hooks/` (never created here — ADR 0067): a
 * same-named `red-<name>` shadow there wins over the library default, and
 * per-point project scripts shadow the matching library scripts.
 *
 * Resolves the plugin root from this module's own location. When the skill dir
 * cannot be located (e.g. a bundled copy without the surrounding tree) the
 * defaults fall back to a non-existent project path (`<root>/.red/hooks/lib`) —
 * so an install without the scripts simply runs no default for that point — and
 * the library hooks dir is left undefined (no library-dir contribution).
 */
export function makeHookResolveOptions(
  root: string,
  locateSkillDir: () => string = skillDirFromModule,
): ResolveHooksOptions {
  let skillDir: string | undefined;
  try {
    skillDir = locateSkillDir();
  } catch {
    skillDir = undefined;
  }

  const libHooksDir = skillDir
    ? join(skillDir, "hooks")
    : join(hooksDir(root), "lib");
  const projectHooksDir = hooksDir(root);

  return {
    defaultCommand: scriptDefaultResolver(libHooksDir, {
      projectHooksDir,
      projectRoot: root,
      exists: existsSync,
    }),
    libraryHooksDir: skillDir ? join(skillDir, "hooks") : undefined,
    projectHooksDir,
  };
}

/**
 * The base RED_AFK_* env handed to every hook command. Event-specific context
 * can override RED_AFK_WORKSPACE when dispatchHooks layers per-hook variables.
 */
export function hookEnv(
  repo: string,
  root: string,
  slot?: number,
  runner?: string,
): Record<string, string> {
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
