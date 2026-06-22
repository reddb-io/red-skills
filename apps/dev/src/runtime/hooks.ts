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
    const r = await execTool("sh", ["-c", command], {
      cwd,
      env: fullEnv,
      input: stdinJson,
    });
    return { code: r.code, stdout: r.stdout };
  };
}

/**
 * The default-command resolver + directory hooks options bound to the shipped
 * hook scripts. Built-in defaults (cargo / gradle / heartbeat / envelope /
 * validation) ship at `<plugin>/defaults/`; library hook scripts ship at
 * `<plugin>/hooks/` as per-point subdirectories. The project's own hooks live
 * under `<root>/.red/hooks/` (never created here — ADR 0067). When the skill
 * dir cannot be located (e.g. a bundled copy without the surrounding tree) the
 * resolver falls back to the legacy project path for defaults, and the library
 * hooks dir is left undefined (no library-dir contribution).
 */
export function makeHookResolveOptions(root: string): ResolveHooksOptions {
  let skillDir: string | undefined;
  try {
    skillDir = skillDirFromModule();
  } catch {
    skillDir = undefined;
  }

  const defaultsDir = skillDir
    ? join(skillDir, "defaults")
    : join(root, ".red", "hooks", "defaults");

  return {
    defaultCommand: scriptDefaultResolver(defaultsDir, existsSync),
    libraryHooksDir: skillDir ? join(skillDir, "hooks") : undefined,
    projectHooksDir: join(root, ".red", "hooks"),
  };
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
