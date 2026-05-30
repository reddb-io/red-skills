// runtime/hooks.ts — the real HookExec + default-resolver wiring for the
// lifecycle hook dispatcher (ADR 0026).
//
// hook-config's `resolveHooks` turns the parsed `.red/config.yaml` into an
// ordered command list per lifecycle point (built-in defaults first, then
// user-declared commands); hook-dispatcher then runs each command through an
// injected `HookExec`, piping the current mutable context as JSON on stdin and
// reading the (optionally JSON) mutated context back from stdout. This module
// supplies that executor over a real shell, plus the env every hook receives.

import { join } from "node:path";
import { execTool } from "./exec.js";
import type { HookExec } from "../core/hook-dispatcher.js";
import { scriptDefaultResolver, type ResolveHooksOptions } from "../core/hook-config.js";

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
 * The default-command resolver bound to the shipped hook scripts. The built-in
 * defaults (cargo / gradle / heartbeat / envelope / validation) live under
 * `<root>/.red/hooks/defaults`; a default whose script is absent is skipped, so
 * an install without the scripts simply runs no default for that point.
 */
export function makeHookResolveOptions(root: string): ResolveHooksOptions {
  const defaultsDir = join(root, ".red", "hooks", "defaults");
  return { defaultCommand: scriptDefaultResolver(defaultsDir) };
}

/** The RED_AFK_* env handed to every hook command. */
export function hookEnv(repo: string, root: string): Record<string, string> {
  return {
    RED_AFK_REPO: repo,
    RED_AFK_ROOT: root,
  };
}
